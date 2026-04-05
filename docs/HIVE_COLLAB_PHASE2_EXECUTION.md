# Hive Collaboration Phase 2 Execution Plan

Date: 2026-04-03
Status: draft, ready after Phase 1.5
Owner: codex-planner

## Purpose

This document is the executable implementation brief for Phase 2 of the Hive collaboration stack.

Phase 2 extends the AgentBus pattern from:

- plan-level discuss

to:

- task-level worker discuss

It assumes Phase 1.5 has already landed the shared progress surface.

## Phase 2 Goal

Route worker discuss through AgentBus rooms while keeping Hive as the source of truth for task execution state.

Expected outcome:

1. when worker discuss is triggered, Hive can create a `task_discuss` room
2. the room is seeded with a compact task brief
3. replies are collected asynchronously
4. replies are synthesized into the existing worker `DiscussResult` shape
5. task-level collaboration state is visible through the same `CollabCard` / lifecycle event surface from Phase 1.5
6. failure or zero replies still falls back to the current local discuss path

## Dependency on Phase 1.5

Phase 2 should start only after these foundations exist:

- `CollabCard`
- lifecycle events
- compact / restore wiring for collaboration state
- stable orchestrator identity for room lifecycle

Reason:

- do not add more room kinds before existing rooms are observable

## Explicit Non-Goals

Do **not** implement any of the following in Phase 2:

- review rooms
- repair / replan advisory rooms
- human bridge / agent-im mapping
- Discord thread integration
- MindKeeper runtime linkage beyond existing checkpointing
- replacing worker execution with AgentBus
- letting AgentBus decide task success / failure
- broad room ACL / moderation features

## Trigger Rule

Phase 2 should reuse the current worker discuss trigger semantics.

That means:

- existing thresholds and discuss triggers stay the same
- only the transport behind worker discuss changes

Do not change:

- `discuss_threshold` meaning
- worker model selection
- review cascade routing

## Room Model

Phase 2 introduces:

- `room_kind = 'task_discuss'`

Each task-discuss room should link to:

- `run_id`
- `task_id`
- assigned worker model
- task brief / question

## New Data Shapes

### `TaskDiscussBrief`

Add a task-scoped seed object:

```ts
interface TaskDiscussBrief {
  type: 'task-discuss-brief';
  version: 1;
  created_at: string;
  run_id: string;
  task_id: string;
  goal: string;
  task_description: string;
  assigned_model: string;
  discuss_reason: string;
  cwd_hint: string;
  estimated_files: string[];
  acceptance_criteria: string[];
  questions: string[];
}
```

Rules:

- keep it compact
- no full path leakage
- enough context for another session to reply usefully without needing full Hive state

### `TaskDiscussRoomRef`

Add task-level room metadata:

```ts
interface TaskDiscussRoomRef {
  room_id: string;
  room_kind: 'task_discuss';
  task_id: string;
  transport: 'agentbus';
  reply_count: number;
  timeout_ms: number;
  join_hint?: string;
  created_at: string;
}
```

This should align with the existing plan-room metadata style from Phase 1.

## Runtime Design

### Current worker discuss behavior

```text
dispatcher / discuss path
  -> local discuss helper
  -> merged DiscussResult
  -> continue worker execution
```

### Phase 2 behavior

```text
dispatcher / discuss path
  -> if worker discuss transport == local
       -> existing local discuss
  -> if worker discuss transport == agentbus
       -> create task_discuss room
       -> post TaskDiscussBrief
       -> emit room:opened / card update
       -> collect replies
       -> emit reply:arrived events
       -> if replies > 0:
            -> synthesize into DiscussResult
            -> emit synthesis:* events
            -> close room
       -> if failure or 0 replies:
            -> emit fallback:local
            -> use existing local discuss
  -> continue current worker flow
```

## Scope Boundaries

### Likely files to modify

- `orchestrator/types.ts`
- `orchestrator/agentbus-adapter.ts`
- `orchestrator/dispatcher.ts`
- `orchestrator/discuss-bridge.ts`
- `orchestrator/driver.ts` only if task room refs must be persisted in run artifacts
- `orchestrator/worker-status-store.ts`
- `orchestrator/loop-progress-store.ts`
- `orchestrator/compact-packet.ts`
- `orchestrator/mcp-surface.ts`
- `orchestrator/hiveshell-dashboard.ts`
- `mcp-server/index.ts`
- focused tests for task discuss transport

### Do not touch unless clearly required

- review cascade logic
- repair / replan logic
- reporter logic
- agent-im
- MindKeeper runtime

## File-Level Plan

### 1. `orchestrator/types.ts`

Add:

- `TaskDiscussBrief`
- `TaskDiscussRoomRef`
- any minimal extensions to `CollabCard` needed for `room_kind: 'task_discuss'`

Do not:

- add speculative room types beyond what this phase needs

### 2. `orchestrator/agentbus-adapter.ts`

Extend the adapter pattern used for plan rooms:

- open task discuss room
- post task brief
- collect replies
- return room refs and reply metadata

Keep it thin:

- no task-quality judgment in the adapter

### 3. `orchestrator/dispatcher.ts`

Branch the transport in the worker discuss path.

Required behavior:

- preserve current trigger semantics
- preserve current fallback to local discuss
- record task room metadata when AgentBus is used

### 4. `orchestrator/discuss-bridge.ts`

If needed, reuse the current merge / synthesis logic so AgentBus replies can end as the same `DiscussResult` shape.

Do not:

- create a second incompatible task discuss result type

### 5. Progress and artifact surfaces

Reuse the Phase 1.5 short card path.

Required consumers:

- worker status surface
- compact packet
- hiveshell dashboard
- MCP short views where worker discuss status matters

## Validation Requirements

### Build

- `npm run build`

### Focused tests

At minimum:

- task discuss chooses `agentbus` when configured
- task discuss falls back to local on adapter error
- task discuss falls back to local on zero replies
- task discuss with reply produces valid `DiscussResult`
- task-level `CollabCard` appears in progress surfaces
- no full path leakage in `TaskDiscussBrief`

### Practical smoke

Acceptable smoke for Phase 2:

1. force one task into worker discuss
2. create `task_discuss` room
3. another session joins and replies
4. Hive collects replies and produces worker `DiscussResult`
5. task status / compact surface shows the room card

## Merge Acceptance

Phase 2 is acceptable to merge if:

- existing local worker discuss still works
- task discuss can run through AgentBus with a real reply
- task discuss falls back cleanly on zero replies or adapter failure
- task room metadata is visible in progress surfaces
- Hive remains the source of truth for task execution state
- no review / repair / human bridge logic is pulled into this phase

## Follow-up After Phase 2

Natural next stages:

1. review rooms
2. repeated-fail advisory rooms
3. MindKeeper room linkage
4. agent-im thread mapping
