[Read: /Users/xin/auto-skills/CtriXin-repo/hive/broadcast-server-fixed.ts]

已有一个修复版本存在，但让我仔细核对根因分析的准确性。

## 根因分析

### Bug 1: `broadcast()` TypeError: Cannot read properties of undefined (reading 'send')

**根因**: `channels` Map 中的 subscriber clientId 在 `clients` Map 中找不到对应的 client 对象。这发生在竞态条件下——client 在 `removeClient` 时从 `this.clients` 被删除，但某些 channel 的 subscriber Set 中仍残留其 id（比如 `removeClient` 没有被调用，或者 `ws.readyState` 检查时 client 已被并发删除）。原代码用 `client.ws.send(...)` 而没有对 `client` 做 nullish 检查。

**修复**: `client?.ws.readyState === 1`（可选链），外层先收集活跃客户端再批量发送。

### Bug 2: `startPingCheck()` TypeError: Cannot read properties of undefined (reading 'lastPing')

**根因**: `for...of` 遍历 `this.clients` Map 时，`this.removeClient(id)` 在循环体内删除了当前 Map 的 entry。在 JS 规范中，对 Map 进行 `for...of` 遍历时删除**非下一个待访问**的 key 是安全的，但删除**当前正在访问的 key** 在某些引擎/V8 版本中会导致迭代器状态异常，返回 undefined。

**修复**: 先收集所有超时 id 到数组，遍历结束后批量删除。

### Bug 3: channels Map 内存泄漏

**根因**: `removeClient` 从 channel 的 Set 中删除 client id 后，没有检查 Set 是否为空并清理空的 channel entry。随着 client 反复加入/退出，废弃 channel 持续堆积。

**修复**: 删除 client id 后检查 `channelSubscribers.size === 0`，若为空则 `this.channels.delete(channel)`。

### Bug 4: 广播延迟 4.7s（52000 订阅者）

**根因**: 
1. 每次循环都重复调用 `JSON.stringify`，52000 次序列化开销巨大
2. 同步串行 `ws.send()` 阻塞事件循环 4.7 秒，期间无法处理其他 I/O

**修复**: 预序列化一次 + 提供 `broadcastAsync` 分片发送方法，每 1000 个订阅者让出一次事件循环。

---

现有 `broadcast-server-fixed.ts` 的修复是正确的。下面是优化版本：


--- Writing: /Users/xin/auto-skills/CtriXin-repo/hive/broadcast-server-fixed.ts ---
interface Client {
  id: string;
  ws: { send(data: string): void; readyState: number };
  subscribedChannels: Set<string>;
  lastPing: number;
}

// Fix1_broadcast_nullish: 用可选链防御 channels 中残留的 clientId
//   根因: removeClient 未被调用或竞态导致 clientId 在 clients 中不存在，
//   client 为 undefined 时 client.ws.send 抛出 TypeError
//
// Fix2_ping_iteration: 先收集再批量删除，不在 for...of 遍历中修改 Map
//   根因: 遍历 this.clients 时调用 removeClient 删除 entry，
//   迭代器返回 undefined 导致 client.lastPing 抛出 TypeError
//
// Fix3_channel_leak: removeClient 时清理空 channel entry
//   根因: 从 Set 中 delete 后未检查 size===0，废弃 channel 持续堆积
//
// Fix4_broadcast_perf: 预序列化 + 异步分片 + try/catch 清理
//   根因: 52000 次 JSON.stringify + 同步 ws.send 阻塞事件循环 4.7s

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

  broadcast(channel: string, message: string): number {
    const subscribers = this.channels.get(channel);
    if (!subscribers) return 0;

    // Fix4: 预序列化，避免每个客户端重复 stringify
    const payload = JSON.stringify({ channel, data: message });
    let sent = 0;

    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      // Fix1: 可选链防御 client 为 undefined 的情况
      if (client?.ws.readyState === 1) {
        try {
          client.ws.send(payload);
          sent++;
        } catch {
          // Fix4: send 失败时清理无效客户端
          this.removeClient(client.id);
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

--- End of /Users/xin/auto-skills/CtriXin-repo/hive/broadcast-server-fixed.ts ---


## 总结

### 4 个 Bug 根因与修复

| # | 错误 | 根因 | 修复 |
|---|------|------|------|
| 1 | `broadcast()` TypeError on `.send` | `channels` Set 中的 clientId 在 `clients` Map 中不存在，`client` 为 undefined | `client?.ws.readyState === 1` 可选链 |
| 2 | `startPingCheck()` TypeError on `.lastPing` | `for...of` 遍历 Map 时在循环体内 `removeClient` 删除 entry，迭代器返回 undefined | 先收集超时 id 到数组，遍历结束后批量删除 |
| 3 | channels Map 内存泄漏 (34521 vs 12000) | `removeClient` 从 Set 中 delete 后未清理空 channel entry | `subs.size === 0` 时 `this.channels.delete(channel)` |
| 4 | broadcast 延迟 4.7s | 每次循环重复 `JSON.stringify` + 同步串行 `ws.send` 阻塞事件循环 | 预序列化 + `broadcastAsync` 分片发送 + `try/catch` 清理无效客户端 |

### 性能优化建议（52000 订阅者场景）

1. **使用 `broadcastAsync` 替代同步 `broadcast`** — 每 1000 个订阅者 `setImmediate` 让出事件循环，避免阻塞
2. **预序列化** — `JSON.stringify` 只调用一次，所有订阅者共享同一 payload 字符串
3. **架构层面**：超过万级订阅者时考虑 Redis Pub/Sub 分片，多进程各自负责一部分订阅者
4. **增量清理**：`broadcast` 中 `try/catch` 捕获 send 失败并自动 `removeClient`，防止无效连接累积
5. **监控**：`getStats()` 暴露 clients/channels 比率，可设置告警阈值检测泄漏