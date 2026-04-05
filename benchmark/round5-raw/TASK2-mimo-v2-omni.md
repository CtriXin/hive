# TASK2: Code Review + Fix Suggestions — Rate Limiter Analysis

## Code Overview

```typescript
class RateLimiter {
  private windows: Map<string, number[]> = new Map();
  private config: { windowMs: number; maxRequests: number };

  constructor(windowMs: number = 60000, maxRequests: number = 100) {
    this.config = { windowMs, maxRequests };
  }

  isAllowed(key: string): boolean { /* sliding window check + record */ }
  getRemainingRequests(key: string): number { /* remaining quota query */ }
  getRetryAfterMs(key: string): number { /* retry-after calculation */ }
  reset(key: string): void { /* clear key state */ }
  startCleanup(intervalMs: number = 60000): NodeJS.Timeout { /* periodic GC */ }
}
```

A single-process, sliding-window rate limiter using `Map<string, number[]>` to track per-key request timestamps.

---

## Challenger (Correctness)

### Findings

| # | Severity | Finding | Location | Detail |
|---|----------|---------|----------|--------|
| C1 | `red` | `isAllowed` not atomic — race condition | `isAllowed()` :95-114 | In concurrent async environments (Node.js event loop interleaving between `await` points, or worker threads), two calls can both read `timestamps.length < maxRequests` before either pushes, resulting in >maxRequests recorded. Single-threaded Node mitigates this for synchronous code, but breaks if `isAllowed` is ever called from multiple workers or if the caller awaits between the check and the side effect. |
| C2 | `red` | `getRetryAfterMs` can return negative value | `getRetryAfterMs()` :126-130 | When the oldest timestamp has already expired (`timestamps[0] + windowMs < Date.now()`), the subtraction yields a negative number. Callers using this as `Retry-After` header will produce invalid HTTP responses. The `timestamps.length < maxRequests` guard at line 128 helps, but stale entries survive if no one called `isAllowed` recently to prune them. |
| C3 | `red` | `isAllowed` stale-data bug in `getRetryAfterMs` | `getRetryAfterMs()` :129 | If all timestamps in the array are expired but no one called `isAllowed` to `shift()` them, `timestamps[0]` points to an old entry → `getRetryAfterMs` returns a large negative or stale positive value instead of `0`. |
| C4 | `yellow` | `getRemainingRequests` reads stale data | `getRemainingRequests()` :117-124 | `filter()` creates a new array but never writes it back. The original `timestamps` array still contains expired entries. Subsequent `isAllowed()` calls will `shift()` them, but between calls, `getRemainingRequests` returns a value based on a snapshot that diverges from `isAllowed`'s view. Not a correctness bug per se (the remaining count is still correct), but inconsistent — two methods have different pruning strategies. |
| C5 | `yellow` | `Array.shift()` is O(n) per expired entry | `isAllowed()` :105-107 | In worst case (high burst followed by quiet period), all entries expire at once, causing `shift()` to relocate the entire array `n` times → O(n²). For `maxRequests=100`, this is bounded but wasteful. |
| C6 | `green` | No `stopCleanup()` method | `startCleanup()` :137-149 | The returned `NodeJS.Timeout` handle is the only way to stop the interval. If the caller doesn't store and clear it, the timer leaks. API design gap, not a bug. |

### Challenger Verdict: **CONTESTED**

The race condition (C1) is mitigated by Node.js single-threaded model for synchronous callers, but is a latent defect if usage patterns change. The negative `getRetryAfterMs` (C2, C3) is a real correctness bug that can surface in production.

---

## Architect (Scalability)

### Findings

| # | Severity | Finding | Detail |
|---|----------|---------|--------|
| A1 | `red` | Unbounded `Map` growth — OOM vulnerability | `key` is caller-controlled (userId, IP, token). An attacker can send requests with random/high-cardinality keys → unbounded Map entries. Each entry holds a `number[]` of up to `maxRequests` timestamps. At 10k unique keys × 100 entries × 8 bytes ≈ 8 MB, but scales linearly with no ceiling. |
| A2 | `red` | Single-process state — no horizontal scaling | State lives in-process memory. In a multi-instance deployment behind a load balancer, each instance has independent counters → effective rate limit is `maxRequests × instanceCount`. No Redis/distributed store integration. |
| A3 | `yellow` | `startCleanup` full-scan is O(n) blocking | Iterates every key and creates a new filtered array for each. With 100k keys, this blocks the event loop. No chunked/deferred processing. |
| A4 | `yellow` | Per-key memory footprint is O(maxRequests) | Each key stores up to `maxRequests` timestamps as `number[]`. For a counter-based approach (fixed window or token bucket), this would be O(1) per key. The sliding window precision comes at significant memory cost. |
| A5 | `green` | `NodeJS.Timeout` return type couples to Node.js | Prevents reuse in browser/deno/edge runtimes. Minor for a server-side tool, but worth noting for portability. |
| A6 | `green` | No observability hooks | No way to export metrics (hit rate, rejection rate, active keys) for monitoring/alerting. Production rate limiters should expose Prometheus counters or similar. |

### Architect Verdict: **REJECT**

Unbounded memory (A1) is a denial-of-service vector. Single-process state (A2) makes this unusable in any real clustered deployment. These are not optimization concerns — they are fundamental architectural limitations for production use.

---

## Subtractor (Simplification)

### Findings

| # | Severity | Finding | Suggestion |
|---|----------|---------|------------|
| S1 | `red` | `startCleanup` is unnecessary complexity | `isAllowed()` already prunes expired entries on every call. For low-traffic keys, the periodic cleanup only reclaims memory of abandoned keys — but that's better solved by a max-key ceiling with LRU eviction, not a timer. Remove `startCleanup` entirely; add lazy eviction. |
| S2 | `yellow` | `number[]` sliding window is over-engineered for most use cases | If exact sliding-window semantics aren't required, a **fixed-window counter** (`{ count: number, windowStart: number }`) achieves O(1) memory per key with ~50% rate accuracy loss at window boundaries. For API rate limiting, this trade-off is almost always acceptable. |
| S3 | `yellow` | `getRemainingRequests` duplicates pruning logic | It runs `filter()` independently instead of reusing `isAllowed`'s pruning. Consolidate: have `isAllowed` (or a shared `_prune` helper) be the single source of truth. |
| S4 | `green` | `getRetryAfterMs` is rarely needed | Most rate limiters just return 429 with a generic message. This method adds API surface and maintenance burden. If kept, fix the negative-value bug (C2) at minimum. |
| S5 | `green` | Class structure adds indirection | If only used as middleware, a closure `createLimiter(config) => isAllowed(key) => boolean` is simpler, avoids `this` binding issues, and is easier to test. |

### Subtractor Verdict: **CONTESTED**

The class is not excessively complex, but `startCleanup` (S1) is genuinely unnecessary overhead. The sliding window array approach (S2) is the right choice if exact semantics matter, but most use cases don't need it.

---

## Fix Suggestions

### Minimum Viable Fix (address red findings)

```typescript
class RateLimiter {
  private windows = new Map<string, number[]>();
  private maxKeys: number;

  constructor(
    private windowMs = 60000,
    private maxRequests = 100,
    maxKeys = 100_000,
  ) {
    this.maxKeys = maxKeys;
  }

  isAllowed(key: string): boolean {
    if (this.windows.size >= this.maxKeys && !this.windows.has(key)) {
      return false;
    }

    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.windows.get(key);

    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    let writeIdx = 0;
    for (let i = 0; i < timestamps.length; i++) {
      if (timestamps[i] >= cutoff) {
        timestamps[writeIdx++] = timestamps[i];
      }
    }
    timestamps.length = writeIdx;

    if (timestamps.length >= this.maxRequests) return false;

    timestamps.push(now);
    return true;
  }

  getRemainingRequests(key: string): number {
    const timestamps = this.windows.get(key);
    if (!timestamps) return this.maxRequests;

    const cutoff = Date.now() - this.windowMs;
    let count = 0;
    for (const t of timestamps) {
      if (t >= cutoff) count++;
    }
    return Math.max(0, this.maxRequests - count);
  }

  getRetryAfterMs(key: string): number {
    const timestamps = this.windows.get(key);
    if (!timestamps || timestamps.length === 0) return 0;

    const now = Date.now();
    const cutoff = now - this.windowMs;

    let validCount = 0;
    let oldestValid = Infinity;
    for (const t of timestamps) {
      if (t >= cutoff) {
        validCount++;
        oldestValid = Math.min(oldestValid, t);
      }
    }

    if (validCount < this.maxRequests) return 0;
    return Math.max(0, oldestValid + this.windowMs - now);
  }

  reset(key: string): void {
    this.windows.delete(key);
  }
}
```

Key changes:
- **A1 fix**: `maxKeys` ceiling prevents OOM
- **C2/C3 fix**: `getRetryAfterMs` now prunes before calculating, never returns negative
- **C5 fix**: in-place compaction (`writeIdx`) replaces O(n²) `shift()` loop
- **S1 fix**: removed `startCleanup` — `isAllowed` already lazily prunes
- **S3 fix**: `getRemainingRequests` now counts in-place without creating new arrays

---

## Verdict Summary

```
┌──────────────────┬─────────────┐
│ Perspective      │ Verdict     │
├──────────────────┼─────────────┤
│ Challenger       │ CONTESTED   │
│ Architect        │ REJECT      │
│ Subtractor       │ CONTESTED   │
├──────────────────┼─────────────┤
│ Overall          │ REJECT      │
└──────────────────┴─────────────┘
```

**Overall: REJECT**

The unbounded memory growth (A1) is a denial-of-service vector. The single-process state (A2) makes it unsuitable for any real deployment with >1 instance. The `getRetryAfterMs` negative-value bug (C2/C3) is a correctness defect. These are not theoretical concerns — they will manifest under realistic load patterns.

**Recommendation**: Apply the minimum viable fix above for single-process use cases. For production, migrate to a Redis-backed sliding window (e.g., `redis-cli EVAL` with sorted sets) or use an established library (`rate-limiter-flexible`, `@upstash/ratelimit`).

---

*Reviewed by: mimo-v2-omni*
*Date: 2026-04-04*
