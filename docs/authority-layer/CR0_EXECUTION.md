# Hive Authority Layer CR0 Execution Plan

Date: 2026-04-05
Status: ready for parallel design / implementation discussion
Owner: codex-planner

## CR0 purpose

Deliver the first usable `Claude replacer` slice for Hive without destabilizing the current Hive × AgentBus mainline.

CR0 means:

- review authority only
- policy-driven committee routing
- initial profile seeding
- Codex-backed synthesis

It does **not** mean full planner replacement yet.

## Problem statement

Hive currently has a practical dependency on an unreliable external authority path:

- old workflow assumed one premium model could cover plan / review / arbitration
- that assumption is now operationally weak
- domestic models already cover large parts of implementation and review work
- what is missing is not raw capability alone, but a stable authority structure

CR0 solves this by introducing:

- role-based committee review
- explicit escalation rules
- profile-driven model selection
- synthesis by Codex rather than trust in a single reviewer

## Deliverables

### 1. Committee policy

Introduce an authority policy config that can answer:

- when to use `single`
- when to escalate to `pair`
- when to escalate to `jury`
- what counts as disagreement
- what budget cap applies per stage

Minimal suggested shape:

```json
{
  "authority": {
    "review": {
      "default_mode": "pair",
      "max_models": 3,
      "escalate_on": [
        "high_complexity",
        "strict_boundary",
        "low_confidence",
        "disagreement"
      ],
      "primary_candidates": ["kimi-k2.5", "mimo-v2-pro", "qwen3.5-plus", "glm-5.1"],
      "synthesizer": "codex"
    }
  }
}
```

### 2. Review committee runner

Minimal flow:

1. choose primary reviewer
2. optionally choose challenger / jury members
3. collect structured review outputs
4. detect disagreement / overlap / confidence issues
5. synthesize into one final actionable review result

### 3. Seed profile support

Use the existing profile system, not a new one.

Existing files already support this:

- `config/model-profiles.json`
- `config/model-lessons.json`
- `orchestrator/profiler.ts`
- `orchestrator/model-scorer.ts`
- `orchestrator/model-registry.ts`

CR0 should add:

- light-weight seed scores for currently observed committee models
- optional seed notes / lessons for known review behavior

### 4. Human-readable docs

Document:

- topology
- routing rules
- score semantics
- disagreement semantics
- what the committee can and cannot decide

## Design rules

### Rule 1: deterministic verification stays above opinion

Committee review may:

- interpret findings
- challenge false positives
- suggest repairs

Committee review may **not**:

- override a failing build
- override failing smoke/test evidence
- redefine deterministic verification outcomes as "probably OK"

### Rule 2: escalation beats fixed fan-out

Default should be:

- cheapest sufficient authority

Not:

- always run 4 reviewers

Recommended ladder:

1. `single`
2. `pair`
3. `jury`
4. `jury + Codex synthesis`

### Rule 3: Codex is the final synthesis layer

Committee members provide:

- evidence
- objections
- coverage gaps
- alternative repair directions

Codex provides:

- final merged conclusion
- severity normalization
- patch-ready actionable output

### Rule 4: separate this work from the AgentBus mainline

CR0 should happen in a separate worktree and separate doc track.

The Hive × AgentBus mainline remains:

- collaboration transport first
- authority layer second

## Initial architecture

```text
Task / review request
        │
        ▼
Authority policy selector
        │
        ├─ single -> primary reviewer
        ├─ pair   -> primary + challenger
        └─ jury   -> primary + challenger + specialist(s)
        │
        ▼
Structured review outputs
        │
        ▼
Disagreement detector / overlap reducer
        │
        ▼
Codex synthesis
        │
        ▼
Final actionable review result
```

## Proposed model roles for CR0

### Primary reviewer

Best current candidate:

- `kimi-k2.5`

Desired behavior:

- stable severity calibration
- clear pass/fail recommendation
- low hallucination rate on architecture boundary

### Challenger / implementation reviewer

Best current candidate:

- `mimo-v2-pro`

Desired behavior:

- catch lifecycle / implementation issues
- challenge hidden bugs the primary reviewer misses

### Adversarial reviewer

Best current candidate:

- `glm-5.1` or `glm-5-turbo`

Desired behavior:

- intentionally search for blast radius, coupling, and silent regressions

### Checklist / coverage reviewer

Best current candidate:

- `qwen3.5-plus`

Desired behavior:

- enumerate missing tests
- check guard paths / config paths / non-happy paths

### Dispatcher / external coordinator

Best current candidate:

- `gpt-5.x`

Desired behavior:

- assign review angles
- compare outputs
- surface disagreements for Codex synthesis

## Initial disagreement semantics

CR0 does not need complicated probabilistic voting.

Simple disagreement flags are enough:

- one reviewer says `PASS`, another says `must fix before smoke`
- one reviewer claims a behavior is by design, another labels it a bug
- multiple reviewers point at the same file/area but propose incompatible fixes
- one reviewer finds a deterministic failure path others miss

When disagreement happens:

- do not average blindly
- elevate to Codex synthesis
- optionally request one extra targeted reviewer if the dispute is unresolved

## Initial scoring policy

Use the existing profile dimensions.

Suggested mapping:

- planning quality -> `spec_adherence`
- review quality -> `review`
- repair usefulness -> `repair`
- smoke triage / integration judgement -> `integration`
- boundary control -> `scope_discipline`
- latency / response turnaround -> `turnaround_speed`

CR0 rule:

- seed scores are advisory
- keep `samples=1`
- keep `effective_samples` low
- rely on later decay + updates to correct mistakes

## Validation plan

CR0 is ready when all of the following are true:

1. a review request can run without Claude
2. Hive can choose between `single` and `pair` at minimum
3. disagreement can be surfaced explicitly
4. Codex can synthesize committee output into one actionable result
5. initial seed scores influence routing without locking it permanently
6. the Hive × AgentBus mainline remains unaffected unless explicitly wired later

## Explicit non-goals

CR0 should not:

- rewrite `planner.ts`
- replace all review cascade internals at once
- add a new persistence schema unless existing profile files are clearly insufficient
- optimize for global cost first; correctness and stability come first
- block the current AgentBus mainline work

## Main questions for the parallel worktree group

1. Should CR0 start as `pair` by default, or `single` with escalation?
2. Should `mimo` be treated as a general reviewer or a lifecycle specialist only?
3. Should `glm` remain an adversarial specialist or join the default pair for high-risk review?
4. How much structured schema do we need for committee outputs before synthesis?
5. Should committee collection happen via direct dispatch first, or via AgentBus-backed rooms from day one?

