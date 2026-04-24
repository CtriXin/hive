# Hive Thin Handoff Protocol

## Goal

Reduce double token spend between host runner and worker/model handoff.

Host should not inline long plans into every worker prompt.
Instead hand off through compact files and refs.

## Core rule

Prefer:
- `goal`
- `next_action`
- `constraints`
- `refs`
- `expected_output`

Avoid:
- long raw transcript
- full previous plan pasted inline
- repeated repo background in every worker prompt

## Recommended packet

`./.ai/plan/packet.json`

Recommended fields:
- `task_id`
- `run_id`
- `goal`
- `status`
- `owner`
- `cli`
- `model`
- `next_action`
- `constraints`
- `refs`
- `changed_files`
- `expected_output`

## Budget

Stay within existing Hive handoff rules where applicable:
- worker→worker packet < 500 words
- tier transition brief <= 100 words

## Handoff surfaces

Use these together:
- `current.md` — top-level truth
- `handoff.md` — executable handoff log
- `packet.json` — machine handoff
- `human-progress.md` — human visible run state

## Ownership

One task, one owner at a time.
Do not silently take over another worker's task without recording it.

## Validation

At handoff time include only:
- key validation results
- unresolved risk
- exact next action

Do not paste whole logs when a path is enough.
