# Hive Collaboration Phase 1.5 Execution Plan

Date: 2026-04-03
Status: ready for implementation
Owner: codex-planner

## Purpose

This document is the executable implementation brief for Phase 1.5 of the Hive collaboration stack.

Phase 1.5 exists between:

- completed Phase 1 planner discuss transport
- future Phase 2 worker discuss transport

Its job is to make existing collaboration rooms observable before adding new room kinds.

Use this document when:

- implementing the next collaboration slice after Phase 1 smoke
- reviewing scope for `CollabCard` and lifecycle events
- wiring collaboration state into compact / restore / status surfaces

## Phase 1.5 Goal

Turn the existing plan-level AgentBus room into a host-visible progress surface.

Expected outcome:

1. Hive emits structured lifecycle events for planner discuss rooms
2. Hive exposes a short `CollabCard` instead of only ad-hoc room text
3. compact / restore / status surfaces can show active collaboration state
4. planner room lifecycle uses one stable orchestrator identity
5. no new room kinds are introduced yet

## Inputs from Phase 1

Already complete:

- planner discuss via AgentBus
- structured `PlanningBrief`
- room metadata in planner result
- two-session smoke
- `min_replies=0` grace window

Known deferred item entering Phase 1.5:

- Finding 1: stable orchestrator identity across open / collect / close

## Explicit Non-Goals

Do **not** implement any of the following in Phase 1.5:

- worker discuss via AgentBus
- review rooms
- repair / replan rooms
- human bridge or agent-im thread mapping
- MindKeeper runtime integration beyond existing checkpoint usage
- room ACL / permissions
- human-readable synthesis brief rewrite from raw JSON
- broad `collab-links.ts` persistence for all future room kinds

## Product Rule

Events before capabilities.

Before adding `task_discuss` or `review` rooms, the existing `plan` room must have:

- lifecycle events
- a stable short card
- compact / restore visibility

## Scope Boundaries

### Allowed files to modify

- `orchestrator/types.ts`
- `orchestrator/agentbus-adapter.ts`
- `orchestrator/planner-runner.ts`
- `orchestrator/driver.ts` if a lightweight snapshot must ride with run state
- `orchestrator/loop-progress-store.ts`
- `orchestrator/compact-packet.ts`
- `orchestrator/mcp-surface.ts`
- `orchestrator/hiveshell-dashboard.ts`
- `orchestrator/index.ts`
- `mcp-server/index.ts`
- focused tests for the new card / event / compact behavior

### Do not touch unless strictly required

- `orchestrator/dispatcher.ts`
- `orchestrator/reviewer.ts`
- worker execution flow
- review cascade logic
- `agent-im`
- `MindKeeper` runtime behavior

## New Data Shapes

### `CollabCard`

Add a compact host-facing collaboration card:

```ts
interface CollabCard {
  room_id: string;
  room_kind: 'plan';
  status: 'open' | 'collecting' | 'synthesizing' | 'closed' | 'fallback';
  replies: number;
  last_reply_at?: string;
  join_hint?: string;
  focus_task_id?: string;
  next: string;
}
```

Phase 1.5 rule:

- `room_kind` is fixed to `'plan'`
- `focus_task_id` is normally absent for plan rooms
- keep this card small enough for compact / status / MCP reuse

### `CollabLifecycleEvent`

Add a lightweight event shape:

```ts
interface CollabLifecycleEvent {
  type:
    | 'room:opened'
    | 'reply:arrived'
    | 'synthesis:started'
    | 'synthesis:done'
    | 'fallback:local'
    | 'room:closed';
  room_id: string;
  room_kind: 'plan';
  at: string;
  reply_count?: number;
  focus_task_id?: string;
  note?: string;
}
```

Rules:

- do not model a generic event bus for all future phases yet
- keep the payload flat and host-consumable
- enough detail for compact / status / dashboard, not raw room internals

### Optional wrapper

If needed, add a tiny wrapper such as:

```ts
interface CollabStatusSnapshot {
  card: CollabCard;
  recent_events: CollabLifecycleEvent[];
}
```

Prefer this over broad run-state churn.

## Runtime Design

### Current Phase 1 behavior

```text
executePlannerDiscuss()
  -> open room
  -> collect replies
  -> synthesize or fallback
  -> return room metadata
```

### Phase 1.5 behavior

```text
executePlannerDiscuss()
  -> open room with stable orchestrator id
  -> emit room:opened
  -> update card(status=open/collecting)
  -> collect replies
  -> on each newly seen reply:
       -> emit reply:arrived
       -> update card(replies, last_reply_at, next)
  -> if replies > 0:
       -> emit synthesis:started
       -> update card(status=synthesizing)
       -> synthesize
       -> emit synthesis:done
       -> close room
       -> emit room:closed
       -> update card(status=closed, next=done)
  -> if replies == 0 or adapter fails:
       -> emit fallback:local
       -> update card(status=fallback, next=continuing with local)
       -> run existing local discuss
```

## Stable Orchestrator Identity Fix

Fix Finding 1 in this phase.

Required behavior:

- one room lifecycle uses one consistent orchestrator identity
- the same ID is used for:
  - room creation
  - opening broadcast
  - optional summary / close message

Acceptable implementation options:

1. return `orchestrator_id` from `openPlannerDiscussRoom()` and thread it through
2. add a room session object that contains `room_id`, `join_hint`, `orchestrator_id`

Do not:

- generate a fresh orchestrator ID inside every adapter function

## Wiring Targets

### compact / restore

At minimum, compact output should include the current `CollabCard` when present.

Required fields:

- `room_id`
- `status`
- `replies`
- `last_reply_at` if available
- `join_hint` if available
- `next`

### CLI / MCP / hiveshell

Replace the current one-line room summary with the same short card semantics.

Required consumers:

- `hive status`
- `hive watch`
- compact packet
- MCP short plan card

Preferred behavior:

- all consumers render from one shared card shape
- no consumer inspects raw AgentBus messages directly

## File-Level Plan

### 1. `orchestrator/types.ts`

Add:

- `CollabCard`
- `CollabLifecycleEvent`
- optional `CollabStatusSnapshot`

Keep Phase 1.5 narrow:

- only `room_kind: 'plan'` is needed now
- do not add speculative fields for future room kinds unless already justified

### 2. `orchestrator/agentbus-adapter.ts`

Required changes:

- thread one stable orchestrator identity across room lifecycle
- optionally expose enough metadata so planner-runner can emit correct events

Do not:

- move plan-quality logic into the adapter
- turn the adapter into a generic state manager

### 3. `orchestrator/planner-runner.ts`

Required changes:

- produce lifecycle events during the AgentBus path
- update the current `CollabCard` as the room progresses
- preserve the current fallback behavior

Do not:

- add worker discuss
- change planner model routing

### 4. Progress surfaces

Primary files:

- `orchestrator/loop-progress-store.ts`
- `orchestrator/compact-packet.ts`
- `orchestrator/mcp-surface.ts`
- `orchestrator/hiveshell-dashboard.ts`
- `orchestrator/index.ts`

Required changes:

- persist or derive a current collaboration snapshot
- show the card consistently across surfaces

### 5. `mcp-server/index.ts`

Keep the output concise.

Do:

- surface the short card
- keep `room_id` clickable / visible

Do not:

- add a new MCP tool for this phase

## Validation Requirements

### Build

- `npm run build`

### Focused tests

At minimum:

- stable orchestrator identity test
- lifecycle event emission test
- compact packet includes `CollabCard`
- status / MCP rendering uses the short card
- fallback path updates card to `fallback`

### Practical smoke

Acceptable smoke for Phase 1.5:

1. open a planner discuss room
2. inspect one progress surface while replies are pending
3. confirm `reply:arrived` updates reply count and `last_reply_at`
4. confirm synthesis or fallback updates `status` and `next`
5. confirm compact / restore contains the card

## Merge Acceptance

Phase 1.5 is acceptable to merge if:

- Phase 1 behavior still works unchanged
- one stable orchestrator identity is used per plan room lifecycle
- lifecycle events exist for the plan room path
- compact / restore can show current collaboration state
- CLI / MCP / hiveshell render one short card instead of ad-hoc text
- no worker discuss code path is introduced yet

## Next Stage

After Phase 1.5 lands:

1. worker discuss via AgentBus
2. optional human-readable synthesis brief upgrade
3. later room kinds (`review`, `recovery`)
