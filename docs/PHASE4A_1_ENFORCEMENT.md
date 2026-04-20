# Phase 4A.1: Enforcement Design

**Date**: 2026-04-10
**Status**: implemented

## 1. Router Override Policy

The capability router currently produces advisory decisions. This phase makes it mechanically affect dispatch under defined conditions.

### Override Decision Matrix

| Condition | Override? | Reason |
|-----------|-----------|--------|
| `selection_method = scored` AND score gap >= 0.15 | YES | High confidence router decision |
| `selection_method = scored` AND assigned provider in cooldown | YES | Planner assigned a failed provider |
| `selection_method = scored` AND `isRepair = true` | YES | Repair rounds benefit from capability-aware selection |
| `selection_method = heuristic` | NO | Not enough data to justify override |
| `selection_method = fallback` | YES (conservative) | All providers unhealthy, take best available |
| Scored but selected model `max_complexity < task.complexity` | NO | Router picked weaker model — conservative keep |
| Scored but selected provider ≠ planner provider AND no cooldown | CONSERVATIVE | Log as `suggest_only`, keep planner assignment |

### Override Result Fields

Every dispatch records:
- `planner_assigned_model` — what planner originally picked
- `router_selected_model` — what router scored highest
- `effective_model` — what actually runs the task
- `override_applied` — true/false
- `override_reason` — human-readable policy reason

### Policy ID

Each override is tagged with a `RoutingOverridePolicy` enum value for traceability:
- `high_confidence_score` — scored with sufficient gap
- `provider_cooldown` — planner model's provider is cooled down
- `repair_round_boost` — repair round uses router selection
- `fallback_best_available` — all deprioritized, best remaining
- `conservative_keep` — low confidence or mismatch, keep planner
- `suggest_only` — router disagrees but not confident enough to override

## 2. Discuss Gate Enforcement

The discuss gate currently evaluates conditions but takes no mechanical action. This phase maps each trigger policy to a concrete enforcement action.

### Enforcement Action Matrix

| Trigger Policy | Risk Level | Enforcement Action |
|---------------|------------|-------------------|
| `confidence_threshold` (confidence < 0.5) | HIGH | `reroute` to stronger model (Sonnet authority) |
| `confidence_threshold` (0.5 <= confidence < 0.7) | MEDIUM | `reroute` to partner model |
| `high_complexity_repair` (high + retry >= 2) | HIGH | `escalate` to Opus authority |
| `high_complexity_repair` (medium-high or retry < 2) | MEDIUM | `reroute` to partner model |
| `high_risk_failure_class` (planner) | HIGH | `escalate` to Opus for replanning |
| `high_risk_failure_class` (context) | MEDIUM | `reroute` to cross-model discussion partner |
| `high_risk_failure_class` (scope) | MEDIUM | `reroute` to Sonnet authority model |
| `unstable_retries` (retry >= 5) | HIGH | `block` with `requires_higher_review` |
| `unstable_retries` (3 <= retry < 5) | MEDIUM | `reroute` to stronger model |
| `capability_mismatch` | MEDIUM | `reroute` to capable model |

### Provider Failure分流

Provider failure is NOT a discuss problem. The routing system handles it:
- Provider in cooldown → router marks deprioritized, picks next best
- All providers in cooldown → fallback to best-scored deprioritized
- Provider API error → dispatcher fallback chain (existing)

Discuss gate must NOT trigger for pure provider failures. The `provider` failure class is explicitly excluded from `HIGH_RISK_FAILURE_CLASSES`.

### Dispatch Record Fields

Every dispatch records discuss gate state:
- `discuss_required` — true if gate triggered
- `enforcement_action` — `reroute` | `escalate` | `block` | `suggest_only` | `none`
- `effective_path` — `direct` | `rerouted` | `escalated` | `blocked`
- `dispatch_blocked` — true if task cannot proceed
- `escalation_target` — recommended model/authority

## 3. Durable Provider Cooldown

Current: in-memory Map, lost between sessions/runs.
Target: file-based, survives session restart.

### Design

- Store at `.ai/runs/<run-id>/provider-cooldown.json`
- Simple JSON: `{ "providers": { "<name>": { "failures": N, "last_failure": ts } } }`
- Loaded at dispatch start, written on each failure
- Cooldown window: 60 seconds (same as current)
- No database, no complex state machine

### Integration

- `ProviderCooldownStore` class with `record()`, `isCooledDown()`, `reset()`, `load()`, `save()`
- Router reads from store instead of in-memory Map
- Dispatcher writes failures to store
- Cross-session: load from file if exists

## 4. Blast Radius Controls

### What CAN change per dispatch
1. `effective_model` — may differ from planner assignment
2. Dispatch path — may be rerouted or blocked
3. Provider cooldown state — persisted to disk

### What MUST NOT change
1. Planner's task decomposition — unchanged
2. Task descriptions — unchanged
3. Review cascade — unchanged
4. Non-gated tasks — dispatch normally, no added latency

### Regression guardrails
1. Normal tasks (no gate, no cooldown) dispatch exactly as before
2. Override only applies when policy conditions are met
3. Provider failure never routes through discuss gate
4. Effective model always matches what actually runs
