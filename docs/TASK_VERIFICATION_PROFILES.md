# Task Verification Profiles

## Goal

Use `.hive/rules/*.md` to add task-scoped verification on top of repo defaults from `.hive/project.md`.

This repo now has four starter profiles:

| Profile | Use for | Main checks |
|---------|---------|-------------|
| `mcp-surface` | MCP tool/API surface changes | `build`, built MCP entry exists |
| `autoloop-runtime` | `driver` / `dispatcher` / `run-store` / `worktree-manager` / runtime state changes | `build`, runtime regression tests |
| `review-pipeline` | review cascade / review heuristics / scoring-side review gates | `build`, review-focused tests |
| `provider-routing` | provider config / routing / MMS fallback selection | `build`, provider-routing tests |

## How to use

Planner or human-authored plan can set:

```json
{
  "id": "task-a",
  "verification_profile": "autoloop-runtime"
}
```

Execution behavior:

1. project-level checks still run
2. the selected task profile adds extra checks
3. `worktree|both` checks run in task worktree smoke verification
4. `suite|both` checks run after progressive merge
5. results are stored in `task_verification_results[taskId]`

## Authoring rule files

Rule file syntax is the same as `.hive/project.md`:

- `<type> | <command-or-path> | <label> | <scope> | required|optional`

Example:

```md
- build | npm run build | TypeScript build | both | required
- command | npx vitest run tests/foo.test.ts | Focused regression test | suite | required
```

## Current MVP policy

- Assignment is explicit: use `verification_profile`
- Rules are additive, not replacement
- Prefer narrow regression commands over full-suite duplication
- Prefer one dominant profile per task

## Suggested next additions

- `planner-surface` if planner changes become frequent enough
- `reporting-surface` if reporter / output formatting starts drifting often
