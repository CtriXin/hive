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

1. `.hive/project.md`
2. fallback repo scripts from `package.json`

This means development-time verification should be authored intentionally in `.hive/project.md` whenever the project has non-trivial needs.

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
2. **Test/Lint/Type Verification** - Runs the project's verification suite (test, lint, typecheck) as defined in `.hive/project.md` or `package.json`
3. **Review Cascade Gating** - Progresses through cross-review → a2a → Sonnet → Opus stages; each stage must pass before proceeding
4. **Repair Threshold** - Tracks repair attempts per task; triggers replan when threshold exceeded

### Failure Classes

| Class | Description | Action |
|-------|-------------|--------|
| Verification failure | Tests, lint, or typecheck failed | Enter repair loop with same task |
| Empty diff | No meaningful changes produced | Mark as failed, trigger replan |
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

See [docs/INTEGRATION_SMOKE.md](./INTEGRATION_SMOKE.md) for the full validation summary and smoke test procedures.

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
