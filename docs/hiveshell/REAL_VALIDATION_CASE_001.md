# Real Validation Case 001

Date: 2026-04-07
Status: refreshed for repeatable docs-only smoke
Owner: codex

## Purpose

Run one safe end-to-end integration case on latest `main` without touching core runtime code.

This case is meant to validate:

- autoloop execution (`plan -> execute -> verify -> review -> finalize`)
- host-visible surfaces (`hive status`, `hive shell`, `hive compact`, `hive restore`)
- run artifact generation
- review participation on a real run
- lesson-path observation without requiring a forced failure

This case is intentionally low-risk. It should not change runtime code, routing logic, or provider config.

## Why this case

Use this before any new major feature phase when:

- the collaboration stack has reached feature closure
- authority follow-up is already merged
- the next need is runtime confidence, not more design

This is a proof run, not a stress run.

## Task Goal

Ask Hive to complete this goal:

```text
Create or update docs/hiveshell/REAL_VALIDATION_RUN_LOG.md with one new top entry for the latest safe Hive validation smoke. If the file does not exist, create it with a short title first. The new entry must include: (1) date, (2) goal summary, (3) final run status, (4) whether verification passed, (5) whether review passed, (6) changed files, and (7) whether any unexpected runtime/code files were touched. Only modify docs/hiveshell/REAL_VALIDATION_RUN_LOG.md. Do not modify runtime code, config, scripts, package.json, or any other docs.
```

## Why this specific goal

It is useful, visible, and safe:

- creates a real diff
- stays inside one docs file
- still exercises planning, execution, verification, and review
- is repeatable on latest `main` without depending on a previously missing file
- avoids accidental runtime regressions during the validation stage

## Run Procedure

### 1. Prepare

From repo root:

```bash
npm run build
```

### 2. Run one real integration round

Use either MCP `run_goal` or CLI. CLI example:

```bash
hive run --goal "Create or update docs/hiveshell/REAL_VALIDATION_RUN_LOG.md with one new top entry for the latest safe Hive validation smoke. If the file does not exist, create it with a short title first. The new entry must include: (1) date, (2) goal summary, (3) final run status, (4) whether verification passed, (5) whether review passed, (6) changed files, and (7) whether any unexpected runtime/code files were touched. Only modify docs/hiveshell/REAL_VALIDATION_RUN_LOG.md. Do not modify runtime code, config, scripts, package.json, or any other docs." --cwd /Users/xin/auto-skills/CtriXin-repo/hive
```

### 3. After the run completes

Capture these surfaces:

```bash
hive status --cwd /Users/xin/auto-skills/CtriXin-repo/hive
hive shell --cwd /Users/xin/auto-skills/CtriXin-repo/hive
hive compact --cwd /Users/xin/auto-skills/CtriXin-repo/hive
hive restore --cwd /Users/xin/auto-skills/CtriXin-repo/hive
hive score --cwd /Users/xin/auto-skills/CtriXin-repo/hive
```

### 4. Lesson-path observation

Do not force a failure just to create lessons.

Instead, observe whether the run naturally touched the lesson path:

```bash
git diff -- config/model-lessons.json
```

Interpretation:

- if changed: lesson extraction path was exercised
- if unchanged: review likely passed cleanly without new lesson-worthy failures

Both outcomes are acceptable for this case.

## Expected Success Shape

The run is considered useful if all of the following are true:

1. a real `run_id` is created
2. the final run status is terminal (`done` or clearly explained `blocked`)
3. changed files are limited to `docs/hiveshell/REAL_VALIDATION_RUN_LOG.md`
4. `npm run build` remains green
5. `hive shell` renders the expected sections without surface breakage
6. `hive compact` and `hive restore` both produce usable restore output
7. review ran as part of the autoloop and the result is visible in run artifacts or summary text

## Minimal Evidence To Return

Return only this:

- `run_id`
- final status
- changed files
- whether review passed / failed
- whether `config/model-lessons.json` changed
- whether `hive shell` rendered correctly
- whether `hive compact` and `hive restore` produced restore output
- whether any unexpected runtime/code files were touched

## Failure Handling

If the run touches files outside `docs/hiveshell/REAL_VALIDATION_RUN_LOG.md` unexpectedly:

- stop
- do not keep iterating
- report the touched files and run status

If the run fails verification or review:

- keep the artifacts
- do not manually patch the repo in the smoke step
- report the failure class and top finding

That failure is still useful validation data.

## Copyable Execution Prompt

Use this exact prompt for an execution agent:

```text
Run Real Validation Case 001 from docs/hiveshell/REAL_VALIDATION_CASE_001.md on latest main. Do not broaden scope. Execute the run, then collect only the Minimal Evidence To Return section. Do not manually improve the result after the run unless the document explicitly says to. If the run touches non-doc runtime files, stop and report immediately.
Run Real Validation Case 001 from docs/hiveshell/REAL_VALIDATION_CASE_001.md on latest main. Do not broaden scope. Execute the run, then collect only the Minimal Evidence To Return section. Do not manually improve the result after the run unless the document explicitly says to. If the run touches files outside docs/hiveshell/REAL_VALIDATION_RUN_LOG.md, stop and report immediately.
```

## What this case does not prove

This case does not prove:

- recovery-room correctness under real failure
- human bridge runtime posting
- advisory scoring usefulness across multiple runs
- authority routing quality under contested review

Those belong to later runtime-focused validation, not this first safe case.
