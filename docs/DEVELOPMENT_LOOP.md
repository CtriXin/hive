# Hive Development Loop

## Goal

Use Hive during development, not only after development.

The intended loop is:

`implement -> dispatch/repair -> verify -> score -> continue`

This gives three benefits at the same time:

1. lower model cost during implementation
2. continuous functional validation
3. continuous scoring of task/model outcomes

## Recommended usage modes

### 1. Cheap dev mode

Use for:

- small edits
- narrow bug fixes
- local exploration

Recommended operations:

- `hive run --init-only`
- `dispatch_single`
- local verification only

Goal:

- keep cost low
- avoid full review/replan when not needed

### 2. Integration mode

Use for:

- a completed sub-feature
- a repair batch
- before merging a meaningful chunk

Recommended operations:

- `run_goal`
- `resume_run`
- `run_status`
- full review + suite verification

Goal:

- validate real integration behavior
- collect meaningful run-state data

### 3. Milestone mode

Use for:

- bigger refactors
- architecture shifts
- release candidates

Recommended operations:

- full autoloop
- progressive merge
- suite verification
- review of score / retry / repair patterns

Goal:

- treat Hive as both executor and evaluator

## Required team workflow

Every agent iteration must follow this order:

1. implement changes
2. run `npm run build`
3. update progress/bridge docs if the iteration changes behavior or plan
4. if MCP-facing code changed, refresh MCP connectivity before the next MCP-based validation round

## MCP operational rule

### codex-planner

- When MCP-related code changes, rebuild first.
- Then restart or refresh the Codex-side MCP session before relying on the new tools.
- Assume Codex-side MCP does **not** hot-reload automatically.

### claude-planner

- After MCP-related code changes, rebuild first.
- Human will manually reconnect Claude-side MCP.
- Do not assume Claude is using the latest `dist/` until reconnect is complete.

### codex-shell

- If running in a separate worktree, always build after each iteration before reporting completion.
- Do not claim a tool/path is ready until the local build has passed.

## Verification policy rule

Default order of precedence:

1. task `verification_profile` → `.hive/rules/<rule-id>.md`
2. `.hive/project.md`
3. fallback repo scripts from `package.json`

This means development-time verification should be authored intentionally in `.hive/project.md` whenever the project has non-trivial needs.
Task-specific checks should be authored intentionally in `.hive/rules/` when only part of the plan needs stronger validation.
Starter profiles and authoring guidance live in [docs/TASK_VERIFICATION_PROFILES.md](./TASK_VERIFICATION_PROFILES.md).

## Why this loop matters

Hive should not be treated as a one-shot orchestrator.

The intended product behavior is:

`development process = execution loop + evaluation loop`

That means:

- each dev round can reduce cost
- each dev round can validate behavior
- each dev round can improve model/task scoring

## Integration Validation

Each task execution in the autoloop undergoes a structured validation sequence before proceeding to the next phase.

### Verification Scope

Validation checks cover four areas:

1. **Worktree Diff Checks** - Verifies that worker changes produce a non-empty, meaningful diff; detects empty commits or no-op executions
2. **Project Verification** - Runs repo-wide checks from `.hive/project.md` or `package.json`
3. **Task Verification Rules** - Runs additive task-scoped checks from `.hive/rules/<rule-id>.md` when a task declares `verification_profile`
4. **Review Cascade Gating** - Progresses through cross-review → a2a → Sonnet → Opus stages; each stage must pass before proceeding
5. **Repair Threshold** - Tracks repair attempts per task; triggers replan when threshold exceeded

### Failure Classes

| Class | Description | Action |
|-------|-------------|--------|
| Verification failure | Project-level or task-level checks failed | Enter repair loop with same task |
| Empty diff / no-op success | Worker reports success but produces `changedFiles=[]` | Fail the review gate, then enter repair or replan |
| Review rejection | Findings exceed acceptable threshold | Escalate to next review tier or repair |
| Threshold exceeded | Max repairs (default: 3) reached | Trigger replan for remaining tasks |

### Review Gating

The review cascade acts as a quality gate:

- **cross-review**: Lightweight peer check
- **a2a**: Multi-lens arbitration (challenger, architect, subtractor)
- **sonnet**: Deep review with reasoning traces
- **opus**: Final authority on architecture/significant changes

A task only proceeds when the highest invoked tier returns `passed: true`.

### Repair Threshold

Before replan is triggered:

- Each task tracks its repair attempt count
- Default threshold: 3 repairs per task
- Exceeding threshold marks task as `failed` and excludes from further repair
- Replan generates new task breakdown for remaining work

## Cost And Budget

Autoloop now records two cost layers:

1. `round_cost_history` — raw per-round usage history
2. `result.cost_estimate` / `result.token_breakdown` — accumulated run total

Budget behavior:

- each completed round records a budget snapshot after spending is written
- `run_goal`, `run_status`, CLI status, and reports should surface current budget status
- if `budget.block=true` and budget is exhausted, the loop blocks before the next round starts

See [docs/INTEGRATION_SMOKE.md](./INTEGRATION_SMOKE.md) for the full validation summary and smoke test procedures.

For the collaboration-layer roadmap across Hive / AgentBus / agent-im / MindKeeper, see [docs/HIVE_COLLAB_STACK.md](./HIVE_COLLAB_STACK.md).

## Minimal commands

```bash
# after each iteration
npm run build

# safe inspection
hive status --cwd /path/to/repo

# restore without re-executing
hive resume --run-id <run-id> --cwd /path/to/repo

# restore and continue
hive resume --run-id <run-id> --cwd /path/to/repo --execute
```
