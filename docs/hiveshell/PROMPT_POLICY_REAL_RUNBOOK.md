# Prompt Policy Real Runbook

Last updated: 2026-04-07
Owner: main agent
Status: active

## Goal

Make it easy to collect real prompt-policy samples without requiring a heavy operator workflow.

The operator should only need to do two things:

1. run a real Hive task normally
2. record the `run_id` in the sample log

Everything else can be reconstructed later from run artifacts.

## Minimum Operator Action

After you run Hive, append one entry to:

- `docs/hiveshell/PROMPT_POLICY_SAMPLE_LOG.md`

Minimum fields:

- `run_id`
- `goal`
- `count_as_sample: yes|no`
- optional short note

That is enough for later analysis.

## Where The Real Evidence Lives

For each run, the real evidence is under:

- `.ai/runs/<run-id>/`

Most useful files:

- `.ai/runs/<run-id>/result.json`
- `.ai/runs/<run-id>/state.json`
- `.ai/runs/<run-id>/worker-status.json`
- `.ai/runs/<run-id>/score-history.json`
- `.ai/runs/<run-id>/round-XX-score.json`
- `.ai/runs/<run-id>/workers/*.transcript.jsonl`

## Does It Need The Full Hive Flow

No. It does not need a perfect full-flow success case.

A run counts as a usable sample if all are true:

- it is a real task, not a synthetic prompt-policy test
- Hive created a real `run_id`
- worker/review artifacts were written
- we can inspect `result.json`

These run outcomes are all acceptable as samples:

- `done`
- `partial`
- `request_human`
- `blocked`

These do NOT count as useful samples:

- `--init-only`
- planning failed before workers ever ran
- auth / Keychain interruption prevented a real run from starting
- no `.ai/runs/<run-id>/result.json`

## What I Will Read Later

Once you give me a `run_id`, I will inspect:

1. task shape and file scope
2. `prompt_fragments`
3. `prompt_policy_version`
4. `failure_attribution`
5. `prompt_fault_confidence`
6. `recommended_fragments`
7. `score-history.json`
8. whether the sample is valid or should be discarded

## Fast Operator Commands

Normal execution:

```bash
hive run --goal "<real task>" --cwd <repo-root> --mode safe
```

Helpful follow-up commands if you want a quick look yourself:

```bash
hive status --cwd <repo-root>
hive shell --cwd <repo-root>
hive compact --cwd <repo-root>
hive restore --cwd <repo-root>
```

But these follow-up commands are optional for sample collection.

## Counting Rule

Count the run as a prompt-policy sample only if:

- the task is real
- the run produced inspectable artifacts
- the failure/success is not dominated by startup auth interruption

If unsure, still log the `run_id` and set:

- `count_as_sample: maybe`

I can decide later whether it should be counted.

## Shortest Correct Workflow

1. run a real Hive task
2. copy the `run_id`
3. append one entry to `docs/hiveshell/PROMPT_POLICY_SAMPLE_LOG.md`
4. tell me the `run_id`

That is enough. You do not need to manually summarize the whole run every time.
