import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  classifyProviderFailure,
  isRetryableFailure,
  decideRetryAction,
  getBackoffDelayMs,
  transitionOnFailure,
  transitionOnSuccess,
  checkRecovery,
  shouldAvoidProvider,
  selectFallbackProvider,
  ProviderHealthStore,
  type ProviderHealthState,
  type FallbackCandidate,
} from '../orchestrator/provider-resilience.js';

// ═══════════════════════════════════════════════════════════════════
// Failure Taxonomy Tests
// ═══════════════════════════════════════════════════════════════════

describe('classifyProviderFailure', () => {
  it('classifies rate limit errors', () => {
    expect(classifyProviderFailure({ message: '429 Too Many Requests' })).toBe('rate_limit');
    expect(classifyProviderFailure({ message: 'Rate limit exceeded' })).toBe('rate_limit');
    expect(classifyProviderFailure({ message: 'overloaded' })).toBe('rate_limit');
    expect(classifyProviderFailure({ message: '限流' })).toBe('rate_limit');
  });

  it('classifies auth failures', () => {
    expect(classifyProviderFailure({ message: '401 Unauthorized' })).toBe('auth_failure');
    expect(classifyProviderFailure({ message: '403 Forbidden' })).toBe('auth_failure');
    expect(classifyProviderFailure({ message: 'invalid api key' })).toBe('auth_failure');
  });

  it('classifies quota exhaustion', () => {
    expect(classifyProviderFailure({ message: 'Quota exhausted' })).toBe('quota_exhausted');
    expect(classifyProviderFailure({ message: 'Insufficient credits' })).toBe('quota_exhausted');
  });

  it('classifies timeouts', () => {
    expect(classifyProviderFailure({ message: 'ETIMEDOUT' })).toBe('timeout');
    expect(classifyProviderFailure({ message: 'Connection timeout' })).toBe('timeout');
  });

  it('classifies transient network errors', () => {
    expect(classifyProviderFailure({ message: 'ECONNREFUSED' })).toBe('transient_network');
    expect(classifyProviderFailure({ message: 'ECONNRESET' })).toBe('transient_network');
    expect(classifyProviderFailure({ message: 'socket hang up' })).toBe('transient_network');
  });

  it('classifies server errors', () => {
    expect(classifyProviderFailure({ message: '502 Bad Gateway' })).toBe('server_error');
    expect(classifyProviderFailure({ message: '503 Service Unavailable' })).toBe('server_error');
  });

  it('classifies provider unavailable', () => {
    expect(classifyProviderFailure({ message: 'No route found for model' })).toBe('provider_unavailable');
    expect(classifyProviderFailure({ message: 'Unknown provider' })).toBe('provider_unavailable');
  });

  it('classifies unknown failures as fallback', () => {
    expect(classifyProviderFailure({ message: 'something weird happened' })).toBe('unknown_provider_failure');
  });

  it('handles string errors', () => {
    expect(classifyProviderFailure('429 rate limit')).toBe('rate_limit');
  });

  it('handles null/undefined-like errors', () => {
    expect(classifyProviderFailure(null)).toBe('unknown_provider_failure');
  });
});

describe('isRetryableFailure', () => {
  it('allows retry for transient failures', () => {
    expect(isRetryableFailure('rate_limit')).toBe(true);
    expect(isRetryableFailure('timeout')).toBe(true);
    expect(isRetryableFailure('transient_network')).toBe(true);
    expect(isRetryableFailure('server_error')).toBe(true);
  });

  it('blocks retry for auth and quota', () => {
    expect(isRetryableFailure('auth_failure')).toBe(false);
    expect(isRetryableFailure('quota_exhausted')).toBe(false);
    expect(isRetryableFailure('provider_unavailable')).toBe(false);
  });

  it('allows retry for unknown failures (conservative)', () => {
    expect(isRetryableFailure('unknown_provider_failure')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Retry / Backoff Policy Tests
// ═══════════════════════════════════════════════════════════════════

describe('decideRetryAction', () => {
  it('blocks non-retryable failures immediately', () => {
    const result = decideRetryAction('auth_failure', 1);
    expect(result.action).toBe('block');
  });

  it('blocks after retry budget exhausted', () => {
    const result = decideRetryAction('rate_limit', 5);
    expect(result.action).toBe('cooldown');
  });

  it('allows immediate retry for transient network', () => {
    const result = decideRetryAction('transient_network', 1);
    expect(result.action).toBe('immediate_retry');
  });

  it('allows bounded retry for rate limit', () => {
    const result = decideRetryAction('rate_limit', 1);
    expect(result.action).toBe('bounded_retry');
    expect(result.backoff_ms).toBeGreaterThan(0);
  });

  it('uses exponential backoff for second retry', () => {
    const result = decideRetryAction('rate_limit', 2);
    expect(result.action).toBe('backoff_retry');
    expect(result.backoff_ms).toBeGreaterThan(0);
  });
});

describe('getBackoffDelayMs', () => {
  it('returns 0 for non-retryable failures', () => {
    expect(getBackoffDelayMs('auth_failure', 1)).toBe(0);
    expect(getBackoffDelayMs('quota_exhausted', 1)).toBe(0);
  });

  it('returns positive delay for retryable failures', () => {
    expect(getBackoffDelayMs('rate_limit', 1)).toBeGreaterThan(0);
    expect(getBackoffDelayMs('server_error', 1)).toBeGreaterThan(0);
  });

  it('increases with attempt number (exponential)', () => {
    const d1 = getBackoffDelayMs('rate_limit', 1);
    const d2 = getBackoffDelayMs('rate_limit', 2);
    expect(d2).toBeGreaterThan(d1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Circuit Breaker State Machine Tests
// ═══════════════════════════════════════════════════════════════════

function freshState(): ProviderHealthState {
  return {
    breaker: 'healthy',
    consecutive_failures: 0,
    cycle_failures: 0,
    last_failure_at: 0,
    last_success_at: Date.now(),
    probe_count: 0,
  };
}

describe('transitionOnFailure', () => {
  it('stays healthy on first failure', () => {
    const state = transitionOnFailure(freshState(), 'rate_limit');
    expect(state.breaker).toBe('degraded');
  });

  it('opens after 2 consecutive failures', () => {
    let state = freshState();
    state = transitionOnFailure(state, 'rate_limit');
    expect(state.breaker).toBe('degraded');
    state = transitionOnFailure(state, 'rate_limit');
    expect(state.breaker).toBe('open');
  });

  it('stays open on further failures', () => {
    let state = freshState();
    state = transitionOnFailure(state, 'server_error');
    state = transitionOnFailure(state, 'server_error');
    expect(state.breaker).toBe('open');
    state = transitionOnFailure(state, 'server_error');
    expect(state.breaker).toBe('open');
  });

  it('increments consecutive_failures and cycle_failures', () => {
    let state = freshState();
    state = transitionOnFailure(state, 'timeout');
    expect(state.consecutive_failures).toBe(1);
    expect(state.cycle_failures).toBe(1);
  });
});

describe('transitionOnSuccess', () => {
  it('resets to healthy after success', () => {
    let state = freshState();
    state = transitionOnFailure(state, 'rate_limit');
    state = transitionOnFailure(state, 'rate_limit');
    expect(state.breaker).toBe('open');

    state = transitionOnSuccess(state);
    expect(state.breaker).toBe('healthy');
    expect(state.consecutive_failures).toBe(0);
    expect(state.cycle_failures).toBe(0);
  });
});

describe('checkRecovery', () => {
  it('transitions open -> probing after cooldown', () => {
    let state = freshState();
    state = transitionOnFailure(state, 'rate_limit');
    state = transitionOnFailure(state, 'rate_limit');
    state = { ...state, opened_at: Date.now() - 61_000 }; // 61s ago

    const recovered = checkRecovery(state);
    expect(recovered.breaker).toBe('probing');
    expect(recovered.consecutive_failures).toBe(0);
  });

  it('stays open before cooldown expires', () => {
    let state = freshState();
    state = transitionOnFailure(state, 'rate_limit');
    state = transitionOnFailure(state, 'rate_limit');
    state = { ...state, opened_at: Date.now() - 10_000 }; // 10s ago

    const recovered = checkRecovery(state);
    expect(recovered.breaker).toBe('open');
  });

  it('stays healthy for already healthy state', () => {
    const state = freshState();
    const checked = checkRecovery(state);
    expect(checked.breaker).toBe('healthy');
  });
});

describe('shouldAvoidProvider', () => {
  it('avoids open breaker', () => {
    let state = freshState();
    state = transitionOnFailure(state, 'rate_limit');
    state = transitionOnFailure(state, 'rate_limit');
    state = { ...state, opened_at: Date.now() - 10_000 }; // still in cooldown

    const result = shouldAvoidProvider(state);
    expect(result.avoid).toBe(true);
    expect(result.state).toBe('open');
  });

  it('does not avoid degraded', () => {
    let state = freshState();
    state = transitionOnFailure(state, 'rate_limit');

    const result = shouldAvoidProvider(state);
    expect(result.avoid).toBe(false);
    expect(result.state).toBe('degraded');
  });

  it('does not avoid healthy', () => {
    const result = shouldAvoidProvider(freshState());
    expect(result.avoid).toBe(false);
  });

  it('does not avoid probing (post-cooldown)', () => {
    let state = freshState();
    state = transitionOnFailure(state, 'rate_limit');
    state = transitionOnFailure(state, 'rate_limit');
    state = { ...state, opened_at: Date.now() - 61_000 };

    const result = shouldAvoidProvider(state);
    expect(result.avoid).toBe(false);
    expect(result.state).toBe('probing');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Fallback Strategy Tests
// ═══════════════════════════════════════════════════════════════════

function makeCandidate(provider: string, breaker: ProviderHealthState['breaker']): FallbackCandidate {
  return {
    provider,
    model: `model-${provider}`,
    health: {
      breaker,
      consecutive_failures: breaker === 'open' ? 5 : breaker === 'degraded' ? 1 : 0,
      cycle_failures: 0,
      last_failure_at: 0,
      last_success_at: Date.now(),
      probe_count: 0,
    },
  };
}

describe('selectFallbackProvider', () => {
  it('prefers healthy over degraded over open', () => {
    const candidates = [
      makeCandidate('open-prov', 'open'),
      makeCandidate('degraded-prov', 'degraded'),
      makeCandidate('healthy-prov', 'healthy'),
    ];
    const selected = selectFallbackProvider(candidates, 'primary');
    expect(selected?.provider).toBe('healthy-prov');
  });

  it('never selects open provider', () => {
    const candidates = [
      makeCandidate('only-open', 'open'),
    ];
    const selected = selectFallbackProvider(candidates, 'primary');
    expect(selected).toBeNull();
  });

  it('excludes primary provider', () => {
    const candidates = [
      makeCandidate('primary', 'healthy'),
      makeCandidate('alternate', 'degraded'),
    ];
    const selected = selectFallbackProvider(candidates, 'primary');
    expect(selected?.provider).toBe('alternate');
  });

  it('returns null when no candidates available', () => {
    const selected = selectFallbackProvider([], 'primary');
    expect(selected).toBeNull();
  });

  it('prefers fewer failures as tiebreaker', () => {
    const candidates = [
      makeCandidate('prov-a', 'healthy'),
      makeCandidate('prov-b', 'healthy'),
    ];
    // Both healthy, same score — tiebreak on consecutive_failures
    candidates[0].health.consecutive_failures = 3;
    candidates[1].health.consecutive_failures = 0;

    const selected = selectFallbackProvider(candidates, 'primary');
    expect(selected?.provider).toBe('prov-b');
  });
});

// ═══════════════════════════════════════════════════════════════════
// ProviderHealthStore Tests
// ═══════════════════════════════════════════════════════════════════

describe('ProviderHealthStore: basic operations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-health-'));
  });

  it('starts with healthy default state', () => {
    const store = new ProviderHealthStore(tmpDir);
    const state = store.getState('kimi');
    expect(state.breaker).toBe('healthy');
    expect(state.consecutive_failures).toBe(0);
  });

  it('records failure and transitions state', () => {
    const store = new ProviderHealthStore(tmpDir);
    store.recordFailure('kimi', 'rate_limit');
    const state = store.getState('kimi');
    expect(state.breaker).toBe('degraded');
    expect(state.consecutive_failures).toBe(1);
  });

  it('records success and resets', () => {
    const store = new ProviderHealthStore(tmpDir);
    store.recordFailure('kimi', 'rate_limit');
    store.recordFailure('kimi', 'rate_limit');
    expect(store.getState('kimi').breaker).toBe('open');

    store.recordSuccess('kimi');
    expect(store.getState('kimi').breaker).toBe('healthy');
  });

  it('shouldAvoid returns correct state', () => {
    const store = new ProviderHealthStore(tmpDir);
    expect(store.shouldAvoid('kimi').avoid).toBe(false);

    store.recordFailure('kimi', 'server_error');
    store.recordFailure('kimi', 'server_error');
    expect(store.shouldAvoid('kimi').avoid).toBe(true);
  });

  it('getAllStates returns all providers', () => {
    const store = new ProviderHealthStore(tmpDir);
    store.recordFailure('kimi', 'rate_limit');
    store.recordFailure('qwen', 'timeout');
    expect(store.getAllStates().size).toBe(2);
  });
});

describe('ProviderHealthStore: decisions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-health-decisions-'));
  });

  it('records and retrieves decisions', () => {
    const store = new ProviderHealthStore(tmpDir);
    store.recordDecision({
      provider: 'kimi',
      failure_subtype: 'rate_limit',
      action: 'bounded_retry',
      action_reason: 'first retry',
      dispatch_affected: false,
      backoff_ms: 2000,
      attempt: 1,
      timestamp: Date.now(),
    });
    const decisions = store.getRecentDecisions();
    expect(decisions.length).toBe(1);
    expect(decisions[0].provider).toBe('kimi');
  });
});

describe('ProviderHealthStore: persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-health-persist-'));
  });

  it('saves and loads state', () => {
    const store = new ProviderHealthStore(tmpDir);
    store.recordFailure('kimi', 'rate_limit');
    store.recordFailure('kimi', 'rate_limit');
    store.save();

    const store2 = new ProviderHealthStore(tmpDir);
    const state = store2.getState('kimi');
    expect(state.breaker).toBe('open');
    expect(state.consecutive_failures).toBe(2);
  });

  it('persists decisions across sessions', () => {
    const store = new ProviderHealthStore(tmpDir);
    store.recordDecision({
      provider: 'kimi',
      failure_subtype: 'rate_limit',
      action: 'cooldown',
      action_reason: 'test',
      dispatch_affected: true,
      backoff_ms: 0,
      attempt: 1,
      timestamp: Date.now(),
    });
    store.save();

    const store2 = new ProviderHealthStore(tmpDir);
    expect(store2.getRecentDecisions().length).toBe(1);
  });

  it('returns empty state if file missing', () => {
    const store = new ProviderHealthStore(tmpDir);
    expect(store.getAllStates().size).toBe(0);
  });

  it('returns empty state if file malformed', () => {
    const filePath = path.join(tmpDir, 'provider-health.json');
    fs.writeFileSync(filePath, 'not json');
    const store = new ProviderHealthStore(tmpDir);
    expect(store.getAllStates().size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Cooldown Integration Tests (unified routing + health)
// ═══════════════════════════════════════════════════════════════════

describe('ProviderHealthStore: cooldown (unified routing)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-cooldown-unified-'));
  });

  it('isCooledDown false with no failures', () => {
    const store = new ProviderHealthStore(tmpDir);
    expect(store.isCooledDown('kimi')).toBe(false);
  });

  it('isCooledDown false below threshold', () => {
    const store = new ProviderHealthStore(tmpDir);
    store.recordFailure('kimi', 'rate_limit');
    expect(store.isCooledDown('kimi')).toBe(false);
  });

  it('isCooledDown true at threshold (2 failures)', () => {
    const store = new ProviderHealthStore(tmpDir);
    store.recordFailure('kimi', 'rate_limit');
    store.recordFailure('kimi', 'rate_limit');
    expect(store.isCooledDown('kimi')).toBe(true);
  });

  it('isCooledDown auto-clears after cooldown window', () => {
    const store = new ProviderHealthStore(tmpDir);
    store.recordFailure('kimi', 'rate_limit');
    store.recordFailure('kimi', 'rate_limit');
    expect(store.isCooledDown('kimi')).toBe(true);

    const future = Date.now() + 61_000;
    expect(store.isCooledDown('kimi', future)).toBe(false);
  });

  it('resetCooldown clears the state', () => {
    const store = new ProviderHealthStore(tmpDir);
    store.recordFailure('kimi', 'rate_limit');
    store.recordFailure('kimi', 'rate_limit');
    expect(store.isCooledDown('kimi')).toBe(true);

    store.resetCooldown('kimi');
    expect(store.isCooledDown('kimi')).toBe(false);
  });

  it('resetCooldown is idempotent on fresh provider', () => {
    const store = new ProviderHealthStore(tmpDir);
    expect(() => store.resetCooldown('nonexistent')).not.toThrow();
  });
});
