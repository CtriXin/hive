# Main Agent Real Task Brief

Last updated: 2026-04-07
Owner: review coordinator
Status: active

## Goal

Hive has entered the next stage:

- no longer prioritize endless micro regression-only rounds
- shift to real feature work plus real validation
- prove domestic models can take over meaningful development flow when Claude is unavailable

This brief is for the main agent. Execute the work directly and keep scope tight.

## Working Rule

The main goal is not "make more tests pass".

The main goal is:

- add real capability to Hive
- improve visibility / restore continuity / human takeover quality
- run at least one minimal but real task through the main path

## Current Focus

Work one slice at a time. Prefer the smallest real feature that improves end-to-end usefulness.

Priority order:

1. worker discuss result visibility
2. planner discuss continuity in compact / CLI / restore
3. request_human decision trace
4. one minimal real smoke task through the main path

Do not expand all four at once unless they are naturally tiny and coupled.

## Focus 1: Worker Discuss Result Visibility

What to improve:

- latest worker discuss decision should be visible after the run
- latest discuss quality_gate should be visible
- latest discuss thread_id or mode should be recoverable if useful

Preferred surfaces:

- worker status snapshot
- hiveshell dashboard Workers section
- compact / restore prompt

Constraints:

- do not redesign discuss_results
- do not build a full audit system
- keep it concise and recoverable

Success signal:

- a human can open status or restore context and immediately know what the last worker discuss concluded

## Focus 2: Planner Discuss Continuity

What to improve:

- planner discuss synthesis outcome should remain visible after planning is done
- compact / restore / CLI should expose the conclusion, not only room metadata

Useful fields:

- quality_gate
- one-line overall assessment
- room / collab context when relevant

Constraints:

- do not redesign planning brief
- do not change room payload shape unless absolutely necessary
- keep the surface short

Success signal:

- restore context explains what planner discuss concluded and how strong it was

## Focus 3: request_human Decision Trace

What to improve:

- when Hive stops at request_human, the human should understand why without reading raw state blobs

Target shape:

- 1 to 3 concise lines
- what blocked progress
- what should be handled next

Preferred surfaces:

- compact restore prompt
- hiveshell dashboard or CLI

Constraints:

- do not redesign the state machine
- do not change merge / review / recovery semantics
- summarize existing signals only

Success signal:

- request_human becomes a readable handoff instead of a vague stop code

## Focus 4: One Minimal Real Smoke Task

This is the proof step.

Requirements:

- choose one small but real code task
- not a test-only change
- try to pass through as much real Hive flow as practical

Good candidates:

- expose one missing runtime summary field end-to-end
- tighten one real shell / compact / dashboard behavior with actual state flow
- fix one clear runtime bug on the main path

Need evidence:

- which path actually ran
- what was mocked vs real
- what files changed
- what verification passed

Success signal:

- the result feels like real development, not only internal hardening

## Delivery Rules

For every round:

- keep the slice minimal
- do not hide test gaps
- do not overclaim coverage
- say clearly whether the change is:
  - feature
  - bugfix
  - test-only regression
  - refactor

## File Hygiene

Do not include unrelated noise in implementation or commits.

Keep out:

- `config/model-profiles.json`
- `.sessions/`
- `docs/CC_SOURCE_REFERENCE.md`
- `docs/hiveshell/REAL_VALIDATION_CASE_001.md`
- `t/`

## Validation Philosophy

Prefer focused validation for the slice you touched.

Always include:

- targeted tests
- `npm run build`

When doing the real smoke slice, include:

- the actual runtime command(s)
- what path was truly exercised

## Mandatory Reporting

After each round, append a receipt to:

- `docs/hiveshell/MAIN_AGENT_PROGRESS_RECEIPTS.md`

Do not overwrite previous receipts. Append a new round section each time.
