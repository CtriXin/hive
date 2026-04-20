# Phase 5A.1: Mode Enforcement Completion

## Overview

Quick / Think / Auto execution modes now have mechanically different runtime behavior across 4 dimensions: review intensity, verification scope, planning depth, and automatic escalation.

## Enforcement Matrix

| Dimension | Quick | Think | Auto |
|---|---|---|---|
| **Planning Depth** | minimal (max 5 tasks, simple) | full (analytical, risk analysis) | full (analytical, risk analysis) |
| **Dispatch Style** | single | parallel | full-orchestration |
| **Review Intensity** | light (cross-review only) | full-cascade | full-cascade |
| **Verification Scope** | minimal (smoke only) | standard (build + test, skip lint) | full-suite (build + test + lint) |
| **Discuss Gate** | disabled | standard | enforced |
| **Auto-merge** | no | no | yes |
| **Repair / Replan** | no | yes | yes |

## Key Changes

### Review Intensity Routing (`orchestrator/reviewer.ts`)

`runReview()` now accepts optional `reviewIntensity` parameter. `'light'` mode runs cross-review only — skips a2a, arbitration, and final review stages. `'full-cascade'` runs the complete pipeline.

### Verification Scope (`orchestrator/driver.ts`)

Quick mode skips suite verification entirely (only smoke check). Think mode runs standard verification but skips linting. Auto runs the full build + test + lint suite.

### Planning Depth (`orchestrator/planner.ts`, `planner-runner.ts`)

Three distinct prompt templates:
- **Minimal** (Quick): max 5 tasks, no dependencies, keep it simple
- **Analytical** (Think): risk analysis, tradeoffs, max 8 tasks
- **Full** (Auto): same as analytical, but with full orchestration around it

`planGoal()` accepts `{ planningDepth: 'minimal' | 'full' }` to select the template.

### Automatic Escalation (`orchestrator/mode-policy.ts`)

`shouldEscalateModeRich()` evaluates multiple runtime signals:

| Trigger | From | To |
|---|---|---|
| high_risk_task | quick | think |
| discuss_gate_in_quick | quick | think |
| high_complexity_in_quick | quick | think |
| provider_instability_in_quick | quick | think |
| planner_failure_in_quick | quick | think |
| repeated_failure_in_think (2+) | think | auto |
| critical_verify_in_think | think | auto |
| auto (any) | — | never escalates |

Escalation is logged to `RunState.mode_escalation_history` and displayed in MCP `run_status` output.

## Blast Radius

| File | Change |
|---|---|
| `orchestrator/mode-policy.ts` | Rich escalation inputs + multi-trigger detection |
| `orchestrator/reviewer.ts` | Light review path |
| `orchestrator/driver.ts` | All enforcement convergence: review intensity, verification scope, escalation |
| `orchestrator/planner.ts` | Minimal + analytical prompt templates |
| `orchestrator/planner-runner.ts` | Planning depth option |
| `orchestrator/types.ts` | `mode_escalation_history` on `RunState` |
| `mcp-server/index.ts` | Escalation history display |
| `tests/mode-enforcement.test.ts` | New test file — 29 tests |
| `tests/mode-policy.test.ts` | Minor fix: reason string format |

## Resolved Risks

- **Duplicate variable in driver.ts**: Fixed `reSmokePassed` double declaration introduced during edits
- **Backward compat**: `shouldEscalateMode(mode, riskLevel)` delegates to rich version with defaults — no API break
