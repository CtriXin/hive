import { describe, expect, it, beforeEach } from 'vitest';
import {
  routeWithCapabilities,
  updateProviderFailure,
  clearProviderCooldown,
  type CapabilityRouterInput,
  type ModelCapabilityProfile,
  type ProviderFailureState,
} from '../orchestrator/capability-router.js';

// ═══════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════

const makeProfile = (
  overrides: Partial<ModelCapabilityProfile> = {},
): ModelCapabilityProfile => ({
  scores: {
    implementation: { value: 0.5, samples: 0, effective_samples: 0, last_updated: null },
    review: { value: 0.5, samples: 0, effective_samples: 0, last_updated: null },
    repair: { value: 0.5, samples: 0, effective_samples: 0, last_updated: null },
    integration: { value: 0.5, samples: 0, effective_samples: 0, last_updated: null },
    spec_adherence: { value: 0.5, samples: 0, effective_samples: 0, last_updated: null },
    scope_discipline: { value: 0.5, samples: 0, effective_samples: 0, last_updated: null },
    turnaround_speed: { value: 0.5, samples: 0, effective_samples: 0, last_updated: null },
  },
  domain_tags: [],
  avoid_tags: [],
  ...overrides,
});

const makeInput = (
  overrides: Partial<CapabilityRouterInput> = {},
): CapabilityRouterInput => ({
  taskType: 'implementation',
  complexity: 'low',
  contextSize: 0,
  failureHistory: [],
  isRepair: false,
  budgetPressure: 'low',
  now: 0,
  ...overrides,
});

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe('capability-router', () => {
  let providerFailures: Map<string, ProviderFailureState>;

  beforeEach(() => {
    providerFailures = new Map();
  });

  it('selects cheaper/faster model for simple tasks', () => {
    const profiles: Record<string, ModelCapabilityProfile> = {
      'qwen-3.5': makeProfile({
        scores: {
          ...makeProfile().scores,
          implementation: { value: 0.9, samples: 5, effective_samples: 5, last_updated: null },
          turnaround_speed: { value: 0.9, samples: 5, effective_samples: 5, last_updated: null },
        },
      }),
      'kimi-k2.5': makeProfile({
        scores: {
          ...makeProfile().scores,
          implementation: { value: 0.5, samples: 0, effective_samples: 0, last_updated: null },
          turnaround_speed: { value: 0.6, samples: 20, effective_samples: 20, last_updated: null },
        },
      }),
    };

    const input = makeInput({ complexity: 'low', contextSize: 1000 });
    const decision = routeWithCapabilities(input, profiles, providerFailures);

    expect(decision.selectedModel).toBe('qwen-3.5');
  });

  it('selects stronger model for high-complexity tasks', () => {
    const profiles: Record<string, ModelCapabilityProfile> = {
      'qwen-3.5': makeProfile({
        scores: {
          ...makeProfile().scores,
          implementation: { value: 0.6, samples: 5, effective_samples: 5, last_updated: null },
        },
      }),
      'kimi-k2.5': makeProfile({
        scores: {
          ...makeProfile().scores,
          implementation: { value: 0.95, samples: 20, effective_samples: 20, last_updated: null },
        },
      }),
    };

    const input = makeInput({ complexity: 'high', contextSize: 1000 });
    const decision = routeWithCapabilities(input, profiles, providerFailures);

    expect(decision.selectedModel).toBe('kimi-k2.5');
  });

  it('triggers escalation for repair/retry after failure', () => {
    const profiles: Record<string, ModelCapabilityProfile> = {
      'qwen-3.5': makeProfile({
        scores: {
          ...makeProfile().scores,
          implementation: { value: 0.8, samples: 5, effective_samples: 5, last_updated: null },
          repair: { value: 0.5, samples: 2, effective_samples: 2, last_updated: null },
        },
      }),
      'kimi-k2.5': makeProfile({
        scores: {
          ...makeProfile().scores,
          implementation: { value: 0.85, samples: 20, effective_samples: 20, last_updated: null },
          repair: { value: 0.95, samples: 10, effective_samples: 10, last_updated: null },
        },
      }),
    };

    const input = makeInput({
      isRepair: true,
      complexity: 'medium',
      failureHistory: [
        { model: 'qwen-3.5', provider: 'qwen', timestamp: 1000, reason: 'timeout' },
      ],
    });
    const decision = routeWithCapabilities(input, profiles, providerFailures);

    expect(decision.selectedModel).toBe('kimi-k2.5');
    expect(decision.reasons.some((r) => r.includes('repair'))).toBe(true);
  });

  it('deprioritizes provider route after failure cooldown', () => {
    const profiles: Record<string, ModelCapabilityProfile> = {
      'qwen-3.5': makeProfile({
        scores: {
          ...makeProfile().scores,
          implementation: { value: 0.95, samples: 10, effective_samples: 10, last_updated: null },
        },
      }),
      'kimi-k2.5': makeProfile({
        scores: {
          ...makeProfile().scores,
          implementation: { value: 0.8, samples: 10, effective_samples: 10, last_updated: null },
        },
      }),
    };

    // Put qwen provider into cooldown by recording 2 failures
    updateProviderFailure('qwen', providerFailures);
    updateProviderFailure('qwen', providerFailures);

    const input = makeInput({ complexity: 'low' });
    const decision = routeWithCapabilities(input, profiles, providerFailures);

    expect(decision.selectedModel).toBe('kimi-k2.5');

    expect(decision.candidates.some((c) => c.model === 'qwen-3.5')).toBe(false);
    expect(decision.candidates.every((c) => !c.deprioritized)).toBe(true);
  });

  it('produces deterministic output for same inputs', () => {
    const profiles: Record<string, ModelCapabilityProfile> = {
      'glm-5-turbo': makeProfile({
        scores: {
          ...makeProfile().scores,
          implementation: { value: 0.9, samples: 10, effective_samples: 10, last_updated: null },
        },
      }),
      'kimi-k2.5': makeProfile({
        scores: {
          ...makeProfile().scores,
          implementation: { value: 0.85, samples: 10, effective_samples: 10, last_updated: null },
        },
      }),
    };

    const input = makeInput({ complexity: 'medium' });

    const run1 = routeWithCapabilities(input, profiles, providerFailures);
    const run2 = routeWithCapabilities(input, profiles, providerFailures);

    expect(run1.selectedModel).toBe(run2.selectedModel);
    expect(run1.selectedProvider).toBe(run2.selectedProvider);
    expect(run1.selectionMethod).toBe(run2.selectionMethod);
    expect(run1.candidates).toEqual(run2.candidates);
    expect(run1.reasons).toEqual(run2.reasons);
  });
});
