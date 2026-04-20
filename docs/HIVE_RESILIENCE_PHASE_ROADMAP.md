# Hive Resilience Phase Roadmap

Date: 2026-04-10
Status: working roadmap
Owner: codex-planner

## One-line direction

Keep `Hive` as the orchestration control plane, and make it meaningfully more robust by borrowing execution-discipline ideas from `gsd-2` and interaction-shape ideas from `Muse Spark`.

## What this roadmap is trying to do

This roadmap is not trying to:

- replace `Hive` with `gsd-2`
- turn `Hive` into a single-agent runtime
- copy `Muse Spark` product surface before the core loop is stable

This roadmap is trying to:

- reduce execution drift
- reduce hidden failure states
- improve resume / repair correctness
- improve user-visible progress
- make model routing and discuss escalation more mechanical
- build a cleaner base for later product upgrades

## External ideas worth borrowing

### From `gsd-2`

- `fresh session per task`
- packed context injection
- stricter state machine transitions
- failure forensics and recovery
- capability-aware routing
- stronger progress surface

### From `Muse Spark`

- explicit mode split: `Quick / Think / Auto`
- agent-as-product feel instead of backend-only feel
- tool-native workflow instead of model-call-only workflow
- clearer operator feedback during long-running work

## Priority rule

Prioritize items that satisfy all four:

1. lower real failure rate
2. give immediate user-visible improvement
3. have limited blast radius
4. strengthen later phases instead of creating rework

## How we should work

For this roadmap, the operating model is:

- `Codex` acts as planner and produces phase briefs / task breakdowns
- `Hive` executes the implementation work
- each phase lands with tests, run artifacts, and a short closeout note
- phase review happens before opening the next phase

Execution guardrails:

- one phase can contain multiple tasks, but keep one primary theme
- do not mix core runtime hardening with UI polish in the same implementation task
- every task must define validation before coding starts
- every phase should leave behind reusable artifacts under `docs/` or `.ai/runs/`

## Phase order

### Phase 1 - Execution Isolation and Context Discipline

Priority: `P0`

Why first:

- this gives the fastest quality lift
- it directly targets worker drift and context pollution
- it improves both first-pass success and repair quality

Primary goals:

- make every task run in a fresh worker context by default
- inject only task-scoped context, not broad repo noise
- make context packaging explicit and inspectable

Scope:

- define a task context pack artifact
- pre-select files, rules, and goal snippets before dispatch
- harden worktree/session ownership boundaries
- ensure repair rounds also use the same isolation rules

Expected user-visible wins:

- workers wander less
- fewer "it forgot the task boundary" failures
- repair prompts become more targeted

Suggested deliverables:

- `task-context-pack` artifact format
- dispatch-time context builder
- session/worktree isolation rules
- tests for fresh-session and context-pack assembly
- one short design note documenting what enters a worker context

Likely files:

- `orchestrator/dispatcher.ts`
- `orchestrator/worktree-manager.ts`
- `orchestrator/types.ts`
- `orchestrator/worker-status-store.ts`

Acceptance:

- each task dispatch records what context was injected
- repair tasks do not silently reuse polluted session state
- same input produces stable context-pack output
- targeted tests cover at least one multi-task and one repair scenario

Out of scope:

- advanced model routing
- UI redesign

### Phase 2 - State Machine Hardening and Failure Classification

Priority: `P0`

Why second:

- once execution is cleaner, the next biggest problem is hidden ambiguity
- we need to know exactly where a run failed and whether it is resumable

Primary goals:

- tighten run/task state transitions
- classify failures into stable buckets
- make resume and retry semantics explicit

Scope:

- formalize state transitions for planning / dispatch / review / verify / repair / replan
- define failure classes such as `context`, `tool`, `provider`, `build`, `test`, `merge`, `policy`
- persist transition reasons and retry counters in a durable way
- ensure terminal vs resumable failures are mechanically distinguishable

Expected user-visible wins:

- fewer "stuck but unclear why" runs
- easier manual inspection
- better repair prompts because failure cause is clearer

Suggested deliverables:

- state transition matrix
- failure classification schema
- durable transition logging
- tests for retry / replan / blocked edge cases

Likely files:

- `orchestrator/driver.ts`
- `orchestrator/types.ts`
- `orchestrator/reviewer.ts`
- `orchestrator/dispatcher.ts`

Acceptance:

- every failed task has a machine-readable failure class
- `resume` behavior is deterministic for each end state
- tests cover blocked, partial, repairable, and done paths

Out of scope:

- dashboard polish
- long-term memory

### Phase 3 - Progress Surface and Forensics Pack

Priority: `P0`

Why third:

- users need to feel the system is alive
- failures should leave behind evidence, not mystery

Primary goals:

- expose live progress clearly
- persist a compact forensic pack for every failed path

Scope:

- unify loop progress artifact for current phase, focus task, focus worker, reason
- surface progress in CLI and MCP
- persist per-task forensic packs with prompt pointer, context pointer, stdout/stderr tail, verification summary, decision trace

Expected user-visible wins:

- better trust during long runs
- easier postmortem
- faster human intervention when needed

Suggested deliverables:

- progress artifact store
- status/watch integration
- forensic pack schema and writer
- docs for how to inspect failed runs

Likely files:

- `orchestrator/driver.ts`
- `orchestrator/index.ts`
- `mcp-server/index.ts`
- new progress / forensic helper modules

Acceptance:

- a running loop exposes current phase within 1 second of phase change
- a failed task leaves enough artifacts for replay-free diagnosis
- `hive status` can answer "what is it doing now" and "why did it fail"

Out of scope:

- full TUI
- advanced visual design

### Phase 4 - Capability Routing and Mechanical Discuss Gates

Priority: `P1`

Why fourth:

- once the loop is stable and visible, routing improvements become safer
- discuss escalation should become a rule, not a vibe

Primary goals:

- improve model selection quality under cost constraints
- force structured discuss escalation when confidence is low or risk is high

Scope:

- add capability-aware scoring on top of existing routing
- add budget pressure behavior and failure escalation rules
- define discuss triggers using confidence, task shape, and failure class
- enforce discuss gate behavior instead of leaving it prompt-only

Expected user-visible wins:

- cheaper easy tasks
- fewer low-confidence guesses
- review quality becomes more consistent

Suggested deliverables:

- routing score inputs and policy
- observed outcome feedback loop
- discuss gate policy and tests
- reporting that shows why a model was selected or escalated

Likely files:

- `config/model-profiles.json`
- `config/model-lessons.json`
- `orchestrator/dispatcher.ts`
- `orchestrator/discuss-bridge.ts`
- `orchestrator/worker-discuss-handler.ts`

Acceptance:

- routing decisions are explainable
- low-confidence tasks cannot silently skip discuss policy
- failure retry can escalate model tier when configured

Out of scope:

- broad product UX work

### Phase 5 - Operator Modes and Product Feel

Priority: `P1`

Why fifth:

- by this point the core loop should already be more trustworthy
- now product shape can amplify that strength

Primary goals:

- make `Hive` easier to drive and understand
- expose explicit operating modes inspired by `Muse Spark`

Scope:

- introduce `Quick / Think / Auto` mode semantics
- tighten status, watch, and result summaries around those modes
- improve operator-facing wording and handoff surfaces

Expected user-visible wins:

- clearer mental model
- less confusion about when Hive is planning vs executing autonomously
- easier adoption by new users

Suggested deliverables:

- mode contract
- CLI and MCP exposure
- docs and examples for when to use each mode

Acceptance:

- users can intentionally select the depth / autonomy mode
- mode choice changes runtime behavior in observable ways

Out of scope:

- deep memory system

### Phase 6 - Cross-Run Learning and Rule Auto-Selection

Priority: `P2`

Why sixth:

- this is valuable, but it compounds best after earlier phases make artifacts trustworthy

Primary goals:

- learn from prior runs without contaminating current execution
- reduce manual rule/profile assignment

Scope:

- run outcome learning
- rule recommendation or auto-selection
- light project memory for repeated failure patterns

Expected user-visible wins:

- fewer repeated mistakes
- less manual setup for verification profiles and repair hints

Suggested deliverables:

- reusable lesson store
- rule-selection heuristics
- memory guardrails to avoid stale or over-broad recalls

Acceptance:

- repeated failure classes can influence future planning or verification
- auto-selected rules are inspectable and overridable

Out of scope:

- broad human collaboration redesign

### Phase N - Pluggable Worker Backends and Advanced Surfaces

Priority: `P2+`

This is the expansion phase after the core system is materially stronger.

Possible directions:

- pluggable worker backend contracts
- optional `gsd`-style execution backend
- richer TUI / web progress surface
- deeper `AgentBus` / `MindKeeper` convergence
- more tool-native execution flows

Rule:

Do not start this phase until Phases 1-4 are delivering stable value on real runs.

## Immediate recommendation

Start with three tightly-scoped implementation packets:

1. `Phase 1A` - fresh session + context pack
2. `Phase 2A` - failure classification + transition logging
3. `Phase 3A` - loop progress artifact + `hive status` visibility

These three together should produce the biggest "it already feels better" effect.

## Definition of done for each phase

Each phase should close only when all are true:

- implementation landed
- tests added or updated
- one real run or realistic smoke was captured
- docs updated with the new runtime behavior
- open risks are written down before moving on

## Planner note for future execution

When using `Hive` to execute this roadmap, each phase brief should contain:

- one primary objective
- exact files in scope
- validation plan
- blast-radius note
- explicit non-goals

This keeps `Hive` focused and makes it easier to compare planned vs actual outcomes.
