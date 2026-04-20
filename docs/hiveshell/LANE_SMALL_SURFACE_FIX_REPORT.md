# auto-execute-small Surface Consistency Fix

> Date: 2026-04-11
> Problem: lite path was incorrect — `status=done` with `must_pass && passed=false`
> in `verification_results`, and advisory boundary was too broad.

## Problem

Before fix, `auto-execute-small` (verification_scope: `minimal`) had two issues:

### Issue 1: Suite verification polluted small task results
1. Ran full suite verification (build + npm test) despite `minimal` contract
2. `_smokeResults[taskId] = false` when worktree build failed
3. Phase 4 → `suiteVerificationPassed = false` → `replan` next action
4. `allow_replan: false` → repair disabled → `partial + repair disabled by mode contract`

### Issue 2: Advisory boundary too broad (over-correction)
1. Made ALL verification advisory for minimal mode
2. Even required `must_pass` build checks became non-blocking
3. Result: `status=done` with `TypeScript build passed=False, must_pass: true`

## Fix

### orchestrator/driver.ts

**Phase 3** — suite verification respects contract:
```typescript
const effectiveConditions = modeContract.verification_scope === 'minimal'
  ? minimalSuiteConditions(spec.done_conditions)
  : suiteScopedConditions(spec.done_conditions);
```
Task-level suite verification skipped for minimal modes.

**Phase 4** — narrowed advisory boundary:
```typescript
// Only minimal-scoped checks are blocking.
const minimalCheckKeys = new Set(
  minimalSuiteConditions(spec.done_conditions).map(conditionKey),
);
const minimalSuiteChecksPassed = suiteResults
  .filter((r) => minimalCheckKeys.has(conditionKey(r.target)))
  .every((r) => !r.target.must_pass || r.passed);

// Suite non-blocking when minimal required checks passed.
// Out-of-scope failures (scope:suite) are advisory for minimal modes.
const suiteVerificationNonBlocking = modeContract.verification_scope === 'minimal'
  && allReviewsPassed
  && minimalSuiteChecksPassed;
```

Key distinction:
- **Smoke checks** (per-worktree build): advisory for minimal modes
- **Minimal suite checks** (merged codebase build): still blocking
- **Out-of-scope suite checks** (npm test, lint): advisory for minimal modes

Result: `status=done` only when minimal required build check actually passes.

### `minimalSuiteConditions()` helper

Filters done_conditions to keep only `scope:'both'` and `type:'build'` conditions,
excluding `scope:'suite'` conditions (npm test, lint).

## Tests

### `tests/minimal-verification-scope.test.ts` — 4 passing
Tests `minimalSuiteConditions()` filtering logic.

### `tests/minimal-advisory-boundary.test.ts` — 5 passing
Tests Phase 4 `suiteVerificationNonBlocking` decision:
1. Suite fail but minimal build pass → non-blocking = true (done allowed)
2. Minimal build fail → non-blocking = false (done blocked)
3. No suite conditions, build passes → done allowed
4. Empty suite results edge case
5. execute-standard does not use advisory bypass (documented)

## Contract Verification Matrix

| Property | auto-execute-small | Behavior |
|---|---|---|
| `verification_scope` | `minimal` | Only build check, no suite tests |
| `allow_repair` | `false` | Not reached — task succeeds |
| `allow_replan` | `false` | Not reached — task succeeds |
| `discuss_gate` | `disabled` | Not triggered |
| `dispatch_style` | `single` | 1 worker |
| `review_intensity` | `light` | 1/1 passed |

## Finalize mismatch fix

> Added: 2026-04-11
> Problem: `partial + finalize` when repair/replan disabled by mode contract

### What went wrong

When `auto-execute-small` had a worker/review failure, the Phase 2 repair-disabled
and Phase 1 replan-disabled branches both set:
```
status = 'partial'
next_action = 'finalize'   ← WRONG
```

This left a false terminal surface: `status=partial` but `next_action=finalize`,
with `final_summary` saying "verification passed" despite review/worker failure.

Run evidence: `run-1775897594580` — `status=partial`, `next_action.kind=finalize`.

### Fix

**`orchestrator/driver.ts`** — two locations:

1. **Replan disabled (Phase 1, ~line 1892):**
   Before: `setLoopPhase(spec.cwd, currentState, 'partial', 'finalize', ...)`
   After:  `next_action = 'request_human'`, proper summary with review counts

2. **Repair disabled (Phase 2, ~line 2000):**
   Before: `setLoopPhase(spec.cwd, currentState, 'partial', 'finalize', ...)`
   After:  `next_action = 'request_human'`, proper summary with review counts

Both branches now correctly set `request_human` instead of `finalize`, because
when repair/replan is disabled by mode contract, the only correct path is to
escalate to human intervention.

### Rerun evidence

| Run | status | next_action.kind | review | build |
|-----|--------|------------------|--------|-------|
| run-1775897594580 (before fix) | partial | `finalize` ← WRONG | 0/1 | ❌ |
| run-1775902489891 | partial | `request_human` ← FIXED | 1/1 | ❌ build_fail |
| run-1775902658393 | partial | `request_human` ← FIXED | 1/1 | ❌ build_fail |

`next_action.kind` is now consistently `request_human` for all failure paths.
No more `finalize` on `partial`/`blocked` states.

### Why this is confirmed

The two `setLoopPhase(..., 'finalize', ...)` calls in repair/replan disabled
branches are replaced with direct `makeNextAction('request_human', ...)`.
The ONLY path to `finalize` is now the Phase 4 success gate:
```
allReviewsPassed && (smoke checks OK) && (suite checks OK) && no merge blocks
```

## Sign-off

`auto-execute-small` surface is now consistent:
- Successful execution → `status=done`, `next_action=finalize`, "verification passed"
- Required build check fails → NOT `done` (properly blocks)
- Out-of-scope suite failures → advisory, don't block minimal mode task
- No `partial + repair disabled`, no spurious `request_human`
