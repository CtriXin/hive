# Hive Real Smoke Matrix

Date: 2026-04-07
Status: latest-main validation closeout reached
Owner: codex-planner

## Why this file exists

The collaboration stack has already reached Phase 7 plus the first authority-layer merge.
Most slices are unit-tested and build-clean, but real smoke should now focus on:

- runtime transport behavior
- host-visible surfaces on latest `main`
- honest authority fallback behavior
- combined restore / compact / dashboard rendering

This file is the practical checklist for that work.

Quick closeout guide: see `docs/hiveshell/PHASE_CLOSEOUT_CHECKLIST.md`.

## Current baseline

Already green on latest `main`:

- `npm run build`
- `npm run test:smoke`
- targeted authority + collab tests

Historically real-smoked already:

- planner discuss (`room_kind=plan`)
- worker discuss (`room_kind=task_discuss`)
- recovery advisory (`room_kind=recovery`)

Freshly re-confirmed on current `main`:

- external review two-session smoke (`room_kind=review`)
- combined compact / restore / dashboard surface smoke with room refs + bridge refs + advisory + authority
- authority runtime honesty for `model synthesis` vs `heuristic fallback` vs `fail_closed`
- MCP `run_status` / `compact_run` / tools registration surfaces

## Priority bands

Use this rule:

- `P0` = run before starting another large feature phase
- `P1` = strong regression value, but can be delegated after `P0`
- `P2` = optional or future-slice dependent

## Matrix

| ID | Priority | Area | Goal | Current state | Suggested executor |
|---|---|---|---|---|---|
| SMK-001 | P0 | Latest-main baseline | Reconfirm build + structural smoke on current `main` | PASS on latest `main` | any agent |
| SMK-002 | P0 | External review room | Verify real two-session `review` room lifecycle | PASS on latest `main` | dual-terminal agent |
| SMK-003 | P0 | Authority runtime | Verify honest authority surfaces for model / heuristic / fail_closed paths | PASS across all 3 subcases on latest `main` surfaces | codex or strong reviewer agent |
| SMK-004 | P0 | Surface integration | Verify `hive shell` / `hive compact` / `hive restore` and dashboard carry collab + bridge + advisory + authority together | PASS on latest `main` | any careful agent |
| SMK-005 | P1 | Planner / task / recovery regression | Reconfirm old room kinds after authority merge only if runtime drift is suspected | Historical smoke passed | delegated agent |
| SMK-006 | P1 | MCP surfaces | Reconfirm `run_status` / `compact_run` / tools list after latest merge | PASS on latest `main` | delegated agent |
| SMK-007 | P2 | Human bridge runtime | Real downstream `agent-im` posting if/when runtime exists | Not in scope yet | later |

## Detailed checklist

### SMK-001: Latest-main baseline

Run:

```bash
npm run build
npm run test:smoke
```

Pass means:

- TypeScript compiles
- provider baseline checks pass
- no obvious repo-shape regression was introduced

Evidence to keep:

- command exit code
- final line counts, especially `26 passed, 0 failed`

### SMK-002: External review two-session smoke

Purpose:

- validate the only remaining room kind that is implementation-complete but not yet re-smoked on latest `main`

Must verify:

- room opens as `room_kind=review`
- payload type is `review-brief`
- reply is collected through real AgentBus transport
- close payload type is `external-review-summary`
- no full cwd path leaks; only basename hint
- review findings are appended as advisory context, not as a transport error

Recommended setup:

- isolated `AGENTBUS_DATA_DIR`
- Terminal A runs Hive side
- Terminal B joins / watches / replies

Evidence to capture:

- `room_id`
- `orchestrator_id`
- `participant_id`
- payload types seen on open and close
- `response_time_ms`
- one snippet showing basename-only `cwd_hint`

### SMK-003: Authority runtime smoke

Purpose:

- verify that the merged authority layer is honest at runtime, not only in unit tests

Required subcases:

1. `model synthesis` path
   - expect `authority.synthesized_by=<model>`
   - expect no fake `heuristic` label
2. `heuristic fallback` path
   - expect `authority.synthesized_by` absent
   - expect `authority.synthesis_strategy=heuristic`
   - expect synthesis token accounting still recorded
3. `fail_closed` path
   - expect verdict `BLOCKED`
   - expect no score update side effects
   - expect failure reason mentions `fail_closed`

Preferred validation surfaces:

- worker/review summary line
- report summary output
- `hiveshell-dashboard`
- run artifacts if generated

Evidence to capture:

- exact summary line for each path
- whether `synth=` renders as model vs `heuristic`
- one proof that token stage for attempted synthesis still exists

### SMK-004: Combined surface integration smoke

Purpose:

- ensure all host-visible surfaces still read well after Phase 5/6/7 plus authority merge

Run at least:

```bash
hive shell
hive compact
hive restore
```

Must verify:

- collab room summaries still render
- `Mindkeeper linked rooms` renders when `room_refs` exist
- `Human bridge threads` renders when `bridge_refs` exist
- `Advisory` section renders when advisory history exists
- `Authority` section renders without hiding advisory / bridge sections

Pass condition:

- all four surface families can coexist in one latest-main render without truncation or misleading labels

Evidence to capture:

- one shell/dashboard snippet
- one compact snippet
- one restore snippet

### SMK-005: Historical room-kind regression pack

Re-run only if:

- room schema changes again
- adapter lifecycle code changes again
- surface output starts drifting

Targets:

- `plan`
- `task_discuss`
- `recovery`

Current status:

- historical smokes already passed
- not mandatory immediately after the latest authority merge

### SMK-006: MCP surface regression

Run if you want one more host-side confidence pass:

- `run_status`
- `compact_run`
- tools list / MCP registration

Purpose:

- confirm that compact and status surfaces did not regress after the latest merge chain
- note: if an external MCP harness reports `Transport closed`, distinguish harness transport issues from local Hive MCP behavior before treating it as a product regression

## Recommended execution order

If time is limited, do exactly this:

1. `SMK-001` latest-main baseline
2. `SMK-002` external review two-session smoke
3. `SMK-003` authority runtime smoke
4. `SMK-004` combined surface integration smoke

That sequence gives the highest signal for the least effort.

## Latest closeout snapshot

Validated on 2026-04-07:

- `SMK-001`: latest `main` baseline remained green (`build` + `test:smoke`)
- `SMK-002`: real two-session `review` room smoke passed; open=`review-brief`, close=`external-review-summary`, basename-only `cwd_hint`, room closed cleanly
- `SMK-003`: driver/report/shell all render authority honestly:
  - `model synthesis` -> `synth=gpt-5.4`
  - `heuristic fallback` -> `synth=heuristic`
  - `fail_closed` -> `synth=blocked(gpt-5.4)` with failure reason preserved and no score side effects
- `SMK-004`: `shell` / `compact` / `restore` carried collab + advisory + authority + bridge + mindkeeper surfaces together without truncation or misleading labels
- `SMK-006`: local MCP stdio client saw `10` registered tools and both `run_status` / `compact_run` returned expected surfaces

## Suggested split across parallel agents

- Agent A: `SMK-002` external review two-session smoke
- Agent B: `SMK-004` combined surface integration smoke
- Agent C: `SMK-006` MCP regression smoke
- Codex/main thread: `SMK-003` authority runtime smoke and triage

## Minimal report template

Use this exact shape when another agent reports back:

```text
Smoke ID:
Result: PASS | FAIL
Environment:
Commands:
Key evidence:
- room_id / run_id:
- payload type(s):
- summary snippet:
- path leakage check:
Notes:
```

## Exit rule for the current stage

For the current post-merge stage, we can call real smoke coverage "good enough" when:

- `SMK-001` passes on latest `main`
- `SMK-002` passes once on latest `main`
- `SMK-003` covers all 3 authority subcases once
- `SMK-004` passes once on latest `main`

After that, the stack is in a good place to start the next product phase without pretending unit tests replaced runtime validation.
