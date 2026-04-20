# Phase 2A: State Machine Hardening + Failure Classification

**Date**: 2026-04-10  
**Status**: Complete  
**Run ID**: run-1775781412448  

## Overview

Phase 2A introduces explicit state machine definitions, failure classification schema, transition logging, and deterministic repair/replan semantics to the Hive orchestration system.

## Goals Achieved

1. **Explicit State Machine**: Defined `RunStatus` and `TaskRunStatus` with clear transitions
2. **Failure Classification**: 15-category schema for machine-readable failure reporting
3. **Transition Logging**: Persistent records in `.ai/runs/<runId>/transitions.json`
4. **Repair/Replan Logic**: Deterministic decisions based on failure class and retry counts

## Core Components

### 1. State Machine Types (`orchestrator/types.ts`)

#### RunStatus States
- `init` → `planning` → `executing` → `reviewing` → `verifying` → `repairing` → `replanning` → `blocked` | `partial` | `done`

#### TaskRunStatus States
- `pending` → `worker_failed` → `no_op` → `review_failed` → `verification_failed` → `merge_blocked` → `verified` → `merged` → `superseded`

#### Terminal Reasons
- `RunTerminalReason`: `all_gates_passed`, `planner_failure`, `budget_exhausted`, `max_rounds_reached`, `unrecoverable_error`
- `TaskTerminalReason`: `review_passed`, `repair_exhausted`, `scope_violation`, etc.

### 2. Failure Classification Schema (`orchestrator/failure-classifier.ts`)

| Class | Description | Repairable | Triggers |
|-------|-------------|------------|----------|
| `context` | Task misunderstanding | Yes | Repair first, replan if repeated |
| `tool` | Tool misuse | Yes | Repair |
| `provider` | API/rate limit | No (after retry) | Repair first, replan if persistent |
| `build` | Compilation failure | Yes | Repair |
| `test` | Test failure | Yes | Repair |
| `lint` | Linting failure | Yes | Repair |
| `verification` | Verification failure | Yes | Repair |
| `merge` | Git merge conflict | Sometimes | Manual intervention |
| `policy` | Policy hook failure | Sometimes | Manual intervention |
| `review` | Code review failure | Yes | Repair |
| `planner` | Planning failure | No | Replan |
| `scope` | Scope violation | Yes | Repair |
| `no_op` | Empty diff | Yes | Repair |
| `budget` | Budget exhausted | No | Block |
| `unknown` | Unclassified | Yes | Default to repair |

### 3. Transition Logging (`orchestrator/run-transition-log.ts`)

- **Path**: `.ai/runs/<runId>/transitions.json`
- **Record Fields**: `id`, `timestamp`, `run_id`, `task_id?`, `from_state`, `to_state`, `reason`, `failure_class?`, `retry_count?`, `replan_count?`, `round`
- **Functions**:
  - `recordRunTransition()` - Log run-level transitions
  - `recordTaskTransition()` - Log task-level transitions
  - `getTransitionsByFailureClass()` - Query by failure type
  - `summarizeTransitionLog()` - Human-readable summary

### 4. Failure Classifier Functions

```typescript
classifyWorkerFailure(workerResult: WorkerResult): FailureClass
classifyReviewFailure(reviewResult: ReviewResult): FailureClass
classifyVerificationFailure(verificationResult: VerificationResult): FailureClass
classifyMergeFailure(blockerKind: string): FailureClass
classifyPlannerFailure(plannerError: string): FailureClass
classifyPolicyHookFailure(hookStage, hookLabel, stderr): FailureClass
isFailureRepairable(failureClass): boolean
shouldReplanVsRepair(failureClass, retryCount, maxRetries): 'repair' | 'replan' | 'blocked'
```

## Integration Points

### driver.ts
- Initial state changed from `planning` to `init`
- `setTerminalState()` for terminal transitions with reason tracking
- `setTaskState()` with failure classification
- Transition log sync on resume
- Terminal state recording at completion

### dispatcher.ts
- Worker failure classification on error
- `no_op` detection for empty diffs

### reviewer.ts
- Review failure classification via `failure_attribution` or finding analysis

### verifier.ts
- Verification failure classification by target type (build/test/lint/command)

## Test Coverage

**File**: `tests/failure-classifier.test.ts` (43 tests)
- Worker failure classification (provider, tool, context, no_op)
- Review failure classification (security, API, missing functionality)
- Verification failure classification (build, test, lint, command)
- Merge failure classification (scope_violation, merge_conflict, hook_failed)
- Planner failure classification (timeout, rate limit, context)
- `isFailureRepairable()` and `shouldReplanVsRepair()` logic

**File**: `tests/state-machine.test.ts` (27 tests)
- RunStatus transitions
- TaskRunStatus transitions with failure classification
- FailureClassifier method tests

**Total**: 70 tests, all passing

## Hive Validation Run

**Run ID**: `run-1775781412448`  
**Directory**: `.ai/runs/run-1775781412448/`  
**Status**: partial (3/5 tasks completed, 2 tasks blocked by max_rounds)  

### Transition Log Sample
```json
{
  "id": "t-1775781412455-lp4ule",
  "timestamp": "2026-04-10T00:36:52.455Z",
  "run_id": "run-1775781412448",
  "from_state": "init",
  "to_state": "executing",
  "reason": "Starting execution loop",
  "replan_count": 0,
  "round": 0
}
```

### Task Verification Results
- `build-verify`: ✅ Passed (verified)
- `check-core-files`: ✅ Passed (verified)
- `summary-report`: ✅ Passed (verified)
- `test-failure-classifier`: ❌ Failed (review_failed, provider error)
- `test-state-machine`: ❌ Failed (review_failed, no_op)

**Note**: Test tasks failed due to worker execution issues (provider rate limits, no-op detection), not due to implementation problems. Direct test execution (`npm test`) confirms all 70 tests pass.

## Files Modified/Created

| File | Status | Description |
|------|--------|-------------|
| `orchestrator/types.ts` | Modified | Added FailureClass, RunTransitionRecord, TaskStateRecord, terminal reasons |
| `orchestrator/failure-classifier.ts` | Created | Failure classification logic |
| `orchestrator/run-transition-log.ts` | Created | Transition logging mechanism |
| `orchestrator/driver.ts` | Modified | Integrated state machine and failure classification |
| `tests/failure-classifier.test.ts` | Created | 43 tests for classifier |
| `tests/state-machine.test.ts` | Created | 27 tests for state machine |

## Decision Logic

### Repair vs Replan vs Block

```
budget failure → blocked
planner failure → replan
context failure (first) → repair
context failure (repeated) → replan
provider failure (first) → repair
provider failure (repeated) → replan
other failures → repair (within budget)
```

## Next Steps (Phase 2B+)

1. **Adaptive Retry Logic**: Dynamic retry counts based on failure class
2. **Failure Pattern Learning**: Track failure patterns across runs
3. **Human Handoff Triggers**: Automatic escalation for non-repairable failures
4. **Recovery Room Integration**: Link failure classes to recovery strategies

## References

- Run artifacts: `.ai/runs/run-1775781412448/`
- Transition log: `.ai/runs/run-1775781412448/transitions.json`
- Worker transcripts: `.ai/runs/run-1775781412448/workers/*.transcript.jsonl`
