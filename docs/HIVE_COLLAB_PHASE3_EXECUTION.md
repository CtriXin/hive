# Hive Collaboration Phase 3 Execution Plan

Date: 2026-04-04
Status: implementation complete, pending external review
Owner: codex-planner

## Purpose

This document is the executable brief for Phase 3 of the Hive collaboration stack.

Phase 3 exists after:

- Phase 2 worker discuss transport
- Phase 2.5 task-level collab surface

and before:

- recovery / repeated-fail advisory rooms
- MindKeeper room linkage
- agent-im human bridge

Its job is to add one post-cascade external advisory slot for failed review outcomes without changing Hive's review source-of-truth.

## Phase 3 Goal

Turn failed internal review results into a short-lived `review` room that outside sessions can advise on.

Expected outcome:

1. after internal review fails, Hive can open a `room_kind=review` room on AgentBus
2. another session can reply with repair guidance or challenge likely false positives
3. Hive persists the review room through the existing collab surfaces
4. external replies become advisory findings added to the repair context
5. if AgentBus fails or nobody replies, Hive continues with the original internal review result

## Explicit Non-Goals

Do **not** implement any of the following in Phase 3:

- replacing the internal review cascade
- making external review a hard gate for merge
- review rooms for already-passed tasks
- model-based synthesis for external review replies
- multi-room history beyond the existing task-level collab slot
- recovery / repeated-fail rooms
- agent-im / Discord / MindKeeper wiring

## Runtime Rule

Phase 3 keeps Hive as the review authority.

That means:

- internal `reviewCascade()` still decides pass/fail
- external `review` room runs **after** the cascade and only when the review already failed
- external replies are advisory repair context, not a second source of truth
- zero replies or AgentBus errors fall back to the existing internal review result

## Implementation Slice

### 1. Review room transport

Add:

- `ReviewBrief`
- `CollabRoomKind = 'plan' | 'task_discuss' | 'review'`
- `openReviewRoom()` and `external-review-summary` close payload
- `collab.review_transport`, `collab.review_timeout_ms`, `collab.review_min_replies`

Transport default:

- `review_transport`: `off`
- opt-in path: `agentbus`

### 2. Post-cascade advisory slot

New handler:

- `orchestrator/review-room-handler.ts`

Behavior:

- build a compact `ReviewBrief` from failed `ReviewResult`
- open review room
- collect quick advisory replies
- synthesize replies with a lightweight merge
- append advisory findings with lens `external-review`
- preserve existing failed review result when no replies arrive

### 3. Surface reuse

No new host schema.

Reuse:

- `CollabCard`
- `CollabStatusSnapshot`
- `worker-status.json`
- compact / restore
- MCP execution / dispatch cards
- hiveshell dashboard / `hive workers` / `hive status`

Rule:

- latest task-level room wins the existing worker `collab` slot
- run-level active room continues to use `loop-progress.json`

## Files

Primary files:

- `orchestrator/collab-types.ts`
- `orchestrator/agentbus-adapter.ts`
- `orchestrator/review-room-handler.ts`
- `orchestrator/driver.ts`
- `orchestrator/types.ts`

Focused tests:

- `tests/agentbus-adapter.test.ts`
- `tests/review-room-handler.test.ts`
- `tests/worker-status-store.test.ts`
- `tests/compact-packet.test.ts`
- `tests/mcp-surface.test.ts`
- `tests/hiveshell-dashboard.test.ts`

## Validation

Passed locally:

- `npm test -- tests/agentbus-adapter.test.ts tests/review-room-handler.test.ts tests/worker-status-store.test.ts tests/compact-packet.test.ts tests/mcp-surface.test.ts tests/hiveshell-dashboard.test.ts`
- `npm run build`

## Exit Criteria

1. failed internal review can open a `review` room when transport=`agentbus`
2. reply-free path falls back cleanly to the original internal review result
3. advisory replies are attached to repair context as `external-review` findings
4. task-level collab surfaces can show `review` rooms without new schema work
5. Hive remains the source of truth for merge / repair / replan decisions
