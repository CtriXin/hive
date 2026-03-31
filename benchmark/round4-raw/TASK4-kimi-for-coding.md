## 根因分析

### 错误 1: `Cannot read properties of undefined (reading 'send')`
**根因**: 竞态条件。`subscribers` Set 中的 `clientId` 存在，但 `this.clients.get(clientId)` 返回 `undefined`。发生在 `removeClient()` 和 `broadcast()` 并发执行时：
- 线程A: `broadcast()` 获取到 subscribers Set
- 线程B: `removeClient()` 从 `this.clients` 删除 client，但未从 `this.channels` 删除（或删除操作未完成）
- 线程A: 遍历 subscribers 时 client 已不存在

### 错误 2: `Cannot read properties of undefined (reading 'lastPing')`
**根因**: `for...of` 遍历 `this.clients` 时，`removeClient()` 修改了 Map。虽然 Map 遍历是安全的，但 `removeClient` 内部又遍历 `client.subscribedChannels`，如果回调中再次触发删除会导致问题。更可能是 `handlePong` 或 `removeClient` 在 interval 回调执行期间被调用，导致 client 在遍历时被删除。

### 错误 3: Channels Map 内存泄漏
**根因**: `removeClient` 只从 channel 中删除 clientId，但**没有删除空的 channel**。长期运行后，channels Map 累积大量废弃 channel。

### 错误 4: 广播延迟 4.7s
**根因**: 同步遍历 52000 订阅者，每个 `JSON.stringify` 同步执行阻塞事件循环。

---

## 修复后代码


--- Writing: /Users/xin/auto-skills/CtriXin-repo/hive/broadcast-server-fixed.ts ---
interface Client {
  id: string;
  ws: { send(data: string): void; readyState: number };
  subscribedChannels: Set<string>;
  lastPing: number;
}

class BroadcastServer {
  private clients = new Map<string, Client>();
  private channels = new Map<string, Set<string>>(); // channel → client ids
  private pingInterval: NodeJS.Timeout | null = null;

  addClient(id: string, ws: Client['ws']): void {
    const client: Client = { id, ws, subscribedChannels: new Set(), lastPing: Date.now() };
    this.clients.set(id, client);
  }

  removeClient(id: string): void {
    const client = this.clients.get(id);
    if (!client) return;

    // 从所有已订阅的 channel 中移除，并清理空 channel
    for (const channel of client.subscribedChannels) {
      const channelSubscribers = this.channels.get(channel);
      if (channelSubscribers) {
        channelSubscribers.delete(id);
        // 修复3: 删除空 channel 防止内存泄漏
        if (channelSubscribers.size === 0) {
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

    // 修复4: 预序列化消息，避免对每个客户端重复 JSON.stringify
    const payload = JSON.stringify({ channel, data: message });

    let sent = 0;
    const now = Date.now();

    // 修复1: 防御性检查 client 是否存在（处理竞态条件）
    // 修复4: 使用数组缓存活跃客户端，批量发送减少 Map 查找
    const activeClients: Client[] = [];

    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      // 双重检查: client 存在且连接打开
      if (client?.ws.readyState === 1) {
        activeClients.push(client);
      }
    }

    // 批量发送（可进一步优化为 setImmediate 分片）
    for (const client of activeClients) {
      try {
        client.ws.send(payload);
        sent++;
      } catch (err) {
        // 发送失败时清理无效客户端
        this.removeClient(client.id);
      }
    }

    return sent;
  }

  // 修复4: 异步分片广播，避免阻塞事件循环
  async broadcastAsync(channel: string, message: string, chunkSize = 1000): Promise<number> {
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

      // 每批处理后让出事件循环
      if (i + chunkSize < clientIds.length) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    return sent;
  }

  startPingCheck(intervalMs: number = 30000, timeoutMs: number = 60000): void {
    this.pingInterval = setInterval(() => {
      const now = Date.now();

      // 修复2: 先收集超时客户端，再批量删除，避免遍历中修改 Map
      const toRemove: string[] = [];

      for (const [id, client] of this.clients) {
        // 防御性检查 client 存在（虽然遍历中应该存在）
        if (client && now - client.lastPing > timeoutMs) {
          toRemove.push(id);
        }
      }

      // 批量删除，避免遍历中修改
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

  // 调试/监控方法
  getStats(): { clients: number; channels: number; avgChannelsPerClient: number } {
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


## 修复点注释说明

| 位置 | 修复内容 |
|------|----------|
| `removeClient:20-23` | 删除空 channel，防止内存泄漏 |
| `broadcast:45-48` | 预序列化 JSON，避免 52000 次重复 `JSON.stringify` |
| `broadcast:52-58` | 防御性检查 `client?.ws`，处理竞态条件 |
| `broadcast:62-68` | try-catch 包装 send，失败时自动清理 |
| `broadcastAsync:76-102` | 新增异步分片广播，每 1000 个让出事件循环 |
| `startPingCheck:114-116` | 先收集超时 ID 到数组，遍历后再批量删除 |
| `startPingCheck:119-121` | 批量删除，避免 `for...of` 遍历中修改 Map |

## 性能优化建议（52000 订阅者）

1. **预序列化**: 消息只 `JSON.stringify` 一次（已实现）
2. **异步分片**: 使用 `broadcastAsync()` 每 1000 个客户端让出事件循环（已实现）
3. **Worker Threads**: 超大规模广播考虑使用 Worker 线程池
4. **连接分片**: 单节点承载 52000 WebSocket 连接已达极限，考虑：
   - Redis Pub/Sub 多节点水平扩展
   - 一致性哈希分片客户端到不同节点
5. **零拷贝**: 使用 `SharedArrayBuffer` 或 `Buffer` 避免消息复制