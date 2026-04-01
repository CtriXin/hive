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
| `planner-surface` | planner / translator changes | `build`, integration tests |
| `reporting-surface` | reporter / result-store changes | `build`, result-store tests |

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

## Auto-suggest from estimated_files

When the planner does not set `verification_profile`, the build step automatically suggests a profile by matching the task's `estimated_files` against each rule's `## File patterns` section.

- Matching is prefix-based: `orchestrator/driver.ts` matches pattern `orchestrator/driver.ts` or `orchestrator/`
- The rule with the most file matches wins
- If no files match any rule, no profile is assigned (project-level checks only)
- Explicit planner assignment always takes priority over auto-suggest

## Current MVP policy

- Assignment is explicit or auto-suggested from file patterns
- Rules are additive, not replacement
- Prefer narrow regression commands over full-suite duplication
- Prefer one dominant profile per task
