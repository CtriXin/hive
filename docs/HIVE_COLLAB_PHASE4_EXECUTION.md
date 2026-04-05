# Hive Collaboration Phase 4 Execution Plan

Date: 2026-04-05
Status: implementation complete, smoke passed
Owner: codex-planner

## Purpose

This document is the executable brief for Phase 4 of the Hive collaboration stack.

Phase 4 exists after:

- Phase 3 external review slot
- existing task/run collab surfaces

and before:

- MindKeeper room linkage
- agent-im human bridge
- advisory scoring

Its job is to add one repeated-fail `recovery` advisory room before Hive retries a repair again.

## Phase 4 Goal

Turn repeated repair failure into a short-lived `recovery` room that outside sessions can advise on.

Expected outcome:

1. after a task already failed repair at least once, Hive can open a `room_kind=recovery` room on AgentBus before the next repair attempt
2. another session can reply with root-cause guidance, smallest next repair, or a stop-retrying recommendation
3. Hive persists the recovery room through the existing collab surfaces
4. advisory replies become extra repair findings for the next repair prompt
5. if AgentBus fails or nobody replies, Hive continues with the existing repair findings

## Explicit Non-Goals

Do **not** implement any of the following in Phase 4:

- changing retry budgets or replan rules
- making recovery advisory a hard gate for repair execution
- opening recovery rooms for first-pass review failures
- multi-room history beyond the existing task-level collab slot
- MindKeeper / Discord / human approval wiring
- authority-layer / committee routing

## Runtime Rule

Phase 4 keeps Hive as the repair authority.

That means:

- Hive still decides whether to retry, replan, or request human help
- recovery advisory runs only when the task already has repeated repair failure
- recovery replies are appended to the next repair prompt as advisory findings
- zero replies or AgentBus errors fall back to the current repair findings

## Implementation Slice

### 1. Recovery room transport

Add:

- `RecoveryBrief`
- `CollabRoomKind = 'plan' | 'task_discuss' | 'review' | 'recovery'`
- `openRecoveryRoom()` and `recovery-summary` close payload
- `collab.recovery_transport`, `collab.recovery_timeout_ms`, `collab.recovery_min_replies`, `collab.recovery_after_failures`

Transport default:

- `recovery_transport`: `off`
- opt-in path: `agentbus`
- `recovery_after_failures`: `1` (open before the second repair attempt)

### 2. Repeated-fail advisory slot

New handler:

- `orchestrator/recovery-room-handler.ts`

Behavior:

- build a compact `RecoveryBrief` from the failed review + repair history
- open recovery room
- collect quick advisory replies
- synthesize replies with the same lightweight merge pattern used by review rooms
- append advisory findings with lens `recovery-advisory`
- preserve the existing repair findings when no replies arrive

### 3. Repair prompt integration

Integrate into `driver.ts`:

- before a repeated repair attempt, call the recovery advisory handler
- append returned findings into `buildRepairPrompt()`
- prefix advisory lines so `External Advisory` / `Recovery Advisory` stay readable in the repair prompt
- reuse worker-status / compact / dashboard / MCP surfaces through the existing `collab` slot

## Files

Primary files:

- `orchestrator/collab-types.ts`
- `orchestrator/agentbus-adapter.ts`
- `orchestrator/recovery-room-handler.ts`
- `orchestrator/driver.ts`
- `orchestrator/types.ts`

Focused tests:

- `tests/agentbus-adapter.test.ts`
- `tests/recovery-room-handler.test.ts`
- `tests/worker-status-store.test.ts`
- `tests/compact-packet.test.ts`
- `tests/mcp-surface.test.ts`
- `tests/hiveshell-dashboard.test.ts`

## Validation

Passed locally:

- `npm test -- tests/agentbus-adapter.test.ts tests/review-room-handler.test.ts tests/recovery-room-handler.test.ts tests/worker-status-store.test.ts tests/compact-packet.test.ts tests/mcp-surface.test.ts tests/hiveshell-dashboard.test.ts`
- `npm run build`

Smoke passed:

- recovery room open / reply / close path passed
- `room_kind=recovery` verified
- `recovery-brief` opening payload verified
- `recovery-summary` close payload verified
- `cwd_hint` stayed basename-only (`hive`)
- next repair prompt included `[Recovery Advisory]` findings
- 0-reply fallback path also passed with `quality_gate=fallback`

## Exit Criteria

1. repeated repair failure can open a `recovery` room when transport=`agentbus`
2. reply-free path falls back cleanly to the current repair findings
3. advisory replies are attached to the next repair prompt as `recovery-advisory` findings
4. task-level collab surfaces can show `recovery` rooms without new schema work
5. Hive remains the source of truth for retry / replan / human escalation decisions
