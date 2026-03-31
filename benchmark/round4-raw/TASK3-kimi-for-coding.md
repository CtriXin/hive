[Read: /Users/xin/.sce/beliefs/SUMMARY.md]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/.ai/manifest.json]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/.ai/plan/current.md]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/rules/planning.md]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/rules/execution.md]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/rules/AGENT_RULES.md]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/package.json]

现在我已经了解了项目架构。让我为"限时秒杀"功能制定完整的任务分解和模型分配方案。

---

## 限时秒杀功能 - 任务分解与模型分配方案

### 1. 子任务拆分

| ID | 任务描述 | 复杂度 | 预估文件 | 依赖关系 |
|:---:|---------|:------:|---------|---------|
| T1 | 秒杀商品管理 API（CRUD + 库存预扣）| high | `src/flash-sale/product-api.ts`, `src/flash-sale/types.ts` | - |
| T2 | 秒杀倒计时前端组件（服务端时间同步）| medium | `src/flash-sale/countdown.tsx`, `src/flash-sale/time-sync.ts` | - |
| T3 | 高并发库存扣减服务（Redis + Lua）| high | `src/flash-sale/inventory-service.ts`, `scripts/stock-deduct.lua` | - |
| T4 | 秒杀订单异步处理队列（RabbitMQ/Kafka）| high | `src/flash-sale/order-queue.ts`, `src/flash-sale/order-worker.ts` | T1 |
| T5 | 防刷策略（IP限流 + 频率控制 + 验证码）| medium-high | `src/flash-sale/anti-fraud.ts`, `src/flash-sale/rate-limiter.ts` | - |
| T6 | 秒杀结果推送（WebSocket 实时通知）| medium | `src/flash-sale/websocket-notifier.ts` | T4 |
| T7 | 监控告警面板（Grafana + Prometheus）| medium | `src/flash-sale/metrics.ts`, `grafana/dashboard.json` | T1, T3, T4 |

### 2. 并行执行组

```
Group A (无依赖，可并行):
├── T1: 商品管理 API
├── T2: 倒计时组件
├── T3: 库存扣减服务
└── T5: 防刷策略

Group B (依赖 Group A):
├── T4: 订单队列 (依赖 T1)
└── T6: WebSocket 通知 (依赖 T4)

Group C (依赖 Group A + B):
└── T7: 监控面板 (依赖 T1, T3, T4)
```

### 3. 模型分配方案

| 任务 | 分配模型 | 理由 |
|-----|---------|------|
| T1 | **kimi-for-coding** | 高复杂度 CRUD + 业务逻辑，需要深度分析能力确保数据一致性 |
| T2 | **qwen3-coder-plus** | 前端组件相对独立，速度最快，可快速交付 |
| T3 | **kimi-for-coding** | 高并发 + Lua 脚本，需要最强编码能力保证正确性 |
| T4 | **kimi-k2.5** | 消息队列处理，需要稳定可靠，无硬伤 |
| T5 | **MiniMax-M2.5** | 中等复杂度，速度较快，限流算法实现质量中上足够 |
| T6 | **glm-5-turbo** | WebSocket 实现，速度快，均衡稳定 |
| T7 | **glm-5** | 需要详尽输出监控指标和 Grafana 配置，内容详尽型模型适合 |

### 4. 关键风险和缓解措施

| 风险 | 影响 | 缓解措施 |
|-----|------|---------|
| **T3 Lua 脚本原子性** | 超卖/库存不一致 | 使用 Redis EVALSHA + 预编译脚本；单元测试覆盖并发场景 |
| **T4 消息丢失** | 订单丢失 | 实现幂等消费 + 死信队列 + 消息确认机制 |
| **T3+T4 依赖冲突** | 集成失败 | Group A 完成后先进行接口契约 Review |
| **WebSocket 连接风暴** | 服务雪崩 | T6 实现连接限流 + 心跳保活 + 优雅降级 |
| **时序依赖** | T4/T6/T7 阻塞 | 明确定义接口契约，允许 Mock 数据并行开发 |

### 5. 预估总耗时

**执行策略**: 分 3 个波次并行执行

```
波次 1 (Group A, 全部并行):
├── T1 (kimi-for-coding):    ~130s
├── T2 (qwen3-coder-plus):   ~40s   ← 关键路径
├── T3 (kimi-for-coding):    ~130s  ← 关键路径
└── T5 (MiniMax-M2.5):       ~60s

波次 1 完成时间: max(130, 40, 130, 60) = 130s

波次 2 (Group B, 依赖 Group A):
├── T4 (kimi-k2.5):          ~100s  ← 关键路径
└── T6 等待 T4 完成后执行

波次 3 (Group C):
└── T7 (glm-5):              ~190s  ← 关键路径
```

**总预估耗时**: 130s + 100s + 190s = **~420s (7分钟)**

**优化方案**: 若 T1/T3 使用不同模型并行，可压缩至 ~360s

---

### 执行计划 JSON

```json
{
  "plan_id": "flash-sale-001",
  "tasks": [
    {"id": "T1", "desc": "秒杀商品管理 API", "model": "kimi-for-coding", "complexity": "high", "files": ["src/flash-sale/product-api.ts", "src/flash-sale/types.ts"]},
    {"id": "T2", "desc": "秒杀倒计时组件", "model": "qwen3-coder-plus", "complexity": "medium", "files": ["src/flash-sale/countdown.tsx", "src/flash-sale/time-sync.ts"]},
    {"id": "T3", "desc": "高并发库存扣减", "model": "kimi-for-coding", "complexity": "high", "files": ["src/flash-sale/inventory-service.ts", "scripts/stock-deduct.lua"]},
    {"id": "T4", "desc": "订单异步队列", "model": "kimi-k2.5", "complexity": "high", "files": ["src/flash-sale/order-queue.ts", "src/flash-sale/order-worker.ts"], "depends_on": ["T1"]},
    {"id": "T5", "desc": "防刷策略", "model": "MiniMax-M2.5", "complexity": "medium-high", "files": ["src/flash-sale/anti-fraud.ts", "src/flash-sale/rate-limiter.ts"]},
    {"id": "T6", "desc": "WebSocket 推送", "model": "glm-5-turbo", "complexity": "medium", "files": ["src/flash-sale/websocket-notifier.ts"], "depends_on": ["T4"]},
    {"id": "T7", "desc": "监控告警面板", "model": "glm-5", "complexity": "medium", "files": ["src/flash-sale/metrics.ts", "grafana/dashboard.json"], "depends_on": ["T1", "T3", "T4"]}
  ],
  "parallel_groups": [
    ["T1", "T2", "T3", "T5"],
    ["T4"],
    ["T6"],
    ["T7"]
  ],
  "estimated_duration_sec": 420,
  "critical_path": ["T1/T3", "T4", "T7"]
}
```