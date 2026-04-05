# CR0 Engineering Review — Mimo Lifecycle Perspective

Date: 2026-04-05
Reviewer: mimo-v2-pro (implementation / lifecycle reviewer)
Scope: CR0 execution plan engineering落地审查

---

## Verdict: CONDITIONAL PASS

CR0 design is sound. 落地有几个实际问题需要先解决。

---

## 1. 最小代码切入点

不要一次改 9 个文件。分三步走：

**第一步：只加配置，不动代码**
- `config/model-profiles.json` — 补 4 个 seed profile
- `config/authority-policy.json` — 新建，纯数据

这两个文件加完，现有 scorer 就能用 seed 分数做路由参考，零风险。

**第二步：两个纯函数模块**
- `orchestrator/authority-policy.ts` — 读配置、选模式、挑模型
- `orchestrator/disagreement-detector.ts` — 比较 review 输出、标记分歧

都是纯函数，不碰 I/O，好测试。

**第三步：runner + 接入点**
- `orchestrator/committee-runner.ts` — 串联 dispatch → collect → detect
- `orchestrator/reviewer.ts` — 加一个入口函数
- `orchestrator/driver.ts:1181` — 调用点改一行

---

## 2. 改哪些文件

| 文件 | 动作 | 风险 |
|------|------|------|
| `config/model-profiles.json` | 改 — 加 seed | 低 |
| `config/authority-policy.json` | 新建 | 零 |
| `orchestrator/types.ts` | 改 — 加 3-4 个 type | 低，向后兼容 |
| `orchestrator/authority-policy.ts` | 新建 ~120 行 | 低 |
| `orchestrator/disagreement-detector.ts` | 新建 ~100 行 | 低 |
| `orchestrator/committee-runner.ts` | 新建 ~200 行 | 中 |
| `orchestrator/reviewer.ts` | 改 — 加入口 | 中 |
| `orchestrator/driver.ts:1181` | 改 — 路由一行 | 中 |

**CR0 不碰的文件：**
- `planner.ts` — 文档明确写了 out of scope
- `model-scorer.ts` — 现有逻辑够用
- `model-registry.ts` — `rankModelsForTask` 已经能做初始委员会选择
- AgentBus transport — 先用 direct dispatch

---

## 3. scorer / registry / orchestrator 分别怎么接

### scorer（model-scorer.ts）
不改。原因：
- `computeWeightedScore()` 已经读 profile scores
- seed profile 加进 `model-profiles.json` 后，scorer 自动用
- `getConfidenceFactor()` 会自动压低 `samples=1` 的权重
- 不需要任何代码变更

### registry（model-registry.ts）
第一步不改。原因：
- `rankModelsForTask()` 能按 task fingerprint 排序
- `authority-policy.ts` 从 policy 的 `primary_candidates` 里过滤就行
- 如果后续需要更复杂的委员会选择逻辑，再加 `selectCommitteeMembers()`
- 现阶段够用

### orchestrator（driver.ts）
只改一处：`reviewCascade()` 调用点。

```typescript
// 现在 (line ~1181)
const review = await reviewCascade(wr, task, plan!, registry);

// 改成
const review = await runReview(wr, task, plan!, registry);
// runReview 内部判断：有 authority-policy.json → committeeRunner
// 没有 → 走原来的 reviewCascade()
```

加一个 feature gate，没配置文件就走老逻辑，行为完全不变。

---

## 4. Lifecycle / Observability 怎么保持清晰

### 必须加的 observability

**committee-runner.ts 内部必须输出：**
- `committee_mode: 'single' | 'pair' | 'jury'` — 用了哪个模式
- `committee_members: string[]` — 选了哪些模型
- `disagreement_flags: string[]` — 标记了哪些分歧
- `committee_duration_ms: number` — 委员会总耗时
- `per_member_duration_ms: Record<string, number>` — 每个成员耗时

**写入位置：**
- `WorkerStatusEntry` 加 `committee_mode?` 和 `disagreement_flags?` 字段
- `ReviewResult` 已有 `findings` 数组，分歧标记作为 finding 加入
- `RunScoreSignals` 加 `committee_disagreement_count`

### 不要加的
- 不加新的 dashboard 页面 — hiveshell 现有输出够用
- 不加新的 compact-packet 字段 — 等 CR1 再说
- 不加新的 MCP surface endpoint — 等 CR3

### 日志规范
```
[authority] mode=pair members=[kimi-k2.5,mimo-v2-pro] task=task-a
[authority] disagreement: kimi=PASS mimo=REJECT → escalate to codex
[authority] synthesis complete verdict=REJECT findings=3 duration=4200ms
```

---

## 5. Top Lifecycle Risks

### Risk 1: 成本静默放大
4 模型审查 = 4x token。没有 budget guard。

**修法：** `authority-policy.json` 加 `max_models` 和 cost cap。`committee-runner.ts` 每 dispatch 一个成员前检查 budget。

### Risk 2: 分歧检测误报
简单的 PASS vs must-fix 标记会在每次运行都触发 Codex synthesis，如果校准不准的话。

**修法：** 默认用 `pair`，不是 `jury`。policy 加 `disagreement_threshold` — 分歧数超过阈值才升级。第一版可以先 log，不自动升级。

### Risk 3: Seed 分数过拟合 Phase 3
`samples=1` 一次坏运行就能翻转路由。

**修法：** `getConfidenceFactor()` 已经在压低低样本分数。seed 分数标 `advisory`。不让 seed 单独触发模式升级。

### Risk 4: 委员会 runner 阻塞主循环
串行 dispatch（A 等完 B 等）会让 review 延迟 4x。

**修法：** 成员并行 dispatch（Promise.all），和现有 worker dispatch 一样。加 timeout。

### Risk 5: 和 AgentBus mainline 耦合
CR0 说"独立 track"但代码改 `driver.ts`。

**修法：** config flag gate。没有 `authority-policy.json` 或者 `enabled: false` → 行为完全不变。

---

## 6. Must-Have Tests

### 新测试文件

| 文件 | 覆盖 |
|------|------|
| `tests/authority-policy.test.ts` | 加载配置、模式解析、升级触发、缺配置回退 |
| `tests/disagreement-detector.test.ts` | PASS-vs-REJECT、by-design-vs-bug、兼容/不兼容修复、一致评审无误报 |
| `tests/committee-runner.test.ts` | 成员选择、并行 dispatch mock、结果收集、timeout 处理 |

### 需要更新的现有测试

| 文件 | 改什么 |
|------|--------|
| `tests/reviewer.test.ts` | 加 committee 模式返回合法 `ReviewResult` 的 case |

### 不需要的测试
- 不需要 e2e integration test — CR0 先用 mock，真模型调用在 smoke 验证
- 不需要 scorer 测试 — 没改 scorer
- 不需要 registry 测试 — 没改 registry

---

## 7. 第一批真正动手的文件

按顺序，每步都能独立验证：

1. **`config/model-profiles.json`** — 加 4 个 seed profile。现有代码自动读取。
2. **`config/authority-policy.json`** — 新建。纯数据，零逻辑。
3. **`orchestrator/types.ts`** — 加 `CommitteeMode`、`CommitteeReviewResult`。向后兼容。
4. **`orchestrator/authority-policy.ts`** — 纯函数，~120 行。写完立刻写测试。
5. **`orchestrator/disagreement-detector.ts`** — 纯函数，~100 行。写完立刻写测试。
6. **`tests/authority-policy.test.ts`** + **`tests/disagreement-detector.test.ts`**
7. **`orchestrator/committee-runner.ts`** — 串联逻辑，~200 行。
8. **`orchestrator/reviewer.ts`** — 加 `runCommitteeReview()` 入口。
9. **`orchestrator/driver.ts:1181`** — 改一行调用。

第 1-2 步今天就能做。第 3-6 步一天。第 7-9 步一天。总共 2-3 天出 CR0 MVP。

---

## 8. 设计问题（需要回答）

文档里有 5 个 open questions。工程视角的建议：

1. **pair 还是 single 默认？** — `pair`。single 省不了多少钱，pair 能 catch 更多问题。
2. **mimo 通用还是 lifecycle 专用？** — 先当 challenger 用，不限制 review 角度。
3. **glm 默认 pair 还是高风险才用？** — 高风险才用。glm 的 false positive 率不适合默认。
4. **委员会输出需要多严格的 schema？** — 先复用现有的 `ReviewFinding` 结构，不要新造 schema。
5. **direct dispatch 还是 AgentBus？** — direct dispatch。AgentBus 在 smoke 验证完之前别碰。
