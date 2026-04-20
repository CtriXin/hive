# Phase 5A: Quick / Think / Auto Modes + Operator Surface

**Date**: 2026-04-10
**Status**: implemented
**Theme**: Making Hive's execution style explicit and predictable

## 1. Mode Definition

### ExecutionMode

Three distinct operator-facing modes that control how deeply Hive engages its orchestration machinery:

| Mode | Planning | Dispatch | Review | Verify | Discuss | Repair | Replan | Auto-merge |
|------|----------|----------|--------|--------|---------|--------|--------|------------|
| `quick` | minimal | single | light | minimal | disabled | NO | NO | yes |
| `think` | full | parallel | full-cascade | standard | standard | yes | yes | NO |
| `auto` | full | full-orchestration | full-cascade | full-suite | enforced | yes | yes | yes |

### Mode Contracts

Each mode produces a `ModeContract` that answers at runtime:

- `planning_depth` — how deep planning goes
- `dispatch_style` — how workers are dispatched
- `review_intensity` — how thorough review is
- `verification_scope` — how much verification
- `discuss_gate` — whether cross-model discussion is forced
- `allow_auto_merge` — whether passed tasks auto-merge
- `allow_repair` — whether repair rounds are allowed
- `allow_replan` — whether replanning is allowed

## 2. Runtime Behavior

### Quick Mode

- Uses planner-assigned model directly — no routing override, no discuss gate
- Worker dispatch and review proceed normally
- If repair or replan is needed → skip and finalize with available results
- No mode escalation — Quick stays Quick

### Think Mode

- Full planning, full review cascade
- No auto-merge by default — changes stay in worktrees for inspection
- Discuss gate runs at standard level
- Repair and replan allowed

### Auto Mode

- Hive's full orchestration: plan → dispatch → review → verify → repair → replan
- Routing override and discuss gate both enforced
- Auto-merge for passed tasks
- Full verification suite

## 3. Mode Escalation

When a task is assessed as high-risk:

- `Quick + high-risk` → escalates to `Think`
- `Think` and `Auto` never escalate further

Escalation is recorded in the progress artifact so users can see when/why mode changed.

## 4. Default Behavior

- If no `--execution-mode` flag: **defaults to `auto`**
- `hive run` command: `--execution-mode quick | think | auto`
- MCP `run_goal`: `execution_mode` parameter (optional, defaults to auto)

## 5. Operator Surface

### CLI `hive status`

```
🟡 Run: run-1234567890
📊 status: executing
🔁 round: 2
⚡ execution_mode: auto
🧭 phase: repairing — Repairing 1 failed task(s)...
```

### MCP `run_status`

```
## Run: run-1234567890
**Status**: executing
**Goal**: Build auth system
**Mode**: safe
**Execution Mode**: auto
**Rounds**: 2/6
```

### Loop Progress Artifact

`.ai/runs/<run-id>/loop-progress.json` now includes `execution_mode` field.

### Mode Escalation Display

If mode was escalated during execution, MCP output shows:

```
**Mode Escalated**: quick → think
```

## 6. Files Modified

| File | Change |
|------|--------|
| `orchestrator/types.ts` | Added `ExecutionMode`, `ModeContract` types; `execution_mode` on `RunSpec` |
| `orchestrator/loop-progress-store.ts` | Added `execution_mode` field to `LoopProgress` |
| `orchestrator/mode-policy.ts` | **NEW** — mode contracts, inference, escalation logic |
| `orchestrator/driver.ts` | Mode-aware repair/replan skip, mode in progress updates |
| `orchestrator/dispatcher.ts` | Quick mode skips routing override and discuss gate |
| `orchestrator/index.ts` | CLI `--execution-mode` flag, mode display in status |
| `mcp-server/index.ts` | MCP `execution_mode` param, mode display in run_status |
| `tests/mode-policy.test.ts` | **NEW** — 11 tests for mode contracts, inference, escalation |

## 7. Verification

```
npm run build: ✅ Passes
npm test: 784/784 pass (784 passing, 0 failing)
New tests: 11/11 pass
```

## 8. Blast Radius

### What changed
1. `RunSpec` gains optional `execution_mode` field (backward compatible — defaults to `auto`)
2. `dispatchBatch` accepts optional `executionMode` (backward compatible — `undefined` = existing behavior)
3. Quick mode skips routing + discuss gate enforcement
4. Quick mode skips repair/replan rounds

### What did NOT change
1. Planner's task decomposition
2. Task descriptions
3. Review cascade for Think/Auto modes
4. Existing `RunMode` (safe/balanced/aggressive) — orthogonal concern
5. Non-Quick task dispatch — exactly as before

### Regression guardrails
1. Default mode is `auto` — existing users see no behavior change
2. Quick mode is strictly less orchestration, not more — cannot introduce failures
3. Mode escalation is opt-in and logged

## 9. Known Limitations

1. **Review intensity not yet enforced in code** — `light` vs `full-cascade` is defined in contract but the actual review cascade still runs the same path. Future: let mode skip a2a lenses in Quick mode.
2. **Verification scope not yet enforced** — `minimal` vs `full-suite` is defined but not mechanically enforced. Future: Quick mode could skip suite-level verification.
3. **Planning depth not yet enforced** — `minimal` vs `full` planning is defined but planning still uses the same prompt. Future: Quick mode could skip planning entirely and use a simple worker dispatch.
4. **Mode escalation not yet auto-triggered** — `shouldEscalateMode` is defined but not yet hooked into the driver loop.

## 10. Next Phase (Phase 6A)

- Cross-Run Learning + Rule Auto-Selection
- If provider rate limits still cause pain, consider a Provider Resilience Mini-Pack
