# Hive vNEXT 变更通知

> 版本: 2.1.0（预发布）
> 日期: 2026-04-04
> 状态: 实现完成，待合并

本文档汇总 Hive vNEXT 中所有破坏性变更、新增功能以及迁移指引。请在升级前完整阅读。

---

## 目录

1. [破坏性变更 (Breaking Changes)](#一破坏性变更-breaking-changes)
2. [新功能 (New Features)](#二新功能-new-features)
3. [迁移路径 (Migration Path)](#三迁移路径-migration-path)
4. [已知限制](#四已知限制)
5. [参考文档](#五参考文档)

---

## 一、破坏性变更 (Breaking Changes)

### 1.1 配置结构扩展：`tiers` 与 `collab` 成为必填兼容字段

Hive 配置从扁平模型升级至分层模型。虽然旧字段（`orchestrator`、`high_tier`、`review_tier`、`default_worker`、`fallback_worker`）仍被兼容保留，但以下新结构将成为推荐标准：

```json
{
  "tiers": {
    "translator": { "model": "..." },
    "planner": { "model": "..." },
    "discuss": { "model": "...", "mode": "auto" },
    "executor": { "model": "..." },
    "reviewer": {
      "cross_review": { "model": "..." },
      "arbitration": { "model": "..." },
      "final_review": { "model": "..." }
    },
    "reporter": { "model": "..." }
  },
  "collab": {
    "plan_discuss_transport": "local",
    "plan_discuss_timeout_ms": 15000,
    "plan_discuss_min_replies": 0,
    "worker_discuss_transport": "local",
    "worker_discuss_timeout_ms": 10000,
    "worker_discuss_min_replies": 0
  }
}
```

**影响：**
- 若你的自动化配置仅写入旧字段，运行时行为不变。
- 若要通过 AgentBus 启用协作讨论，必须显式声明 `collab.*_transport` 为 `"agentbus"`。
- 依赖 `config/*.json` 直接读取旧字段的外部脚本，建议同步读取 `tiers.*` 路径。

### 1.2 返回类型扩展：`PlanGoalResult` 与 `WorkerResult` 新增可选字段

以下类型新增了可选字段，若你的下游代码对返回 JSON 执行了严格模式验证（strict schema validation），可能需要放宽校验：

- `PlanGoalResult.plan_discuss_room?: PlannerDiscussRoomRef`
- `WorkerResult.worker_discuss_room?: WorkerDiscussRoomRef`
- `WorkerStatusEntry.collab?: CollabStatusSnapshot`
- `CompactPacketWorker.collab?: CollabCard`

**影响：**
- TypeScript 编译不会报错（字段为可选）。
- Python / Zod / JSON Schema 等强校验场景需更新 schema。

### 1.3 CLI / MCP 输出格式微调

当 `collab` 启用且使用 `agentbus` 时，`hive status`、`hive workers`、MCP planning/execution 卡片会额外输出 `room_id`、`status`、`replies`、`next` 等字段。若你的解析逻辑假设固定列数或严格正则匹配，需更新解析规则。

---

## 二、新功能 (New Features)

### 2.1 AgentBus 规划讨论 (`plan_discuss_transport = agentbus`)

Planner 在生成计划后，可选择通过 AgentBus 创建异步讨论房间，而非仅限本地同步讨论。

关键行为：
- 房间创建后发布精简版计划摘要（PlanningBrief）。
- 其他会话可异步回复。
- Hive 在超时或收到足够回复后自动汇总为 `PlanDiscussResult`。
- 零回复或适配器失败时自动回退至本地讨论（`fallback:local`）。
- 房间元数据持久化到运行产物中。

### 2.2 AgentBus 任务级讨论 (`worker_discuss_transport = agentbus`)

Worker 在执行任务时若触发不确定性讨论（`discuss_threshold` 触发），同样支持通过 AgentBus 路由。

关键行为：
- 以 `task_discuss` 房间类型发布 `WorkerDiscussBrief`。
- 生命周期与规划房间一致：`open` → `collecting` → `synthesizing` → `closed` / `fallback`。
- 汇总结果复用现有 `DiscussResult` 结构，保持 Worker 执行流不变。

### 2.3 协作状态可视化：`CollabCard` + `CollabLifecycleEvent`

引入宿主可见的协作卡片与生命周期事件：

```ts
interface CollabCard {
  room_id: string;
  room_kind: 'plan' | 'task_discuss';
  status: 'open' | 'collecting' | 'synthesizing' | 'closed' | 'fallback';
  replies: number;
  last_reply_at?: string;
  join_hint?: string;
  focus_task_id?: string;
  next: string;
}
```

覆盖场景：
- `hive status` / `hive watch` 显示当前活跃房间状态。
- `hive workers` 显示已完成任务的协作快照。
- compact / restore 输出携带聚焦 Worker 的 collab 信息。
- MCP 执行与调度卡片展示任务级协作行。

### 2.4 稳定的 Orchestrator 身份

AgentBus 房间生命周期（创建、收集、关闭）复用同一个 `orchestrator_id`，解决 Phase 1 中身份漂移问题，确保房间权限与消息归属一致。

### 2.5 预算与成本估算增强（已有类型扩展）

新增细粒度 token 与预算类型：
- `StageTokenUsage`、`TokenBreakdown`
- `BudgetStatus`、`RoundCostEntry`
- `OrchestratorResult` 新增 `token_breakdown`、`budget_status`、`budget_warning` 字段

为后续按阶段成本监控打下基础。

### 2.6 Translator 层级（Tier 0）正式纳入类型系统

`TranslationResult` 与 `TierConfig` 将 translator 作为独立层级纳入，支持翻译阶段的模型选择与 token 统计。

---

## 三、迁移路径 (Migration Path)

### 3.1 仅升级 Hive 核心，不启用 AgentBus（推荐第一步）

1. 更新代码/二进制到 vNEXT。
2. 确认 `collab` 配置块不存在或两个 transport 均为 `"local"`。
3. 运行现有测试与 smoke：
   ```bash
   npm run build
   npm run test:smoke
   ```
4. 验证 `local` 路径的规划讨论与 Worker 讨论行为与之前完全一致。

### 3.2 启用 Planner AgentBus 讨论

在 `.hive/config.json`（或你的配置源）中添加：

```json
{
  "collab": {
    "plan_discuss_transport": "agentbus",
    "plan_discuss_timeout_ms": 15000,
    "plan_discuss_min_replies": 0
  }
}
```

验证步骤：
1. 运行一次规划任务。
2. 检查输出中是否出现 `room_id` 与 `join_hint`。
3. 从另一个会话向该房间发送回复。
4. 确认 Hive 在超时后正确汇总并继续执行。

### 3.3 启用 Worker AgentBus 讨论

在同一份配置中补充：

```json
{
  "collab": {
    "plan_discuss_transport": "agentbus",
    "worker_discuss_transport": "agentbus",
    "worker_discuss_timeout_ms": 10000,
    "worker_discuss_min_replies": 0
  }
}
```

验证步骤：
1. 触发一次 Worker 不确定性讨论（可通过降低 `discuss_threshold` 实现）。
2. 检查 `.ai/run-artifacts/` 下是否记录 `task_discuss` 房间元数据。
3. 运行 `hive workers` 确认任务级 `CollabCard` 可见。
4. 运行 compact 流程，确认 restore prompt 提及房间信息。

### 3.4 外部集成脚本迁移检查清单

| 场景 | 动作 |
|------|------|
| 读取旧配置字段 | 保持兼容，同时准备读取 `tiers.*` 路径 |
| 解析 CLI / MCP 输出 | 允许额外出现 `room_id`、`replies`、`status`、`next` 列 |
| 对 PlanGoalResult / WorkerResult 做 JSON Schema 校验 | 在 schema 中增加可选字段 |
| 消费 compact packet | 增加对 `CompactPacketWorker.collab` 的处理分支（可为空） |

---

## 四、已知限制

- **AgentBus 为可选依赖**：若 AgentBus 服务不可达，`agentbus` transport 会自动回退到 `local`，不会中断运行，但协作功能降级。
- **暂不支持 review / repair / recovery 房间**：Phase 2.5 之后才会进入 review rooms 阶段。
- **Discord / agent-im 未直接集成**：当前仅通过 AgentBus 房间协议支持多会话协作，尚未打通 Discord 线程映射。
- **MindKeeper 运行时联动有限**：checkpoint 与 room link 的深层集成在后续阶段规划中。

---

## 五、参考文档

- `docs/HIVE_COLLAB_STACK.md` — 协作栈整体定位
- `docs/HIVE_COLLAB_PHASE1_EXECUTION.md` — Phase 1: Planner AgentBus 讨论
- `docs/HIVE_COLLAB_PHASE1_5_EXECUTION.md` — Phase 1.5: CollabCard / 生命周期事件
- `docs/HIVE_COLLAB_PHASE2_EXECUTION.md` — Phase 2: Worker AgentBus 讨论
- `docs/HIVE_COLLAB_PHASE2_5_EXECUTION.md` — Phase 2.5: 任务级协作持久化
- `rules/AGENT_RULES.md` — 多模型协作规范

---

如有迁移问题，请在升级前阅读上述执行计划文档，或先在隔离 worktree 中运行 `npm run test:smoke` 验证。
