# Hive Human Progress Surface

## Goal

When Hive starts a run, the human should not need to guess:
- is it actively running?
- is it waiting?
- is it retrying?
- did it fallback?
- is it blocked?
- does it need human input?

## Output surface

Each run should maintain a human-readable markdown file:

- `hive/.ai/runs/<run-id>/human-progress.md`

Optionally also keep a latest pointer/copy:

- `hive/.ai/restore/latest-human-progress.md`

## Source inputs

Prefer reusing existing Hive state:
- `worker-status.json`
- `compact-packet.json` / `compact-packet.md`
- `loop-progress`
- run state / next_action
- provider fallback / cooldown state
- dashboard surface

Do not invent a second independent truth source.

## Required fields

At top:
- run id
- goal
- started
- updated
- overall status
- next action

Counters:
- done
- failed
- running
- pending
- queued_retry
- blocked

Optional but recommended:
- fallback count
- request_human count

## Required status vocabulary

Use these values consistently:
- `pending`
- `running`
- `waiting`
- `queued_retry`
- `fallback`
- `blocked`
- `request_human`
- `failed`
- `done`

## Meaning

- `running` — there is active worker execution now
- `waiting` — system is waiting on time/resource/external condition, not deadlocked
- `queued_retry` — retry scheduled after backoff/cooldown
- `fallback` — route/model/provider fallback happened
- `blocked` — cannot continue automatically, but not yet escalated to human
- `request_human` — human decision/input required
- `failed` — terminal failure
- `done` — terminal success

## Minimum table

| Unit | Provider | Status | Elapsed | Output | Note |
|------|----------|--------|---------|--------|------|

The `Note` column should explain cooldown / fallback / blocker in one line.

## Human-first rule

If the run is not making forward progress, the file must say why in plain language.
Examples:
- waiting on provider cooldown
- queued for retry in 5m
- blocked by missing human approval
- fallback from provider A to provider B in progress

## Non-goals

- not a transcript dump
- not raw JSON mirrored into markdown
- not a duplicate of the full dashboard
