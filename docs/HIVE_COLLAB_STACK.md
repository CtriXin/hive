# Hive Collaboration Stack

Date: 2026-04-02
Status: active working plan

## Goal

Build a combined system where:

- `Hive` owns execution
- `AgentBus` owns async multi-session collaboration
- `agent-im` owns human/session visibility and intervention
- `MindKeeper` owns memory, recall, and checkpoint restore

This is not a replacement plan for Hive.
This is a composition plan.

Implementation briefs:

- [docs/HIVE_COLLAB_PHASE1_EXECUTION.md](./HIVE_COLLAB_PHASE1_EXECUTION.md) — frozen Phase 1 brief
- [docs/HIVE_COLLAB_PHASE1_5_EXECUTION.md](./HIVE_COLLAB_PHASE1_5_EXECUTION.md) — progress surface / CollabCard / lifecycle events
- [docs/HIVE_COLLAB_PHASE2_EXECUTION.md](./HIVE_COLLAB_PHASE2_EXECUTION.md) — worker discuss via AgentBus

## Core Positioning

### Hive

Owns:

- plan
- dispatch
- review
- verify
- repair / replan
- budget / score
- compact / restore

Does not own:

- room protocol
- async message bus
- Discord / human-facing interaction
- long-term memory substrate

### AgentBus

Owns:

- room
- participant
- message
- receipt
- cursor
- follow-up / close

Does not own:

- task execution
- review / verification
- build / test / repair loop

### agent-im

Owns:

- session visibility
- Discord thread / hub card / permission surface
- human replies into collaboration channels

Does not own:

- Hive runtime decisions
- AgentBus protocol semantics

### MindKeeper

Owns:

- recipe
- checkpoint
- bootstrap / recall
- cross-session / cross-project memory

Does not own:

- runtime orchestration
- message transport

## Control Plane Rule

`Hive` is the control plane.

The other systems are adapters / subsystems:

- Hive -> AgentBus
- Hive -> MindKeeper
- agent-im -> AgentBus
- agent-im -> Hive read-only status surface

Avoid reverse control from AgentBus or MindKeeper into Hive core loop.

## Unified Object Model

The combined system must converge on five shared objects:

### 1. Run

Key:

- `run_id`

Owner:

- Hive

### 2. Task

Key:

- `run_id + task_id`

Owner:

- Hive

### 3. Room

Key:

- `room_id`

Owner:

- AgentBus

### 4. Session

Key:

- `session_id`
- `agent_id`

Owner:

- runtime host / agent-im

### 5. Checkpoint

Key:

- `dst-*`

Owner:

- MindKeeper

## Required Links

Each run should be able to point to:

- related `task_id`s
- related `room_id`s
- active `session_id`s / `agent_id`s
- latest `dst-*` checkpoint

Suggested link record:

```ts
interface CollaborationLink {
  run_id: string;
  task_id?: string;
  room_id?: string;
  room_kind?: 'plan' | 'task_discuss' | 'review' | 'human_review';
  agent_ids?: string[];
  session_ids?: string[];
  discord_thread_id?: string;
  checkpoint_id?: string;
  updated_at: string;
}
```

## Recommended System Shape

```text
Human / Discord / Multi-session
            │
            ▼
      agent-im (I/O bridge)
            │
            ▼
      AgentBus (rooms / bus)
            │
            ▼
 Hive (plan / dispatch / review / verify / repair)
            │
            ▼
 MindKeeper (checkpoint / recall / board / recipe)
```

## Phase 1 MVP

### MVP Target

Make `planner discuss` run through `AgentBus`.

That means:

1. Hive creates a planning room after generating a plan
2. other sessions can reply asynchronously
3. Hive collects replies, synthesizes them, and continues execution

### Why this first

This gives the fastest visible improvement:

- no human relay
- no bridge-doc-only workflow
- plan discussion becomes a real collaboration object
- minimal disturbance to Hive core execution

### Explicit non-goals for Phase 1

Do not include:

- worker discuss via AgentBus
- review rooms
- repair/replan integration
- agent-im integration
- deep MindKeeper integration

## Phase 1 File Plan

### New files in Hive

- `orchestrator/agentbus-adapter.ts`
- `orchestrator/collab-links.ts`

### Main files to update

- `orchestrator/planner-runner.ts`
- `orchestrator/types.ts`
- `mcp-server/index.ts`
- `orchestrator/index.ts`

### Optional first-pass file

- `docs/MCP_USAGE.md`

## Phase 1 Runtime Flow

```text
planGoal()
  -> initial plan
  -> create AgentBus planning room
  -> post compact plan summary
  -> wait for replies (timeout / min_replies)
  -> synthesize replies into PlanDiscussResult
  -> persist room_id into run artifacts
  -> continue execution
```

## Phase 1 Adapter Contract

Suggested minimal adapter:

```ts
export interface AgentBusReply {
  participant_id: string;
  content: string;
}

export interface PlannerDiscussRoom {
  room_id: string;
  join_hint?: string;
}

export async function openPlannerDiscussRoom(input: {
  cwd: string;
  goal: string;
  planner_model: string;
  plan_summary: string;
  participants?: string[];
}): Promise<PlannerDiscussRoom>;

export async function collectPlannerDiscussReplies(input: {
  cwd: string;
  room_id: string;
  timeout_ms: number;
  min_replies?: number;
}): Promise<AgentBusReply[]>;

export async function closePlannerDiscussRoom(input: {
  cwd: string;
  room_id: string;
  summary?: string;
}): Promise<void>;
```

## Configuration Proposal

Add a small collaboration block to Hive config:

```json
{
  "collab": {
    "plan_discuss_transport": "agentbus",
    "plan_discuss_timeout_ms": 15000,
    "plan_discuss_min_replies": 0
  }
}
```

Default behavior should remain compatible:

- `local` = existing in-process discuss path
- `agentbus` = new room-based path

## TODO

### P0

- Create `orchestrator/agentbus-adapter.ts`
- Create `orchestrator/collab-links.ts`
- Add `plan_discuss_room` metadata to planner/run artifacts
- Add `collab.plan_discuss_transport` config support
- Connect `planner-runner.ts` to AgentBus path behind a config switch
- Add one focused test for room metadata persistence

### P1

- Add synthesis helper from AgentBus replies -> `PlanDiscussResult`
- Expose `room_id` in MCP / CLI result output
- Add timeout / min reply rules
- Add one end-to-end smoke with two sessions

### P2

- Extend same pattern to `worker discuss`
- Add room summaries into compact packet
- Add MindKeeper checkpoint link to active room ids
- Add agent-im thread mapping for plan rooms

## Validation Plan

### Minimal validation

1. Hive generates a plan
2. Hive creates an AgentBus room
3. another session joins and replies
4. Hive collects replies and synthesizes `PlanDiscussResult`
5. run artifact contains `room_id`

### CLI / MCP evidence

Expected surfaces after MVP:

- plan output prints room id / join hint
- run artifact contains room id
- compact output can later include active room ids

## Design Guardrails

- Do not let AgentBus drive Hive execution state directly
- Do not make MindKeeper a runtime dependency for Phase 1
- Do not route review / repair through AgentBus yet
- Do not make agent-im a requirement for Phase 1
- Keep Hive as the source of truth for run/task state

## Phase 2 Direction

If Phase 1 works well, next extension should be:

1. `worker discuss -> AgentBus`
2. `run checkpoint -> MindKeeper`
3. `AgentBus room <-> agent-im thread`

That sequence preserves the same layering:

- first collaboration
- then memory
- then human bridge
