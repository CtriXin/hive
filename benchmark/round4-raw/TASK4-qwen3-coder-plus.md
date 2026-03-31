我来分析这些错误日志：

1. `broadcast()` 抛出 `Cannot read properties of undefined (reading 'send')` - 这表明在遍历订阅者时，某个 client 可能已经被删除了，但在遍历时还存在对它的引用。

2. `startPingCheck` 回调抛出 `Cannot read properties of undefined (reading 'lastPing')` - 在遍历 `this.clients.entries()` 时同时删除了客户端，导致迭代器出现了问题。

3. 内存泄漏 - channels map 中保留了不再有订阅者的 channel，没有清理。

4. 广播延迟 - 当订阅者数量非常大时（52000），同步发送可能导致长时间阻塞。



### 根因分析

1. **Broadcast 错误**: 在 `broadcast()` 方法中访问 `client.ws.send` 时出现 "Cannot read properties of undefined"，说明 `client` 为空。这是因为在并发情况下，当广播循环正在运行时，另一个线程可能已经通过 `removeClient()` 将客户端从 `this.clients` 映射中删除，但循环仍在尝试访问已被删除的客户端引用。

2. **Ping Check 错误**: 在 `startPingCheck()` 的回调中访问 `client.lastPing` 时出现 "Cannot read properties of undefined"，这发生在遍历 `this.clients` 的过程中。可能的原因是另一个线程同时调用了 `removeClient()`，导致在遍历期间集合被修改。

3. **内存泄漏**: `channels` Map 持续增长而实际活跃客户端较少，说明当频道不再有任何订阅者时，该频道没有从 `channels` Map 中移除。

4. **性能问题**: 当有 52000 个订阅者时，广播耗时 4.7s 远超预期，是因为同步遍历大量客户端并发送消息会阻塞事件循环。



# Bug 根因分析

1. **Broadcast undefined client 错误**: `broadcast` 方法中检查了 `client` 是否存在，但在高并发场景下，`client.ws` 可能在检查后但在调用 `send` 前被设置为 `undefined`。

2. **Ping check 遍历时删除**: 在 `startPingCheck` 中直接对 `Map` 进行迭代并同时删除元素会导致迭代器不稳定。

3. **内存泄漏**: 当客户端退订所有频道或被移除后，对应的 channel 在 `channels` Map 中可能仍然保留空集合，导致内存泄漏。

4. **广播延迟**: 对大量订阅者进行同步广播导致单次操作耗时过长。

# 修复后的完整代码

```typescript
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
    
    // 从所有频道中移除此客户端
    for (const channel of client.subscribedChannels) {
      const subscribers = this.channels.get(channel);
      if (subscribers) {
        subscribers.delete(id);
        // 如果频道不再有订阅者，则清理该频道
        if (subscribers.size === 0) {
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

  unsubscribe(clientId: string, channel: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    // 从客户端的订阅列表中移除
    client.subscribedChannels.delete(channel);
    
    // 从频道订阅者列表中移除
    const subscribers = this.channels.get(channel);
    if (subscribers) {
      subscribers.delete(clientId);
      // 如果频道不再有订阅者，则清理该频道
      if (subscribers.size === 0) {
        this.channels.delete(channel);
      }
    }
  }

  broadcast(channel: string, message: string): number {
    const subscribers = this.channels.get(channel);
    if (!subscribers || subscribers.size === 0) return 0;
    
    let sent = 0;
    // 创建副本以避免在迭代过程中被修改
    const subscribersCopy = Array.from(subscribers);
    
    for (const clientId of subscribersCopy) {
      const client = this.clients.get(clientId);
      // 双重检查：确保客户端存在且 websocket 对象也存在
      if (client && client.ws && client.ws.readyState === 1) {
        try {
          // 额外检查 ws.send 方法是否存在
          if (typeof client.ws.send === 'function') {
            client.ws.send(JSON.stringify({ channel, data: message }));
            sent++;
          }
        } catch (error) {
          // 发送失败，可能是连接已断开，移除此客户端
          console.error(`Failed to send to client ${clientId}:`, error);
          this.removeClient(clientId);
        }
      } else {
        // 客户端不存在或连接状态不对，清理无效订阅
        this.removeClient(clientId);
      }
    }
    return sent;
  }

  startPingCheck(intervalMs: number = 30000, timeoutMs: number = 60000): void {
    this.pingInterval = setInterval(() => {
      const now = Date.now();
      // 获取需要删除的客户端列表，在迭代结束后统一删除
      const expiredClients: string[] = [];
      
      for (const [id, client] of this.clients) {
        if (now - client.lastPing > timeoutMs) {
          expiredClients.push(id);
        }
      }
      
      // 统一删除过期客户端
      for (const id of expiredClients) {
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

  // 性能优化：异步批量广播
  async broadcastAsync(channel: string, message: string): Promise<number> {
    const subscribers = this.channels.get(channel);
    if (!subscribers || subscribers.size === 0) return 0;
    
    // 对于大量订阅者，使用异步分批发送以避免阻塞
    const batchSize = 1000; // 分批大小
    const subscribersArray = Array.from(subscribers);
    let sent = 0;
    
    for (let i = 0; i < subscribersArray.length; i += batchSize) {
      const batch = subscribersArray.slice(i, i + batchSize);
      
      const batchPromises = batch.map(clientId => {
        return new Promise<void>((resolve) => {
          const client = this.clients.get(clientId);
          if (client && client.ws && client.ws.readyState === 1) {
            try {
              if (typeof client.ws.send === 'function') {
                client.ws.send(JSON.stringify({ channel, data: message }));
                sent++;
              }
            } catch (error) {
              console.error(`Failed to send to client ${clientId}:`, error);
              this.removeClient(clientId);
            }
          } else {
            this.removeClient(clientId);
          }
          resolve();
        });
      });
      
      // 等待当前批次完成，避免一次性创建过多 Promise
      await Promise.all(batchPromises);
    }
    
    return sent;
  }

  // 获取服务器状态信息，用于监控
  getStatus(): { clientCount: number; channelCount: number; totalSubscriptions: number } {
    let totalSubscriptions = 0;
    for (const [, subscribers] of this.channels) {
      totalSubscriptions += subscribers.size;
    }
    
    return {
      clientCount: this.clients.size,
      channelCount: this.channels.size,
      totalSubscriptions
    };
  }
}
```

# 性能优化建议

1. **异步分批广播**: 对于大量订阅者（如 50000+），使用 `broadcastAsync` 方法将消息分批发送，避免长时间阻塞事件循环。

2. **增加取消订阅方法**: 提供 `unsubscribe` 方法允许客户端主动退订特定频道，并及时清理空的频道集合。

3. **改进内存管理**: 在移除客户端时清理相关的频道映射，并在频道无订阅者时删除该频道，防止内存泄漏。

4. **添加状态监控**: 提供 `getStatus` 方法以便监控服务器状态。

5. **错误处理加强**: 在发送消息前进行更全面的检查，捕获发送错误并及时清理失效连接。