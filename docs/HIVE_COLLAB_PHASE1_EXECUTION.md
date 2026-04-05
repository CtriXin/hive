# Hive Collaboration Phase 1 Execution Plan

Date: 2026-04-02
Status: implemented, smoke-validated, frozen
Owner: codex-planner

## Purpose

This document is the executable implementation brief for Phase 1 of the Hive collaboration stack.

It is intentionally narrower than `docs/HIVE_COLLAB_STACK.md`.

Phase 1 is now complete. Keep this file as the frozen implementation record for planner discuss via AgentBus.

Successor briefs:

- `docs/HIVE_COLLAB_PHASE1_5_EXECUTION.md` — CollabCard + lifecycle events + compact wiring + Finding 1 fix
- `docs/HIVE_COLLAB_PHASE2_EXECUTION.md` — worker discuss via AgentBus

Use this document when:

- another agent needs to implement the work
- another planner needs to review the implementation direction
- Hive execution should be scoped tightly and cheaply

## Phase 1 Goal

Route **planner discuss** through `AgentBus` rooms while keeping Hive as the source of truth for run/task state.

Expected outcome:

1. Hive still generates plans in its normal flow
2. planner discuss can run in one of two modes:
   - `local` (existing behavior)
   - `agentbus` (new behavior)
3. when `agentbus` mode is enabled:
   - a planning room is created
   - a compact plan summary is posted into the room
   - replies are collected asynchronously
   - replies are synthesized into a `PlanDiscussResult`
   - room metadata is persisted into Hive artifacts

## Explicit Non-Goals

Do **not** implement any of the following in Phase 1:

- worker discuss via AgentBus
- review rooms
- repair / replan integration
- agent-im integration
- MindKeeper runtime integration
- room-to-Discord mapping
- human approval workflows
- replacing existing local discuss flow
- modifying `orchestrator/discuss-bridge.ts` in Phase 1

## Scope Boundaries

### Allowed files to add

- `orchestrator/agentbus-adapter.ts`
- tests directly related to the adapter and planning-room metadata

### Allowed files to modify

- `orchestrator/planner-runner.ts`
- `orchestrator/types.ts`
- `mcp-server/index.ts`
- `orchestrator/index.ts`
- optional: `docs/MCP_USAGE.md`

### Do not touch

- `orchestrator/dispatcher.ts`
- `orchestrator/driver.ts`
- `orchestrator/reviewer.ts`
- `orchestrator/minimax-smoke.ts`
- `orchestrator/diagnostics.ts`
- `tests/diagnostics.test.ts`
- `api/`
- `.hive/config.json`
- `config/model-capabilities.json`
- `config/model-profiles.json`

## Runtime Design

### Existing flow

```text
planGoal()
  -> generate plan
  -> optional local discuss
  -> continue
```

### Phase 1 flow

```text
planGoal()
  -> generate plan
  -> if collab.plan_discuss_transport == "local"
       -> existing local discuss via discuss-bridge.ts:discussPlan()
  -> if collab.plan_discuss_transport == "agentbus"
       -> planner-runner.ts branches before calling discussPlan()
       -> create AgentBus planning room
       -> post compact plan summary
       -> collect replies with timeout / min replies
       -> if room creation / collection fails, fall back to local discuss
       -> synthesize replies into PlanDiscussResult using one cheap model pass
       -> persist room metadata
  -> continue
```

## Configuration Proposal

Add a new optional config block under Hive config:

```json
{
  "collab": {
    "plan_discuss_transport": "local",
    "plan_discuss_timeout_ms": 15000,
    "plan_discuss_min_replies": 0
  }
}
```

### Semantics

- `plan_discuss_transport`
  - `"local"` = current path
  - `"agentbus"` = new room-based path
- `plan_discuss_timeout_ms`
  - max wait time for async replies
  - default `15000`
- `plan_discuss_min_replies`
  - minimum reply count before synthesis
  - `0` means: do not block the run if no replies arrive
  - default `0`

### Compatibility rule

If `collab` is absent, Hive must behave exactly as before.

## New Data Shapes

### Planner discuss room metadata

Suggested type:

```ts
interface PlannerDiscussRoomRef {
  room_id: string;
  transport: 'agentbus';
  reply_count: number;
  timeout_ms: number;
  join_hint?: string;
  created_at: string;
}
```

## File-Level Plan

### 1. `orchestrator/agentbus-adapter.ts`

Responsibilities:

- thin bridge from Hive to AgentBus
- no business logic about plan quality
- no Hive run-state mutation

Suggested exports:

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
}): Promise<PlannerDiscussRoom>;

export async function collectPlannerDiscussReplies(input: {
  cwd: string;
  room_id: string;
  timeout_ms: number;
  min_replies?: number;
}): Promise<AgentBusReply[]>;
```

Implementation guidance:

- shortest correct path is acceptable
- prefer programmatic import from `agentbus` over shelling out to CLI
- shelling out is acceptable only if direct import is impractical in the first pass
- keep failure mode explicit and easy to debug
- if AgentBus room creation or reply collection fails, log it and fall back to local discuss

### 2. `orchestrator/planner-runner.ts`

Required changes:

- add `collab` config read
- branch local vs agentbus transport inside `planner-runner.ts` before calling `discussPlan()`
- generate compact plan summary for room seeding
  - prefer reusing an existing compact/planning summary helper if one fits
  - otherwise build a new small planner-specific summary string here
- collect replies
- synthesize to `PlanDiscussResult`
- return room metadata in `PlanGoalResult`

Do not:

- modify planning model selection logic
- modify execution order logic
- add worker-discuss logic here
- move transport branching into `discuss-bridge.ts` for Phase 1

### 3. `orchestrator/types.ts`

Required additions:

- `PlannerDiscussRoomRef`
- new field on `PlanGoalResult` or equivalent result shape:
  - `plan_discuss_room?: PlannerDiscussRoomRef`

Do not:

- add broad collaboration types unrelated to Phase 1
- Note: `PlanGoalResult` currently lives in `orchestrator/planner-runner.ts`, not in `types.ts`

### 4. `mcp-server/index.ts`

Required changes:

- surface `room_id` / `join_hint` in planning output
- keep output concise
- do not dump raw room payloads
- limit Phase 1 to the existing planning output surface; do not add a new MCP tool

### 5. `orchestrator/index.ts`

Required changes:

- surface room info in CLI planning output if applicable
- keep old behavior unchanged when no room exists

## Synthesis Strategy

AgentBus replies need to become a `PlanDiscussResult`.

Phase 1 decision:

- use one cheap model summarization pass
- input = compact plan summary + raw AgentBus replies
- output = existing `PlanDiscussResult` shape
- reuse the existing `safeQuery` pattern already used by Hive discuss helpers
- use the `discuss` tier model from config for the summarization pass
- treat this extra model call as an intentional collaboration cost for Phase 1

Do not:

- over-design a complex schema parser
- require all participants to return strict JSON in Phase 1
- introduce a second discuss result shape for AgentBus transport

## Artifact Requirements

At minimum, after a successful AgentBus-backed plan discuss, Hive should persist:

- `room_id`
- reply count
- transport
- timeout used
- optional join hint

Phase 1.5 preferred additions:

- `last_reply_at`
- short room status (`open|collecting|synthesizing|fallback|closed`)
- `focus_task_id`
- one short `next` field for host-facing output

Persistence targets:

- plan result structure
- MCP / CLI output summary
- later: `loop-progress.json` / compact / restore

## Validation Requirements

### Build

- `npm run build`

### Focused tests

At minimum:

- adapter behavior test
- planner-runner transport branch test
- MCP or CLI output test for room metadata

### Practical smoke

Acceptable smoke for Phase 1:

1. run planner with `transport=agentbus`
2. verify room was created
3. inject or simulate reply
4. verify result contains room metadata

True multi-session end-to-end is a stretch goal, not a merge blocker for Phase 1.

## Review Checklist

When reviewing an implementation, check these first:

1. Did the implementation preserve `local` discuss as the default/fallback?
2. Did it keep Hive as source of truth for run/task state?
3. Did it avoid touching worker discuss / repair / replan?
4. Is `room_id` persisted into artifacts?
5. Does `planner-runner.ts` branch before calling `discussPlan()`?
6. Does AgentBus failure fall back to local discuss?
7. Are errors explicit instead of silently degrading?
8. Did it avoid modifying unrelated files listed above?

## Merge Acceptance

Phase 1 is acceptable to merge if:

- build passes
- focused tests pass
- `agentbus` transport works at least in a controlled/focused path
- room metadata is visible and persisted
- local discuss path still works

## Future Follow-up (Not for this phase)

After Phase 1 lands:

1. worker discuss via AgentBus
2. compact packet includes active room references
3. introduce a dedicated `collab-links` persistence layer once multiple room kinds exist
4. MindKeeper checkpoint includes room links
5. agent-im displays room-linked planning status
