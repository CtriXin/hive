# Integration Smoke Test Reference

Quick reference for autoloop validation behavior.

## End-to-End Loop Flow (`run_goal`)

```
plan → execute → verify → review → decide_next
  ↑                    ↓
  └──────── repair / replan ←────┘
```

1. **Plan** — Goal translated to parallel task groups
2. **Execute** — Workers run in isolated worktrees
3. **Verify** — Project checks plus optional task-rule checks are evaluated per `VerificationScope`
4. **Review** — Cross-review → A2A → Sonnet → Opus cascade
5. **Decide** — Next action based on failure class

## Verification Scope

Defined by `VerificationScope` (orchestrator/types.ts:131):

| Scope   | Checks                                    |
|---------|-------------------------------------------|
| worktree | Only the task's isolated worktree        |
| suite    | Full project test suite                  |
| both     | Worktree first, then suite if passed     |

## Failure Classes

`VerificationFailureClass` (orchestrator/types.ts:133-141):

| Class         | Meaning                              | Typical Action     |
|---------------|--------------------------------------|--------------------|
| test_fail     | Test assertion failed                | repair_task        |
| lint_fail     | Static analysis error                | repair_task        |
| review_fail   | Review found issues                  | repair_task        |
| build_fail    | Compilation failed                   | replan / request_human |
| command_fail  | Custom verification command failed   | retry_task         |
| missing_output| Expected file not created            | retry_task         |
| infra_fail    | Runner/system error                  | retry_task         |
| unknown       | Unclassified failure                 | request_human      |

## Repair / Replan Logic

`NextActionKind` (orchestrator/types.ts:143-149):

| Action        | Trigger Condition                        | Behavior                              |
|---------------|------------------------------------------|---------------------------------------|
| execute       | New task ready                           | Dispatch worker                       |
| retry_task    | Transient failure (infra/command)        | Redispatch same task                  |
| repair_task   | Review/project-check/task-check failure  | Feed findings to same worker          |
| replan        | Build fail or structural issue           | Re-run planner with failure context   |
| request_human | Max retries/replans exceeded             | Halt, preserve state                  |
| finalize      | All done conditions met                  | Merge worktrees, report               |

Runtime note:

- a task that reports success but returns `changedFiles=[]` is recorded as `task_states[taskId].status = "no_op"`
- no-op tasks are not treated as verified success; they enter the existing `repair_task` / `replan` flow
- task-level verification can add extra checks through `.hive/rules/<rule-id>.md` when the task declares `verification_profile`
- a task that passes review but fails task-scoped smoke verification is now kept out of `done` and routed back into repair
- each round also persists a budget snapshot after cost is recorded, so `run_status` can show current spend / remaining budget
- when `budget.block=true` and the budget is exhausted, the loop stops before entering another round

### Limits

- `max_rounds` — Hard cap on total iterations
- `max_worker_retries` — Per-task retry budget
- `max_replans` — Planner re-invocation budget

### Auto-merge

When `allow_auto_merge: true`, verified worktrees are merged progressively. Failed tasks stay isolated for repair while others proceed.
