## 根因分析

### 错误 1: `broadcast()` — `Cannot read properties of undefined (reading 'send')`
**根因**: `channels` Map 中存储的 `clientId` 对应的 `client` 在 `this.clients.get(clientId)` 时可能已被删除（如客户端断连后被 `removeClient` 清理），但 `channels` 中的引用未被清除。代码虽然有 `if (client && ...)` 的检查，但日志显示 `clientId="c-9a3f"` 时 client 为 undefined。等一下——代码看起来有 null check，为什么还会抛错？

仔细看：异常发生在第 42 行 `client.ws.send(...)`。虽然外层有 `if (client && client.ws.readyState === 1)` 检查，但在高并发场景下 `removeClient` 可能就在检查之后、send 之前执行（或在遍历 subscribers 期间另一个调用触发了 `removeClient`），导致 client 被置为 undefined。更关键的是——`removeClient` 中的 `this.channels.get(channel)?.delete(id)` 使用了可选链，**不会删除空 Set**，channel Map 持续积累孤儿条目。

**真正原因**: `subscribers` 是一个 Set 引用，遍历期间另一个线程/调用通过 `removeClient` 删除了 client 但 Set 中的 id 未被清理（或清理时序问题）。在单线程 JS 中，这更可能是因为 `removeClient` 删除了 `clients` 中的条目但 channels Set 中残留了 id。

### 错误 2: `startPingCheck` — `Cannot read properties of undefined (reading 'lastPing')`
**根因**: `for (const [id, client] of this.clients)` 遍历 Map 时，`removeClient(id)` 在循环体内修改了正在遍历的 Map（删除 entries）。JS 规范中 Map 在迭代中删除是安全的，但日志明确说"正在遍历中删除了 entries"导致了问题——这说明可能存在 `removeClient` 中的 `this.clients.delete(id)` 在某些边缘情况下导致迭代器行为异常（虽然规范说 Map 迭代中 delete 安全，但某些旧引擎或特定实现中可能有问题），或者 `removeClient` 的副作用（channels Map 的修改）引发了连锁反应。

### 错误 3: channels Map 内存泄漏
**根因**: `removeClient` 只删除 channel Set 中的 client id，但 **不清理空的 channel Set**。当一个 channel 的所有 subscriber 都离开后，`this.channels` 中仍然保留一个空 Set，永远无法回收。

### 错误 4: 广播延迟 4.7s / 52000 订阅者
**根因**: 同步逐个 `ws.send()`，52000 次 JSON.stringify + send 串行执行阻塞事件循环。

---

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/broadcast-server-fixed.ts]

已经存在一个修复版本了。让我审查它是否完整解决了所有问题。

现有修复版本已经覆盖了 4 个 bug，但有几个问题需要修正：

1. **Fix1 不完整** — `broadcast()` 中 `removeClient` 会修改正在遍历的 `subscribers` Set（因为 `removeClient` 调用 `subs.delete(id)`），导致遍历中 Set 被修改，可能跳过元素或抛错。应该先 snapshot 再遍历。
2. **Fix2** 正确。
3. **Fix3** 正确。
4. **Fix4** 的 `broadcastAsync` 中同样存在遍历中修改 Set 的问题（虽然用了 `Array.from` snapshot，但 `removeClient` 删除了 clients Map 中的 entry，后续 chunk 中 get 到 undefined 会被可选链兜住，这部分 OK）。但同步 `broadcast()` 需要同样的 snapshot 处理。
5. **缺少 `unsubscribe` 方法** — 没有单独取消订阅的入口，这是功能缺失。

[MultiEdit: /Users/xin/auto-skills/CtriXin-repo/hive/broadcast-server-fixed.ts]

第三个 edit 把 getStats 方法也替换掉了。让我修复这个：

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/broadcast-server-fixed.ts]

[Edit: /Users/xin/auto-skills/CtriXin-repo/hive/broadcast-server-fixed.ts]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/broadcast-server-fixed.ts]

API Error: 400 {"error":{"type":"1234","message":"Network error, error id: 202603281324538e0a6dc2194740e3, please contact customer service (request id: 20260328052452152881935vdBgZodq)"},"type":"error"}