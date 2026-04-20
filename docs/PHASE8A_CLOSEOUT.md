# Phase 8A Closeout: Provider Resilience Pack

**Date**: 2026-04-11
**Status**: delivered

## Verification Results

| Criterion | Status |
|-----------|--------|
| Provider failure has stable subtypes (8 types) | DONE |
| Retry/backoff policy with bounded retries | DONE |
| Cooldown/breaker has durable state (file-backed) | DONE |
| Fallback/failover is explainable | DONE |
| Provider failure doesn't consume ordinary repair rounds | DONE — auth/quota throw immediately |
| Progress/forensics reflects provider resilience decisions | DONE — `provider_failure_subtype` + `provider_fallback_used` on WorkerResult |
| `npm run build` passes | DONE |
| Targeted tests pass | DONE — 60 tests (48 new + 12 existing cooldown) |
| Short design document | DONE — `docs/PHASE8A_PROVIDER_RESILIENCE.md` |

## Changed Files

| File | Action | Description |
|------|--------|-------------|
| `orchestrator/types.ts` | Modified | Added 6 new types (`ProviderFailureSubtype`, `CircuitBreakerState`, `ProviderResilienceDecision`, `ProviderHealthState`, `ProviderHealthStoreData`), extended `WorkerConfig` and `WorkerResult` |
| `orchestrator/provider-resilience.ts` | **New** | Core module: failure taxonomy (8 subtypes), circuit breaker state machine, retry/backoff policy, fallback strategy, durable health store |
| `orchestrator/dispatcher.ts` | Modified | Integrated resilience layer: `classifyError` uses new taxonomy, health store usage, circuit breaker-aware fallback, backoff delays, provider fields on WorkerResult |
| `tests/provider-resilience.test.ts` | **New** | 48 tests covering taxonomy, retry policy, breaker state machine, fallback selection, health store persistence |
| `tests/dispatcher-fallback.test.ts` | Modified | Updated legacy failure type mapping expectation |
| `docs/PHASE8A_PROVIDER_RESILIENCE.md` | **New** | Design document explaining resilience strategy |

## Implementation Summary

### Provider Failure Taxonomy (A)

8 stable subtypes replacing the old 3-type `FailureClass`:
- `rate_limit`, `timeout`, `transient_network`, `server_error` — retryable
- `auth_failure`, `quota_exhausted`, `provider_unavailable` — non-retryable (immediate throw)
- `unknown_provider_failure` — conservative retryable (don't block on unfamiliar errors)

### Retry / Backoff Policy (B)

- Max 2 retries after original call
- Per-subtype base delay (500ms–2000ms)
- Exponential backoff on 2nd retry (2x)
- 5-second hard cap on any backoff
- Non-retryable failures throw immediately — no wasted time

### Fallback Strategy (C)

- Channel fallback respects circuit breaker state
- Model fallback provider health is checked before switching
- Fallback selection scores: healthy > degraded > probing
- Decision is explainable via `provider_failure_subtype` and `provider_fallback_used` on WorkerResult

### Circuit Breaker (D)

4-state machine: healthy → degraded → open → probing → healthy
- Opens after 2 consecutive failures
- 60s cooldown before probing
- 2 probe attempts before deciding
- Success resets all counters
- Persisted to `.ai/runs/<run-id>/provider-health.json`

### Main Loop Integration (E)

- `dispatchBatch` creates health dir per run
- Each worker loads/saves health state
- Channel fallback skips open providers
- Model fallback logs when blocked by breaker state

### Explainability (F)

- `WorkerResult.provider_failure_subtype` — what kind of provider failure
- `WorkerResult.provider_fallback_used` — whether fallback path was taken
- `ProviderHealthStore` decision trace — last 100 decisions persisted
- Console messages include failure subtype and breaker state

## Pending Risks

1. **Concurrent workers**: Multiple parallel workers share the same file-backed health store. Race conditions possible but low-impact (stale read at worst).
2. **CooldownStore still exists**: `ProviderCooldownStore` is still used by `capability-router.ts`. Phase 8A's `ProviderHealthStore` is additive, not a replacement. Future: unify.
3. **Driver.ts not updated**: The driver creates runs but doesn't explicitly wire the health store. Workers get it via `providerHealthDir` in config, which works.
4. **No retry loop in spawnWorker**: Currently the retry/backoff policy affects fallback decisions but doesn't loop back to re-attempt the same provider. This is intentional for safety — a future iteration could add same-provider retry with backoff.

## Next Phase Recommendation

The next phase should be `Human Intervention + Steering Surface`. Before that, consider:
- Unifying `ProviderCooldownStore` and `ProviderHealthStore` into a single health system
- Adding `provider_health_status` to the run status output (`hive run_status`)
- Adding same-provider retry loop with backoff (currently only fallback, not re-try)
