[Read: /Users/xin/auto-skills/CtriXin-repo/hive/broadcast-server-fixed.ts]

已存在修复版本。以下是根因分析和修复说明：

## 1. 错误日志根因分析

### Error 1: `Cannot read properties of undefined (reading 'send')`
**根因**: 竞态条件。`broadcast()` 遍历 `subscribers` 时，某 client 在 `subscribers` 集合中，但已从 `this.clients` Map 中移除（如并发断开连接）。

### Error 2: `Cannot read properties of undefined (reading 'lastPing')`
**根因**: 遍历 Map 时修改。`startPingCheck` 的 `for...of` 循环中调用 `removeClient()` 直接删除 `this.clients` 的 entry，导致迭代器失效。

### Error 3: 内存泄漏（channels 持续增长）
**根因**: `removeClient()` 只从 channel 中删除 clientId，但未在 channel 为空时删除 channel 本身。

### Error 4: 广播延迟 4.7s
**根因**: 
- 同步遍历 52000 订阅者阻塞事件循环
- 每个客户端重复调用 `JSON.stringify()`
- 无分片机制

## 2. 修复后的代码

已写入 `broadcast-server-fixed.ts`，关键修复点：

| 行号 | 修复内容 |
|------|----------|
| 28-30 | 删除空 channel 防止内存泄漏 |
| 56-77 | 防御性检查 + 预序列化 + try/catch 清理 |
| 83-113 | 新增 `broadcastAsync()` 分片广播方法 |
| 119-132 | 先收集再删除，避免遍历中修改 Map |

## 3. 性能优化建议

```typescript
// 对于 52000 订阅者，使用异步分片广播：
await server.broadcastAsync("flash-sale", message, 1000);
```

**进一步优化方向**：
1. **Worker Threads**: 将序列化和发送 offload 到 worker
2. **Redis Pub/Sub**: 多实例时分片广播
3. **WebSocket 压缩**: 启用 `permessage-deflate`
4. **连接分桶**: 按 region/server 分桶并行广播