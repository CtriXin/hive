# Phase 3 External Review Slot - A2A Review Report
# Date: 2026-04-04
# Reviewer: hive-a2a (kimi-k2.5, qwen3.5-plus, glm-5-turbo)

## Summary

| Review Area | Verdict | 🔴 Red | 🟡 Yellow | 🟢 Green |
|-------------|---------|--------|-----------|----------|
| 1. Architecture Boundary | PASS | 0 | 0 | 0 |
| 2. Transport/Lifecycle | PASS | 0 | 2 | 2 |
| 3. Data Structure/Repair Context | PASS | 0 | 0 | 0 |
| 4. Test Coverage | PASS | 0 | 2 | 1 |

**Overall Verdict: PASS** - No critical issues found in Phase 3 implementation.

---

## 1. Architecture Boundary Review

**Status**: LGTM from all lenses

Key findings:
- `maybeRunExternalReviewSlot()` correctly gates on `reviewResult.passed` (line 108)
- External review only triggers after internal review fails
- Advisory-only semantics: external findings appended but don't override pass/fail
- Hive retains source-of-truth for merge/repair/replan decisions
- Clean fallback: zero replies or errors return original `reviewResult`

---

## 2. Transport/Lifecycle Review

**Findings:**

| Sev | File:Line | Issue |
|-----|-----------|-------|
| 🟡 | mcp-server/index.ts:439 | Truncated diff - may hide error handling in plan_discuss_collab propagation |
| 🟡 | config/model-lessons.json:109 | Missing newline at EOF |
| 🟢 | config/model-profiles.json:113 | Normal score update (statistical recalculation) |
| 🟢 | config/model-profiles.json:164 | Normal score update (statistical recalculation) |

**Review room transport semantics:**
- `openReviewRoom()` / `closeDiscussRoom(room_kind='review')` payload types are consistent
- `external-review-summary` type correctly selected in `closeDiscussRoom` (line 212-213)
- `min_replies=0` with `NON_BLOCKING_REPLY_GRACE_MS=2500ms` provides reasonable quick-reply window
- Clean fallback paths: zero replies (line 251-253) and adapter errors (line 305-307) both return original review result

---

## 3. Data Structure/Repair Context Review

**Status**: LGTM from all lenses

Key observations:
- `external_review_collab` on `ReviewResult` is appropriate - mirrors `worker_discuss_collab` pattern
- Appending findings to `reviewResult.findings` is safe - repair logic processes all findings uniformly
- `yellow` + `lens='external-review'` correctly expresses advisory nature (non-blocking)
- No findings pollution risk - `decision='flag'` (not 'accept'/'dismiss') prevents unintended repair side effects

---

## 4. Test Coverage Review

**Covered paths:**
1. Review brief building with path sanitization (cwd_hint)
2. External advisory findings added when replies arrive
3. Original review result preserved when no replies
4. Room lifecycle: open → collecting → synthesizing → closed/fallback
5. Summary payload type verification (`external-review-summary`)
6. Grace period collection for `min_replies=0`

**Gaps identified (non-blocking for smoke):**
- Multiple replies aggregation logic (only single reply tested)
- Close failure error handling path
- Snapshot publish ordering verification
- Worker-status surface integration

**Recommendation:** Address multiple replies test before Phase 3.5 (recovery rooms).

---

## Exit Criteria Status

| Criteria | Status |
|----------|--------|
| Failed internal review opens `review` room when transport=agentbus | ✅ |
| Reply-free path falls back cleanly | ✅ |
| Advisory findings attached to repair context | ✅ |
| Task-level collab surfaces show `review` rooms | ✅ |
| Hive remains source of truth | ✅ |

**Phase 3 is ready for smoke test.**
