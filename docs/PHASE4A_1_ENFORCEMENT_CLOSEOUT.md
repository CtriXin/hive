# Phase 4A.1: Enforcement Closeout

**Date**: 2026-04-10
**Status**: Complete
**Theme**: Routing + Discuss Gate Enforcement + Durable Cooldown

## Executive Summary

Phase 4A.1 upgrades three existing diagnostic systems into mechanical enforcement controls:

1. **Router override policy** — capability routing now mechanically affects effective model under defined conditions
2. **Discuss gate enforcement** — gate triggers map to concrete dispatch actions (reroute/escalate/block)
3. **Durable provider cooldown** — cooldown state persists to disk, survives session restart

Build passes, 30 new tests pass, 770/771 total (1 pre-existing unrelated failure in `lock.test.ts`).

## Deliverables

### ✅ Complete

| Deliverable | Location | Status |
|-------------|----------|--------|
| Enforcement policy design doc | `docs/PHASE4A_1_ENFORCEMENT.md` | Complete |
| Router override logic | `orchestrator/routing-enforcement.ts` | Complete |
| Durable cooldown store | `orchestrator/provider-cooldown-store.ts` | Complete |
| Dispatcher integration | `orchestrator/dispatcher.ts` | Complete |
| New enforcement types | `orchestrator/types.ts` | Complete |
| Router enforcement tests | `tests/routing-enforcement.test.ts` | 16 tests |
| Cooldown store tests | `tests/provider-cooldown-store.test.ts` | 14 tests |
| Design doc | `docs/PHASE4A_1_ENFORCEMENT.md` | Complete |
| This closeout | `docs/PHASE4A_1_ENFORCEMENT_CLOSEOUT.md` | Complete |

## Build & Test Status

```
npm run build: ✅ Passes
npm test (all): 770/771 pass (1 pre-existing unrelated failure)
New tests: 30/30 pass
  - routing-enforcement: 16 tests
  - provider-cooldown-store: 14 tests
Existing enforcement-related tests: 38/38 pass
  - discuss-gate: 20 tests
  - planner: 8 tests
```

## Implementation Details

### A. Router Override Policy

**File**: `orchestrator/routing-enforcement.ts`

The `enforceRoutingOverride()` function evaluates a policy matrix:

| Condition | Override | Policy ID |
|-----------|----------|-----------|
| `scored` + gap >= 0.15 + complexity OK | YES | `high_confidence_score` |
| Planner provider in cooldown | YES | `provider_cooldown` |
| Repair round | YES | `repair_round_boost` |
| `fallback` method | YES | `fallback_best_available` |
| `heuristic` method | NO | `conservative_keep` |
| Gap < 0.15 | NO | `suggest_only` |
| Router picks weaker model for complexity | NO | `conservative_keep` |

Each decision produces a `RoutingEnforcementResult`:
- `planner_assigned_model`
- `router_selected_model`
- `effective_model`
- `override_applied: boolean`
- `override_reason: string`
- `policy: RoutingOverridePolicy`

### B. Discuss Gate Enforcement

**File**: `orchestrator/routing-enforcement.ts` (same file, separate function)

The `enforceDiscussGate()` function maps each trigger policy to a concrete action:

| Trigger Policy | Action | Effective Path |
|---------------|--------|----------------|
| `confidence_threshold` | `reroute` | `rerouted` |
| `high_complexity_repair` + Opus | `escalate` | `escalated` |
| `high_complexity_repair` + partner | `reroute` | `rerouted` |
| `high_risk_failure_class` + Opus | `escalate` | `escalated` |
| `high_risk_failure_class` + other | `reroute` | `rerouted` |
| `unstable_retries` + Opus (>=5) | `block` | `blocked` |
| `unstable_retries` (3-4) | `reroute` | `rerouted` |
| `capability_mismatch` | `reroute` | `rerouted` |
| `none` | `none` | `direct` |

Each decision produces a `DiscussEnforcementResult`:
- `discuss_required: boolean`
- `enforcement_action: reroute | escalate | block | suggest_only | none`
- `effective_path: direct | rerouted | escalated | blocked`
- `dispatch_blocked: boolean`
- `escalation_target: string`

### C. Durable Provider Cooldown

**File**: `orchestrator/provider-cooldown-store.ts`

- `ProviderCooldownStore` class with `recordFailure()`, `isCooledDown()`, `reset()`, `save()`, `load()`
- Persists to `.ai/runs/<runId>/provider-cooldown.json`
- Simple JSON format: `{ providers: { "<name>": { failures: N, last_failure: ts } } }`
- Auto-clears after 60-second window
- Global singleton via `getGlobalCooldownStore()`
- No database, no complex state machine

### D. Dispatcher Integration

**File**: `orchestrator/dispatcher.ts` (modified)

The `dispatchBatch()` function now:
1. Evaluates routing override for each task
2. Applies override if policy conditions met
3. Evaluates discuss gate and maps to enforcement action
4. Uses effective model (after override + reroute/escalate) for worker dispatch
5. Logs all decisions with policy IDs for traceability

## Changed Files

| File | Change |
|------|--------|
| `orchestrator/routing-enforcement.ts` | **NEW** — router override policy + discuss gate enforcement logic |
| `orchestrator/provider-cooldown-store.ts` | **NEW** — durable cooldown persistence |
| `orchestrator/types.ts` | Modified — added `RoutingEnforcementResult`, `DiscussEnforcementResult`, `RoutingOverridePolicy` types |
| `orchestrator/dispatcher.ts` | Modified — integrated enforcement, uses effective model for dispatch |
| `orchestrator/capability-router.ts` | Modified — exported `extractProvider()` |
| `tests/routing-enforcement.test.ts` | **NEW** — 16 tests for override policy |
| `tests/provider-cooldown-store.test.ts` | **NEW** — 14 tests for cooldown persistence |
| `docs/PHASE4A_1_ENFORCEMENT.md` | **NEW** — design doc |
| `docs/PHASE4A_1_ENFORCEMENT_CLOSEOUT.md` | **NEW** — this closeout |

## Verification Results

### Routing Override
- ✅ High confidence score override works
- ✅ Small gap → suggest only (no override)
- ✅ Provider cooldown forces override
- ✅ Repair round boost works
- ✅ Fallback mode uses best available
- ✅ Conservative keep when router agrees with planner
- ✅ Dispatch record includes all required fields

### Discuss Gate Enforcement
- ✅ No trigger → direct path
- ✅ Low confidence → reroute to Sonnet
- ✅ High complexity repair → escalate to Opus or reroute
- ✅ Planner failure → escalate to Opus
- ✅ Context failure → reroute to cross-model
- ✅ Scope failure → reroute to Sonnet
- ✅ Retry >= 5 → block with Opus authority
- ✅ 3-4 retries → reroute
- ✅ Capability mismatch → reroute

### Provider Cooldown
- ✅ Records failure, marks cooldown after 2 failures
- ✅ Auto-clears after 60s window
- ✅ Persists to disk
- ✅ Loads from disk
- ✅ Handles missing/malformed files gracefully
- ✅ Global singleton works correctly

### Regression Guards
- ✅ Normal tasks dispatch as before (existing tests pass)
- ✅ Provider failure never routes through discuss gate (provider excluded from HIGH_RISK_FAILURE_CLASSES)
- ✅ Build passes
- ✅ 770/771 tests pass (1 pre-existing unrelated failure)

## Known Limitations

1. **Cooldown window is 60s** — may be too short for some providers. Configurable but hardcoded.
2. **Cooldown store is per-run** — `.ai/runs/<runId>/` means different runs have separate cooldowns. This is intentional for isolation.
3. **Discuss gate enforcement uses hardcoded escalation targets** — `claude-sonnet`, `claude-opus`. Should ideally resolve from model registry.
4. **Effective model logging is console.log only** — not yet in structured artifact. Future: include in dispatch record JSON.

## Risks

1. **Override too aggressive?** — The 0.15 score gap threshold and conservative defaults should prevent runaway overrides. Monitor via `override_reason` logs.
2. **Block too broad?** — Only `unstable_retries` with `>=5` retries + Opus authority triggers block. Very rare in practice.
3. **Cooldown persistence race** — No file locking on `provider-cooldown.json`. Safe because writes are append-like (full object write) and cooldown is best-effort.

## Next Phase Recommendation (Phase 5A)

With enforcement in place, Phase 5A (Quick/Think/Auto modes + operator surface) can build on top of:
- Effective model selection as a mode signal
- Discuss gate actions as mode-dependent behaviors
- Provider cooldown as a reliability signal for Auto mode

Specifically:
- Quick mode: skip discuss gate, use cheapest capable model
- Think mode: full enforcement, discuss gate active
- Auto mode: adaptive — enable gate + override, monitor cooldown

## Sign-Off

**Implementation**: Complete
**Testing**: Complete (30 new tests, 770/771 total)
**Documentation**: Complete
**Build**: Passes

**Ready for**: Phase 5A (Quick/Think/Auto modes + operator surface)
