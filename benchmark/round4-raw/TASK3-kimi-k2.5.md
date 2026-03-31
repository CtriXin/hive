[Read: /Users/xin/auto-skills/CtriXin-repo/hive/.ai/manifest.json]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/.ai/plan/current.md]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/rules/AGENT_RULES.md]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/rules/planning.md]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/rules/execution.md]

基于 Hive 架构规则和秒杀系统需求，以下是我的任务规划：

---

## 1. 子任务拆分

| id | 描述 | 复杂度 | 预估文件 | 依赖关系 |
|---|---|---|---|---|
| T1 | 秒杀商品管理 API（CRUD + 库存预扣） | medium-high | `src/seckill/product-api.ts`, `src/seckill/types.ts` | 无 |
| T2 | 秒杀倒计时前端组件（服务端时间同步） | medium | `src/components/SeckillCountdown.tsx`, `src/hooks/useServerTime.ts` | 无 |
| T3 | 高并发库存扣减服务（Redis + Lua） | high | `src/seckill/inventory-service.ts`, `src/seckill/scripts/deduct.lua` | 无 |
| T4 | 秒杀订单异步处理队列（RabbitMQ/Kafka） | medium-high | `src/seckill/order-queue.ts`, `src/seckill/order-consumer.ts` | T1 |
| T5 | 防刷策略（IP限流 + 用户频率 + 验证码） | high | `src/seckill/rate-limiter.ts`, `src/seckill/captcha-service.ts` | 无 |
| T6 | 秒杀结果推送（WebSocket 实时通知） | medium | `src/seckill/websocket-notifier.ts` | T4 |
| T7 | 监控告警面板（Prometheus 指标埋点） | medium | `src/seckill/metrics.ts`, `grafana/dashboard.json` | T3, T4 |

---

## 2. 并行执行组

```
Group A (可并行): T1, T2, T3, T5
Group B (依赖 T1): T4
Group C (依赖 T4): T6
Group D (依赖 T3, T4): T7
```

**并行路径:**
- 路径1: T1 → T4 → T6
- 路径2: T3 → T7
- 路径3: T2 (独立)
- 路径4: T5 (独立)

---

## 3. 模型分配方案

| 任务 | 模型 | 理由 |
|---|---|---|
| T1 | **kimi-for-coding** | CRUD 逻辑复杂，需要深度分析能力处理库存预扣的边界情况 |
| T2 | **qwen3-coder-plus** | 前端组件相对独立，追求速度，深度要求不高 |
| T3 | **kimi-for-coding** | Redis + Lua 防超卖是核心难点，需要最强模型确保正确性 |
| T4 | **kimi-k2.5** | 消息队列处理需要稳定可靠，无硬伤 |
| T5 | **kimi-for-coding** | 防刷策略涉及安全，需要深度分析多种攻击场景 |
| T6 | **MiniMax-M2.5** | WebSocket 逻辑中等，速度较快 |
| T7 | **glm-5-turbo** | 监控埋点相对标准，速度快 |

---

## 4. 关键风险和缓解措施

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| **Redis Lua 脚本并发安全** | 超卖/数据不一致 | T3 由最强模型处理 + 单元测试覆盖边界场景 |
| **库存预扣与订单不一致** | 资损 | T1 和 T4 设计幂等机制，T7 监控埋点告警 |
| **WebSocket 连接泄漏** | 内存溢出 | T6 实现心跳检测 + 连接池管理 |
| **限流误杀正常用户** | 用户体验差 | T5 分级限流策略 + 白名单机制 |
| **时间同步精度** | 倒计时不同步 | T2 使用 NTP 校准 + 服务端推送 |

---

## 5. 预估总耗时

**关键路径分析:**
- T1 (130s) → T4 (100s) → T6 (60s) = **290s**
- T3 (130s) → T7 (60s) = **190s** (并行)
- T2 (40s), T5 (130s) (并行)

**总耗时: ~290秒 (约 5 分钟)**

---

## 执行计划 JSON

```json
{
  "tasks": [
    {"id": "T1", "description": "Seckill product management API with CRUD and inventory pre-deduction", "assigned_model": "kimi-for-coding", "complexity": "medium-high", "files": ["src/seckill/product-api.ts", "src/seckill/types.ts"], "dependencies": []},
    {"id": "T2", "description": "Seckill countdown component with server time sync", "assigned_model": "qwen3-coder-plus", "complexity": "medium", "files": ["src/components/SeckillCountdown.tsx", "src/hooks/useServerTime.ts"], "dependencies": []},
    {"id": "T3", "description": "High-concurrency inventory deduction service (Redis + Lua)", "assigned_model": "kimi-for-coding", "complexity": "high", "files": ["src/seckill/inventory-service.ts", "src/seckill/scripts/deduct.lua"], "dependencies": []},
    {"id": "T4", "description": "Async order processing queue (RabbitMQ/Kafka)", "assigned_model": "kimi-k2.5", "complexity": "medium-high", "files": ["src/seckill/order-queue.ts", "src/seckill/order-consumer.ts"], "dependencies": ["T1"]},
    {"id": "T5", "description": "Anti-spam strategy (IP rate limiting + user frequency + captcha)", "assigned_model": "kimi-for-coding", "complexity": "high", "files": ["src/seckill/rate-limiter.ts", "src/seckill/captcha-service.ts"], "dependencies": []},
    {"id": "T6", "description": "Seckill result push via WebSocket", "assigned_model": "MiniMax-M2.5", "complexity": "medium", "files": ["src/seckill/websocket-notifier.ts"], "dependencies": ["T4"]},
    {"id": "T7", "description": "Monitoring dashboard with Prometheus metrics", "assigned_model": "glm-5-turbo", "complexity": "medium", "files": ["src/seckill/metrics.ts", "grafana/dashboard.json"], "dependencies": ["T3", "T4"]}
  ],
  "parallel_groups": [
    ["T1", "T2", "T3", "T5"],
    ["T4"],
    ["T6"],
    ["T7"]
  ],
  "estimated_duration": 290,
  "critical_path": ["T1", "T4", "T6"]
}
```