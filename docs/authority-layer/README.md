# Hive Authority Layer

Date: 2026-04-05
Status: proposal / parallel track
Owner: codex-planner

## Why this exists

Hive currently has a growing dependency gap:

- `Claude` is no longer stable enough to act as the only planner / reviewer authority
- even when available again, cost and throughput are unlikely to return to the old baseline
- Hive already has enough domestic-model surface area to replace single-model authority with a structured multi-model authority layer

This folder defines that replacement direction.

This is **not** a side note for the current Hive × AgentBus mainline.
It is a separate product track.

## Core position

Do **not** build a new "Claude clone" abstraction.

Build an `authority layer` on top of Hive instead:

- one model may act as primary
- a second model may challenge
- a third/fourth model may arbitrate when needed
- a dedicated synthesizer model performs final synthesis and tie-break decisions

In other words:

`single strong model` -> `role-based committee` -> `synthesizer pass`

This makes Hive less dependent on any one provider.

## Relation to the Hive × AgentBus mainline

Keep the two tracks separate.

### Hive × AgentBus mainline owns

- collaboration transport
- room lifecycle
- task/run collab surfaces
- compact / restore wiring
- review-room / worker-discuss / future recovery-room transport

### Authority layer owns

- model committee policy
- planner / reviewer / repair authority routing
- disagreement escalation
- score updates for authority roles
- seed profiles, lessons, and future auto-learning

Rule:

- the authority layer may **use** AgentBus
- but it must not destabilize the current Hive × AgentBus mainline while that line is still being smoke-validated and extended

## Product goal

Replace the old implicit assumption:

- "Claude is the strongest single authority"

with a new explicit system:

- "Hive chooses the cheapest sufficient authority topology for this stage"

That topology may be:

- `single`
- `pair`

Later phases may extend this to `jury`, but CR0 only commits to the
`single -> pair -> synthesizer pass` ladder.

## Minimum viable target

The first target is **not** full planner replacement.

The first target is:

1. review authority without Claude
2. explicit committee policy
3. seed scores for the currently observed domestic models
4. deterministic escalation rules

Why start here:

- review is the closest role to the old Claude authority behavior
- review outputs are easier to compare than planner outputs
- review can be combined with deterministic smoke/build/test signals
- review mistakes are visible earlier than planner mistakes

## Recommended staged rollout

### CR0

Review committee MVP:

- committee policy config
- `single | pair` mode
- low-confidence / disagreement escalation
- manual seed profiles for Kimi / Qwen / GLM / Mimo
- one synthesis pass as final aggregator

Operational note for CR0:

- when synthesis succeeds, runtime records `synthesized_by=<model>`
- when synthesis is attempted but falls back to heuristic merge, runtime records
  `synthesis_strategy=heuristic` instead of pretending a model completed the pass
- when synthesis is attempted but blocked by `fail_closed`, runtime records
  `synthesis_attempted_by=<model>` so the blocked attempt stays visible
- synthesis failure is governed by explicit `synthesis_failure_policy`
- default CR0 posture is `fail_closed`, not implicit heuristic fallback

### CR1

Planner committee:

- primary planner
- challenger planner
- Codex merges into final plan

### CR2

Learning loop:

- committee outcomes update `model-profiles.json`
- false-positive / missed-risk review patterns update `model-lessons.json`
- authority routing improves with real usage

### CR3

Operationalization:

- compact / status / dashboard expose authority topology
- MCP surface can show committee decisions and disagreements
- optional AgentBus rooms for committee review collection

## Current recommended role map

Based on the observed behavior in the Hive repo so far:

- `Kimi` -> primary review authority
- `Mimo` -> implementation/lifecycle reviewer
- `GLM` -> adversarial reviewer
- `Qwen` -> coverage/checklist reviewer
- `GPT` -> dispatch helper, reviewer coordinator, cross-check
- `GPT-5.4` -> final synthesis, tie-break, merge-ready conclusion

None of these should be treated as a full drop-in Claude replacement by itself.
The replacement is the **system**, not a single model.

## Initial assumptions

These assumptions are deliberate and should be challenged by the parallel worktree group:

1. `review` is the best first authority slice
2. `committee escalation` is better than "always 4 models"
3. a real synthesis pass is required for stable final decisions
4. deterministic smoke/build/test must remain separate from model opinion
5. profile seeds should be light-weight, low-confidence, and easy to overwrite

## Non-goals for CR0

Do **not** do these in the first slice:

- replacing the full Hive autoloop planner in one jump
- rewriting the current model scorer from scratch
- turning every stage into a 4-model committee by default
- using model voting to override deterministic smoke/build/test outcomes
- merging this work into the active Hive × AgentBus mainline before the design stabilizes

## Suggested reading order

1. `docs/authority-layer/PROJECT_DIRECTION.md`
2. `docs/authority-layer/CR0_EXECUTION.md`
3. `docs/authority-layer/INITIAL_MODEL_SEEDS.md`
4. `docs/authority-layer/SESSION_WORKTREE_PACK.md`
5. `docs/HIVE_COLLAB_STACK.md`
6. `docs/hiveshell/COLLAB_STACK_PROGRESS.md`
