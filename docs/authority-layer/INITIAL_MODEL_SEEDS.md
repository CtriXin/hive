# Authority Layer Initial Model Seeds

Date: 2026-04-05
Status: draft seed proposal
Owner: codex-planner

## Purpose

These are the proposed initial seeds for the first non-Claude authority layer experiments.

They are based on:

- recent Hive × AgentBus Phase 3 review behavior
- current review docs from Kimi / Mimo / Qwen / GLM
- actual smoke outcomes already observed in this repo

These are **not** long-term truths.
They are low-confidence starting points.

## Seeding principles

Use the existing profile store only.

Rules:

- `samples = 1`
- `effective_samples` stays low, around `0.35 - 0.70`
- scores are allowed to be overwritten quickly by real runs
- seed what we observed, not what we hope

## Proposed seeds

### kimi-k2.5

Reasoning:

- best calibration in recent Phase 3 review
- closest to a stable primary reviewer
- strongest agreement with actual smoke outcomes

Suggested seed deltas:

- `review = 0.88`
- `spec_adherence = 0.84`
- `scope_discipline = 0.82`

Role recommendation:

- primary review authority

### Mimo role (`MiniMax-M2.5` at current runtime)

Reasoning:

- promising implementation/lifecycle reviewer
- caught at least one real lifecycle-risk style issue
- severity calibration is not yet stable enough for sole authority

Suggested seed deltas:

- `review = 0.74`
- `spec_adherence = 0.72`
- `scope_discipline = 0.70`

Role recommendation:

- lifecycle / implementation reviewer
- challenger in `pair` mode

### qwen3.5-plus

Reasoning:

- useful at checklist and test-coverage review
- tends to over-classify "should add test" as "must fix now"
- still valuable as coverage guardrail

Suggested seed deltas:

- `review = 0.68`
- `spec_adherence = 0.76`
- `scope_discipline = 0.72`

Role recommendation:

- checklist / coverage reviewer

### glm-5.1

Reasoning:

- good adversarial pressure
- more false positives and over-escalation than desired for primary authority
- still useful to expose blast radius and hidden coupling

Suggested seed deltas:

- `review = 0.62`
- `spec_adherence = 0.65`
- `scope_discipline = 0.58`

Role recommendation:

- adversarial reviewer

## Suggested near-term routing

### Cheap path

- single: `kimi-k2.5`

### Standard path

- pair: `kimi-k2.5` + `MiniMax-M2.5`

### High-risk path

- jury: `kimi-k2.5` + `MiniMax-M2.5` + `glm-5.1`

### Coverage-heavy path

- pair: `kimi-k2.5` + `qwen3.5-plus`

## Seed caveats

Do not overfit Phase 3.

Known limits:

- these seeds are heavily review-biased
- they do not prove planner ability
- they do not prove repair quality in long loops
- they do not yet cover doc-writing or synthesis quality well

## Recommended data to collect next

Before strengthening these seeds, gather:

1. review false-positive rate
2. review missed-bug rate
3. disagreement rate against deterministic smoke/build/test
4. synthesis-pass correction rate per reviewer
5. per-role latency / cost / usefulness
