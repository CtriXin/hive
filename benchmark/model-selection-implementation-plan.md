# Model Selection Implementation Plan

本文档定义 Hive 项目的第一版“能力画像 + benchmark + worker 选择”机制。

目标：
- 不再只靠单一总分分配 model
- 把 benchmark 结果沉淀为可复用的动态画像
- 在不引入不可控 runtime 自主行为的前提下，让 Claude 在 planning 阶段做更好的 worker 分配
- 后续支持不同 benchmark 类型扩展，不被一次任务结果绑死

## 1. 核心结论

### 1.1 Claude 的角色

Claude 适合做：
- planner
- selector advisor
- ranked assignment reviewer

Claude 不适合直接做：
- runtime 自主 spawn 决策器

实际控制链路应保持为：

`User Goal -> Planner -> Ranked Recommendations -> Claude confirms assigned_model -> Dispatcher executes`

也就是说：
- Claude 在 `plan` 阶段做“谁更适合”的判断
- Orchestrator/dispatcher 负责真正 spawn worker
- 这样更可审计、更安全，也更符合当前 Hive 架构

### 1.2 当前阶段的最优平衡

当前最优方案不是：
- 只保留一个总分
- 或者一次性发明 15+ 个 domain score

当前最优方案是：

1. 保留静态能力配置
2. 新增动态画像配置
3. 引入任务指纹
4. 先做 hard filters，再做 weighted ranking
5. 使用 `samples + confidence + time decay`
6. Phase 1 只启用 benchmark 能直接观测到的维度

## 2. 配置分层

### 2.1 不替代 `model-capabilities.json`

不要直接用 `model-profiles.json` 替代 `config/model-capabilities.json`。

应该分成两层：

#### A. 静态层：`config/model-capabilities.json`

保留现有职责：
- provider
- display_name
- context_window
- 成本
- max_complexity
- sweet_spot / avoid
- 其它先验能力

这是“先验事实层”。

#### B. 动态层：`config/model-profiles.json`

新增职责：
- benchmark 观测值
- samples
- confidence
- time decay
- reliability
- 动态推荐标签

这是“运行画像层”。

### 2.2 新增文件

第一版建议新增：

```text
config/model-profiles.json
config/benchmark-policy.json
orchestrator/profiler.ts
orchestrator/task-fingerprint.ts
```

## 3. 数据模型

### 3.1 `config/model-profiles.json`

建议结构：

```json
{
  "schema_version": "1.0",
  "profiles": {
    "glm5-turbo": {
      "scores": {
        "implementation": { "value": 0.80, "samples": 2, "last_updated": "2026-03-24" },
        "review":         { "value": 0.50, "samples": 0, "last_updated": null },
        "repair":         { "value": 0.65, "samples": 2, "last_updated": "2026-03-24" },
        "integration":    { "value": 0.53, "samples": 2, "last_updated": "2026-03-24" },
        "spec_adherence": { "value": 0.80, "samples": 2, "last_updated": "2026-03-24" },
        "scope_discipline": { "value": 0.95, "samples": 2, "last_updated": "2026-03-24" },
        "turnaround_speed": { "value": 0.65, "samples": 2, "last_updated": "2026-03-24" }
      },
      "domain_tags": ["typescript", "infrastructure", "adapters", "registries"],
      "avoid_tags": ["coordination-heavy"]
    }
  }
}
```

说明：
- `provider` / `display_name` / `context_window` / 成本 — 全部在静态层 `model-capabilities.json`，不重复存
- `scores.*.value` 使用 `0.0-1.0`；`samples=0` 时 value 保持默认 `0.5`（中性，不参与排名）
- `samples` 用于 confidence 计算；`last_updated` 用于时间衰减
- `domain_tags` 是 Phase 1 的软标签；`avoid_tags` 是动态 hard filter 输入
- `avoid_tags`（动态，benchmark 发现）与静态层 `avoid`（先验禁忌）在 `profiler.ts` 做 union merge

### 3.2 domain score 升级位

Phase 1 不在 JSON 里写空 `domains` 结构（噪音）。用 `schema_version` 管理升级：

- Phase 1：`schema_version: "1.0"`，用 `domain_tags` 软标签
- Phase 2：有专项 benchmark 数据后，bump 到 `"2.0"`，加 `domains` 字段

届时 `profiler.ts` 的 `loadProfiles()` 按 `schema_version` 做兼容读取。

### 3.3 `config/benchmark-policy.json`

建议结构：

```json
{
  "schema_version": "1.0",
  "min_samples_for_confidence": 3,
  "half_life_days": 30,
  "default_score": 0.5,
  "hard_filters": {
    "strict_boundary_min_scope_discipline": 0.4,
    "integration_min_confidence": 0.5
  },
  "base_weights": {
    "implementation":   1.0,
    "review":           1.0,
    "repair":           1.0,
    "integration":      1.0,
    "spec_adherence":   1.0,
    "scope_discipline": 1.0,
    "turnaround_speed": 0.8
  },
  "role_boost": 2.0,
  "strict_boundary_boost": 1.5,
  "fast_turnaround_boost": 1.0
}
```

说明：运行时权重计算：
```
weight[dim] = base_weights[dim]
            + (dim == fingerprint.role ? role_boost : 0)
            + (needs_strict_boundary && dim == "scope_discipline" ? strict_boundary_boost : 0)
            + (needs_fast_turnaround && dim == "turnaround_speed" ? fast_turnaround_boost : 0)
```

这样 policy 文件不与 fingerprint 逻辑打架，权重动态生效。

## 4. 任务指纹

### 4.1 新增 `TaskFingerprint`

建议在 `orchestrator/task-fingerprint.ts` 定义：

```ts
export interface TaskFingerprint {
  role: 'planning' | 'implementation' | 'review' | 'repair' | 'integration';
  domains: string[];
  complexity: 'low' | 'medium' | 'medium-high' | 'high';
  needs_strict_boundary: boolean;   // true → scope_discipline weight 加 boost
  needs_fast_turnaround: boolean;   // true → turnaround_speed weight 加 boost
  is_repair_round: boolean;         // true → role 强制为 'repair'
}
```

移除字段说明：
- `collaboration_risk` 与 `needs_strict_boundary` 高度重叠，合并后更简洁
- `runtime_dependency` 在选择逻辑里没有对应权重或 filter，Phase 1 不需要

### 4.2 指纹来源

Phase 1 不要求复杂 ML 推断，使用规则即可：

- `category` 映射到 `domains`
- 是否第二轮修复任务 → `is_repair_round = true`，同时强制 `role = 'repair'`
- 任务触及 shared contract / config / dispatcher / cross-module wiring → `needs_strict_boundary = true`
- `depends_on.length > 1` 或跨多个模块 → `needs_strict_boundary = true`（替代原 collaboration_risk）

### 4.3 规则示例

- `category=config` -> `domains=["config_ops"]`
- `category=tests` -> `domains=["tests"]`
- 涉及 `orchestrator/dispatcher.ts` / `provider-resolver.ts` / `mcp-server/index.ts`
  -> `domains=["typescript","integration"]`
- `depends_on.length > 1` 或跨多个模块
  -> `needs_strict_boundary = true`

## 5. 选择逻辑

### 5.1 先 hard filters

不要直接算分。先过滤：

1. API key / provider 不可用 -> 不候选
2. `avoid_tags` 命中任务高风险特征 -> 降为 fallback 或直接过滤
3. `needs_strict_boundary=true` 且 `scope_discipline < threshold` -> 不候选
4. `role=integration` 且 confidence 太低 -> 不允许排第一

### 5.2 再 weighted ranking

建议用一个函数：

```ts
rankModelsForTask(fingerprint, capabilities, profiles): RankedAssignment[]
```

输出不是单个 model，而是 ranked list：

```ts
interface RankedAssignment {
  model: string;
  final_score: number;
  confidence: number;
  domain_bonus: number;
  reasons: string[];
  blocked_by?: string[];
}
```

### 5.3 推荐公式

建议使用：

```text
weighted_score = Σ(weight[dim] × score[dim].value) / Σ(weight[dim])
confidence_factor = min(1.0, sqrt(avg_samples / MIN_SAMPLES))
domain_bonus = overlap(domain_tags, fingerprint.domains) * 0.05
final_score = weighted_score * confidence_factor + domain_bonus
```

说明：
- `role` 对应的 score 维度自动获得 `role_boost`（在 benchmark-policy.json 配置）
- `needs_strict_boundary = true` 时，`scope_discipline` 权重额外加 `strict_boundary_boost`
- `needs_fast_turnaround = true` 时，`turnaround_speed` 权重额外加 `fast_turnaround_boost`

### 5.4 时间衰减

对 `value` 做轻量衰减：

```text
effective_value = 0.5 + (raw_value - 0.5) * decay_factor
```

其中：

```text
decay_factor = 0.5 ^ (days_since_update / half_life_days)
```

这样太旧的分数会逐渐回归中性值 `0.5`。

## 6. Benchmark 到 Profile 的映射

### 6.1 Phase 1 允许映射的维度

当前 benchmark 能稳定映射：

- `implementation` <- `code_control + delivery_completeness`
- `repair` <- `repair_ability`
- `integration` <- `integration_readiness`
- `spec_adherence` <- `spec_comprehension`
- `scope_discipline` <- `scope_discipline`
- `turnaround_speed` <- `turnaround_speed`

建议新增人工观察映射：

- `handoff_truthfulness`
- `shared_contract_discipline`

### 6.2 暂不启用的维度

当前 benchmark 不能稳定支撑：

- `planning`
- 真正的 `frontend/backend/python` 分值
- `review` 的完整量化

这些保持默认中性值 `0.5`，等新 benchmark pack 再更新。

## 7. 与现有 Orchestrator 的集成点

### 7.1 `orchestrator/profiler.ts`

职责：
- 读取 `model-profiles.json`
- 读取 `benchmark-policy.json`
- 计算 confidence / decay
- 把 benchmark session 写回 profile

建议导出：

```ts
loadProfiles()
saveProfiles()
applyBenchmarkSession()
getEffectiveScore()
```

### 7.2 `orchestrator/task-fingerprint.ts`

职责：
- 从 `SubTask` 生成 `TaskFingerprint`

建议导出：

```ts
buildTaskFingerprint(task: SubTask): TaskFingerprint
```

### 7.3 `orchestrator/model-registry.ts`

新增：

```ts
rankModelsForTask(fingerprint: TaskFingerprint): RankedAssignment[]
assignModel(task: SubTask): string
```

其中：
- `assignModel()` 可继续返回单个结果，兼容现有调用
- `rankModelsForTask()` 供 planner / MCP / CLI 输出审计信息

## 8. 初始阶段 Claude review 要重点看的问题

这部分是给 Claude review 时直接用的 checklist。

### 8.1 结构层

1. 是否把 `model-capabilities.json` 和 `model-profiles.json` 混成一个文件
2. 是否错误地让 Claude 在 runtime 自主 spawn worker
3. 是否没有 hard filters，导致低可靠模型仍可能排第一

### 8.2 数据层

1. 是否凭空发明了当前 benchmark 没有数据支撑的细分 domain 分数
2. 是否没有 `samples`
3. 是否没有 `last_updated`
4. 是否没有时间衰减

### 8.3 调度层

1. 是否只输出 top-1，没有 ranked list 和解释
2. 是否没有 confidence
3. 是否没有保留 override 的空间

### 8.4 可靠性层

1. 是否忽略 `scope_discipline`（Phase 1 最重要的可靠性维度）
2. `needs_strict_boundary` 任务是否有对应的 hard filter 和 weight boost

## 9. MVP 范围

第一版只做这些：

1. 新增 `config/model-profiles.json`
2. 新增 `config/benchmark-policy.json`
3. 新增 `orchestrator/profiler.ts`
4. 新增 `orchestrator/task-fingerprint.ts`
5. `model-registry.ts` 融合静态能力和动态画像
6. 输出 ranked model recommendation
7. 暂时只“推荐”，不自动改 preset

不做这些：

1. 不做自动 runtime spawn 决策
2. 不做自动 apply preset
3. 不做 domain_scores 的强制启用
4. 不做多 benchmark pack 自动汇总

## 10. Phase 2 方向

等后续有更多 benchmark pack 再做：

1. frontend/backend/python 专项 benchmark
2. review-only benchmark
3. debug/repair benchmark
4. trend / drift 分析
5. auto-apply preset（需人工确认开关）

## 11. 给 Claude 的 review 提示

可以直接把下面这段发给 Claude：

```text
请 review 这份实现计划是否适合作为 Hive 第一版“能力画像 + benchmark + worker 选择”机制的实现基线。

重点看：
1. 是否正确区分静态能力层和动态画像层
2. 是否错误地让 Claude 在 runtime 自主 spawn
3. 是否缺少 hard filters
4. 是否存在假精度（benchmark 没测到却硬造 domain score）
5. 是否给后续扩展留好了 schema 升级位
6. 初始阶段有哪些地方可以立刻简化或修正

请按以下结构输出：
1. Blocking issues
2. Suggested simplifications
3. Good decisions to keep
4. MVP-ready or not
```
