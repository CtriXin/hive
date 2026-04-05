# Hive Collaboration Phase 7 Execution Plan

Date: 2026-04-05
Status: minimal slice implementation complete
Owner: codex-planner

## Purpose

This document is the executable brief for Phase 7 of the Hive collaboration stack.

Phase 7 exists after:

- Phase 6 human bridge linkage
- existing plan / task_discuss / review / recovery rooms
- compact / dashboard / restore host-visible surfaces

and before:

- authority-layer routing
- runtime `agent-im` posting
- any feedback loop that changes executor model scores

Its job is to add a separate advisory-scoring surface for collaboration participants without polluting executor scoring.

## Phase 7 Goal

Start turning collaboration replies into a lightweight scored signal.

Expected outcome:

1. Hive can persist per-reply advisory signals under the current run artifact directory
2. plan / task_discuss / review / recovery replies all map into one shared score shape
3. advisory scoring stays separate from executor pass-rate / review pass-rate metrics
4. compact / restore / dashboard can surface the top current advisors for the run
5. no routing or merge decision depends on these scores yet

## Explicit Non-Goals

Do **not** implement any of the following in Phase 7:

- changing `ModelCapability.pass_rate` or executor routing with advisory scores
- making advisory score a merge gate or repair gate
- using authority-layer committee logic
- introducing a global cross-run leaderboard
- requiring full reply text persistence in host-visible surfaces
- changing AgentBus transport semantics

## Minimal Slice

### 1. One run-local artifact

Write one artifact:

- `.ai/runs/<run_id>/advisory-score-history.json`

It should persist:

- raw per-reply signals
- aggregate participant summaries
- run-local summary counts

### 2. Shared scoring heuristic

Use the light heuristic proposed in early Phase 1 discussion:

```text
advisory_score =
  0.3 * timeliness
  0.3 * substance
  0.4 * adoption
```

For this minimal slice:

- `timeliness` = full credit inside the fast window, then linear decay to timeout
- `substance` = lightweight heuristic from content length plus task/file/action hints when available
- `adoption` = whether the reply made it into the synthesized output path for that room

This is intentionally provisional.

### 3. Room coverage in this slice

Capture advisory signals from:

- planner discuss (`plan`) when reply metadata exists in a persisted run
- worker discuss (`task_discuss`) when AgentBus synthesis completes inside a run
- external review slot (`review`)
- repeated-fail advisory (`recovery`)

### 4. Host-visible surfaces

Update only the smallest accepted surfaces:

- `hiveshell-dashboard.ts`
- `compact-packet.ts`
- compact restore prompt

Show:

- total scored replies
- adopted reply count
- top advisor summaries for the current run

## Validation

Local validation for the minimal slice:

- `npm test -- tests/advisory-score.test.ts tests/hiveshell-dashboard.test.ts tests/compact-packet.test.ts tests/mcp-surface.test.ts tests/review-room-handler.test.ts tests/recovery-room-handler.test.ts tests/planner-runner-transport.test.ts tests/worker-discuss-transport.test.ts`
- `npm run build`

## Delivered in the minimal slice

- `orchestrator/advisory-score.ts` for scoring, aggregation, persistence, and formatting
- run-local `advisory-score-history.json` artifact generation
- planner discuss advisory signals persisted from run-time room metadata
- task / review / recovery advisory signals persisted at collection time
- hiveshell dashboard now renders an `Advisory` section
- compact packet / restore prompt now surface `advisory_focus`

## Follow-up items

- improve planner discuss scoring with richer reply-text adoption instead of metadata-only fallbacks
- decide later whether advisory scores should age across runs or stay run-local until proven useful
- if authority-layer wants to consume these signals later, do it through a separate adapter instead of mutating executor scores
