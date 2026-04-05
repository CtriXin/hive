# GLM Adversarial Review: CR0 Authority Layer

Date: 2026-04-05
Reviewer: glm-5.1 (adversarial architect)
Status: final

---

## Verdict

核心洞察正确（Claude 不可靠，需多模型 authority），但 execution plan 把"改 routing"膨胀成了"建第二套 review subsystem"。

**最小安全做法：只 seed profiles → 现有 routing 自然选对模型 → 验证可行 → 再扩展。**

---

## Top 7 Risks

### 1. 双头审查 — reviewer.ts cascade vs CR0 committee `[BLOCKER]`

`reviewer.ts` 已有完整 4 阶段 cascade：

```
cross-review → A2A 3-lens → arbitration → final review
```

每阶段都有 confidence-based skip、verdict 语义、score 回写、lesson 提取。

CR0 提议的 `single → pair → jury → Codex synthesis` 是平行 review 执行模型。`driver.ts:1175` 调 `reviewCascade()` 时走哪条路？路由逻辑本身变成新耦合点。

**结论：CR0 如果不改 cascade 本体，就是在旁边插一套平行 runner。最危险的隐藏耦合。**

### 2. CompactPacket restore 契约污染 `[HIGH]`

`compact-packet.ts` 的 `CompactPacket` 是 restore 跨 session 唯一契约。authority 决策若持久化必须进这里，否则 compact/clear 后丢失。一旦进入，`buildRestorePrompt()` 会携带 committee 上下文影响所有后续 session。

**结论：CR0 阶段不持久化 committee 状态，只在单次 review 内消费。**

### 3. Config sprawl — 第三套 config 表面 `[HIGH]`

现有：
- `model-profiles.json` — 评分数据
- `model-lessons.json` — 失败教训
- `review-policy.json` — 阈值和裁决（`ReviewerTierConfig`）

CR0 再加 `authority` config block。问题：`review-policy.json` 的 `escalation_threshold` 和 `authority.escalate_on` 是同一件事的两个表述。

**结论：用现有 `review-policy.json` + seed profiles，不加新 config 文件。**

### 4. worker-discuss-handler 双路径注入 `[MEDIUM-HIGH]`

`handleDiscussTrigger()` 有 AgentBus 和 local 两条路。authority 若要 gate 状态转换，需同时 wrap 两条。`publishSnapshot()` 直接写 worker-status-store，不经过任何检查。

**结论：CR0 scope 不涉及，但 CR1/CR3 会兑现此风险。留档。**

### 5. Codex synthesis = 单点换单点 `[MEDIUM]`

核心论点"Claude 不稳定 → 用 committee + Codex synthesis 替换"。但 Codex synthesis 本身是另一个单点。committee 产出需要 synthesis 才能变 actionable，没有 synthesis 就是碎片。没解决"依赖单一权威"的问题。

**结论：synthesis 层必须可替换，不硬绑 Codex。**

### 6. Seed profile false precision `[MEDIUM]`

`model-profiles.json` 多数模型 review 维度是 `0.5, samples=0`。Seed `kimi-k2.5: review=0.88` 等数字来源不明。EMA + confidence factor 会当真数据使用。`rankModelsForTask()` 用这些 score 做 weighted ranking，假 seed 直接影响 reviewer 选择。

**结论：seed 用独立标记（`is_seed: true`），不混入 `samples` 计数，或在 `model-scorer.ts` 加 seed 权重衰减。**

### 7. "最小 slice" 实际不小 `[MEDIUM]`

CR0 deliverables：新 schema + 新文件 + 新 runner + 数据注入 + docs。至少 3 个新文件、1 个新 config、1 个新执行路径。这不是 slice，是平行 review subsystem。

**结论：砍到只做 seed profiles + routing 验证。**

---

## Safe CR0 Slice

**不改现有 cascade，只加一层薄 routing。**

```
safe-cr0/
├── 1. seed profiles → 注入 model-profiles.json
│   └── 给 review 维度加初始值，标记为 seed 而非 observed
│
├── 2. 利用现有 selectForFinalReview() + selectCrossReviewer()
│   └── seed profiles 影响模型选择结果，不改代码
│
└── 3. 不写新 runner，不改 reviewer.ts
```

为什么这够：
- `model-registry.ts` 的 `selectForFinalReview()` 已根据 profile score 选模型
- 只需 seed 正确的 review scores → routing 自然选对模型
- 能达到 CR0 核心目标："review without Claude"

做不到的（留给 CR1）：
- single/pair/jury topology
- disagreement detection
- Codex synthesis
- committee runner

---

## Non-Goals

1. 不改 `reviewer.ts` cascade 流程
2. 不加 committee runner
3. 不加 synthesis 层
4. 不持久化 committee 状态（不碰 CompactPacket）
5. 不改 compact/restore
6. 不改 worker discuss 路径
7. 不加 dashboard 表面
8. 不改 AgentBus adapter

---

## False Expansion List

| Proposal 项 | 为什么是 false expansion |
|---|---|
| single/pair/jury topology | 现有 cascade 已经是 topology：1→3→1→1，重命名不增加能力 |
| Disagreement detector | A2A 3-lens 已在做，`CONTESTED` verdict 就是 disagreement 结果 |
| Codex synthesis | `selectForArbitration()` + `selectForFinalReview()` 已是 synthesis，换个模型不需要新 runner |
| `escalate_on` triggers | `review-policy.json` 的 `escalation_threshold` + confidence check 已在做 |
| GPT-5.x coordinator | 和 `driver.ts` orchestration 职责重叠 |
| Docs (topology, routing) | 没实现就写 doc 是 premature |

---

## One-Line Summary

Seed profiles first, prove review works without Claude, then consider committee. Everything else is scope creep.
