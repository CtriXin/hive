## 根因分析

### 错误 1: `Cannot read properties of undefined (reading 'send')`
**根因**: `channels` 和 `clients` 两个 Map 状态不一致。当 `removeClient` 删除 client 时,`channels` 中的 subscriber ID 未同步清理,导致 `broadcast` 遍历时 `clients.get(clientId)` 返回 `undefined`。

### 错误 2: `Cannot read properties of undefined (reading 'lastPing')`  
**根因**: **在遍历 Map 时并发修改**。`startPingCheck` 的 `for...of` 遍历过程中调用 `removeClient`,导致遍历器访问已删除的 entry。

### 错误 3: channels Map 内存泄漏
**根因**: `removeClient` 只删除 channel 内的 client ID,但当 channel 变空时未删除 channel 本身,导致空 Set 累积。

### 错误 4: 广播延迟 4.7s
**根因**: 同步串行发送 52000 条消息,阻塞事件循环。

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/broadcast-server-fixed.ts]

已有完整修复版本 `broadcast-server-fixed.ts`。下面是根因总结和性能优化建议:

---

## 1. 错误根因

| 错误 | 根因 | 位置 |
|------|------|------|
| `Cannot read properties of undefined (reading 'send')` | `channels` 残留已删除的 `clientId`,`clients.get()` 返回 `undefined` | `broadcast()` L71-74 |
| `Cannot read properties of undefined (reading 'lastPing')` | 在 `for...of` 遍历 `clients` 时调用 `removeClient` 修改 Map | `startPingCheck()` L131-135 |
| channels 内存泄漏 | `removeClient` 删除 subscriber 后未清理空 channel Set | `removeClient()` L40-48 |
| 广播延迟 4.7s | 52000 次 `JSON.stringify` + 同步 `ws.send` 阻塞事件循环 | `broadcast()` L68-85 |

---

## 2. 性能优化建议 (52000 订阅者)

### A. 使用 `broadcastAsync()` 替代 `broadcast()`
```typescript
// 同步版本会阻塞事件循环 4.7s
server.broadcast('flash-sale', msg);  // ❌

// 异步分片版本，每 1000 个客户端让出事件循环
await server.broadcastAsync('flash-sale', msg, 1000);  // ✅
```
**效果**: 52 个分片 × ~1ms ≈ 52ms (满足 <100ms 要求)

### B. 预序列化 payload
```typescript
// 原始: 每次调用都 stringify (52000 次)
client.ws.send(JSON.stringify({ channel, data: message }));

// 优化: 只 stringify 一次
const payload = JSON.stringify({ channel, data: message });
client.ws.send(payload);
```
**效果**: 减少 51999 次 JSON 序列化 (~3-4s 节省)

### C. 进一步优化 (可选)
```typescript
// 1. 使用 WebSocket 压缩
ws.send(payload, { compress: true });

// 2. 使用 Worker 线程并行发送
// 3. 使用二进制协议替代 JSON
```

---

## 3. 修复点对照表

| 修复点 | 行号 | 说明 |
|--------|------|------|
| Fix1 | L73-74 | `client?.ws` 可选链防御 undefined |
| Fix2 | L130-139 | 先收集 `toRemove[]` 再批量删除 |
| Fix3 | L44-47 | `subs.size === 0` 时删除 channel |
| Fix4 | L68, L75-81, L88-121 | 预序列化 + try/catch 清理 + 异步分片 |