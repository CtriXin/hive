# Hive Parallel Handoff

本文档用于 5 路并行开发时的统一执行协议。

目标：
- 所有 worker 读同一套权威文档
- 所有 worker 基于当前仓库基线开发
- 所有 worker 在各自 `git worktree` 中工作，不污染当前目录
- 最终由 Codex 负责整合，Claude 做交叉审

## 0. 角色分工

- 执行 owner：各 worker
- 最终整合者：Codex
- 最终交叉审：Claude
- 人类：最终确认与合并

## 1. 文档优先级

严格按以下顺序执行：

1. `ERRATA.md`
2. `SELF_CONTAINED_ADDENDUM.md`
3. 对应的 `tasks/TASK-*.md`
4. `CLI_BRIDGE_IMPLEMENTATION_PLAN.md`（仅作代码片段参考，不作架构裁决）

## 2. 开工前硬前置

不要让 5 路直接在当前目录改。

当前目录是基线仓库。先完成以下动作：

1. 检查当前目录改动是否就是要作为并行基线的内容。
2. 在当前目录做一次基线提交。
3. 从这个基线 commit 创建 5 个 `git worktree`。

推荐命令：

```bash
cd /Users/xin/auto-skills/CtriXin-repo/hive

git add orchestrator/types.ts package.json tsconfig.json PARALLEL_HANDOFF.md
git commit -m "chore(foundations): freeze parallel handoff baseline"

git worktree add ../hive-a2 -b task/a2-dispatcher
git worktree add ../hive-b  -b task/b-review
git worktree add ../hive-c  -b task/c-mcp
git worktree add ../hive-d  -b task/d-provider
git worktree add ../hive-e  -b task/e-config
```

## 3. 共享边界

以下文件视为共享契约，除非明确需要，不允许 worker 擅自修改：

- `orchestrator/types.ts`
- `package.json`
- `tsconfig.json`
- `ERRATA.md`

如果某 worker 认为必须修改这些文件：
- 不要直接改
- 在自己的交付说明中单列 `Required shared-contract change`
- 交由 Codex 在整合阶段统一处理

## 4. 写入边界

### Worker A2

Worktree:
- `/Users/xin/auto-skills/CtriXin-repo/hive-a2`

可写文件：
- `orchestrator/dispatcher.ts`
- `orchestrator/index.ts`
- `bin/hive`

禁止改动：
- 其他任意文件

### Worker B

Worktree:
- `/Users/xin/auto-skills/CtriXin-repo/hive-b`

可写文件：
- `orchestrator/reviewer.ts`
- `orchestrator/a2a-bridge.ts`
- `orchestrator/discuss-bridge.ts`

禁止改动：
- 其他任意文件

### Worker C

Worktree:
- `/Users/xin/auto-skills/CtriXin-repo/hive-c`

可写文件：
- `orchestrator/planner.ts`
- `orchestrator/translator.ts`
- `orchestrator/reporter.ts`
- `mcp-server/index.ts`

禁止改动：
- 其他任意文件

### Worker D

Worktree:
- `/Users/xin/auto-skills/CtriXin-repo/hive-d`

可写文件：
- `orchestrator/model-registry.ts`
- `orchestrator/provider-resolver.ts`
- `orchestrator/protocol-adapter.ts`
- `orchestrator/context-recycler.ts`

禁止改动：
- 其他任意文件

### Worker E

Worktree:
- `/Users/xin/auto-skills/CtriXin-repo/hive-e`

可写文件：
- `config/**`
- `orchestrator/worktree-manager.ts`
- `scripts/**`
- `rules/**`
- `.ai/**`
- `CLAUDE.md`

禁止改动：
- 其他任意文件

## 5. 所有 Worker 通用交付要求

每个 worker 都必须：

1. 先阅读：
   - `/Users/xin/auto-skills/CtriXin-repo/cli2cli/ERRATA.md`
   - `/Users/xin/auto-skills/CtriXin-repo/cli2cli/SELF_CONTAINED_ADDENDUM.md`
   - 自己对应的 `TASK-*.md`
2. 只在自己的 worktree 中工作。
3. 不回退、不覆盖别人可能会改的共享文件。
4. 如果依赖尚未实现，允许按 task 文档写正确 import/export，保持接口对齐，不要擅自扩散改动。
5. 完成后自检：
   - `npx tsc --noEmit`
   - 与自己文件相关的 smoke check
6. 最后输出：
   - 改了哪些文件
   - 通过了哪些验证
   - 还依赖哪些别人的接口
   - 有没有需要 Codex 整合时统一处理的共享契约变更

## 6. Claude Handoff Prompts

以下 prompt 可直接发给 Claude。每一路开一个独立会话。

### Prompt A2

```text
You are Worker A2 for the Hive project.

Repository worktree:
/Users/xin/auto-skills/CtriXin-repo/hive-a2

Read first:
1. /Users/xin/auto-skills/CtriXin-repo/cli2cli/ERRATA.md
2. /Users/xin/auto-skills/CtriXin-repo/cli2cli/SELF_CONTAINED_ADDENDUM.md
3. /Users/xin/auto-skills/CtriXin-repo/cli2cli/tasks/TASK-A2-qwen35.md

Authority order:
ERRATA.md > SELF_CONTAINED_ADDENDUM.md > TASK-A2-qwen35.md > CLI_BRIDGE_IMPLEMENTATION_PLAN.md

Write scope only:
- orchestrator/dispatcher.ts
- orchestrator/index.ts
- bin/hive

Do not modify:
- orchestrator/types.ts
- package.json
- tsconfig.json
- ERRATA.md
- any files outside your write scope

Important constraints:
- The project is self-contained
- Use provider-resolver and discuss-bridge, not the old names
- dispatchBatch must return DispatchResult with worker_results and opus_tasks
- CLI examples and behavior must use hive/bin/hive
- Do not import external project paths
- If other modules are missing, keep interfaces aligned and do not broaden your write scope

Validation:
- Run npx tsc --noEmit
- Report changed files, validation results, and unresolved interface dependencies
```

### Prompt B

```text
You are Worker B for the Hive project.

Repository worktree:
/Users/xin/auto-skills/CtriXin-repo/hive-b

Read first:
1. /Users/xin/auto-skills/CtriXin-repo/cli2cli/ERRATA.md
2. /Users/xin/auto-skills/CtriXin-repo/cli2cli/SELF_CONTAINED_ADDENDUM.md
3. /Users/xin/auto-skills/CtriXin-repo/cli2cli/tasks/TASK-B-kimi.md

Authority order:
ERRATA.md > SELF_CONTAINED_ADDENDUM.md > TASK-B-kimi.md > CLI_BRIDGE_IMPLEMENTATION_PLAN.md

Write scope only:
- orchestrator/reviewer.ts
- orchestrator/a2a-bridge.ts
- orchestrator/discuss-bridge.ts

Do not modify:
- shared contract files
- files outside your write scope

Important constraints:
- discuss-bridge is SDK-based and self-contained
- Do not shell out to discuss.sh
- Use provider-resolver, not mms-bridge-resolver
- Keep exports aligned with downstream imports

Validation:
- Run npx tsc --noEmit
- Report changed files, validation results, and unresolved interface dependencies
```

### Prompt C

```text
You are Worker C for the Hive project.

Repository worktree:
/Users/xin/auto-skills/CtriXin-repo/hive-c

Read first:
1. /Users/xin/auto-skills/CtriXin-repo/cli2cli/ERRATA.md
2. /Users/xin/auto-skills/CtriXin-repo/cli2cli/SELF_CONTAINED_ADDENDUM.md
3. /Users/xin/auto-skills/CtriXin-repo/cli2cli/tasks/TASK-C-qwenmax.md

Authority order:
ERRATA.md > SELF_CONTAINED_ADDENDUM.md > TASK-C-qwenmax.md > CLI_BRIDGE_IMPLEMENTATION_PLAN.md

Write scope only:
- orchestrator/planner.ts
- orchestrator/translator.ts
- orchestrator/reporter.ts
- mcp-server/index.ts

Do not modify:
- shared contract files
- files outside your write scope

Important constraints:
- planner complexity must use 4 levels: low, medium, medium-high, high
- plan_tasks must accept Chinese or English and translate when needed
- execute_plan must handle DispatchResult and opus_tasks
- execute_plan/report flow must produce Chinese report by default
- Keep MCP tool behavior aligned with ERRATA

Validation:
- Run npx tsc --noEmit
- Report changed files, validation results, and unresolved interface dependencies
```

### Prompt D

```text
You are Worker D for the Hive project.

Repository worktree:
/Users/xin/auto-skills/CtriXin-repo/hive-d

Read first:
1. /Users/xin/auto-skills/CtriXin-repo/cli2cli/ERRATA.md
2. /Users/xin/auto-skills/CtriXin-repo/cli2cli/SELF_CONTAINED_ADDENDUM.md
3. /Users/xin/auto-skills/CtriXin-repo/cli2cli/tasks/TASK-D-glm5.md

Authority order:
ERRATA.md > SELF_CONTAINED_ADDENDUM.md > TASK-D-glm5.md > CLI_BRIDGE_IMPLEMENTATION_PLAN.md

Write scope only:
- orchestrator/model-registry.ts
- orchestrator/provider-resolver.ts
- orchestrator/protocol-adapter.ts
- orchestrator/context-recycler.ts

Do not modify:
- shared contract files
- files outside your write scope

Important constraints:
- provider-resolver replaces mms-bridge-resolver
- Load provider config from config/providers.json
- Keep the project self-contained
- Exports must match downstream imports exactly

Validation:
- Run npx tsc --noEmit
- Report changed files, validation results, and unresolved interface dependencies
```

### Prompt E

```text
You are Worker E for the Hive project.

Repository worktree:
/Users/xin/auto-skills/CtriXin-repo/hive-e

Read first:
1. /Users/xin/auto-skills/CtriXin-repo/cli2cli/ERRATA.md
2. /Users/xin/auto-skills/CtriXin-repo/cli2cli/SELF_CONTAINED_ADDENDUM.md
3. /Users/xin/auto-skills/CtriXin-repo/cli2cli/tasks/TASK-E-minimax.md

Authority order:
ERRATA.md > SELF_CONTAINED_ADDENDUM.md > TASK-E-minimax.md > CLI_BRIDGE_IMPLEMENTATION_PLAN.md

Write scope only:
- config/**
- orchestrator/worktree-manager.ts
- scripts/**
- rules/**
- .ai/**
- CLAUDE.md

Do not modify:
- shared contract files
- files outside your write scope

Important constraints:
- Keep config/script names aligned with Hive identity
- .ai protocol must follow ERRATA
- Do not reintroduce external runtime dependencies

Validation:
- Run npx tsc --noEmit when applicable
- Run relevant shell smoke checks
- Report changed files, validation results, and unresolved interface dependencies
```

## 7. Codex Integration Protocol

我作为最终整合者，按这个顺序工作：

1. 等 5 路各自完成并提交。
2. 回到基线仓库 `/Users/xin/auto-skills/CtriXin-repo/hive`。
3. 依次合并：
   - D
   - E
   - B
   - A2
   - C

建议命令：

```bash
cd /Users/xin/auto-skills/CtriXin-repo/hive

git merge task/d-provider
git merge task/e-config
git merge task/b-review
git merge task/a2-dispatcher
git merge task/c-mcp
```

如有冲突：
- 以 `ERRATA.md` 为最终裁决
- 不在冲突中随意改共享契约
- 共享契约确需变更时，由 Codex 在当前目录统一修正

## 8. Claude Cross-Review Prompt

在整合完成后，把以下 prompt 发给 Claude 做最终交叉审：

```text
Please perform a cross-review of the integrated Hive branch as a reviewer, not as an implementer.

Repository:
/Users/xin/auto-skills/CtriXin-repo/hive

Read first:
1. /Users/xin/auto-skills/CtriXin-repo/cli2cli/ERRATA.md
2. /Users/xin/auto-skills/CtriXin-repo/cli2cli/SELF_CONTAINED_ADDENDUM.md
3. All task files under /Users/xin/auto-skills/CtriXin-repo/cli2cli/tasks/

Review focus:
- Violations against ERRATA authority
- Interface mismatches across modules
- Missing handling of opus_tasks / DispatchResult
- MCP Chinese I/O behavior
- Self-contained requirement violations
- Wrong old names reintroduced from the original Plan
- Risky assumptions in provider, discussion, review, and CLI flows

Output format:
1. Findings first, ordered by severity
2. Each finding must include file path and line reference
3. Then list open questions / assumptions
4. Then a short integration summary
```

## 9. 完成定义

并行阶段完成，不等于项目完成。

真正完成定义：

1. 5 路都在各自 worktree 完成交付
2. Codex 在当前目录完成整合
3. `npx tsc --noEmit` 通过
4. 相关 smoke tests 通过
5. Claude 交叉审完成
6. 人类确认后再决定是否合并/发 PR
