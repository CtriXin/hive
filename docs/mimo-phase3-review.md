# Phase 3 External Review Slot — Code Review (mimo)

Date: 2026-04-04
Reviewer: mimo-v2-pro
Scope: architecture boundaries, transport/lifecycle, repair-context/data-shape, test coverage

---

## Review 1: Architecture Boundary

**1. `review-room-handler.ts:108` — review room fires on ANY failed review, not just internal cascade failure**
- **Severity: Low**
- `maybeRunExternalReviewSlot` gates on `reviewResult.passed`, correct. Also gates on `collab.review_transport === 'agentbus'` at line 113. Review room only triggers when internal review failed AND transport is opted-in. No scope creep into recovery/human-bridge/MindKeeper.
- **Verdict: OK** — boundary is clean.

**2. `driver.ts:1194` — external review is purely advisory, does NOT override merge/repair/replan**
- **Severity: Low**
- Result of `maybeRunExternalReviewSlot` replaces `review` in the array, but `passed` field is never touched — comes from `...reviewResult` spread (review-room-handler.ts:301). External findings appended to `findings[]`, but `passed` stays false. Downstream `repair_task` decision at line 1404 checks `!r.passed` which still triggers repair correctly.
- **Verdict: OK** — Hive remains source-of-truth for pass/fail.

**3. `collab-types.ts:81,90` — CollabCard / CollabStatusSnapshot fully reused**
- **Severity: OK (no issue)**
- `CollabRoomKind` adds `'review'` to existing union. `CollabCardStatus` adds `'fallback'`. No new schema invented — all review room state lives in existing `CollabCard` + `CollabStatusSnapshot` shape.
- **Verdict: OK**

**4. No scope creep detected**
- **Severity: OK**
- No references to MindKeeper, recovery rooms, or human-bridge in Phase 3 files. `types.ts:391` adds `external_review_collab?: CollabStatusSnapshot` to `ReviewResult` — minimal extension.
- **Verdict: OK**

**Summary: No findings above Low severity. Architecture boundaries are clean.**

---

## Review 2: Transport / Lifecycle

**1. `agentbus-adapter.ts:210-213` — close summary payload type is stable**
- **Severity: OK**
- `closeDiscussRoom` correctly maps `room_kind === 'review'` → `type: 'external-review-summary'`. Mapping logic at lines 210-213 is a simple ternary chain. Test at `agentbus-adapter.test.ts:122-172` verifies the payload type.
- **Verdict: OK**

**2. `review-room-handler.ts:141-153` — safeCloseRoom swallows errors silently**
- **Severity: Medium**
- `safeCloseRoom` catches errors and only `console.log`s them. If `closeDiscussRoom` fails, the room is left OPEN in AgentBus. The `room:closed` event is still pushed (lines 177-185) even though the room wasn't actually closed, creating a false signal in the collab snapshot. Downstream consumers (hiveshell dashboard, worker-status) will show "closed" while the room is still open.
- **Fix:** If `safeCloseRoom` throws, either skip the `room:closed` event or mark it with `note: 'close failed — room may still be open'`.

**3. `review-room-handler.ts:186-193` — finalizeWithoutReplies returns original reviewResult when no snapshot**
- **Severity: Low**
- At line 192, if `snapshot` or `room` is undefined, returns original `reviewResult` unmodified. If `openReviewRoom` throws at line 196, the catch at line 305 calls `finalizeWithoutReplies` which returns the original — correct. Currently safe.
- **Verdict: OK**

**4. `agentbus-adapter.ts:145-147` — min_replies=0 grace window semantics**
- **Severity: Low**
- When `min_replies=0`, wait budget is `Math.min(timeout, 2500ms)`. For review rooms with `review_min_replies: 0` (default per review-room-handler.ts:118), room opens, collects for 2.5s max, then closes. Intentional "quick scan" mode. Test at `agentbus-adapter.test.ts:235-294` validates the grace period captures fast replies.
- **Verdict: OK — semantics are reasonable.**

**5. Orchestrator identity stability**
- **Severity: OK**
- `makeReviewOrchestratorId` at line 84 uses `hive-review-${taskId}-${Date.now().toString(36)}`. Same pattern as planner (`hive-planner-`) and worker (`hive-worker-`). Identity created once in `openReviewRoom` and passed through to `closeDiscussRoom`. Test at `agentbus-adapter.test.ts:68-119` validates stable identity across open/close for planner rooms — same logic applies to review rooms.
- **Verdict: OK**

**Summary: One Medium finding (safeCloseRoom false room:closed event). Everything else clean.**

---

## Review 3: Repair-Context / Data-Shape

**1. `types.ts:391` + `review-room-handler.ts:301-303` — external_review_collab on ReviewResult**
- **Severity: Low**
- Adding `external_review_collab?: CollabStatusSnapshot` to `ReviewResult` is minimal. Optional, so existing code that creates `ReviewResult` doesn't need changes. Field only populated by `maybeRunExternalReviewSlot`. Right blast radius.
- **Verdict: OK**

**2. `review-room-handler.ts:269` + `review-room-handler.ts:302` — advisory findings appended to findings[]**
- **Severity: Medium**
- External findings appended at line 302: `findings: [...reviewResult.findings, ...externalFindings]`. These have `severity: 'yellow'`, `lens: 'external-review'`, `decision: 'flag'`.

  Risk: `buildRepairPrompt` in driver.ts:456 filters on `f.decision !== 'dismiss'` — external findings with `decision: 'flag'` WILL be included in repair prompts. This is desirable (external advisory should inform repair). But if a future consumer counts `red` findings to decide escalation severity, `yellow` external findings could inflate count.

  `updateTaskStatesFromReviews` at driver.ts:175-196 checks `review.passed` — not findings count — so pass/fail unaffected.

- **Verdict: Acceptable but worth a comment.** `yellow` + `lens: 'external-review'` is well-chosen — won't trigger `red`-severity escalation paths.

**3. Smaller blast-radius alternative?**
- **Severity: N/A (design question)**
- Current approach (append to findings, attach snapshot) is already minimal. Alternative: separate `external_advisory_findings[]` array on `ReviewResult`, but that requires all downstream consumers to know about two arrays. Current single-array approach with `lens` discrimination is simpler.
- **Verdict: Current approach is the right trade-off.**

**4. `review-room-handler.ts:95` — finding ID collision risk**
- **Severity: Low**
- External findings start at `startingId = reviewResult.findings.length + 1`. If internal findings have IDs [1, 2, 3], external get [4, 5, ...]. Assumes internal IDs are sequential from 1 — typically true but not guaranteed.
- **Fix (if desired):** line 269 — `const startingId = Math.max(0, ...reviewResult.findings.map(f => f.id)) + 1;`

**Summary: One Low finding (ID collision). The findings-append approach is sound.**

---

## Review 4: Test Coverage

**Covered paths:**
- `review-room-handler.test.ts:126` — replies arrive → external findings appended, snapshot is `closed`, close summary has `quality_gate: 'pass'`
- `review-room-handler.test.ts:174` — 0 replies → original result preserved, snapshot is `fallback`, close summary has `quality_gate: 'fallback'`
- `agentbus-adapter.test.ts:122` — review room close writes `external-review-summary` payload type
- `agentbus-adapter.test.ts:68` — stable orchestrator identity across open/close
- `agentbus-adapter.test.ts:235` — min_replies=0 grace window captures fast replies
- `buildReviewBrief` — cwd_hint doesn't leak full path

**Missing high-risk cases (must fix before smoke):**

1. **Multiple replies** — no test covers 2+ external review replies. `buildExternalReviewFindings` mapping and ID incrementing is untested with multiple entries. **Priority: High.**

2. **Adapter error (openReviewRoom throws)** — the catch path at `review-room-handler.ts:305` calls `finalizeWithoutReplies` which needs `snapshot` and `room` to be undefined. No test validates this. **Priority: High.**

3. **collectDiscussReplies throws mid-collection** — if the room exists but `collectDiscussReplies` throws (e.g., messages file corrupted), the catch at line 305 fires. Room is opened but never explicitly closed via `safeCloseRoom` because `room` is set but `snapshot` events may be inconsistent. **Priority: Medium.**

4. **on_snapshot callback throws** — if `onSnapshot` throws during `publishSnapshot`, the entire review slot fails and falls through to catch → `finalizeWithoutReplies`. Correct behavior but untested. **Priority: Low.**

**Can defer to next phase:**

5. **Worker-status surface integration** — `updateWorkerStatus` calls in driver.ts:1210-1231 pass collab snapshots but no integration test verifies dashboard renders review rooms.

6. **Snapshot event ordering** — verifying `room:opened` → `reply:arrived` → `synthesis:started` → `synthesis:done` → `room:closed` events appear in exact order in `recent_events`.

7. **closeDiscussRoom throws after replies collected** — room shows `status: 'closed'` in snapshot but AgentBus room still open. Covered in Review 2 finding #2.

---

## Actionable Summary

| Severity | Count | Must fix before smoke? |
|----------|-------|----------------------|
| Medium   | 2     | Yes (safeCloseRoom false event, test gaps) |
| Low      | 3     | Nice-to-have |
| OK       | 8     | No |

**Must fix before smoke:**
1. **safeCloseRoom false `room:closed` event** — skip the event or mark it as failed-close
2. **Multiple-reply test + adapter-error test** — add 2 test cases to `review-room-handler.test.ts`
