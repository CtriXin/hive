我来分析日志中的 bug 并修复。

## 根因分析

### 错误 1: `broadcast()` TypeError
**现象**: `Cannot read properties of undefined (reading 'send')`  
**根因**: 遍历 `subscribers` Set 时，`clientId` 对应的 `client` 可能已被 `removeClient()` 删除，导致 `client.ws` 为 undefined。竞态条件：ping 检查删除了 client，但广播仍在遍历旧的 subscribers 引用。

### 错误 2: `startPingCheck()` TypeError  
**现象**: `Cannot read properties of undefined (reading 'lastPing')`  
**根因**: `for (const [id, client] of this.clients)` 遍历中调用 `this.removeClient(id)` 会修改正在遍历的 Map，导致迭代器失效。

### 错误 3: 内存泄漏
**现象**: channels Map size=34521，活跃 client 仅 12000  
**根因**: `removeClient()` 只从 channel 的 Set 中删除 clientId，但当 Set 变空时没有删除 channel 本身；`broadcast()` 失败后也没有清理空 channel。

### 错误 4: 广播延迟 4.7s
**现象**: 52000 订阅者耗时过长  
**根因**: 同步遍历 + JSON.stringify 阻塞；没有批量/分片发送机制。



[Read: /Users/xin/auto-skills/CtriXin-repo/hive/broadcast-server-fixed.ts]

## 根因分析

### 错误 1: `broadcast()` TypeError: Cannot read properties of undefined (reading 'send')

**根因**: 遍历 `subscribers` Set 时，`clientId` 对应的 client 可能已被 `removeClient` 删除。`this.clients.get(clientId)` 返回 `undefined`，访问 `client.ws.send` 抛出异常。

**触发场景**: 高并发下 WebSocket 连接断开 → 触发 `removeClient`，同时 `broadcast` 正在遍历同一 channel 的订阅者。

---

### 错误 2: `startPingCheck()` TypeError: Cannot read properties of undefined (reading 'lastPing')

**根因**: `for (const [id, client] of this.clients)` 遍历时直接调用 `this.removeClient(id)` 删除 entry，导致迭代器在下一轮返回 `undefined`，`client.lastPing` 访问失败。

---

### 错误 3: 内存泄漏 — channels Map 持续增长

**根因**: `removeClient` 中仅从 channel 的 Set 中删除 clientId，但未检查 `Set.size === 0`。退订完所有用户的废弃 channel 未被删除，持续堆积。

---

### 错误 4: 广播延迟 4.7s (52000 订阅者)

**根因**: 
- 52000 次同步 `ws.send` 阻塞事件循环
- 每次 `JSON.stringify` 重复序列化相同 payload
- 没有分片让出机制，独占主线程

---

## 修复后的完整代码

```typescript
interface Client {
  id: string;
  ws: { send(data: string): void; readyState: number };
  subscribedChannels: Set<string>;
  lastPing: number;
}

// Fix1_broadcast_nullish: 用可选链防御 channels 中残留的 clientId
//   根因：removeClient 竞态导致 clientId 在 clients 中不存在，
//   client 为 undefined 时 client.ws.send 抛出 TypeError
//
// Fix2_ping_iteration: 先收集再批量删除，不在 for...of 遍历中修改 Map
//   根因：遍历 this.clients 时调用 removeClient 删除 entry，
//   迭代器返回 undefined 导致 client.lastPing 抛出 TypeError
//
// Fix3_channel_leak: removeClient 时清理空 channel entry
//   根因：从 Set 中 delete 后未检查 size===0，废弃 channel 持续堆积
//
// Fix4_broadcast_perf: 预序列化 + 异步分片 + try/catch 清理
//   根因：52000 次 JSON.stringify + 同步 ws.send 阻塞事件循环 4.7s

class BroadcastServer {
  private clients = new Map<string, Client>();
  private channels = new Map<string, Set<string>>();
  private pingInterval: NodeJS.Timeout | null = null;

  addClient(id: string, ws: Client['ws']): void {
    const client: Client = {
      id,
      ws,
      subscribedChannels: new Set(),
      lastPing: Date.now()
    };
    this.clients.set(id, client);
  }

  removeClient(id: string): void {
    const client = this.clients.get(id);
    if (!client) return;
    for (const channel of client.subscribedChannels) {
      const subs = this.channels.get(channel);
      if (subs) {
        subs.delete(id);
        // Fix3: 清理空 channel 防止内存泄漏
        if (subs.size === 0) {
          this.channels.delete(channel);
        }
      }
    }
    this.clients.delete(id);
  }

  subscribe(clientId: string, channel: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.subscribedChannels.add(channel);
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }
    this.channels.get(channel)!.add(clientId);
  }

  // 新增：单个 client 退订接口
  unsubscribe(clientId: string, channel: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.subscribedChannels.delete(channel);
    const subs = this.channels.get(channel);
    if (subs) {
      subs.delete(clientId);
      if (subs.size === 0) {
        this.channels.delete(channel);
      }
    }
  }

  broadcast(channel: string, message: string): number {
    const subscribers = this.channels.get(channel);
    if (!subscribers) return 0;

    // Fix1: 快照 subscriber ids，防止遍历中 removeClient 修改 Set
    const snapshot = Array.from(subscribers);
    const payload = JSON.stringify({ channel, data: message });
    let sent = 0;

    for (const clientId of snapshot) {
      const client = this.clients.get(clientId);
      // 可选链防御 client 不存在的情况
      if (client?.ws.readyState === 1) {
        try {
          client.ws.send(payload);
          sent++;
        } catch {
          // 发送失败立即清理
          this.removeClient(clientId);
        }
      }
    }

    return sent;
  }

  // Fix4: 异步分片广播，每 chunkSize 个订阅者让出事件循环
  async broadcastAsync(
    channel: string,
    message: string,
    chunkSize: number = 1000
  ): Promise<number> {
    const subscribers = this.channels.get(channel);
    if (!subscribers) return 0;

    const payload = JSON.stringify({ channel, data: message });
    const clientIds = Array.from(subscribers);
    let sent = 0;

    for (let i = 0; i < clientIds.length; i += chunkSize) {
      const chunk = clientIds.slice(i, i + chunkSize);
      for (const clientId of chunk) {
        const client = this.clients.get(clientId);
        if (client?.ws.readyState === 1) {
          try {
            client.ws.send(payload);
            sent++;
          } catch {
            this.removeClient(clientId);
          }
        }
      }
      // 最后一批不需要让出
      if (i + chunkSize < clientIds.length) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }

    return sent;
  }

  startPingCheck(
    intervalMs: number = 30000,
    timeoutMs: number = 60000
  ): void {
    this.pingInterval = setInterval(() => {
      const now = Date.now();
      // Fix2: 先收集超时 id，不在遍历中修改 Map
      const toRemove: string[] = [];
      for (const [id, client] of this.clients) {
        if (now - client.lastPing > timeoutMs) {
          toRemove.push(id);
        }
      }
      // 遍历结束后批量删除
      for (const id of toRemove) {
        this.removeClient(id);
      }
    }, intervalMs);
  }

  stopPingCheck(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  handlePong(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) client.lastPing = Date.now();
  }

  // 新增：监控接口
  getStats(): {
    clients: number;
    channels: number;
    avgChannelsPerClient: number;
  } {
    const clientCount = this.clients.size;
    const channelCount = this.channels.size;
    let totalSubs = 0;
    for (const client of this.clients.values()) {
      totalSubs += client.subscribedChannels.size;
    }
    return {
      clients: clientCount,
      channels: channelCount,
      avgChannelsPerClient: clientCount > 0 ? totalSubs / clientCount : 0
    };
  }
}

export { BroadcastServer };
```

---

## 每个修复点的注释说明

| 修复点 | 位置 | 注释 |
|--------|------|------|
| Fix1 | `broadcast()` 行 68, 74-80 | 快照 subscriber ids + 可选链 `client?.ws` + try/catch 清理失败连接 |
| Fix2 | `startPingCheck()` 行 142-151 | 先收集 `toRemove` 数组，遍历结束后批量删除 |
| Fix3 | `removeClient()` 行 44-47 | 删除 clientId 后检查 `subs.size === 0` 并删除空 channel |
| Fix4 | `broadcastAsync()` 行 101-133 | 预序列化 payload + 分片遍历 + `setImmediate` 让出事件循环 |

---

## 性能优化建议（52000 订阅者场景）

| 优化 | 预期收益 |
|------|----------|
| **预序列化** payload (`JSON.stringify` 只做一次) | 减少 52000 次序列化 → ~50% 提升 |
| **异步分片** (`broadcastAsync`, chunkSize=1000) | 避免阻塞主线程 4.7s → 延迟 <100ms |
| **并行发送** (按 WebSocket readyState 分组并发) | 多连接并行发送 → 额外 2-3x 提升 |
| **消息压缩** (对大 payload 使用 gzip) | 减少网络传输量 → 对大消息有效 |
| **水平分片** (按 channel 拆分到多实例) | 单机 52000 → 4 台 × 13000 → 延迟线性下降 |
| **二进制协议** (Protobuf/MessagePack 替代 JSON) | 序列化速度快 2-5x，payload 更小 |