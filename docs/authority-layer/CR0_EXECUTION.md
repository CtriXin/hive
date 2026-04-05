# Hive Authority Layer CR0 Execution Plan

Date: 2026-04-05
Status: narrowed MVP
Owner: codex-planner

## CR0 purpose

Deliver the first usable `review authority without Claude` slice without destabilizing the current Hive mainline.

CR0 is successful when Hive can produce a usable review authority result without treating `Claude` / `Opus` as the only final authority.

## CR0 in one sentence

Use lightweight policy plus a thin review wrapper to introduce `single -> pair -> synthesizer pass` for review authority.

Do **not** build a new parallel review subsystem in CR0.

## What CR0 includes

CR0 includes only these capabilities:

1. seed review-oriented profiles for the current domestic-model committee candidates
2. define one authority policy source for review routing
3. add a thin review entrypoint that can choose:
   - existing review path
   - minimal committee path
4. support explicit escalation from:
   - `single`
   - to `pair`
   - to one synthesis pass
5. keep deterministic verification above model opinion

## What CR0 does not include

CR0 does **not** include:

- planner committee
- default `jury` execution path
- AgentBus-backed committee rooms
- compact / restore persistence for committee state
- dashboard / MCP surface expansion
- auto-learning loop for lessons and score updates
- a rewrite of the current scorer, registry, or full review cascade

## Target shape

CR0 should look like this:

```text
review request
    │
    ▼
runReview()
    │
    ├─ feature off  -> existing reviewCascade()
    └─ feature on   -> authority review wrapper
                        │
                        ├─ single reviewer
                        ├─ escalate to pair when needed
                        └─ synthesizer pass when disagreement or low-confidence remains
```

The key rule is:

- CR0 may wrap the current review system
- CR0 must not create an unrelated second authority stack with overlapping ownership

## Minimal deliverables

### 1. Profile seeds

Add initial review-oriented seeds for:

- `kimi-k2.5`
- `MiniMax-M2.5` (Mimo role at current runtime)
- `glm-5.1`
- `qwen3.5-plus`

Seed data must be treated as low-confidence guidance, not as real observed authority.

### 2. One authority policy source

CR0 needs one authoritative place for:

- `enabled`
- `default_mode`
- `max_models`
- `fallback_order`
- `timeout_ms`
- `partial_result_policy`
- `escalate_on`
- `synthesizer`

Whether this lives inside `review-policy.json` or a new `authority-policy.json` is an implementation choice, but there must be only one source of truth for authority escalation semantics.

### 3. Thin review wrapper

Introduce one entrypoint such as:

- `runReview()`

Behavior:

- if authority mode is disabled, call existing `reviewCascade()`
- if authority mode is enabled, use minimal committee routing

This keeps blast radius small and gives a clean fallback.

### 4. Minimal disagreement handling

CR0 only needs a small disagreement contract.

Treat these as disagreement:

- opposite conclusions on the same change
- same location with severity difference of 2 or more
- deterministic failure path found by one reviewer but missed by another

Do **not** treat these as disagreement in CR0:

- different but compatible fix suggestions
- minor severity drift
- checklist detail differences without verdict impact

### 5. Synthesizer pass

CR0 should run one real synthesis-model pass for disputed or partial committee outputs.

That synthesis pass is responsible for:

- final merged conclusion
- severity normalization
- adopt / reject reasoning
- patch-ready actionable output

## Default topology for CR0

Default CR0 ladder:

1. `single`
2. `pair`
3. `synthesizer pass`

`jury` remains a future extension, not a required CR0 runtime path.

Why:

- it proves the authority-layer idea without 4-model fan-out
- it limits cost and implementation surface
- it avoids turning CR0 into a second full review framework

## Deterministic boundary

Deterministic verification remains above model opinion.

That means:

- failing build / smoke / test cannot be voted away
- committee review may explain the failure, but not override it
- CR0 may still collect advisory review when useful, but final verdict must respect deterministic failure

## Minimal implementation slice

Recommended implementation order:

1. seed profile data
2. define authority policy source
3. add thin `runReview()` wrapper
4. add minimal disagreement detector
5. add minimal synthesis-model handoff

Keep these out of the first patch unless needed:

- new persistence schema
- transport changes
- worker status surface expansion
- score-learning automation

## Success criteria

CR0 is done when all of these are true:

1. Hive can run a review authority flow without `Claude`
2. the system can choose at least between `single` and `pair`
3. disagreement is explicit rather than implicit
4. the synthesizer model can synthesize the final result when needed
5. deterministic verification still wins over model opinion
6. disabling the feature cleanly falls back to the existing review path

## Blockers

These must be resolved before coding deep into CR0:

### 1. Seed semantics

We must define how seed scores influence routing without pretending to be observed authority.

### 2. Policy ownership

We must choose one authority policy source and avoid duplicated escalation semantics.

### 3. Wrapper boundary

We must decide clearly that CR0 is a thin wrapper over existing review flow, not a parallel review subsystem.

### 4. Minimal member output contract

We need a small normalized contract for committee member outputs so disagreement detection is actually implementable.

## Defer items

Push these to later phases:

- `jury` default runtime path
- committee state in compact / restore
- AgentBus committee collection
- dashboard / MCP authority surfaces
- automatic lessons / profile learning loop
- advanced severity mapping tables
- cache reuse and review-angle assignment

## Questions Codex should decide

1. should the default mode be `single` or `pair` in the first implementation?
2. where should the single authority policy source live?
3. how should seed profiles be represented so they affect routing without overstating confidence?
4. should advisory review still run when deterministic verification already failed?
5. should the synthesizer be hardcoded as `gpt-5.4`, or remain policy-selected with `gpt-5.4` as default?

## Guardrail

If a proposed CR0 change does not directly improve `review authority without Claude`, it is probably scope creep.
