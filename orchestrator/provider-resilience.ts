// orchestrator/provider-resilience.ts — Provider failure taxonomy, circuit breaker, retry/backoff, fallback
import fs from 'fs';
import path from 'path';
import type {
  ProviderFailureSubtype,
  CircuitBreakerState,
  ProviderResilienceDecision,
  ProviderHealthState,
  ProviderHealthStoreData,
} from './types.js';

// ═══════════════════════════════════════════════════════════════════
// Failure Taxonomy — classify raw errors into stable subtypes
// ═══════════════════════════════════════════════════════════════════

/**
 * Classify a raw provider error into a stable ProviderFailureSubtype.
 * This is the single source of truth for provider failure classification.
 * Must NOT be mixed with discuss/review/build failure logic.
 */
export function classifyProviderFailure(err: unknown): ProviderFailureSubtype {
  const msg = extractErrorMessage(err);

  // Rate limiting — highest confidence patterns
  if (/429|rate.?limit|throttl|overload|too many requests/i.test(msg)) {
    return 'rate_limit';
  }

  // Auth failures — should NOT be retried blindly
  // Keep 404 model-not-found / permission-denied bundle on the retryable path because
  // some providers surface routing/model-availability issues in 4xx-style text.
  if (/401|403|unauthorized|forbidden|invalid.*key|expired.*token|Please run \/login/i.test(msg)) {
    return 'auth_failure';
  }
  if (/permission denied|not found the model/i.test(msg)) {
    return 'server_error';
  }

  // Plain 404s in provider text are often route/model-availability problems, not hard auth faults.
  if (/404/i.test(msg)) {
    return 'server_error';
  }

  // Generic 4xx still falls back to auth_failure as a conservative default.
  if (/4\d{2}/.test(msg)) {
    return 'auth_failure';
  }


  // Quota exhaustion — retry won't help
  if (/quota|credit.*exhaust|credit.*deplet|insufficient.*credit|balance/i.test(msg)) {
    return 'quota_exhausted';
  }

  // Timeouts
  if (/timeout|ETIMEDOUT|ESOCKETTIMEDOUT|deadline/i.test(msg)) {
    return 'timeout';
  }

  // Transient network errors
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EPIPE|socket hang up|network/i.test(msg)) {
    return 'transient_network';
  }

  // Server errors (5xx)
  if (/5\d{2}|Internal Server Error|Bad Gateway|Service Unavailable|Gateway/i.test(msg)) {
    return 'server_error';
  }

  // Provider unavailable (no route, no provider config)
  if (/No.*route.*found|Unknown provider|provider.*not.*found|provider.*config/i.test(msg)) {
    return 'provider_unavailable';
  }

  // API errors with specific status codes
  const statusMatch = msg.match(/\b([45]\d{2})\b/);
  if (statusMatch) {
    const code = parseInt(statusMatch[1], 10);
    if (code === 429) return 'rate_limit';
    if (code >= 500) return 'server_error';
    if (code >= 400 && code < 500) return 'auth_failure';
  }

  // Chinese rate limiting patterns
  if (/限流|服务不可用|频率限制/i.test(msg)) {
    return 'rate_limit';
  }

  return 'unknown_provider_failure';
}

/**
 * Whether this failure subtype is retryable at all.
 * Auth and quota failures should never be blindly retried.
 */
export function isRetryableFailure(subtype: ProviderFailureSubtype): boolean {
  switch (subtype) {
    case 'rate_limit':
    case 'timeout':
    case 'transient_network':
    case 'server_error':
    case 'unknown_provider_failure':
      return true;
    case 'auth_failure':
    case 'quota_exhausted':
    case 'provider_unavailable':
      return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Retry / Backoff Policy — bounded, explainable, time-safe
// ═══════════════════════════════════════════════════════════════════

const MAX_RETRY_ATTEMPTS = 2; // Max retries after original (total 3 attempts: original + retry1 + retry2)
const BACKOFF_BASE_MS: Record<ProviderFailureSubtype, number> = {
  rate_limit: 2000,
  timeout: 1000,
  transient_network: 500,
  server_error: 1500,
  auth_failure: 0,
  quota_exhausted: 0,
  provider_unavailable: 0,
  unknown_provider_failure: 1000,
};

/**
 * Decide the retry action for a given failure subtype and attempt number.
 * Returns { action, backoff_ms, reason } — all explainable.
 */
export function decideRetryAction(
  subtype: ProviderFailureSubtype,
  attempt: number,
): { action: ProviderResilienceDecision['action']; backoff_ms: number; reason: string } {
  if (!isRetryableFailure(subtype)) {
    return { action: 'block', backoff_ms: 0, reason: `${subtype} is not retryable` };
  }

  if (attempt > MAX_RETRY_ATTEMPTS) {
    return { action: 'cooldown', backoff_ms: 0, reason: `retry budget exhausted (${attempt}/${MAX_RETRY_ATTEMPTS})` };
  }

  if (attempt === 1) {
    // First retry: immediate for transient, short backoff for others
    const base = BACKOFF_BASE_MS[subtype];
    if (subtype === 'transient_network' && base <= 500) {
      return { action: 'immediate_retry', backoff_ms: 0, reason: 'transient network — immediate retry' };
    }
    return { action: 'bounded_retry', backoff_ms: base, reason: `first retry for ${subtype}, backoff ${base}ms` };
  }

  // Second retry: always backoff with exponential
  const base = BACKOFF_BASE_MS[subtype];
  const delay = base * 2; // Simple 2x backoff
  return { action: 'backoff_retry', backoff_ms: delay, reason: `second retry for ${subtype}, exponential backoff ${delay}ms` };
}

/**
 * Calculate backoff delay for a given failure subtype and attempt.
 * Uses per-subtype base with exponential scaling.
 */
export function getBackoffDelayMs(subtype: ProviderFailureSubtype, attempt: number): number {
  const base = BACKOFF_BASE_MS[subtype];
  if (base === 0) return 0;
  return base * Math.pow(2, attempt - 1);
}

// ═══════════════════════════════════════════════════════════════════
// Circuit Breaker — state machine with durable state
// ═══════════════════════════════════════════════════════════════════

const DEGRADED_THRESHOLD = 1;       // Failures before entering degraded
const OPEN_THRESHOLD = 2;           // Failures before opening breaker
const OPEN_COOLDOWN_MS = 60_000;    // How long breaker stays open
const PROBING_MAX = 2;              // Max probes before deciding
const RECOVERY_SUCCESS_WINDOW_MS = 300_000; // 5 min: success resets counter

// Cooldown constants — used by routing layer to deprioritize providers
export const PROVIDER_COOLDOWN_MS = 60_000;
export const PROVIDER_COOLDOWN_MAX_FAILURES = 2;

function healthyState(): ProviderHealthState {
  return {
    breaker: 'healthy',
    consecutive_failures: 0,
    cycle_failures: 0,
    last_failure_at: 0,
    last_success_at: Date.now(),
    probe_count: 0,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Transition circuit breaker state based on a new failure event.
 * Pure function — does not mutate, returns new state.
 */
export function transitionOnFailure(
  current: ProviderHealthState,
  subtype: ProviderFailureSubtype,
  now = Date.now(),
): ProviderHealthState {
  const next = { ...current };
  next.consecutive_failures++;
  next.cycle_failures++;
  next.last_failure_at = now;
  next.last_failure_subtype = subtype;
  next.updated_at = new Date(now).toISOString();

  switch (next.breaker) {
    case 'healthy':
      if (next.consecutive_failures >= OPEN_THRESHOLD) {
        next.breaker = 'open';
        next.opened_at = now;
        next.probe_count = 0;
      } else if (next.consecutive_failures >= DEGRADED_THRESHOLD) {
        next.breaker = 'degraded';
      }
      break;

    case 'degraded':
      if (next.consecutive_failures >= OPEN_THRESHOLD) {
        next.breaker = 'open';
        next.opened_at = now;
        next.probe_count = 0;
      }
      break;

    case 'open':
      // Stay open until cooldown expires; transitions happen in checkRecovery
      break;

    case 'probing':
      next.probe_count++;
      if (next.probe_count > PROBING_MAX) {
        // Still failing during probes → reopen
        next.breaker = 'open';
        next.opened_at = now;
        next.probe_count = 0;
      }
      break;
  }

  return next;
}

/**
 * Transition circuit breaker on a successful provider call.
 * Resets counters and returns to healthy.
 */
export function transitionOnSuccess(
  current: ProviderHealthState,
  now = Date.now(),
): ProviderHealthState {
  return {
    ...healthyState(),
    last_success_at: now,
    updated_at: new Date(now).toISOString(),
  };
}

/**
 * Check if an open/probing breaker should transition to probing.
 * Returns the updated state if transition occurred, or current state otherwise.
 */
export function checkRecovery(
  state: ProviderHealthState,
  now = Date.now(),
): ProviderHealthState {
  if (state.breaker === 'open' && state.opened_at) {
    if (now - state.opened_at >= OPEN_COOLDOWN_MS) {
      return {
        ...state,
        breaker: 'probing',
        probe_count: 0,
        consecutive_failures: 0,
        updated_at: new Date(now).toISOString(),
      };
    }
  }
  return state;
}

/**
 * Whether a provider should be avoided for dispatch right now.
 * open = definitely avoid. probing = use with caution (allowed but logged).
 */
export function shouldAvoidProvider(
  state: ProviderHealthState,
  now = Date.now(),
): { avoid: boolean; state: CircuitBreakerState } {
  const checked = checkRecovery(state, now);
  return {
    avoid: checked.breaker === 'open',
    state: checked.breaker,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Fallback Strategy — explainable, constraint-respecting
// ═══════════════════════════════════════════════════════════════════

export interface FallbackCandidate {
  provider: string;
  model: string;
  health: ProviderHealthState;
}

/**
 * Select a fallback provider when the primary is unhealthy.
 * Respects health state — prefers healthy > degraded > probing.
 * Never selects an open provider.
 */
export function selectFallbackProvider(
  candidates: FallbackCandidate[],
  primaryProvider: string,
): FallbackCandidate | null {
  const available = candidates.filter(
    (c) => c.provider !== primaryProvider && c.health.breaker !== 'open',
  );
  if (available.length === 0) return null;

  // Score: healthy=3, degraded=2, probing=1
  const scoreMap: Record<CircuitBreakerState, number> = {
    healthy: 3, degraded: 2, probing: 1, open: 0,
  };

  available.sort((a, b) => {
    const scoreDiff = scoreMap[b.health.breaker] - scoreMap[a.health.breaker];
    if (scoreDiff !== 0) return scoreDiff;
    // Tie-break: prefer fewer recent failures
    return a.health.consecutive_failures - b.health.consecutive_failures;
  });

  return available[0];
}

// ═══════════════════════════════════════════════════════════════════
// Durable Health Store — file-backed, survives sessions
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_HEALTH_STATE = healthyState();

export class ProviderHealthStore {
  private providers: Map<string, ProviderHealthState> = new Map();
  private decisions: ProviderResilienceDecision[] = [];
  private runDir: string | null = null;
  private dirty = false;

  constructor(runDir?: string) {
    if (runDir) {
      this.runDir = runDir;
      this.load();
    }
  }

  /** Get or create health state for a provider */
  getState(provider: string): ProviderHealthState {
    return this.providers.get(provider) ?? { ...DEFAULT_HEALTH_STATE };
  }

  /** Record a provider failure, returning the updated state */
  recordFailure(provider: string, subtype: ProviderFailureSubtype, now = Date.now()): ProviderHealthState {
    const current = this.getState(provider);
    const next = transitionOnFailure(current, subtype, now);
    this.providers.set(provider, next);
    this.dirty = true;
    return next;
  }

  /** Record a provider success */
  recordSuccess(provider: string, now = Date.now()): void {
    const current = this.getState(provider);
    if (current.last_failure_at > 0) {
      const next = transitionOnSuccess(current, now);
      this.providers.set(provider, next);
      this.dirty = true;
    }
  }

  /** Check if provider should be avoided for dispatch */
  shouldAvoid(provider: string, now = Date.now()): { avoid: boolean; state: CircuitBreakerState } {
    const state = this.getState(provider);
    return shouldAvoidProvider(state, now);
  }

  /** Check if provider is in cooldown (routing deprioritization threshold).
   * Cooldown = >= MAX_FAILURES consecutive failures within cooldown window.
   * Matches legacy ProviderCooldownStore semantics for capability-router. */
  isCooledDown(provider: string, now = Date.now()): boolean {
    const state = this.providers.get(provider);
    if (!state) return false;
    if (state.consecutive_failures < PROVIDER_COOLDOWN_MAX_FAILURES) return false;
    if (state.last_failure_at > 0 && now - state.last_failure_at > PROVIDER_COOLDOWN_MS) {
      this.resetCooldown(provider);
      return false;
    }
    return true;
  }

  /** Reset provider cooldown counters (e.g. after successful probe). */
  resetCooldown(provider: string): void {
    const current = this.providers.get(provider);
    if (!current) return;
    const next = { ...current, consecutive_failures: 0, cycle_failures: 0, last_failure_at: 0 };
    this.providers.set(provider, next);
    this.dirty = true;
  }

  /** Get all provider health states */
  getAllStates(): Map<string, ProviderHealthState> {
    return new Map(this.providers);
  }

  /** Record a resilience decision for diagnostics */
  recordDecision(decision: ProviderResilienceDecision): void {
    this.decisions.push(decision);
    this.dirty = true;
  }

  /** Get recent decisions (last N) */
  getRecentDecisions(n = 20): ProviderResilienceDecision[] {
    return this.decisions.slice(-n);
  }

  // Persistence

  load(): void {
    if (!this.runDir) return;
    const filePath = this.filePath();
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw) as ProviderHealthStoreData;
        this.providers = new Map(Object.entries(data.providers || {}));
        this.decisions = data.decisions || [];
      }
    } catch {
      this.providers = new Map();
      this.decisions = [];
    }
  }

  save(): void {
    if (!this.runDir || !this.dirty) return;
    const filePath = this.filePath();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const data: ProviderHealthStoreData = {
        providers: Object.fromEntries(this.providers),
        decisions: this.decisions.slice(-100), // Keep last 100 decisions
        updated_at: new Date().toISOString(),
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      this.dirty = false;
    } catch {
      // Non-critical: health persistence failure
    }
  }

  private filePath(): string {
    return path.join(this.runDir!, 'provider-health.json');
  }
}

// ═══════════════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════════════

function extractErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as any).message);
  }
  return JSON.stringify(err);
}
