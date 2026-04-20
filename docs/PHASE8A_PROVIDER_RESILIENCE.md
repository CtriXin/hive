# Phase 8A: Provider Resilience Pack

**Date**: 2026-04-11
**Status**: implemented

## Overview

This phase upgrades provider failure handling from a simple cooldown counter to a structured resilience layer with failure taxonomy, circuit breaker state machine, bounded retry/backoff, and explainable fallback selection.

## Problem

Prior to this phase:
- Provider failures were classified into only 3 buckets (`rate_limit`, `server_error`, `quality_fail`)
- Cooldown was a simple failure counter with 60s window — no state machine
- Auth and quota failures could trigger blind retries
- No circuit breaker semantics — provider went from "ok" to "cooled down" with no intermediate state
- Fallback decisions were not explainable in artifacts

## Architecture

### 1. Provider Failure Taxonomy

8 stable subtypes in `ProviderFailureSubtype`:

| Subtype | HTTP patterns | Retryable | Example |
|---------|--------------|-----------|---------|
| `rate_limit` | 429, overloaded, throttled | yes | "429 Too Many Requests" |
| `timeout` | ETIMEDOUT, timeout | yes | "Connection timeout" |
| `transient_network` | ECONNREFUSED, ECONNRESET | yes (immediate) | "socket hang up" |
| `server_error` | 5xx, Bad Gateway | yes | "503 Service Unavailable" |
| `auth_failure` | 401, 403, invalid key | **no** | "401 Unauthorized" |
| `quota_exhausted` | quota, credits | **no** | "Quota exhausted" |
| `provider_unavailable` | no route found | **no** | "No route found for model" |
| `unknown_provider_failure` | unmatched | yes (conservative) | anything else |

Key principle: auth, quota, and provider_unavailable are **never** blindly retried. They throw immediately with an explainable error.

### 2. Retry / Backoff Policy

| Attempt | Action | Backoff |
|---------|--------|---------|
| 1st retry | `bounded_retry` or `immediate_retry` (for transient_network) | Per-subtype base (500–2000ms) |
| 2nd retry | `backoff_retry` | 2x exponential |
| 3rd+ attempt | `cooldown` | Block — proceed to fallback or fail |

Retry budget: max 2 retries after original call (3 total attempts). Each retry has a bounded delay capped at 5 seconds.

### 3. Circuit Breaker State Machine

```
healthy → degraded → open → probing → healthy
  ↑                                ↓
  └──────────── failure ───────────┘
```

| State | Trigger | Behavior |
|-------|---------|----------|
| `healthy` | 0 failures | Normal dispatch |
| `degraded` | 1 consecutive failure | Allowed but logged |
| `open` | 2+ consecutive failures | **Avoided** for dispatch |
| `probing` | 60s cooldown expired | Limited attempts allowed |

Transitions:
- `healthy → degraded`: 1 failure
- `degraded → open`: 2nd consecutive failure
- `open → probing`: 60s cooldown elapsed
- `probing → healthy`: successful call during probe
- `probing → open`: continued failure during probe (reset cooldown)
- Any state → `healthy`: successful call resets all counters

### 4. Fallback Strategy

When primary provider fails and channel fallback is available:
1. Check circuit breaker state — skip channels in `open` state
2. Try alternate channels with backoff
3. If all channels fail, check model fallback provider health
4. Log `open` state warnings but allow dispatch (conservative)

Fallback selection scores candidates by:
1. Health state priority: healthy(3) > degraded(2) > probing(1)
2. Tie-break: fewer consecutive failures

### 5. Durable Health Store

`ProviderHealthStore` replaces the simple `ProviderCooldownStore` for Phase 8A features:
- File-backed: `.ai/runs/<run-id>/provider-health.json`
- Stores both provider states and decision trace
- Decision trace kept to last 100 entries for diagnostics
- Each worker loads state on start, saves on completion

## Integration Points

### dispatcher.ts — spawnWorker

- `classifyError()` now delegates to `classifyProviderFailure()` for 8-subtype taxonomy
- Each provider failure is recorded in `ProviderHealthStore`
- Non-retryable failures (auth, quota) throw immediately without wasting retries
- Channel fallback respects circuit breaker state — skips `open` providers
- `WorkerResult` gains `provider_failure_subtype` and `provider_fallback_used` fields
- Backoff delays are applied before retry/fallback (capped at 5s)

### dispatcher.ts — dispatchBatch

- Creates `providerHealthDir` per run (`.ai/runs/<run-id>/`)
- Passes to each worker via `WorkerConfig.providerHealthDir`
- Workers share state through the file-backed store

### types.ts

- `ProviderFailureSubtype` — 8 fine-grained failure types
- `CircuitBreakerState` — healthy | degraded | open | probing
- `ProviderResilienceDecision` — explainable action record
- `ProviderHealthState` — extended provider state with breaker
- `ProviderHealthStoreData` — durable store format
- `WorkerConfig.providerHealthDir` — optional health directory
- `WorkerResult.provider_failure_subtype` — failure classification on result
- `WorkerResult.provider_fallback_used` — whether fallback was used

## Files Changed

| File | Change |
|------|--------|
| `orchestrator/types.ts` | Added 6 new types, extended WorkerConfig and WorkerResult |
| `orchestrator/provider-resilience.ts` | **New** — taxonomy, breaker, retry, fallback, health store |
| `orchestrator/dispatcher.ts` | Integrated resilience layer, updated classifyError, added health store usage |
| `tests/provider-resilience.test.ts` | **New** — 48 tests covering all components |
| `tests/dispatcher-fallback.test.ts` | Updated test expectation for legacy failure type mapping |

## Blast Radius Controls

- `isRetryableFailure` is conservative: unknown failures default to retryable
- Backoff delays capped at 5 seconds maximum
- Retry budget limited to 2 retries (3 total attempts)
- Circuit breaker only affects channel/model fallback selection, not primary dispatch
- Legacy `FailureType` mapping preserved for `resolveFallback` compatibility
- Provider health store is optional (null if `providerHealthDir` not set)

## What This Does NOT Do

- No complex distributed consensus — single-file state per run
- No provider cost optimization
- No authority-layer changes
- No UI/operator surface changes
- Does not replace `ProviderCooldownStore` (existing cooldown tests still pass)

## Verification

- `npm run build` passes
- 48 new tests pass (provider-resilience.test.ts)
- 13 existing cooldown tests still pass
- Pre-existing baseline test failures in dispatcher-fallback.test.ts (2), mode-enforcement.test.ts (2), mode-policy.test.ts (2), model-proxy.test.ts (3), discuss-gate.test.ts (1), prompt-policy.test.ts (1) are unrelated to this phase
