# Self-Improve TODO

**Date**: 2026-04-22
**Status**: backlog only, not a release blocker

## Current Judgment

Hive already has partial learning primitives in mainline:

- `cross-run lessons`
- `project memory`
- `user profile recall / extraction`
- `model-lessons` extraction from review results

But Hive is **not yet** a complete `self-improving system`.
What is still missing is the closed loop:

1. structured evidence
2. candidate distill
3. scoped promotion
4. actual adoption
5. outcome measurement
6. rollback / decay

This is a product evolution slice, not a current mainline blocker.

## TODO Priority

### P1 — Unified Evidence Layer

Goal: stop treating lessons, memory, and incidents as separate islands.

- unify evidence from:
  - `lesson-store`
  - `project-memory`
  - `user-profile`
  - `routing incidents`
  - review / verification / fallback outcomes
- define one shared schema for:
  - raw evidence
  - distilled candidate
  - applied item
- write run-end evidence to a dedicated store under `.ai/self-improve/`

### P1 — Adoption Log

Goal: know whether a learned item was actually used.

- record when a learned item is injected into:
  - planner context
  - repair prompt
  - routing hint
  - verification hint
- record whether it appears to have helped, had no effect, or made things worse
- make this durable and queryable

### P2 — Promotion Engine

Goal: controlled movement across scopes instead of blind auto-globalization.

- define promotion paths:
  - `run -> project`
  - `project -> global user`
  - `run/project -> upstream product backlog`
- explicitly block unsafe promotions:
  - repo-specific route pins
  - temporary workarounds
  - guardrail-bypassing behavior
- require repeated evidence before promotion

### P2 — Rollback / Decay

Goal: prevent stale or wrong learning from accumulating forever.

- decay stale lessons and memories automatically
- demote or disable items with repeated ineffective adoption
- support reversible promotion state

### P3 — Web / Operator Surface

Goal: make learning visible and inspectable.

- show:
  - what was learned
  - where it came from
  - whether it was applied
  - whether it was effective
  - whether it is stale / demoted
- separate:
  - project memory
  - user preference
  - product backlog candidate

## Non-Goals For Now

These should **not** be silently auto-applied:

- relaxing `executor` Claude guardrails
- changing credentials / keys
- changing global blacklist without explicit operator action
- modifying upstream source code automatically

## Exit Criteria

This slice is only considered complete when Hive can do all of the following:

1. extract structured evidence from completed runs
2. distill candidates by scope
3. apply low-risk items automatically in later runs
4. measure adoption outcomes
5. decay or roll back ineffective items
6. surface the full chain in CLI or Web

