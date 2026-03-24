# Parallel Orchestration Benchmark

这是一套可复用的 benchmark，用来比较不同 model 在多文档约束、并行开发、接口协同、修复收敛这类工程任务上的表现。

它不是测“谁最会写一段代码”，而是测：
- 能不能读懂真实 spec
- 能不能在 write scope 内交付
- 能不能和别人对齐接口
- 出错后能不能在第二轮收敛

## 1. Benchmark 名称

`parallel-orchestration-benchmark`

## 2. 适用场景

适合比较以下能力：

- spec comprehension
- codebase integration
- scope discipline
- repair ability
- delivery under coordination constraints

不适合单独比较以下能力：

- 纯算法能力
- 产品创意
- 长篇文案

## 3. 任务结构

使用一个共享基础仓库，预置：

- `ERRATA.md`
- `SELF_CONTAINED_ADDENDUM.md`
- `TASK-A2-qwen35.md`
- `TASK-B-kimi.md`
- `TASK-C-qwenmax.md`
- `TASK-D-glm5.md`
- `TASK-E-minimax.md`
- Foundation 文件：`orchestrator/types.ts`, `package.json`, `tsconfig.json`

然后把 5 个 model 分到 5 个独立 `git worktree`，每个 model 只拿到：

1. 同一组权威文档
2. 自己的任务文档
3. 自己的 write scope
4. 一次 repair round

## 4. 标准流程

### Phase 0

准备基线：

1. 冻结基础文件
2. 创建 5 个 worktree
3. 明确文档优先级：
   `ERRATA.md > SELF_CONTAINED_ADDENDUM.md > TASK-*.md > PLAN`

### Phase 1

第一轮并行执行。

每个 worker：
- 只允许修改自己的文件
- 完成后提交 handoff
- 运行本地验证

### Phase 2

做第一轮 review，记录：

- 有没有越界改动
- 有没有 shared-contract drift
- 有没有接口断裂
- 有没有自相矛盾的 handoff

### Phase 3

对未收敛 worker 发第二轮定点修复指令。

要求：
- 只修明确 findings
- 不扩展 write scope
- 不再给第三次相同类型尝试

### Phase 4

给出综合评分和排序。

## 5. 评分维度

总分 100，建议权重如下：

| 维度 | 权重 | 看什么 |
|------|------|--------|
| `spec_comprehension` | 20 | 是否真的按 ERRATA / Addendum / Task 理解任务，而不是机械抄旧 Plan |
| `delivery_completeness` | 15 | 是否按任务清单交付了该交付的模块 |
| `code_control` | 20 | API 使用、import 路径、类型控制、实现是否自洽 |
| `scope_discipline` | 10 | 是否越界改文件、是否碰 shared contract |
| `integration_readiness` | 15 | 模块签名是否可并入整体，是否埋下接口炸点 |
| `repair_ability` | 10 | 收到定点反馈后能否明显收敛 |
| `turnaround_speed` | 10 | 相对响应速度与修复速度 |

## 6. 评分规则

### `spec_comprehension`

- 18-20: 几乎完全按权威文档执行
- 14-17: 大方向正确，局部误读
- 8-13: 多处误读或仍受旧文档误导
- 0-7: 核心任务理解错误

### `delivery_completeness`

- 13-15: 交付完整
- 10-12: 基本完整，有少量缺口
- 6-9: 缺少关键项
- 0-5: 交付明显不完整

### `code_control`

- 18-20: import、签名、SDK 用法、类型系统都稳
- 14-17: 少量技术误差
- 8-13: 有真实断点，需要整合者兜底
- 0-7: 自身代码结构大量不成立

### `scope_discipline`

- 9-10: 完全守边界
- 6-8: 有轻微越界倾向
- 3-5: 明显越界但可修复
- 0-2: 持续破坏写入边界或 shared contract

### `integration_readiness`

- 13-15: 可直接进入整合序列
- 10-12: 有少量接缝，但清晰
- 6-9: 多处接口未对齐
- 0-5: 不适合直接整合

### `repair_ability`

- 9-10: 第二轮明显收敛
- 6-8: 有改善，但仍留尾巴
- 3-5: 修复效果一般
- 0-2: 第二轮仍不收敛

### `turnaround_speed`

这是相对维度，建议按同一批次 worker 横向比较：

- 9-10: 明显快
- 7-8: 正常偏快
- 5-6: 正常
- 3-4: 明显慢
- 0-2: 严重拖延

注意：
- 速度不应该盖过正确性
- “快但乱改”不应该拿高分

## 7. 观察记录模板

每个 worker 至少记录这些字段：

```json
{
  "worker": "A2",
  "model_label": "example-model",
  "round1_status": "partial",
  "round2_status": "repaired|unrepaired|not_needed",
  "self_caused_compile_errors": [],
  "scope_violations": [],
  "shared_contract_violations": [],
  "interface_breaks": [],
  "handoff_truthfulness_notes": [],
  "speed_bucket": "fast|normal|slow"
}
```

## 8. 标准评测 Prompt

下面这段可以作为统一评测 prompt 的骨架。实际跑时，把 `WORKTREE_PATH`、`TASK_PATH`、`WRITE_SCOPE` 替换掉。

```text
You are participating in the parallel-orchestration-benchmark.

Repository worktree:
WORKTREE_PATH

Read first:
1. ERRATA.md
2. SELF_CONTAINED_ADDENDUM.md
3. TASK_PATH

Authority order:
ERRATA.md > SELF_CONTAINED_ADDENDUM.md > TASK_PATH > CLI_BRIDGE_IMPLEMENTATION_PLAN.md

Write scope only:
WRITE_SCOPE

Constraints:
- Do not modify shared contract files unless explicitly authorized
- Do not create stub implementations for other workers' modules
- If a neighbor module is missing, keep your imports/exports aligned to the documented contract instead of inventing a local replacement
- After implementation, run local validation and report exact blockers

Required output:
1. changed files
2. validation results
3. unresolved dependencies
4. any required shared-contract change
```

## 9. 二次修复 Prompt 模板

```text
You are in repair round 2 of the parallel-orchestration-benchmark.

Only fix the explicitly listed findings.
Do not broaden scope.
Do not modify files outside your write scope.
Do not create compensating stubs for missing modules.

Findings to fix:
FINDINGS_LIST

Acceptance:
- local validation must pass or remaining errors must be proven to belong only to still-missing external modules
- handoff must match actual worktree state
```

## 10. 排名使用建议

推荐把 benchmark 结果用于：

- 初始模型分工
- 哪些模型适合做 infra / config / review / orchestration
- 哪些模型需要被约束在更小 scope 内

不推荐直接用于：

- 一次 benchmark 后就永久定级
- 不看任务类型直接跨项目套排名

更稳的做法：

1. 至少跑 3 种 benchmark
2. 分别看：
   - infra / integration
   - product feature delivery
   - debugging / repair
3. 再形成长期模型画像

## 11. 本次基线

本次 session 的具体评分记录在：

- `benchmark/session-001-scorecard.json`

当前建议初始排序：

1. E
2. D
3. B
4. A2
5. C
