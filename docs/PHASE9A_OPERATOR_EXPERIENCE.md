# Phase 9A: Operator Experience Pack

**Date**: 2026-04-11
**Status**: implemented
**Theme**: Action-oriented operator summaries and next-action hints

## Problem

Hive has rich execution artifacts (state, progress, forensics, steering, provider health) but lacks a unified interpretation layer. Operators face:

1. **Status without synthesis** — raw fields displayed but no "what's happening" summary
2. **Failures without prioritization** — multiple failures shown but no "main blocker" identification
3. **Next steps implicit** — operator must infer what to do from scattered signals
4. **Inconsistent watch/status language** — different output styles for same concepts

## Solution

A minimal operator experience pack that adds:
1. **Run Summary** — `overall_state`, `primary_blocker`, `top_successes`, `top_failures`
2. **Next Action Hints** — explainable, priority-ranked suggestions (top 3)
3. **Enhanced watch/status** — unified summary section, hints section, consistent terminology

## Architecture

### A. Run Summary Generator (`orchestrator/operator-summary.ts`)

Generates structured `RunSummary` from existing artifacts:

```typescript
interface RunSummary {
  run_id: string;
  overall_state: 'done' | 'partial' | 'blocked' | 'paused' | 'running';
  primary_blocker?: BlockerItem;
  top_successes: SuccessItem[];     // max 3
  top_failures: FailureItem[];       // max 3
  next_action_hints: NextActionHint[]; // max 3
  summary_text: string;
}
```

**Design principles**:
- Conclusion first — `overall_state` is immediately clear
- Action-oriented — `primary_blocker` tells what's stopping progress
- Bounded output — max 3 items per category to avoid overwhelming

### B. Hints Engine (`orchestrator/operator-hints.ts`)

Generates priority-ranked action suggestions from run state:

```typescript
interface OperatorHint {
  action: HintAction;  // resume_run, replan, inspect_forensics, etc.
  priority: 'high' | 'medium' | 'low';
  description: string;
  rationale: string;
  evidence: string[];
  task_id?: string;
}
```

**Hint types**:
| Action | Trigger | Priority |
|--------|---------|----------|
| `resume_run` | Run paused via steering | high |
| `request_human_input` | `request_human` next action | high |
| `provider_wait_fallback` | Provider circuit open/degraded | high/medium |
| `check_budget` | Budget blocked or low ratio | high/medium |
| `replan` | Task failed 2+ retries | high |
| `review_findings` | Review failures detected | high |
| `rerun_stronger_mode` | Task failed once | medium |
| `inspect_forensics` | First failure | medium |
| `retry_later` | Repair round in progress | medium |
| `steering_recommended` | Pending steering actions | low |
| `merge_changes` | Tasks completed | low |

**Ordering**: Sorted by priority (high → medium → low), limited to top 5.

### C. Watch Integration (`orchestrator/watch-format.ts`)

Enhanced `formatWatch()` with two new sections:

1. **Summary** — one-line conclusion + key signals (provider issues, steering pending)
2. **Next Actions** — top 3 hints with icon + description + rationale

```
== Summary ==
✅ DONE — all tasks completed
⚠️ Provider provider-a open (rate_limit)

== Next Actions ==
‼️ [high] Review merged changes
   why: All tasks completed — review before next run
```

### D. Status Integration (`orchestrator/index.ts`)

`hive status` enhanced with new sections after existing output:

```
== Operator Summary ==
📊 overall: running | round 2/6
✅ 2 task(s) completed:
   - task-a (merged)
   - task-b
❌ 1 task(s) failed:
   - task-c (build, 2 retries)
⚠️  blocker: Task task-c failed (2 retries)

== Next Actions ==
‼️ [high] Replan after task-c failed 2 times
   why: Task task-c repeatedly failed — consider replanning
▶️ [medium] Continue repair round
   why: Repairing failed tasks
```

### E. Unified Terminology

Key terms aligned across watch/status:
- `overall_state` — consistent state classification
- `mode` — always shows effective mode (with steering override indicator)
- `provider health` — same breaker states (healthy/degraded/open/probing)
- `steering` — paused, pending, applied, rejected uniformly described

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `orchestrator/operator-summary.ts` | **New** | Run summary generation from artifacts |
| `orchestrator/operator-hints.ts` | **New** | Next action hints engine |
| `orchestrator/watch-format.ts` | Modified | Added Summary + Next Actions sections |
| `orchestrator/watch-loader.ts` | Modified | Exported `loadProviderHealth()` for reuse |
| `orchestrator/index.ts` | Modified | Enhanced `hive status` with operator summary + hints |
| `tests/operator-summary.test.ts` | **New** | 18 tests for summary generation |
| `tests/operator-hints.test.ts` | **New** | 20 tests for hint generation |

## Design Guardrails

1. **No new state source** — summary/hints derived 100% from existing artifacts
2. **Bounded output** — max 3 summaries, max 5 hints to avoid overwhelming
3. **Explainable** — every hint has `rationale` and `evidence` fields
4. **Conclusion first** — `overall_state` shown before details
5. **Graceful fallback** — handles missing artifacts without crashing
6. **CLI-first readability** — plain text output, no fancy UI required

## Verification

### Build
```bash
npm run build  # passes
```

### Tests
```
 Test Files  2 passed (2)
      Tests  38 passed (38)
```

### Manual smoke
```bash
hive status --run-id <id>   # shows operator summary + hints
hive watch --once           # shows summary + next actions sections
```

## What This Does NOT Do

- No web dashboard
- No TUI framework
- No Discord/agent-im integration
- No authority-layer refactoring
- No new state persistence layer

## Blast Radius

### Changed
1. `hive status` output extended with new sections (additive, backward compatible)
2. `hive watch` output extended with Summary + Next Actions sections
3. New modules `operator-summary.ts` and `operator-hints.ts` (no breaking changes)

### NOT Changed
1. Run state machine — unchanged
2. Steering actions — unchanged
3. Provider resilience — unchanged
4. Existing test expectations — unchanged

## Pending Risks

1. **Hint accuracy** — hints are heuristics, may occasionally suggest suboptimal actions
2. **Output length** — status output longer; may scroll for operators with many tasks
3. **State inference** — `overall_state` is inferred, not authoritative (source of truth remains `RunState.status`)

## Usage Examples

```bash
# Enhanced status with summary + hints
hive status --run-id run-1234567890

# Live watch with summary section
hive watch

# Single snapshot with operator summary
hive watch --once
```

## Recommended Next Steps

1. **Phase 9B**: Richer forensics surface (task-level failure deep-dive)
2. **Phase 9C**: Historical trend visualization (score trajectories across runs)
3. **Phase 9D**: Human steering UX improvements (easier action submission)

## Archive/Handoff Guidance

For future sessions continuing Hive UX work:

1. **Design docs** — read `docs/PHASE9A_OPERATOR_EXPERIENCE.md` for surface contracts
2. **Key modules** — `operator-summary.ts` and `operator-hints.ts` are the core
3. **Test coverage** — 38 tests cover main scenarios; extend for new hint types
4. **Extension points** — add new hint types in `operator-hints.ts` generator functions
