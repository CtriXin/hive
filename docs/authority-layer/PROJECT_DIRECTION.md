# Authority Layer Project Direction

Date: 2026-04-05
Status: working north star
Owner: codex-planner

## One-line direction

Make Hive less dependent on `Claude` / `Opus` authority by replacing single-model judgment with a domestic-model authority system plus a dedicated synthesis pass.

This track is successful when the system no longer feels "Claude-or-nothing" for key review and planning decisions.

## What this track is trying to do

This authority-layer track is **not** trying to prove that one domestic model is a full `Opus` replacement.

It is trying to build a system where:

- one model can act as primary
- another can challenge
- another can cover edge cases or adversarial risk
- a dedicated synthesizer can merge the outputs into one stable conclusion

The replacement target is the **authority function**, not a single-model clone.

## Immediate target

Start with the narrowest authority slice that matters:

- `review authority without Claude`

Why this first:

- review outputs are easier to compare than planning outputs
- deterministic smoke/build/test signals can stay as an external boundary
- false positives and missed risks are easier to observe and calibrate

## Longer-term target

The long-term direction is:

1. `review` is no longer blocked on `Claude`
2. `repair / arbitration` is no longer blocked on `Claude`
3. `planning` is no longer blocked on `Claude`
4. `Claude` becomes an optional enhancement instead of a hard dependency

## What "success" means

This track should eventually make these statements true:

- Hive can produce credible review conclusions without `Claude`
- disagreements are handled by explicit routing instead of hidden single-model judgment
- multiple domestic models can cover different authority roles
- a dedicated synthesizer can produce a final actionable synthesis from conflicting or partial reviewer outputs
- losing access to `Claude` hurts quality somewhat, but does not stall the system

## What this track should not become

Avoid these failure modes:

- building a "Claude clone" abstraction
- assuming "4 models by default" is better than targeted escalation
- turning model voting into an override for deterministic verification
- creating a second full review subsystem that duplicates existing Hive mechanisms without a clear boundary
- expanding CR0 into planner replacement, dashboard work, AgentBus rooms, or full learning loops

## CR0 guardrail

CR0 should be judged against one question:

Can Hive get a usable, trustworthy review authority result without relying on `Claude` as the only final authority?

If a proposal does not improve that outcome directly, it is probably scope creep for CR0.
