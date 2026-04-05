# Phase 3 External Review Slot — Code Review Findings

**Reviewer:** qwen3.5-plus  
**Date:** 2026-04-04  
**Scope:** External review slot (post-cascade advisory room)

---

## 1. 架构边界 Review

### Finding #1

- **Severity:** yellow
- **File:** `orchestrator/review-room-handler.ts:108-110`
- **问题:** `maybeRunExternalReviewSlot` 只在 `reviewResult.passed === false` 时触发，符合设计。但缺少对"review room 重复触发"的防护——如果 driver.ts 多次调用此函数，可能为同一任务开多个 review room。
- **为什么:** driver.ts:1186-1236 中对每个 failed review 调用 `maybeRunExternalReviewSlot`，但没有检查该任务是否已有 open 的 review room。
- **最小修法:** 在 `maybeRunExternalReviewSlot` 开头增加：
  ```typescript
  if (reviewResult.external_review_collab) {
    return reviewResult; // already processed
  }
  ```

### Finding #2

- **Severity:** green
- **File:** `docs/HIVE_COLLAB_PHASE3_EXECUTION.md:36-46`
- **说明:** Non-goals 明确定义了边界，没有 scope creep 到 recovery / human bridge / MindKeeper。实现代码遵守了这些边界。

### Finding #3

- **Severity:** green
- **File:** `orchestrator/collab-types.ts:83-99`, `orchestrator/types.ts:391`
- **说明:** `CollabCard` / `CollabStatusSnapshot` 复用到位，`ReviewResult.external_review_collab?: CollabStatusSnapshot` 是最小扩展，没有新造 schema。

---

## 2. Transport / Lifecycle Review

### Finding #4

- **Severity:** yellow
- **File:** `orchestrator/agentbus-adapter.ts:268-280`
- **问题:** `openReviewRoom` 的 `orchestrator_id` 使用 `makeReviewOrchestratorId(taskId)`，每次调用生成新 ID。如果同一任务多次调用，会导致 from ID 不一致。
- **为什么:** `makeReviewOrchestratorId` 使用 `Date.now().toString(36)` 生成唯一 ID，但 review room 可能需要跨多次调用保持同一身份。
- **最小修法:** 传入 `reviewResult.taskId` 生成确定性 ID：
  ```typescript
  function makeReviewOrchestratorId(taskId: string): string {
    return `hive-review-${taskId}`; // 移除时间戳，每任务唯一
  }
  ```

### Finding #5

- **Severity:** green
- **File:** `orchestrator/agentbus-adapter.ts:202-218`
- **说明:** `closeDiscussRoom` 正确写入 `type: 'external-review-summary'`，payload type 稳定。

### Finding #6

- **Severity:** green
- **File:** `orchestrator/review-room-handler.ts:117-118`, `orchestrator/agentbus-adapter.ts:145-148`
- **说明:** `min_replies=0` 时走 `NON_BLOCKING_REPLY_GRACE_MS = 2500` 的 quick-reply 语义合理。0 replies / adapter error 有 clean fallback 到 `finalizeWithoutReplies`。

---

## 3. Repair-Context / Data-Shape Review

### Finding #7

- **Severity:** yellow
- **File:** `orchestrator/review-room-handler.ts:269-302`, `orchestrator/driver.ts:447-483`
- **问题:** external advisory findings 直接 `append` 到 `reviewResult.findings`，可能污染后续 repair/score 语义。现有 code 用 `lens: 'external-review'` 区分，但 downstream 代码可能遍历 `findings` 时不区分 lens。
- **为什么:** `ReviewFinding.lens` 字段存在，但 repair prompt (driver.ts:447-483) 只过滤 `decision !== 'dismiss'`，没有特别处理 `lens === 'external-review'`。
- **最小修法:** 在 `buildRepairPrompt` 中增加 lens 感知：
  ```typescript
  const issueList = findings
    .filter((f) => f.decision !== 'dismiss')
    .map((f) => {
      const prefix = f.lens === 'external-review' ? '[External Advisory] ' : '';
      return `- [${f.severity}] ${prefix}${f.file}${f.line ? `:${f.line}` : ''}: ${f.issue}`;
    })
    .join('\n');
  ```

### Finding #8

- **Severity:** green
- **File:** `orchestrator/types.ts:391`
- **说明:** `external_review_collab` 放在 `ReviewResult` 上是最小必要扩展，没有更小的 blast radius 挂载点。

---

## 4. 测试充分性 Review

### 现有覆盖路径

- ✅ 有 reply / 无 reply 路径
- ✅ summary payload type 验证
- ✅ snapshot 状态流转 (`open` → `collecting` → `closed`/`fallback`)

### 缺失的高风险 Case

| 风险 | Severity | 是否必须在 smoke 前补 |
|------|----------|---------------------|
| multiple replies (2+ 条) | yellow | ✅ 是 |
| closeDiscussRoom 失败时的 fallback | yellow | ✅ 是 |
| snapshot publish 顺序 (先 updateCard 还是先 pushEvent) | green | 可延后 |
| worker-status surface 集成测试 | yellow | ✅ 是 |
| review_transport='off' 时直接跳过 | green | 建议补 |

### 必须在 smoke 前补的测试

1. **`tests/review-room-handler.test.ts`**: 增加 `multiple replies` 测试，验证多条 advisory findings 都被正确追加
2. **`tests/review-room-handler.test.ts`**: 增加 `closeDiscussRoom throws` 测试，验证异常被 swallow 且不中断流程
3. **`tests/review-room-handler.test.ts`**: 增加 `review_transport: 'off'` 测试，验证直接返回原 reviewResult

---

## 总结

| 类别 | Red | Yellow | Green |
|------|-----|--------|-------|
| 架构边界 | 0 | 1 | 2 |
| Transport | 0 | 1 | 2 |
| Data-shape | 0 | 1 | 1 |
| 测试覆盖 | 0 | 3 (待补) | 2 |

### 优先修复顺序

1. **测试补全** (smoke 前必须)
2. `buildRepairPrompt` 增加 lens 感知
3. `makeReviewOrchestratorId` 确定性 ID
4. 重复调用防护

---

## 审查文件清单

- `orchestrator/review-room-handler.ts`
- `orchestrator/driver.ts`
- `orchestrator/collab-types.ts`
- `orchestrator/types.ts`
- `orchestrator/agentbus-adapter.ts`
- `docs/HIVE_COLLAB_PHASE3_EXECUTION.md`
- `tests/review-room-handler.test.ts`
- `tests/agentbus-adapter.test.ts`
