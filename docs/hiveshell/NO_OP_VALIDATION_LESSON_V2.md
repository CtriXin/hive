# No-Op Validation Lesson V2

## What Was Broken Before

Two different issues were mixed together in the recent real-validation path:

- `run-1775572970412` proved the old worker-worktree `build_fail` blocker was gone, but it also showed that `REAL_VALIDATION_CASE_001` had become stale because `docs/hiveshell/PHASE_CLOSEOUT_CHECKLIST.md` already existed on `main`
- `run-1775573723943` exposed a different orchestration bug: the planner split the goal into a read-only analysis task plus edit tasks, so the read-only task necessarily ended as `no_op`
- after that, failed-task tracking and worker surfaces were also too sticky: a later repaired task could still appear in `request_human`, and a worker could still show an old `error` after later succeeding

## What The Latest Fix Changed

The latest fix tightened the orchestration path in three places:

- planner rules now require executable tasks that actually create or modify listed files
- planner-side sanitization now drops explicit read-only / verification-only tasks and rewires downstream dependencies
- run-state failure tracking is now recalculated from current `task_states`, so repaired tasks no longer stay falsely failed
- worker status snapshots now clear stale `error` text when a later update marks the worker `completed` with `success=true`

## What A Fresh Run Should Prove

`run-1775575692467` is the first fresh proof after the fix, and it shows the intended behavior:

- the planner emitted exactly one executable task instead of a read-only analysis step plus follow-up edits
- the run finished `done` in round 1
- `failed_task_ids` and `review_failed_task_ids` both stayed empty
- review and verification both passed, so the run no longer fell into `no_op -> request_human`

This means the main bug that surfaced in `run-1775573723943` is resolved.

## Safe Next Validation Step

The next safe step is to refresh `docs/hiveshell/REAL_VALIDATION_CASE_001.md` so it targets a docs-only artifact that does not already exist on `main`, then run one more fresh smoke.

Recommended checks for that follow-up run:

1. the planner should still emit only executable edit tasks
2. the final status should stay `done` or fail for an honest new reason, not for `no_op`
3. `hive status`, `hive shell`, and `hive compact` should all stay consistent with the terminal state
4. if you want the artifact to land automatically, run with `--auto-merge`
