# Mainline Real Test Checkpoint 2026-04-10

## Purpose

This file is the compact-safe recovery surface for the next user-facing real Hive test on `main`.
If the conversation is compacted or interrupted, resume from this file first.

## Current Mainline Status

- Baseline owner: `gpt-main-agent`
- Repo: `<repo-root>`
- Branch: `main`
- Status: ready to prepare the next real test, but the current working tree is not clean

## Already-Proved Baseline

- Planner fallback hardening is landed on `main`
  - `.ai` / runtime artifacts are excluded from planner context
  - non-Claude planner `tool_use` drift now fails fast with explicit diagnostics
- Planner-authority support proof is already complete on the isolated support lane
  - proof commit: `5f4a83f`
  - proof doc: `docs/authority-layer/CR1_SMOKE_LOG.md`
- Latest shared room proof from support lane is closed and non-blocking

## Current Runtime Wiring Focus

The active mainline focus before the next real test is prompt-policy runtime wiring verification:

- dispatcher should inject prompt policy into worker prompts by default
- worker results should carry `prompt_policy_version` and `prompt_fragments`
- reviewer results should carry:
  - `failure_attribution`
  - `prompt_fault_confidence`
  - `recommended_fragments`

Local validation already passed for the wiring work:

- `pnpm vitest run tests/prompt-policy.test.ts tests/reviewer-authority.test.ts`
- `npm run build`

## Important Working-Tree Reality

Do not assume the current `main` worktree is clean.
There are active local changes from multiple ongoing slices in the repository.

This means the next real test should follow one of these shapes:

1. create a clean validation worktree from the intended mainline baseline, then run the real test there
2. commit or otherwise isolate the exact changes that belong to the real-test attempt before running it in-place

Avoid using a dirty shared worktree as the only source of truth for a real validation claim.

## Next Real Test Goal

The next real test should prove the runtime path, not just local unit coverage.

Minimum desired outputs from the next real run:

- a real `run_id`
- at least one worker with non-empty `changedFiles`
- worker-level prompt policy fields present when applicable
- review-level attribution fields present on failed review paths when applicable
- `status` / `shell` / `compact` / `restore` all still readable after the run

## Compact Guidance

- Compact is not required before the next real test
- This file exists specifically so context is not lost if compact happens later
- If compact is used after the next run starts, first record:
  - the `run_id`
  - the run outcome or latest phase
  - any blocking task ids
  - any manually observed anomaly

## Recovery Steps

If the session is resumed later:

1. read this file
2. read `<hive-agent-room>/gpt-main-agent.md`
3. read `<hive-agent-room>/threads/THREAD-REAL-TEST-BASELINE.md`
4. inspect the latest run under `.ai/runs/`
5. continue from the newest real-test attempt rather than re-deriving the plan from memory

## Key References

- `docs/hiveshell/MAIN_AGENT_PROGRESS_RECEIPTS.md`
- `docs/hiveshell/REAL_VALIDATION_CASE_001.md`
- `docs/hiveshell/REAL_VALIDATION_RUN_LOG.md`
- `<hive-agent-room>/gpt-main-agent.md`
- `<hive-agent-room>/threads/THREAD-REAL-TEST-BASELINE.md`


## 2026-04-10 Runtime Recovery Delta

Two concrete runtime blockers were identified and fixed after the first isolated real run:

- model proxy bridge routes ending with `/v1` were forwarding to `/v1/v1/messages`
- stale worker worktree directories could collide with fresh runs even when no git worktree entry remained
- driver state could incorrectly finalize `done` after review pass even if worker execution had actually failed

Updated proof status:

- first isolated real run: `run-1775751980282`
  - proved prompt-policy metadata persistence in real `worker-status.json`
  - exposed the false-positive success path and the two runtime blockers above
- second isolated real run: `run-1775752795677`
  - active rerun on patched snapshot baseline
  - already proved that the proxy no longer dies on `/v1/v1/messages`
  - already proved worker worktree naming now escapes stale-path collisions
  - current observed worker state reached `discussing`, so runtime moved beyond the old transport crash point

Current recommendation:

- continue using the isolated snapshot baseline for real smoke until `run-1775752795677` settles
- do not treat `run-1775751980282` as a valid success proof even though it ended `done`
- if compact happens, resume from this file and then inspect:
  - `/tmp/hive-mainline-realtest-20260410/.ai/runs/run-1775752795677/`
  - `docs/hiveshell/MAIN_AGENT_PROGRESS_RECEIPTS.md`


## 2026-04-10 Dirty-Baseline Overlay Delta

The `run-phase1a-test` artifact now proves real TaskContextPack persistence:

- artifact: `.ai/runs/run-phase1a-test/context-packs/context-pack-task-a-r0.json`
- confirmed fields:
  - `selected_files`
  - `prompt_fragments`
  - `prompt_policy_version`
  - `assigned_model`
  - `assigned_provider`

A newer real smoke exposed one more runtime blocker beyond transport:

- `run-1775780807211` showed that fresh worker worktrees inherited copied untracked files but not tracked dirty baseline files from the snapshot root
- that caused false task-worktree build failures when the snapshot baseline included local tracked edits not yet committed

This blocker is now fixed locally:

- `orchestrator/worktree-manager.ts` now copies the dirty baseline overlay into fresh worktrees instead of copying only untracked files
- unchanged copied overlay files are still filtered out of worker diff accounting
- targeted tests and `npm run build` passed on both `main` and `/tmp/hive-mainline-realtest-20260410-r3`

Current live rerun after the fix:

- `run-1775781386383`
- baseline: `/tmp/hive-mainline-realtest-20260410-r3`
- purpose: re-test the prompt-policy smoke after fixing dirty-baseline worktree inheritance
