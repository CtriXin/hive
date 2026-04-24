# Hive Packet-First Dispatch

## Goal

Reduce double token spend in Hive dispatch.

Current anti-pattern:
- host runner thinks through a long plan
- host then pastes long plan/context into worker prompt
- worker re-reads the same material again

Packet-first dispatch changes this to:
- host writes compact handoff files
- worker receives short prompt + refs
- worker reads local files as needed

## Non-goals

- do not redesign the full run loop
- do not remove current runtime artifacts
- do not replace `state.json`, `plan.json`, `worker-status.json`, `loop-progress.json`
- do not broaden into web/watch/MCP operator surfaces here

## Core rule

Before worker dispatch, Hive should prefer local refs over inline prompt bulk.

Prefer passing:
- `goal`
- `next_action`
- `constraints`
- `expected_output`
- `refs`
- `task_id` / `run_id`

Avoid passing:
- full prior plan body
- repeated repo background
- long transcript excerpts
- repeated retry history

## Required handoff surfaces

Use the already-landed derived surfaces:
- `./.ai/plan/packet.json`
- `./.ai/plan/handoff.md`
- `./.ai/runs/<run-id>/human-progress.md`

Keep repo reality:
- `current.md` remains existing top-level truth panel
- no `.ai/handoff/current` path is introduced

## Surface roles

- `packet.json` — primary machine handoff surface for worker dispatch
- `handoff.md` — compact human-readable executable handoff
- `human-progress.md` — human/operator-facing progress surface first

Worker default dispatch path should be:
- always read `packet.json`
- then read `handoff.md`
- then read `current.md`

`human-progress.md` is not required in the default worker read path.
Use it as an optional ref for:
- retry / recovery
- human-facing debugging
- web / status / watch operator surfaces

## Worker prompt shape

Worker prompt should be short and file-first.

Recommended structure:

1. role / task identity
2. exact goal
3. exact write scope / constraints
4. exact expected output
5. refs to read in order
6. validation commands

## Suggested dispatch prompt contract

```text
You are worker <task_id> for Hive.

Run ID: <run_id>
Task ID: <task_id>
Goal: <one-line goal>
Status: <status>
Next action: <exact next step>

Read in order:
1. ./.ai/plan/packet.json
2. ./.ai/plan/handoff.md
3. ./.ai/plan/current.md
4. <task-specific refs>

Constraints:
- <constraint>
- <constraint>

Expected output:
- <output>
- <output>

Validation:
- <command>
- <command>
```

## Dispatch budget

Keep worker prompt thin.

Recommended host-side budget:
- task preamble + constraints + expected output: concise bullets only
- do not duplicate fields already present in `packet.json`
- if a fact is in a file ref, reference it instead of pasting it again

## Read order

When using packet-first dispatch, worker read order should be:
1. `packet.json`
2. `handoff.md`
3. `current.md`
4. task-specific file refs
5. `human-progress.md` only if human/progress context is needed
6. only then raw artifacts if still needed

## Failure handling

If `packet.json` is missing or stale:
- fail open
- fall back to current dispatch path
- record this in `handoff.md` or progress note

If `handoff.md` is present but too long:
- read top entry first
- do not paste the entire file back into prompts

## Success criteria

Packet-first dispatch is considered working when:
- worker prompts become shorter
- host no longer pastes long plan bodies inline by default
- workers can continue from refs without transcript copy-paste
- retries/fallbacks do not re-bloat prompts

## Recommended implementation targets

- task dispatch prompt builder
- planner -> executor transition
- retry / repair dispatch path
- worker->worker handoff path

## Validation

Prove at least these:
1. normal dispatch uses packet refs
2. retry dispatch still uses packet refs
3. missing packet falls back safely
4. prompt body size is materially smaller than old inline path
