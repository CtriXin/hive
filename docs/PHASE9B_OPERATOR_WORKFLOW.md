# Phase 9B: Operator Workflow Polishing

**Date**: 2026-04-11
**Status**: delivered
**Theme**: Making Hive CLI output smoother — hints → commands, lifecycle-aware guidance

## Problem

Phase 9A gave operators a clear view of "what's happening" and "what to do next" via summaries and next action hints. But operators still face friction:

1. Seeing "Resume the paused run" as a hint doesn't tell you the exact command to type
2. `status / watch / steer / workers / compact / restore` form a workflow, but the path between them isn't obvious
3. Different run states (paused/blocked/partial/done/running) should naturally suggest different commands, but currently don't
4. Common operations require users to piece together flags themselves

## Solution

Two additions to the existing CLI output model:

1. **Suggested Commands** — real, executable CLI commands attached to hints and lifecycle states
2. **Lifecycle-Aware Guidance** — different run states surface different quick commands

## Architecture

### A. Command Mapping Module (`orchestrator/operator-commands.ts`)

New module, ~160 lines. Three exported functions:

| Function | Purpose |
|----------|---------|
| `commandsForHintAction(action, context)` | Maps a hint action type to 1-2 concrete CLI commands |
| `commandsForRunState(state, context)` | Maps a run state to 2-4 lifecycle commands |
| `suggestNextCommands(state, args)` | Combines hint + lifecycle commands, deduplicates, limits to 4 |

**Design principle**: Commands are real, copy-pasteable, and match the existing CLI surface. No aliases, no new commands — just the right flags on existing commands.

### B. Watch Integration (`orchestrator/watch-format.ts`)

Two changes to `formatWatch()`:

1. **Next Actions section** — each hint now shows `action: <action_type>` field
2. **Suggested Commands section** — appears after Next Actions for non-running states

Output example for a paused run:
```
== Next Actions ==
‼️ [high] Resume the paused run
   action: resume_run
   why: Run is paused via steering — resume to continue

== Suggested Commands ==
  hive resume --run-id run-123 --execute  # Resume run and re-enter loop
  hive steer --run-id run-123  # View pending steering
  hive status --run-id run-123  # See why it paused
```

For running state: no Suggested Commands section (no noise during normal operation).

### C. Status Integration (`orchestrator/index.ts`)

Two changes to `hive status`:

1. **Next Actions section** — each hint now shows `action: <action_type>` field
2. **Quick Commands section** — new section after Next Actions

Output example for a partial run:
```
== Next Actions ==
‼️ [high] Replan after task-c failed 2 times
   action: replan
   why: Task task-c repeatedly failed — replan with failure context

== Quick Commands ==
  hive status --run-id run-123  # Review current state before replanning
  hive steer --run-id run-123 --action request_replan --reason "task-c failed repeatedly"  # Submit replan steering
  hive status --run-id run-123  # See failures and blockers
  hive workers --run-id run-123  # Inspect failed workers
```

### D. Hint-to-Command Mapping

| Hint Action | Commands |
|-------------|----------|
| `resume_run` | `hive resume --run-id <id> --execute` |
| `inspect_forensics` | `hive workers --run-id <id> --worker <task>` + `hive watch --once` |
| `replan` | `hive status` + `hive steer --action request_replan` |
| `rerun_stronger_mode` | `hive steer --action escalate_mode --task-id <id>` + `hive status` |
| `steering_recommended` | `hive steer` (list mode) |
| `provider_wait_fallback` | `hive status` + `hive watch --once` |
| `merge_changes` | `hive compact` + `hive status` |
| `review_findings` | `hive workers --worker <task>` + `hive status` |
| `request_human_input` | `hive status` + `hive workers --worker <task>` |

### E. Lifecycle Command Mapping

| Run State | Commands |
|-----------|----------|
| **running** | `hive watch` + `hive workers` (+ `hive steer` if steering exists) |
| **paused** | `hive resume --execute` + `hive steer` + `hive status` |
| **partial** | `hive status` + `hive workers` + `hive steer --action request_replan` |
| **blocked** | `hive status` + `hive steer` + `hive steer --action escalate_mode` |
| **done** | `hive compact` + `hive status` + `hive restore` |

### F. Deduplication and Limiting

`suggestNextCommands()` merges hint-specific and lifecycle commands:
1. Hint commands first (most relevant to immediate need)
2. Lifecycle commands fill remaining slots
3. Duplicate commands removed (e.g., `hive status` from both sources)
4. Capped at 4 commands (cognitive load limit)

## What Changed

| File | Action | Description |
|------|--------|-------------|
| `orchestrator/operator-commands.ts` | **New** | Command mapping module (160 lines) |
| `orchestrator/watch-format.ts` | Modified | Added action field to hints, Suggested Commands section |
| `orchestrator/index.ts` | Modified | Added action field to hints, Quick Commands section |
| `tests/operator-commands.test.ts` | **New** | 21 tests for command mapping |
| `tests/watch-format.test.ts` | Modified | +4 tests for suggested commands section |

## Design Guardrails

1. **No new commands** — only uses existing `hive` CLI surface
2. **No aliases** — commands are real, not shortcuts that could confuse
3. **Contextual** — different state → different commands, not a static list
4. **Bounded** — max 4 suggested commands, hint field adds 1 line
5. **Running is quiet** — no Suggested Commands during normal operation
6. **Reusable** — `operator-commands.ts` is pure functions, no I/O

## Verification

### Build
```bash
npm run build  # passes
```

### Tests
| Test File | Tests | Status |
|-----------|-------|--------|
| `operator-commands.test.ts` | 21 | All pass |
| `watch-format.test.ts` | 23 | All pass (19 + 4 new) |
| `operator-summary.test.ts` | 18 | All pass (no regression) |
| `operator-hints.test.ts` | 20 | All pass (no regression) |

### Pre-existing Baseline
All pre-existing test failures remain unchanged (unrelated to this phase).

## Blast Radius

- **Low**: CLI output additions only
- `hive status` gains `action:` lines in hints and optional `== Quick Commands ==` section
- `hive watch` gains same sections for non-running states
- No changes to execution logic, state machine, or steering

## Unresolved Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Commands may drift from actual CLI | Low | Commands are constructed from known flag patterns; build catches missing imports |
| Output length increase | Low | Running state skips suggested commands; bounded to 4 max |
| Command duplication if context overlaps | Mitigated | Deduplication in `suggestNextCommands()` |

## Usage Examples

```bash
# See what commands to run next
hive status --run-id run-1234567890

# Live watch with suggested commands for paused/blocked/partial states
hive watch

# Single snapshot
hive watch --once
```

## How to Use

### For Operators

When you see `== Quick Commands ==` or `== Suggested Commands ==` in output:
- Copy-paste the command that matches what you want to do
- Commands include `# comments` explaining their purpose
- The `--run-id` flag is included when a run is available

### For Developers

Extend command mappings by modifying `commandsForHintAction()` and `commandsForRunState()` in `operator-commands.ts`.

## Recommended Archival/Retention

For future sessions:
1. **Primary entry point**: `docs/PHASE9B_OPERATOR_WORKFLOW.md` — this document
2. **Core module**: `orchestrator/operator-commands.ts`
3. **Test coverage**: `tests/operator-commands.test.ts`, updated `tests/watch-format.test.ts`
4. **Surface**: `orchestrator/watch-format.ts`, `orchestrator/index.ts`

### Handoff Pattern

New session接手时：
1. 读取本文档了解设计意图
2. 读取 `operator-commands.ts` 了解命令映射
3. 运行 `npm test -- operator-commands.test.ts` 验证回归
4. 扩展新命令映射时，添加对应测试

## Acceptance Criteria Met

| Criterion | Status |
|-----------|--------|
| Hints carry real executable commands | ✅ (action field + Suggested Commands section) |
| status/watch show different guidance per state | ✅ (running/paused/partial/blocked/done) |
| Output actionable, not overwhelming | ✅ (max 4 commands, running state silent) |
| `npm run build` passes | ✅ |
| Targeted tests pass (21 new + 4 watch) | ✅ |
| Short design document | ✅ |
| Closeout report | ✅ |

---

**Phase 9B is complete.** All deliverables implemented, tested, and documented.
