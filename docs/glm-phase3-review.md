# Phase 3 External Review Slot — GLM Code Review Report

> Date: 2026-04-04
> Reviewer: GLM-5.1 (4 parallel review agents)
> Scope: Architecture boundary, Transport/lifecycle, Repair-context/data-shape, Test coverage

---

## 1. Architecture Boundary Review

### Finding A1 (medium): External advisory findings flow into repair prompts with equal weight

- **File:** `orchestrator/review-room-handler.ts:89-102`, `orchestrator/driver.ts:456`
- **Problem:** External review findings are assigned `decision: 'flag'` and appended to `reviewResult.findings`. Downstream `buildRepairPrompt` at `driver.ts:456` filters findings with `decision !== 'dismiss'` — so every external advisory reply becomes an actionable repair finding. There is no mechanism to mark an external reply as "dismiss" or "info-only".
- **Why:** A false-positive challenge from external review is treated the same as a real issue. External review is supposed to be advisory, but its findings flow directly into repair prompts with the same weight as internal red/yellow findings.
- **Fix:** Add `decision: 'advisory'` to `ReviewFinding.decision` union and have `buildRepairPrompt` exclude advisory-grade findings. Or filter `lens === 'external-review'` out of the repair issue list.

### Finding A2 (low): Repeated external review rooms on repair rounds

- **File:** `orchestrator/driver.ts:1186-1236`
- **Problem:** External review slot runs unconditionally on all failed review results every round. After a repair, if the task still fails, a second external review room opens. No deduplication.
- **Why:** Resource/UX concern — external participants may see multiple rooms for the same task.
- **Fix:** Check for existing `external_review_collab` on the review result and skip if already opened.

### Finding A3 (confirmed OK): `passed` never mutated

- **File:** `orchestrator/review-room-handler.ts:300-304`
- **Verdict:** External review correctly never reverses pass/fail decision. `passed` field is never mutated.

### Finding A4 (confirmed OK): No scope creep into recovery / human bridge / MindKeeper

- **Verdict:** No references to mindkeeper, human-bridge, discord, or recovery in any Phase 3 files.

---

## 2. Transport / Lifecycle Review

### Finding T1 (medium): Duplicate `msg.from` silently dropped

- **File:** `orchestrator/agentbus-adapter.ts:160-169`
- **Problem:** `seenParticipants` dedup is keyed by `msg.from`. If a participant sends two answers (initial reply + correction), only the first is collected. Second is silently dropped.
- **Why:** External reviewer could post follow-up or correction. Dedup swallows legitimate data.
- **Fix:** Key dedup on `(msg.from, msg.seq)` or `msg.msg_id` instead of `msg.from` alone.

### Finding T2 (low): Reply count via `snapshot.card.replies + 1` is fragile

- **File:** `orchestrator/review-room-handler.ts:232-236`
- **Problem:** `on_reply` callback computes `snapshot.card.replies + 1` instead of using authoritative count.
- **Why:** Currently safe (serial callback), but fragile for future parallelization.
- **Fix:** Pass reply count from adapter or use `replies.length`. Add comment marking serial assumption.

### Finding T3 (low): Missing `room_kind` falls through to planner summary type

- **File:** `orchestrator/agentbus-adapter.ts:210-214`
- **Problem:** If `room_kind` is undefined, summary gets type `'planner-discuss-summary'` by fallthrough, not by design.
- **Why:** Future new room kinds would get wrong summary type silently.
- **Fix:** Make `room_kind` required in `CloseRoomInput`, or add explicit default that throws.

### Finding T4 (medium): Narrow window where room opened but snapshot unset — room left unclosed

- **File:** `orchestrator/review-room-handler.ts:305-307`
- **Problem:** Between `room = await openReviewRoom(...)` and `snapshot = { ... }`, if error occurs, `room` is set but `snapshot` is undefined. `finalizeWithoutReplies` checks `if (snapshot && room)` and only then calls `safeCloseRoom`.
- **Why:** Room could be left in OPEN state indefinitely.
- **Fix:** Initialize snapshot immediately after room, or add finally-style close guard.

### Finding T5 (OK): `min_replies=0` grace period semantics

- **File:** `agentbus-adapter.ts:145-148`
- **Verdict:** Sound. `waitBudgetMs` capped to `Math.min(timeout_ms, 2500)`. Test confirms reply captured within grace window.

### Finding T6 (OK): Summary payload type `external-review-summary`

- **File:** `agentbus-adapter.ts:213`
- **Verdict:** Correct and tested.

### Finding T7 (OK): Orchestrator identity stable

- **File:** `agentbus-adapter.ts:83-84`
- **Verdict:** `makeReviewOrchestratorId` generates once, threaded through open/collect/close. Consistent with Phase 1/2.

### Finding T8 (low): Three near-identical `open*Room` functions

- **File:** `agentbus-adapter.ts:111-123, 254-266, 268-280`
- **Problem:** `openPlannerDiscussRoom`, `openWorkerDiscussRoom`, `openReviewRoom` are near-identical. Only variation is orchestrator ID prefix.
- **Fix:** Extract generic `openTypedRoom(brief, orchestratorIdFn)` helper.

---

## 3. Repair-Context / Data-Shape Review

### Finding D1 (high): External findings mixed into `reviewResult.findings` pollutes scoring, lessons, repair, reporting

- **File:** `orchestrator/review-room-handler.ts:300-304`
- **Problem:** External advisory findings appended directly into `findings[]`. Consumed by:
  - `lesson-extractor.ts:147` — `classifyFailure()` text pattern matching produces spurious FailureType from advisory text
  - `driver.ts:524` — repair prompt includes all non-dismissed findings; external advisories always `decision: 'flag'`
  - `driver.ts:516,553,569` — `findings_count` inflated
  - `reporter.ts:43-44` — yellow count inflated with external advisory yellows
  - `review-room-handler.ts:80` — subsequent review brief includes prior external findings
- **Fix:** Use separate `external_advisory_findings` array on `ReviewResult`. Render into repair prompt as separate advisory section:
  ```
  ### External Advisory Guidance (advisory only, not blocking)
  ```

### Finding D2 (medium): `severity: 'yellow'` + `lens: 'external-review'` is fragile

- **File:** `orchestrator/review-room-handler.ts:94-99`
- **Problem:**
  - (a) `yellow` hardcoded — yellow has operational meaning, leaks into yellow counts in reports
  - (b) `lens: 'external-review'` typed as `string` — open union, no exhaustiveness checking
  - (c) `file: 'review-room:${participant_id}'` — synthetic path confuses repair workers
- **Fix:** Add `'external-review'` to lens union explicitly. Use sentinel `file: '(external-advisory)'`. Or (best) isolate from `findings[]` entirely per D1.

### Finding D3 (medium): Repair prompt includes synthetic file references

- **File:** `orchestrator/driver.ts:451-457`
- **Problem:** External finding with `file: 'review-room:reviewer-a'` appears in repair prompt as file to fix. Worker may waste turns locating non-existent file.
- **Fix:** Filter `lens === 'external-review'` out of repair issue list.

### Finding D4 (low): `external_review_collab` placement on ReviewResult

- **File:** `orchestrator/types.ts:391`
- **Problem:** Orchestration concern (did we open a room?) mixed with review data contract. Optional and ignored by existing consumers, so blast radius minimal.
- **Fix:** Acceptable for now. Cleaner mount point: `OrchestratorResult.external_review_snapshots`.

### Finding D5 (OK): Data flow is purely functional

- **File:** `orchestrator/driver.ts:1186-1236`
- **Verdict:** No mutation of shared state. Returns new object. Correctly scoped.

### Finding D6 (OK): loadConfig short-circuits correctly

- **File:** `orchestrator/review-room-handler.ts:108-115`
- **Verdict:** `passed` check runs before `loadConfig`. Order is correct.

---

## 4. Test Coverage Review

### Existing test coverage (4 tests in `review-room-handler.test.ts`, 8 tests in `agentbus-adapter.test.ts`)

| Test | Path Covered |
|------|-------------|
| `buildReviewBrief` | Brief construction, cwd_hint redaction, task_id, findings |
| `maybeRunExternalReviewSlot > replies arrive` | Happy path: open, collect with on_reply, synthesize, close with quality_gate:pass, snapshot lifecycle |
| `maybeRunExternalReviewSlot > no replies` | Zero-replies fallback: status='fallback', close with quality_gate='fallback', original findings unchanged |
| `buildRoomRef > constructs from room and replies` | RoomRef construction, metadata mapping |
| `buildRoomRef > omits join_hint when not present` | Empty replies, undefined join_hint |
| `buildRoomRef > uses ISO date string` | created_at format |
| `open/close lifecycle > stable orchestrator identity` | Full planner discuss lifecycle, identity consistency |
| `open/close lifecycle > writes external-review-summary` | Review room close writes correct payload type |
| `collectPlannerDiscussReplies > collects real answer messages` | FS-based collect with metadata |
| `collectPlannerDiscussReplies > grace window min_replies=0` | Non-blocking mode with fake timers |
| `synthesizeWorkerDiscussReplies` (3 subcases) | Synthesis: fallback, single reply, 2+ replies, truncation |

### Missing tests — MUST fix before smoke (P0)

| # | Missing Test | Risk |
|---|-------------|------|
| 1 | `openReviewRoom` throws | catch block calls `finalizeWithoutReplies` — if buggy, review result lost |
| 2 | `closeDiscussRoom` throws (safeCloseRoom swallow) | Critical safety wrapper, zero coverage |
| 3 | `collectDiscussReplies` throws during collect | Same catch block, null-reference risk |
| 4 | `reviewResult.passed = true` early return | If broken, every passing review opens external room |
| 5 | Config absent or `review_transport !== 'agentbus'` | Guard at line 113-115, zero test coverage |

### Missing tests — SHOULD fix before smoke (P1)

| # | Missing Test | Risk |
|---|-------------|------|
| 6 | Multiple replies finding ordering | `startingId` calculation easy to get wrong |
| 7 | Room with no opening brief throws | Explicit throw path in adapter, uncaught if fires |

### Missing tests — Can defer to next phase

- Reply count increment correctness (trivial logic)
- Per-reply `reply:arrived` events (linear extension)
- Full lifecycle event ordering (nice-to-have)
- MAX_REVIEW_COLLAB_EVENTS cap (unlikely to hit)
- Full `CollabStatusSnapshot` shape (set by construction)
- Duplicate participant deduplication (edge case)
- `min_replies` early exit (perf optimization)
- Concurrent late `on_reply` (adversarial timing)
- Double close idempotency (depends on backend-fs)

---

## Summary: Priority-ranked action items

| Rank | Severity | ID | Issue | Minimal Fix |
|------|----------|----|-------|-------------|
| 1 | **HIGH** | D1 | External findings mixed into `findings[]` | Use separate `external_advisory_findings` array |
| 2 | **MEDIUM** | A1/T1 | Findings flow into repair + duplicate `msg.from` dropped | Filter external lens + key dedup on `(from, seq)` |
| 3 | **MEDIUM** | T4 | Room left unclosed on error between open/snapshot | Add finally-style close guard |
| 4 | **MEDIUM** | D2/D3 | Yellow severity + synthetic file path in repair prompt | Isolate external findings from repair issue list |
| 5 | **P0** | Test | 5 test gaps (error paths + guards) | Add tests #1-5 before smoke |
| 6 | **P1** | Test | 2 test gaps (multi-reply + no-brief) | Add tests #6-7 before smoke |
| 7 | LOW | T2/T3/T8 | Fragile count, silent fallthrough, duplicated open funcs | Polish in next phase |
