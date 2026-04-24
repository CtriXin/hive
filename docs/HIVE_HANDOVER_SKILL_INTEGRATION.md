# Hive × handover skill integration

## Goal

Let Hive reuse the same compact handoff surfaces used by Claude/Codex/manual cheap-model workflows.

## Shared surfaces

Hive should be able to write or update:
- `./.ai/plan/current.md`
- `./.ai/plan/handoff.md`
- `./.ai/plan/packet.json`
- `./.ai/runs/<run-id>/human-progress.md`

## Division of responsibility

### `handover` skill owns
- file roles
- status vocabulary
- required metadata
- compactness rules
- template shape

### Hive owns
- state extraction from runtime
- when to update files
- aggregation from worker state / run state / loop progress / fallback state
- web/watch/dashboard integration

## Required metadata in Hive-written entries

When known, include:
- `ts`
- `agent`
- `cli=hive`
- `model`
- `task_id`
- `run_id`
- `status`

## Human-readable progress

Hive progress should follow the shared status vocabulary:
- `pending`
- `running`
- `waiting`
- `queued_retry`
- `fallback`
- `blocked`
- `request_human`
- `failed`
- `done`

## Recommendation

Implement Hive support as an adapter layer over existing sources:
- worker-status store
- compact packet
- loop progress
- run state next_action

Do not replace those sources.
