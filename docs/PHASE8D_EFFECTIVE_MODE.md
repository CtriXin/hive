# Phase 8D: Effective Mode Consistency

**Date**: 2026-04-11
**Status**: implemented
**Theme**: Single source of truth for execution mode across all mode-sensitive paths

## Problem

After Phase 8B (Human Steering), `escalate_mode` and `downgrade_mode` steering actions set `RunState.runtime_mode_override` to change a run's execution depth at runtime. However, several mode-sensitive code paths continued to read `RunSpec.execution_mode` directly, ignoring the override:

1. **Driver loop** (`driver.ts:1774`) — `spec.execution_mode || 'execute-standard'` — determines early-exit lanes, repair allowance, replan allowance, verification scope
2. **Dashboard** (`hiveshell-dashboard.ts:412`) — only showed `spec.execution_mode`, hiding the steered mode
3. **MCP `run_status`** — showed `spec.mode` (RunMode: safe/balanced/aggressive), not execution mode at all
4. **CLI `hive status`** — showed `spec.execution_mode`, not the effective mode

This meant steering could change the *displayed* mode but not the *actual* execution behavior, or vice versa — the two could diverge silently.

## Solution

### A. Unified Effective Mode Resolver

New helper in `orchestrator/mode-policy.ts`:

```typescript
resolveEffectiveMode(spec, state) → {
  mode,           // raw mode value
  normalized,     // normalized contract-backed mode
  contract,       // ModeContract for the normalized mode
  source,         // 'runtime_override' | 'spec' | 'default'
  overridden      // boolean — was steering used?
}
```

Priority: `state.runtime_mode_override` → `spec.execution_mode` → `'auto'` default.

### B. Consistency Updates

| Location | Before | After |
|----------|--------|-------|
| `driver.ts` entry | `spec.execution_mode` | `resolveEffectiveMode(spec, state)` |
| `hiveshell-dashboard.ts` | `spec.execution_mode` | `resolveEffectiveMode(spec, state)` |
| `mcp-server/index.ts` | `spec.mode` (RunMode) | `resolveEffectiveMode(spec, state)` |
| `orchestrator/index.ts` CLI | `spec.execution_mode` | `resolveEffectiveMode(spec, state)` |
| `watch-loader.ts` | Already correct | No change |
| `steering-actions.ts` | Already correct | No change |

### C. Surface Consistency

When mode is overridden by steering, surfaces show:
- `mode: execute-parallel (steered from execute-standard)`
- MCP: `**Mode**: execute-parallel (steered from execute-standard)`
- CLI: `⚡ mode: execute-parallel (steered from execute-standard)`

### D. Tests

11 new tests in `tests/effective-mode.test.ts`:
- Override is used when present
- Spec fallback when no override
- Default fallback when neither
- Legacy mode normalization in override
- Legacy mode normalization in spec
- Contract matches normalized mode
- Override changes `allow_repair` behavior
- Override changes `allow_replan` behavior
- Override changes verification scope
- No-override case preserves original behavior

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `orchestrator/mode-policy.ts` | Modified | Added `resolveEffectiveMode()` + `EffectiveModeResult` interface |
| `orchestrator/driver.ts` | Modified | Replaced `spec.execution_mode` with `resolveEffectiveMode(spec, currentState)` at entry point; added log when mode is steered |
| `orchestrator/hiveshell-dashboard.ts` | Modified | `renderCurrentMode()` now uses `resolveEffectiveMode()`; shows steered indicator |
| `orchestrator/index.ts` | Modified | CLI `hive status` shows effective mode with steered indicator |
| `mcp-server/index.ts` | Modified | `run_status` shows effective mode instead of wrong `spec.mode` field |
| `tests/effective-mode.test.ts` | **New** | 11 tests for resolver behavior and decision-path impacts |

## Design Guardrails

1. **No mode-policy.ts changes to contracts** — resolver only reads existing contracts
2. **No new steering actions** — only connects existing override to existing consumers
3. **Backward compatible** — `resolveEffectiveMode` handles missing fields gracefully
4. **No normalization in return value** — raw mode preserved in `result.mode`, normalized in `result.normalized`
5. **Source tracking** — `source` and `overridden` fields let callers distinguish override from spec

## Verification

- `npm run build`: passes (tsc, no errors)
- New tests: 11/11 pass
- Existing mode tests: 4 pre-existing failures unchanged (unrelated to this change — test `inferExecutionMode` normalization behavior)
- Steering tests: 44/44 pass

## Blast Radius

### Changed
1. Driver loop entry now uses effective mode — this means steering via `escalate_mode`/`downgrade_mode` now *actually* changes execution behavior (repair, replan, verification scope), not just display
2. Dashboard/MCP/CLI show effective mode with steered indicator

### NOT Changed
1. Mode contracts — unchanged
2. Steering action validation/application — unchanged
3. Planner, dispatcher, reviewer logic — unchanged (they receive the modeContract from the driver, which now correctly reflects the override)
4. Existing test expectations — unchanged

## What This Fixes

Before this change, running `hive steer --action escalate_mode --target-mode think` would:
- Update `runtime_mode_override` in state
- Show the new mode in some surfaces
- But the driver would still use the original `spec.execution_mode` for decisions

After this change, the escalation actually changes:
- `allow_repair`: false→true (when escalating from lite to standard)
- `allow_replan`: false→true
- `verification_scope`: minimal→standard
- `review_intensity`: light→full-cascade
- `discuss_gate`: disabled→standard
