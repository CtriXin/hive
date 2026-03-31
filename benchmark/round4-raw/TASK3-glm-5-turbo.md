我先阅读项目规则和背景，然后输出任务拆分方案。

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/.ai/manifest.json]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/.ai/plan/current.md]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/rules/AGENT_RULES.md]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/rules/planning.md]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/rules/handoff.md]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/rules/execution.md]

以下是任务拆分与模型分配方案：

---

## 1. 子任务拆分

| ID | 描述 | 复杂度 | 预估文件 | 依赖 |
|----|------|--------|---------|------|
| T1 | 秒杀商品管理 API（CRUD + 库存预扣） | medium | `src/seckill/product.controller.ts`, `src/seckill/product.service.ts`, `src/seckill/product.model.ts` | 无 |
| T2 | 高并发库存扣减服务（Redis + Lua 脚本防超卖） | **high** | `src/seckill/stock.service.ts`, `src/seckill/lua/deduct-stock.lua`, `src/seckill/redis-client.ts` | T1（需要库存数据模型） |
| T3 | 秒杀倒计时前端组件（毫秒级服务端时间同步） | medium-high | `src/components/CountdownTimer.tsx`, `src/hooks/useServerTime.ts` | T1（需要活动时间数据接口） |
| T4 | 秒杀订单异步处理队列 | medium | `src/seckill/order-queue/producer.ts`, `src/seckill/order-queue/consumer.ts`, `src/seckill/order-queue/handler.ts` | T2（库存扣减成功后才入队） |
| T5 | 防刷策略（IP 限流 + 用户频率 + 验证码） | medium-high | `src/seckill/rate-limiter.ts`, `src/seckill/anti-fraud/captcha.ts`, `src/seckill/middleware/rate-limit.middleware.ts` | 无 |
| T6 | 秒杀结果推送（WebSocket 实时通知） | medium | `src/seckill/websocket/gateway.ts`, `src/seckill/websocket/handler.ts` | T4（订单处理完成后触发推送） |
| T7 | 监控告警面板（Prometheus 指标埋点） | low | `src/seckill/metrics/index.ts`, `src/seckill/metrics/collectors.ts` | T1, T2, T4（埋点分散在多个服务中） |

---

## 2. 并行执行组

```
Wave 1 (并行): T1, T3, T5
Wave 2 (并行): T2, T7
Wave 3 (并行): T4
Wave 4 (并行): T6
```

**依赖图：**
```
T1 ──→ T2 ──→ T4 ──→ T6
T1 ──→ T3 (并行于T2)
T5 (独立, Wave1并行)
T1,T2,T4 ──→ T7 (可分步埋点)
```

优化后（T7 可分阶段埋点，不阻塞主链路）：
```
Wave 1: T1 + T3 + T5        (并行，无依赖)
Wave 2: T2 + T7(basic)      (T2 依赖 T1，T7 基础埋点依赖 T1)
Wave 3: T4 + T7(stock)      (T4 依赖 T2，T7 库存埋点)
Wave 4: T6 + T7(final)      (T6 依赖 T4)
```

---

## 3. 模型分配方案

| 任务 | 分配模型 | 理由 |
|------|---------|------|
| **T1** 商品 API | `qwen3-coder-plus` | CRUD + 库存预扣是标准模式，复杂度 medium，用最快模型（~40s）性价比最高 |
| **T2** 库存扣减 | `kimi-for-coding` | **唯一 high 复杂度任务**：Redis Lua 脚本原子性、分布式锁、超卖边界条件需要深度分析能力，综合最强模型值得投入 |
| **T3** 倒计时组件 | `MiniMax-M2.5` | medium-high，React hooks + WebSocket 时间同步是成熟模式，M2.5 速度快（~60s）质量中上足够 |
| **T4** 消息队列 | `kimi-k2.5` | medium，队列 producer/consumer 模式需要稳定可靠实现，k2.5 无硬伤适合 |
| **T5** 防刷策略 | `kimi-for-coding` | medium-high，安全相关涉及限流算法（令牌桶/滑动窗口）+ 验证码集成，深度分析防绕过漏洞需要强模型 |
| **T6** WebSocket 推送 | `glm-5-turbo` | medium，WebSocket gateway + 事件分发是标准模式，glm-5-turbo 速度快（~60s）且均衡稳定 |
| **T7** 监控埋点 | `qwen3-coder-plus` | low，Prometheus client 埋点是样板代码，最快模型即可 |

---

## 4. 关键风险与缓解

| 风险 | 级别 | 缓解措施 |
|------|------|---------|
| **T2 Redis Lua 并发边界条件** | 🔴 高 | kimi-for-coding 主力 + review cascade（cross-review → Sonnet），Lua 脚本单独写单元测试压测 |
| **T2/T4 库存与订单一致性** | 🔴 高 | T2 完成后 T4 才启动；库存扣减用 Redis 原子操作保证，订单最终一致性用消息队列 + 补偿机制 |
| **T5 防刷被绕过** | 🟡 中 | 限流 + 验证码双重防护，安全相关任务用 kimi-for-coding 深度分析，review 阶段重点检查绕过场景 |
| **T3 时钟漂移** | 🟡 中 | 用服务端 NTP 时间 + 客户端 RTT 校正，不能信任客户端本地时间 |
| **跨 worker 文件冲突** | 🟡 中 | 各任务文件路径已隔离，T7 埋点分散需确认注入点不与 T1/T2/T4 冲突 |
| **模型编码质量波动** | 🟢 低 | 避免 qwen3-max（编码波动大）和 MiniMax-M2.7（最慢+推理可能出错）；所有任务经过 review cascade |

---

## 5. 预估总耗时

| Wave | 任务 | 模型 | 模型耗时 | Wave 耗时 |
|------|------|------|---------|----------|
| 1 | T1 + T3 + T5 | qwen3-coder-plus / MiniMax-M2.5 / kimi-for-coding | 40s + 60s + 130s | **130s** |
| 2 | T2 + T7(basic) | kimi-for-coding / qwen3-coder-plus | 130s + 40s | **130s** |
| 3 | T4 + T7(stock) | kimi-k2.5 | 100s + (合并进T4) | **100s** |
| 4 | T6 + T7(final) | glm-5-turbo | 60s + (合并进T6) | **60s** |

| 指标 | 值 |
|------|-----|
| **纯执行耗时（串行）** | ~560s |
| **并行执行耗时** | **~420s（~7 分钟）** |
| **加 Review Cascade** | +200-300s（预计 4 阶段 review，取最长） |
| **端到端预估** | **~10-12 分钟** |