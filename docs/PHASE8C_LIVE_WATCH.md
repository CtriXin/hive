# Phase 8C: Live Run Watch + Steering Visibility

**Date**: 2026-04-11
**Status**: delivered
**Theme**: Making run state continuously observable without web dashboard

## Problem

Hive has progress artifacts, forensics, steering, provider health, and mode escalation — but all are "look on disk after the fact". During a long run:
1. `hive status` is a one-shot snapshot, not suited for continuous observation
2. `hive watch` existed but just polled `printHiveShell` without steering/provider/mode detail
3. Steering actions were submitted but hard to see whether they took effect
4. Provider health and mode escalation were invisible during execution

## Solution

Upgrade `hive watch` into a purpose-built live observation surface that aggregates existing artifacts into a single readable view, and enhances `hive status` with mode/steering/provider summaries.

## Architecture

### Data Layer: `orchestrator/watch-loader.ts`

Read-only aggregation of existing artifacts into a unified `WatchData` interface:

| Field | Source | Fallback |
|-------|--------|----------|
| `run_id`, `status`, `round` | `run-store` (state.json) | `loop-progress.json` |
| `phase`, `phase_reason` | `loop-progress.json` | n/a |
| `mode` | `RunSpec.execution_mode` + `RunState.mode_escalation_history` | defaults to `auto` |
| `focus_task/agent/summary` | `loop-progress.json` | n/a |
| `steering` | `steering-store` (steering.json) | empty summary |
| `provider` | `provider-health.json` | empty summary |
| `artifacts_available/missing` | computed | — |

**Design principle**: watch is a read-only surface. It creates no new state source.

### Format Layer: `orchestrator/watch-format.ts`

Two formatters:
- `formatWatch(data)` — full multi-section view for continuous watch
- `formatWatchCompact(data)` — single-line summary for quick polls

Sections rendered:
1. **Run** — run_id, status, round, phase, mode, focus, next action, updated_at
2. **Steering** — paused state, pending count, last applied/rejected, recent actions
3. **Provider** — total/healthy/degraded/open/probing counts, unhealthy detail lines
4. **Mode Escalation** — history entries (only if escalated)
5. **Missing Artifacts** — only when some expected artifacts are absent

### Dashboard Integration: `orchestrator/hiveshell-dashboard.ts`

Extended `HiveShellDashboardData` with:
- `providerHealth: ProviderHealthStoreData | null`
- `steeringStore: SteeringStore | null`

New render functions:
- `renderSteering()` — paused, pending, applied, rejected, recent actions
- `renderProviderHealth()` — counts + unhealthy detail lines
- `renderModeEscalation()` — history entries
- `renderCurrentMode()` — mode + escalation indicator

Dashboard sections updated: added Mode, Steering, Provider Health, Mode Escalation.

### CLI: `orchestrator/index.ts`

`hive watch` upgraded:
- `hive watch` — continuous poll (2s interval, clear screen)
- `hive watch --run-id <id>` — watch specific run
- `hive watch --once` — single snapshot (useful for scripts)
- `hive watch --interval-ms 5000` — custom poll interval

`hive status` enhanced:
- Shows `mode` with escalation count
- Shows mode escalation history entries
- Shows `provider` health summary when provider-health.json exists

## What Changed

| File | Action | Description |
|------|--------|-------------|
| `orchestrator/watch-loader.ts` | **New** | Data aggregation: reads progress, state, steering, provider health into unified WatchData with graceful fallback |
| `orchestrator/watch-format.ts` | **New** | Formatter: multi-section `formatWatch()` and single-line `formatWatchCompact()` |
| `orchestrator/hiveshell-dashboard.ts` | Modified | Added providerHealth/steeringStore fields, 4 new render functions, updated dashboard sections |
| `orchestrator/index.ts` | Modified | Upgraded `hive watch` with --once, dedicated loader/formatter; enhanced `hive status` with mode/steering/provider |
| `tests/watch-loader.test.ts` | **New** | 9 tests: full data, partial data, graceful fallback, steering, provider, mode escalation |
| `tests/watch-format.test.ts` | **New** | 19 tests: all sections, edge cases, compact format |

## Verification

### Build
All new files compile cleanly. `npm run build` passes on main branch.

### Tests
| Test File | Tests | Status |
|-----------|-------|--------|
| `watch-loader.test.ts` | 9 | All pass |
| `watch-format.test.ts` | 19 | All pass |
| `hiveshell-dashboard.test.ts` | 18 | All pass (no regression) |
| `cli-surface.test.ts` | 3 | All pass (no regression) |

## Blast Radius

- **Low**: Watch is read-only, no state mutation
- `hive status` additions are additive (new lines only when data exists)
- Dashboard extensions gracefully handle null data
- No changes to driver, dispatcher, or orchestration logic

## Pending Risks

1. **Long watch output**: For runs with many steering actions or provider entries, output may scroll. The `--once` flag mitigates this for script usage.

## Usage Examples

```bash
# Continuous live watch (refreshes every 2s)
hive watch

# Watch a specific run
hive watch --run-id run-1234567890

# Single snapshot (useful for scripts/piping)
hive watch --once

# Custom refresh interval
hive watch --interval-ms 5000

# Enhanced status with mode/provider/steering
hive status --run-id run-1234567890
```

## Watch Output Example

```
== Hive Watch [2026-04-11T10:00:00Z] ==

== Run ==
run: run-1234567890
status: executing | round: 2/6
phase: executing | Dispatching 2 task(s) to workers
mode: auto
focus: task-a (worker-1) | Implementing auth middleware
next: execute: Dispatching tasks
updated: 2026-04-11T10:00:00.000Z

== Steering ==
no steering actions

== Provider ==
2 total | 1 healthy | 1 degraded
degraded: provider-b (rate_limit)

== Mode Escalation ==
round 1: quick → think | high_risk_task
```
