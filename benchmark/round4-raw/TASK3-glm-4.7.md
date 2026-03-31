## 子任务拆分与模型分配方案

### 1. 子任务拆分

| ID | 描述 | 复杂度 | 预估文件 | 依赖 |
|----|------|--------|----------|------|
| T1 | 秒杀商品管理 API（CRUD + 库存预扣） | 高 | `api/seckill-product.ts`, `models/product.ts`, `services/inventory.ts` | - |
| T2 | 秒杀倒计时前端组件（服务端时间同步） | 中 | `components/Countdown.vue`, `api/time-sync.ts` | - |
| T3 | 高并发库存扣减服务（Redis + Lua） | 高 | `services/redis-seckill.ts`, `scripts/decrement-inventory.lua` | T1 |
| T4 | 秒杀订单异步处理队列 | 中 | `queues/order-queue.ts`, `workers/order-processor.ts` | T3 |
| T5 | 防刷策略（IP限流+频率+验证码） | 高 | `middleware/rate-limit.ts`, `services/captcha.ts`, `services/antibrush.ts` | T1 |
| T6 | 秒杀结果推送 | 中 | `services/websocket.ts`, `handlers/notification.ts` | T4 |
| T7 | 监控告警面板（指标埋点+Grafana配置） | 中 | `metrics/index.ts`, `config/grafana-dashboard.json` | T1, T3, T4, T5 |

### 2. 并行执行组

**Phase 1** (无依赖):
- T1: 秒杀商品管理 API
- T2: 秒杀倒计时前端组件

**Phase 2** (依赖 T1):
- T3: 高并发库存扣减服务
- T5: 防刷策略

**Phase 3** (依赖 T3):
- T4: 秒杀订单异步处理队列

**Phase 4** (依赖 T4):
- T6: 秒杀结果推送

**Phase 5** (等待 T1/T3/T4/T5):
- T7: 监控告警面板

### 3. 模型分配方案

| 任务 | 模型 | 理由 |
|------|------|------|
| T1 | kimi-for-coding | 核心业务逻辑，需要深度设计和一致性，容错低 |
| T2 | glm-5-turbo | 前端组件相对独立，速度快，翻译好利于文档 |
| T3 | kimi-k2.5 | Redis Lua 脚本要求稳定可靠，不容许硬伤 |
| T4 | qwen3.5-plus | 队列处理编码扎实，复杂度中等 |
| T5 | kimi-for-coding | 防刷逻辑复杂且安全敏感，需要深度分析 |
| T6 | glm-5-turbo | WebSocket 推送相对标准，速度快 |
| T7 | glm-5 | 指标埋点需要详尽注释，速度要求低 |

### 4. 关键风险和缓解措施

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Redis Lua 脚本超卖 | 高 | 使用 `WATCH` + Lua 原子操作，预扣库存异步回滚 |
| 高并发服务雪崩 | 高 | 熔断降级、令牌桶限流、排队缓冲 |
| 时间同步偏差 | 中 | 服务端 NTP 同步 + 客户端校正补偿算法 |
| WebSocket 连接风暴 | 中 | 连接数限制 + 消息压缩 + 心跳保活 |
| 队列消息堆积 | 中 | 死信队列 + 消费者动态扩缩容 + 监控告警 |

### 5. 预估总耗时

| 阶段 | 并行任务 | 耗时（最慢任务） |
|------|----------|------------------|
| Phase 1 | T1 (130s) + T2 (60s) | 130s |
| Phase 2 | T3 (100s) + T5 (130s) | 130s |
| Phase 3 | T4 (140s) | 140s |
| Phase 4 | T6 (60s) | 60s |
| Phase 5 | T7 (190s) | 190s |

**总预估耗时**: 650s (约 11 分钟)

**关键路径**: T1 → T5 → T7