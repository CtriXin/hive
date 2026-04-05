# Hive Collaboration Phase 2.5 Execution Plan

Date: 2026-04-03
Status: implementation complete, pending external review
Owner: codex-planner

## Purpose

This document is the executable brief for Phase 2.5 of the Hive collaboration stack.

Phase 2.5 exists after:

- Phase 2 worker discuss transport

and before:

- future review / recovery room kinds

Its job is to make `task_discuss` rooms durable on task-level host surfaces, not only as the current loop's active snapshot.

## Phase 2.5 Goal

Turn worker discuss collaboration from a transient loop-progress snapshot into a reusable task-level surface.

Expected outcome:

1. worker discuss `CollabStatusSnapshot` persists with the worker status artifact
2. `hive workers` can show task-level collab details after the discuss finishes
3. compact / restore carries the focused worker's collab card
4. MCP execution / dispatch cards surface the focused worker's collab state
5. hiveshell dashboard shows recent task-level collab rooms, not only the active loop room

## Explicit Non-Goals

Do **not** implement any of the following in Phase 2.5:

- new room kinds
- review / repair / recovery transport
- multi-room archival database
- room replay tooling
- agent-im / Discord wiring
- MindKeeper room linkage
- model-based worker synthesis upgrade

## Runtime Rule

Phase 2.5 reuses the existing Phase 1.5 / Phase 2 shapes:

- `CollabCard`
- `CollabStatusSnapshot`
- lifecycle events already emitted by planner / worker discuss

Do not invent a second task-collab schema.

## Implementation Slice

### 1. Persist task-level collab on worker status

Extend `WorkerStatusEntry` with:

```ts
collab?: CollabStatusSnapshot;
```

Write rule:

- when worker discuss snapshot updates, store the cloned snapshot on the worker entry
- later status transitions (`running` / `completed` / `failed`) must preserve the stored snapshot unless a newer one arrives

Why:

- `loop-progress.json` only carries the current active room
- `worker-status.json` is the right task-level artifact

### 2. Compact packet

Extend `CompactPacketWorker` with:

```ts
collab?: CollabCard;
```

Required rendering:

- worker focus section includes the focused worker's room id / status / replies / next
- restore prompt mentions the primary worker's collab room when present

### 3. MCP / CLI / dashboard

Required consumers:

- `summarizeExecutionCard()`
- `summarizeDispatchCard()`
- `hive workers`
- `hive status`
- hiveshell dashboard

Rendering rule:

- run-level active room still uses `loop-progress.collab`
- task-level worker rooms render from `worker-status.json`
- dedupe by `room_id` when the active loop room is the same room already shown elsewhere

## Files

Primary files:

- `orchestrator/types.ts`
- `orchestrator/worker-status-store.ts`
- `orchestrator/dispatcher.ts`
- `orchestrator/compact-packet.ts`
- `orchestrator/mcp-surface.ts`
- `orchestrator/hiveshell-dashboard.ts`
- `orchestrator/index.ts`

Focused tests:

- `tests/worker-status-store.test.ts`
- `tests/worker-discuss-transport.test.ts`
- `tests/compact-packet.test.ts`
- `tests/mcp-surface.test.ts`
- `tests/hiveshell-dashboard.test.ts`

## Validation

Passed locally:

- `npm test -- tests/worker-status-store.test.ts tests/worker-discuss-transport.test.ts tests/compact-packet.test.ts tests/mcp-surface.test.ts tests/hiveshell-dashboard.test.ts`
- `npm run build`

## Exit Criteria

1. focused worker keeps its task discuss room after completion
2. compact restore prompt names the primary worker collab room when present
3. MCP execution / dispatch cards show focused worker collab lines
4. dashboard renders task-level collab cards in addition to the active loop room
5. build passes without widening collaboration boundaries
