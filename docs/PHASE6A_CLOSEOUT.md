# Phase 6A Closeout Report

**Date**: 2026-04-10
**Phase**: 6A - Learning Rule Selection
**Status**: Complete

## Executive Summary

Phase 6A implements a lightweight learning system that extracts lessons from transition logs, applies recency-weighted scoring, and auto-selects routing/verification rules with explainable evidence. All 28 new tests pass with zero regressions to pre-existing test failures.

## Deliverables

### Complete

| Deliverable | Location | Status |
|-------------|----------|--------|
| Lesson Store | `orchestrator/lesson-store.ts` | Complete |
| Rule Selector | `orchestrator/rule-selector.ts` | Complete |
| Type Extensions | `orchestrator/types.ts` | Complete |
| Driver Integration | `orchestrator/driver.ts` | Complete |
| Lesson Store Tests | `tests/lesson-store.test.ts` | 15 tests, all passing |
| Rule Selector Tests | `tests/rule-selector.test.ts` | 13 tests, all passing |
| Design Document | `docs/PHASE6A_LEARNING_RULE_SELECTION.md` | Complete |

## Build & Test Status

```
npm run build:  Passes
npm test:       28 new tests passing, 0 regressions
```

Pre-existing baseline: 7 failing tests (unchanged by Phase 6A):
- `discuss-gate`: 1 failure
- `dispatcher-fallback`: 2 failures
- `model-proxy`: 3 failures
- `prompt-policy`: 1 failure

## What Changed

**6 files created/modified:**

1. **orchestrator/lesson-store.ts** — File-backed lesson store with recency decay (2-day half-life, 7-day max window), 6 lesson kinds (failure_pattern, verification_profile, mode_escalation, provider_risk, repair_strategy, rule_recommendation), minimum 2-observation threshold, extract/refresh/persist cycle
2. **orchestrator/rule-selector.ts** — Priority chain selector (explicit config > project policy > learning auto-pick >= 0.7 > learning suggest 0.4-0.7 > fallback), file pattern matching + description keyword fallback, full basis tracing via `RuleSelectionBasis` union type
3. **tests/lesson-store.test.ts** — 15 tests covering: lesson creation, recency decay curve, observation accumulation, pruning of stale lessons, persistence round-trip, confidence calculation, minimum sample enforcement
4. **tests/rule-selector.test.ts** — 13 tests covering: priority chain ordering, confidence threshold gates, file pattern matching, keyword fallback, explicit config override, basis traceability, fallback behavior
5. **orchestrator/types.ts** — Added `Lesson`, `LessonKind`, `LessonStore`, `RuleSelectionBasis`, `RuleSelectionResult` types
6. **orchestrator/driver.ts** — Integrated `getTaskRule()` and `getTaskVerificationConditions()` with lesson store refresh at loop start

## Key Design Decisions

### 1. Conservative Auto-Selection

Auto-selection requires >= 0.7 confidence AND >= 2 observations. Below 0.7 the rule is logged as advisory only. This prevents noisy single-observation patterns from affecting dispatch in early runs.

### 2. File Pattern Matching Before Learning

Deterministic file patterns (`*.test.ts`, `*.md`, etc.) are checked first. Learning rules only fire when file patterns are absent or ambiguous. This ensures fast, reliable behavior for well-known task types while learning fills the gaps.

### 3. Recency Decay (2-Day Half-Life)

Recent patterns carry more weight. A lesson seen 3 times yesterday has higher confidence than one seen 10 times last week. The 7-day max window prevents stale rules from persisting indefinitely.

### 4. Explicit Config Always Wins

No learning rule can override an explicit `hive.config` assignment. The priority chain is strict: config > policy > learning auto-pick > learning suggest > fallback.

## Bug Fixes During Implementation

- **Recency weight capping**: Initial decay formula could produce weights > 1.0 for future-dated timestamps (clock skew). Added `Math.min(weight, 1.0)` cap.
- **File pattern interception in tests**: Rule selector tests initially hit real file pattern matches instead of exercising the learning fallback path. Fixed by using synthetic task IDs that bypass file pattern matching.
- **Mock completeness**: Early lesson store tests used incomplete mocks missing `runIds` and `evidence` arrays. Fixed to use full `Lesson` objects matching the interface.

## Integration Impact

| File | Change | Impact |
|------|--------|--------|
| `orchestrator/types.ts` | +types | New types for lessons, rule selection basis/results |
| `orchestrator/driver.ts` | +integration | `getTaskRule()`, `getTaskVerificationConditions()`, lesson refresh at loop start |
| `orchestrator/lesson-store.ts` | new | Core lesson extraction and persistence |
| `orchestrator/rule-selector.ts` | new | Priority chain rule selection |

## Known Limitations

1. **Single-run scope**: Lessons are scoped to a single run's transition logs. Cross-run aggregation (Phase 6C) is needed for longer-term pattern detection.
2. **Keyword matching is naive**: Description keyword matching uses simple string inclusion, not semantic similarity. Works for clear signals but may miss nuanced matches.
3. **No lesson conflict resolution**: When multiple lessons suggest different rules for the same task, highest confidence wins. No sophisticated conflict resolution yet.

## Recommendations for Phase 6B+

1. **Adaptive verification conditions**: Derive verification retry counts and strategies from learned verification profiles
2. **Cross-run lesson aggregation**: Persist lessons across runs for long-term pattern detection
3. **Trend detection**: Identify whether failure rates for a provider/task type are increasing or decreasing
4. **CLI lesson dashboard**: `hive lessons` command for operators to inspect current lesson state

## Artifacts

- **Design Document**: `docs/PHASE6A_LEARNING_RULE_SELECTION.md`
- **Lesson Store**: `orchestrator/lesson-store.ts`
- **Rule Selector**: `orchestrator/rule-selector.ts`
- **Test Suites**: `tests/lesson-store.test.ts`, `tests/rule-selector.test.ts`

## Sign-Off

**Implementation**: Complete
**Testing**: Complete (28/28 new tests passing, 0 regressions)
**Documentation**: Complete

**Ready for**: Phase 6B planning
