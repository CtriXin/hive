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
