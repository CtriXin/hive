# RC2 Closeout: Stabilization + Flaky Test Cleanup

**Date**: 2026-04-12
**Status**: delivered
**Branch**: main
**Baseline**: 1215/1215 tests pass (was 1178/1192 with 14 failing)
**Build**: `npm run build` passes cleanly

---

## One-Line Summary

Diagnosed and fixed 14 failing tests across 3 test files, verified CLI/MCP surface consistency and artifact integrity, no new features added.

---

## Scope

| Area | What Was Done | Method |
|------|--------------|--------|
| Test failure diagnosis | 14 failures across 4 files classified | Read code, traced data flow, verified runtime behavior |
| Test fixes | 3 files, 4 minimal changes | Fixed syntax error, added missing mock methods, updated stale test data |
| CLI surface verification | hive status, watch, compact, steer | Ran commands against real runs, verified output structure |
| MCP surface verification | run_status, compact_run, resume_run, submit_steering | Traced code paths, verified section parity with CLI |
| Artifact verification | provider-health.json, worker-status.json, worker-events.jsonl | Validated JSON structure, checked field presence |

---

## Findings

### A. Test Failures (14 total, all fixed)

| Test File | Failures | Root Cause | Fix |
|-----------|----------|------------|-----|
| `operator-summary.test.ts` | 1 (parse error) | Missing closing `}` for `describe('provider-facing surface')` — file had unclosed brace | Added missing `});` |
| `hive-config-full.test.ts` | 3 | `canResolveForModel` method not in mock registry; inline mock had all providers same causing exclusion | Added `canResolveForModel: () => true` to mock; fixed inline mock to differentiate failed model's provider |
| `reviewer-authority.test.ts` | 10 | Authority policy mock listed `kimi-k2.5` and `MiniMax-M2.5` as primary candidates, but these are blocked by hard filter (`provider_resolution_failed`) at runtime — `chooseAuthorityReviewers` returned 0 reviewers, causing `'single'` mode instead of `'pair'` | Updated primary_candidates to `claude-sonnet-4-6`, `claude-opus-4-6` (only models that pass hard filter in current config) |

### B. Surface Consistency Audit

| Surface Pair | Consistency | Notes |
|-------------|-------------|-------|
| CLI status vs MCP run_status | consistent | Same sections: Operator Summary, Next Actions, Quick Commands, Collaboration |
| CLI watch vs CLI status | consistent | Shared state machine, same terminology |
| CLI compact vs MCP compact_run | consistent | Same packet format, same fields |
| CLI steer vs MCP submit_steering | consistent | Same action types, same validation |
| Provider health terms | consistent | `healthy/degraded/open/probing` across all surfaces |
| Artifact JSON structure | valid | provider-health.json, worker-status.json, worker-events.jsonl all well-formed |

### C. Artifact Integrity Check

| Artifact | Present | Well-formed | Notes |
|----------|---------|-------------|-------|
| `provider-health.json` | yes | yes | 0 providers (no failures recorded in recent runs — expected) |
| `worker-status.json` | yes | yes | 6 worker entries with task_id, status, assigned_model |
| `worker-events.jsonl` | yes | yes | Event log present |
| `state.json` | no | n/a | Not created for artifact-only runs (no execution loop) |
| `score-history.json` | no | n/a | Not created for artifact-only runs |
| `loop-progress.json` | no | n/a | Not created for artifact-only runs |

Missing artifacts (state.json, score-history.json, loop-progress.json) are expected — these are only written during actual execution rounds, not during planning/artifact-only runs.

---

## Actual Fixes

### Fix 1: operator-summary.test.ts syntax error

**File**: `tests/operator-summary.test.ts:530`

**What changed**: Added missing `});` closing brace for `describe('provider-facing surface')` block.

**Before**: File had 603 lines with unclosed `{` (final depth = 1). Parse error prevented all tests from running.

**After**: File has 604 lines with balanced braces. All 23 tests in this file pass.

**Blast radius**: Zero — test file only.

### Fix 2: hive-config-full.test.ts mock incompleteness

**File**: `tests/hive-config-full.test.ts`

**What changed**:
1. Added `canResolveForModel: () => true` to `mockRegistry` (line 94) — `resolveFallback` calls this method on the registry but the mock didn't have it
2. Fixed inline mock in "returns fallback_worker when different from failed model" test — the mock made ALL models return the same provider, which meant the failed model's provider was excluded and all candidates were also excluded, causing fallback to return the failed model instead of the configured fallback_worker

**Before**: 3 tests failed with `canResolveForModel is not a function` and wrong model selection.

**After**: All 15 tests pass.

**Blast radius**: Zero — test file only.

### Fix 3: reviewer-authority.test.ts stale candidate models

**File**: `tests/reviewer-authority.test.ts`

**What changed**: Updated `primary_candidates` in `defaultAuthorityPolicy` mock from `['kimi-k2.5', 'MiniMax-M2.5']` to `['claude-sonnet-4-6', 'claude-opus-4-6']`.

**Root cause**: The authority layer's `chooseAuthorityReviewers` function filters candidates through `rankModelsForTask` + hard filter. In the current runtime config, `kimi-k2.5` and `MiniMax-M2.5` are blocked by `provider_resolution_failed` (the hard filter checks for working provider routes). Only claude models pass the hard filter. With 0 available candidates, the review cascade stayed in `'single'` mode instead of escalating to `'pair'`.

**Before**: 10 tests failed with `expected 'single' to be 'pair'`.

**After**: All 14 tests pass.

**Blast radius**: Zero — test file only. The test validates the authority pair mechanism, not specific model IDs.

---

## Verification

### Build
```
npm run build  # passes
```

### Tests
```
Test Files  100 passed (100)
Tests       1215 passed (1215)
```

### Manual CLI
- `hive status` — shows run state, round, workers, summary ✓
- `hive watch --once` — shows watch data (when available) ✓
- `hive compact` — produces valid restore packet ✓
- `hive steer` — shows steering status ✓

---

## What Was NOT Done (Out of Scope)

| Item | Why |
|------|-----|
| New features | Stabilization only — no new capabilities |
| Roadmap changes | Out of scope |
| Large refactoring | Out of scope |
| MMS core changes | Explicitly excluded |
| Provider resolution fix for kimi/MiniMax | Separate infrastructure issue — not a test bug |

---

## Residual Risks

| Risk | Severity | Status |
|------|----------|--------|
| kimi-k2.5 and MiniMax-M2.5 blocked by `provider_resolution_failed` | Medium | Runtime issue — these models can't be selected by authority layer or fallback. Not a test issue. |
| state.json/score-history.json not created for artifact-only runs | Low | Expected behavior — only written during execution rounds |
| Concurrent provider health writes | Low | Stale read at worst, no corruption |
| macOS Keychain popup in sandboxed runs | N/A | Environment boundary |

---

## Readiness

RC2 stabilization is complete. The mainline is:

- **Test-clean**: 1215/1215 tests pass, 0 failures
- **Build-clean**: `npm run build` passes
- **Surface-consistent**: CLI and MCP outputs aligned
- **Artifact-valid**: All expected JSON files well-formed

---

**RC2 is delivered.** All deliverables complete: diagnosis, fixes, verification, closeout.
