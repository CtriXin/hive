我来为你规划这个"限时秒杀"功能模块的任务拆分和执行方案。

[mcp__hive__plan_tasks]

plan_tasks 返回了 `plan: null`，没有生成任务计划。让我直接基于需求分析来给出完整的任务拆分方案：

---

## 1. 子任务拆分

| ID | 描述 | 复杂度 | 预估文件 | 依赖 |
|---|---|---|---|---|
| T1 | 秒杀商品数据模型 + CRUD API | medium | `models/FlashSale.ts`, `api/flash-sale.controller.ts` | - |
| T2 | 库存预扣/回滚服务（事务） | high | `services/inventory.service.ts` | T1 |
| T3 | Redis + Lua 防超卖脚本 | high | `lua/inventory.lua`, `services/redis-inventory.ts` | T1 |
| T4 | 秒杀倒计时前端组件 | medium | `components/Countdown.tsx`, `hooks/useServerTime.ts` | - |
| T5 | 服务端时间同步 API | low | `api/time-sync.controller.ts` | - |
| T6 | 订单异步处理队列 | medium-high | `queues/order.processor.ts`, `queues/order.producer.ts` | T3 |
| T7 | 防刷中间件（IP限流+频率控制） | medium | `middleware/rate-limiter.ts`, `middleware/user-throttle.ts` | - |
| T8 | 验证码服务集成 | medium | `services/captcha.service.ts` | - |
| T9 | WebSocket 推送服务 | medium | `ws/flash-sale.gateway.ts` | T3 |
| T10 | Prometheus 指标埋点 | low | `metrics/flash-sale.metrics.ts` | - |
| T11 | Grafana Dashboard 配置 | low | `grafana/flash-sale-dashboard.json` | T10 |

---

## 2. 并行执行组

```
【Phase 1 - 完全并行】
T1  T4  T5  T7  T8  T10
 ↓    ↘
【Phase 2 - 核心依赖】
T2 ←── T1
T3 ←── T1
【Phase 3 - 业务链路】
T6 ←── T3
T9 ←── T3
【Phase 4 - 收尾】
T11 ←── T10
```

**并行组划分**：
- **Group A（6 并行）**: T1, T4, T5, T7, T8, T10
- **Group B（2 并行）**: T2, T3（依赖 T1）
- **Group C（2 并行）**: T6, T9（依赖 T3）
- **Group D（1 任务）**: T11（依赖 T10）

---

## 3. 模型分配方案

| 任务 | 模型 | 理由 |
|---|---|---|
| **T1 数据模型** | kimi-for-coding | 需要考虑库存预扣的事务语义，深度分析 |
| **T2 库存预扣** | kimi-for-coding | 高复杂度，涉及并发事务、幂等性，核心逻辑 |
| **T3 Lua防超卖** | kimi-for-coding | 关键算法，需正确处理原子性和边界条件 |
| **T4 倒计时组件** | qwen3.5-plus | 前端组件，编码扎实即可 |
| **T5 时间同步API** | glm-5-turbo | 简单 API，速度快 |
| **T6 订单队列** | kimi-k2.5 | 消息队列配置需稳定可靠 |
| **T7 防刷中间件** | qwen3.5-plus | 编码任务，逻辑清晰 |
| **T8 验证码服务** | MiniMax-M2.5 | 集成第三方，速度快质量够 |
| **T9 WebSocket** | qwen3.5-plus | 编码扎实 |
| **T10 指标埋点** | glm-5-turbo | 简单，速度快 |
| **T11 Grafana配置** | glm-5-turbo | JSON 配置，简单 |

---

## 4. 关键风险和缓解措施

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| **超卖问题** | 严重业务事故 | T3 Lua 脚本保证原子性 + 库存预热 + 压测验证 |
| **时间同步精度** | 倒计时不准 | T5 NTP + 多次采样取偏差中值 + 前端补偿 |
| **消息队列积压** | 订单处理延迟 | T6 死信队列 + 监控告警 + 水平扩展消费者 |
| **Redis 单点故障** | 库存不可用 | Redis Sentinel/Cluster + 本地缓存降级 |
| **防刷绕过** | 黄牛抢购 | 多层防护：IP + 用户 + 验证码 + 行为分析 |
| **WebSocket 连接风暴** | 服务端压力 | 连接限流 + 心跳优化 + 降级轮询 |

---

## 5. 预估总耗时

**Group A（6 并行）**：
```
max(130, 140, 60, 140, 60, 60) = 140s (qwen3.5-plus 最慢)
```

**Group B（2 并行）**：
```
max(130, 130) = 130s
```

**Group C（2 并行）**：
```
max(100, 140) = 140s
```

**Group D（1 任务）**：
```
60s
```

**总计**：`140 + 130 + 140 + 60 = 470s` ≈ **8 分钟**

> 对比串行执行（约 1300s ≈ 22 分钟），并行化节省 **65%** 时间。

---

## 执行建议

1. **先启动 Group A 全部 6 任务**
2. T1 完成后立即启动 T2 + T3
3. T3 完成后启动 T6 + T9
4. T10 完成后启动 T11
5. **关键路径**: T1 → T3 → T6/T9（需优先保障）