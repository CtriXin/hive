# Phase 8B: Human Intervention + Steering Surface

**Date**: 2026-04-11
**Status**: implemented
**Theme**: Structured human steering into the Hive driver loop

## Problem

Hive's autonomous loop (plan → dispatch → review → verify → repair/replan) runs without a practical human intervention surface. When a run gets stuck or goes off track, the operator has no structured way to:
- Pause and resume at a safe point
- Retry or skip a specific task
- Escalate or downgrade execution depth
- Request a replan
- Leave a structured instruction for the next round

Free-text comments in goal strings or manual state edits are not machine-readable and cannot be safely processed by the driver loop.

## Solution

A minimal but real steering surface: machine-readable action schema, durable store, driver loop integration with safe-point application, validation/guardrails, and status visibility.

## Architecture

### A. Steering Action Schema

```
SteeringAction {
  action_id: string        // steer-<timestamp>-<random>
  run_id: string
  task_id?: string         // for task-level actions
  action_type: SteeringActionType
  scope: 'run' | 'task'
  payload: SteeringActionPayload
  requested_by: 'human' | 'mcp' | 'cli' | 'auto'
  requested_at: ISO timestamp
  status: 'pending' | 'applied' | 'rejected' | 'suppressed' | 'expired'
  applied_at?: number      // epoch ms
  outcome?: string         // effect summary or rejection reason
}
```

Supported action types:

| Action | Scope | Effect |
|--------|-------|--------|
| `pause_run` | run | Stop loop at next safe point |
| `resume_run` | run | Resume from paused state |
| `retry_task` | task | Queue task for repair round |
| `skip_task` | task | Mark task as superseded |
| `escalate_mode` | run | Increase execution depth (quick→think→auto) |
| `downgrade_mode` | run | Decrease execution depth (with caution) |
| `request_replan` | run | Force replan at next round |
| `force_discuss` | run | Enable discuss gate on next dispatch |
| `mark_requires_human` | run | Flag run for human intervention |
| `inject_steering_note` | run | Record advisory note (always allowed) |

### B. Steering Store

File-backed: `.ai/runs/<run-id>/steering.json`

```
SteeringStore {
  run_id: string
  actions: SteeringAction[]
  updated_at: ISO timestamp
}
```

Key properties:
- **Idempotency**: duplicate detection within 30s window
- **Auditability**: every action tracked with status, timestamps, outcome
- **Persistence**: file-backed, survives session restarts

### C. Validation Guardrails

Actions are validated against current run state before application:

| Guard | Prevents |
|-------|----------|
| Terminal state check | No actions on done/blocked runs (except inject_steering_note) |
| Task existence check | No retry/skip for non-existent tasks |
| Already-paused check | No double-pause |
| Not-paused check | No resume when not paused |
| Merged-task check | No retry/skip for already-merged tasks |
| Escalation validation | Target mode must increase review intensity |
| Duplicate suppression | Same action type+task within 30s → suppressed |

### D. Driver Loop Integration

Steering is processed at the **top of each round**, after budget check and before round increment — this is the natural safe point between execution cycles.

```
while (round < max_rounds && !terminal) {
  budget check
  → STEERING SAFE POINT ←    ← new
  round += 1
  plan / execute / review / verify / merge
  decide next_action
}
```

Steering effects:
- **pause_run**: sets `state.steering.paused = true`, breaks loop
- **resume_run**: clears paused flag, loop continues
- **retry_task**: overrides `next_action` to `repair_task` with target task
- **skip_task**: marks task as `superseded`, removes from failed set
- **request_replan**: overrides `next_action` to `replan`
- **mark_requires_human**: sets status to `partial`, next_action to `request_human`
- Others: recorded in steering state, visible in status output

### E. Status / MCP Visibility

Three surfaces expose steering state:

1. **CLI `hive status`**: Shows paused status, last applied/rejected action, pending count
2. **CLI `hive steer`**: List actions or submit new ones (`--action`, `--task-id`, `--target-mode`, `--reason`)
3. **MCP `run_status`**: Shows steering state + pending action details
4. **MCP `submit_steering`**: Submit steering actions programmatically

### F. RunState Integration

```
RunState {
  ...
  steering?: RunStateSteering
}

RunStateSteering {
  paused: boolean
  pending_actions: string[]     // action_ids
  last_applied?: { action_id, action_type, outcome, applied_at }
  last_rejected?: { action_id, action_type, reason, applied_at }
}
```

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `orchestrator/types.ts` | Modified | Added 5 new types: `SteeringActionType`, `SteeringScope`, `SteeringActionStatus`, `SteeringActionPayload`, `SteeringAction`, `RunStateSteering`; added `steering` field to `RunState` |
| `orchestrator/steering-store.ts` | **New** | File-backed store: CRUD, duplicate detection, persistence |
| `orchestrator/steering-actions.ts` | **New** | Validation rules + application logic for all action types |
| `orchestrator/driver.ts` | Modified | Added `processSteeringAtSafePoint()` — reads and applies pending steering at round boundary |
| `orchestrator/index.ts` | Modified | Added `hive steer` CLI command, steering display in `hive status` |
| `mcp-server/index.ts` | Modified | Added `submit_steering` MCP tool, steering display in `run_status` |
| `tests/steering-store.test.ts` | **New** | 12 tests for store persistence, CRUD, deduplication |
| `tests/steering-actions.test.ts` | **New** | 25 tests for validation guardrails + application effects |

## Design Guardrails

1. **Safe-point first**: Steering only processed between rounds, never mid-execution
2. **Machine-readable**: Structured action schema, not free text
3. **Explainable**: Every accept/reject has a reason
4. **Idempotent**: Duplicate actions suppressed within window
5. **Respects state machine**: No terminal-state mutation, no fake task retries
6. **Advisory vs imperative**: `inject_steering_note` is always allowed but has no mechanical effect beyond recording
7. **Escalation validated**: Mode escalation must increase review intensity

## What This Does NOT Do

- No web/TUI console
- No multi-user permission system
- No Discord or agent-im integration
- No authority-layer refactoring
- No memory expansion

## Verification

- `npm run build`: passes
- New tests: 37/37 pass (12 store + 25 actions)
- Pre-existing baseline failures unchanged (12 across 7 files — unrelated)
- Total tests: 982 (945 baseline + 37 new)

## Blast Radius

### Changed
1. `RunState` gains optional `steering` field (backward compatible — defaults to undefined)
2. Driver loop adds steering check at round boundary (no-op when no pending actions)
3. MCP gains `submit_steering` tool (additive)
4. CLI gains `hive steer` command (additive)

### NOT Changed
1. State machine transitions — steering respects existing constraints
2. Planning, dispatch, review, verification logic
3. Provider resilience, mode enforcement, project memory
4. Any existing test expectations

## Pending Risks

1. **Pause during active work**: If a run is paused while workers are mid-execution, the pause takes effect at the next round boundary — current round completes. This is by design (safe point), but operators may expect immediate pause.
2. **Mode change persistence**: `escalate_mode` and `downgrade_mode` now update `RunState.runtime_mode_override` and `RunState.mode_escalation_history`, so `watch/status` reads the true current mode. The override is per-run and does not mutate `RunSpec.execution_mode` on disk — it survives within the active run's state.json.
3. **Concurrent steering**: If multiple steering actions arrive while a run is paused, they queue up. On resume, they're processed in order. No race condition since processing is single-threaded in the driver loop.
4. **No undo**: Once a `skip_task` is applied, the task is marked `superseded`. No built-in "undo skip" — would need a new action type.

## Next Phase Recommendation

- Consider adding `undo_skip_task` and `set_task_priority` actions
- Consider persisting mode changes from escalate/downgrade to RunSpec
- Consider integrating with MindKeeper for cross-run steering patterns
- Consider adding `hive watch --steering` for live steering visibility
