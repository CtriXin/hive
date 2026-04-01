# Task Verification Rules

Use this directory for task-scoped verification profiles.

Each file must be named:

- `<rule-id>.md`

A task can reference it with:

- `verification_profile: "<rule-id>"`

Supported format is the same as `.hive/project.md`.

List syntax:

- `<type> | <command-or-path> | <label> | <scope> | required|optional`

Examples:

- `build | npm run build | TypeScript build | both | required`
- `command | npm run test -- mcp-server | MCP server focused test | suite | required`
- `file_exists | dist/mcp-server/index.js | Built MCP entry exists | suite | required`

Notes:

- Task rules are additive. Effective checks are:
  - project-level checks from `.hive/project.md`
  - plus task-level checks from `.hive/rules/<rule-id>.md`
- `worktree` and `both` checks run in the task worktree smoke phase.
- `suite` and `both` checks run after progressive merge on the integrated codebase.
- Hooks are also supported with the same syntax as `.hive/project.md`, but task-level usage should stay minimal until the contract is exercised more.

## Recommended starter profiles in this repo

- `mcp-surface`
  - Use for `mcp-server/index.ts` and MCP tool contract changes
- `autoloop-runtime`
  - Use for `orchestrator/driver.ts`, `dispatcher.ts`, `run-store.ts`, `worktree-manager.ts`, `types.ts`
- `review-pipeline`
  - Use for `orchestrator/reviewer.ts`, `review-utils.ts`, `task-fingerprint.ts`, review gating logic
- `provider-routing`
  - Use for `orchestrator/hive-config.ts`, `provider-resolver.ts`, `mms-routes-loader.ts`
- `planner-surface`
  - Use for `orchestrator/planner.ts`, `planner-runner.ts`, `translator.ts`
- `reporting-surface`
  - Use for `orchestrator/reporter.ts`, `result-store.ts`

## Selection guidance

- Prefer one profile per task for MVP.
- Pick the profile based on the main blast radius, not every touched file.
- If no existing profile fits well, either:
  - leave `verification_profile` empty and rely on project-level checks, or
  - add a new focused rule file here.
