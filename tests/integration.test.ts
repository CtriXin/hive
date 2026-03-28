/**
 * Integration tests — verify modules work together correctly.
 * No real API calls; mocks file system and provider resolution.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import type { SubTask } from '../orchestrator/types.js';

// ── Mock MMS model-routes.json ──

const MOCK_MMS_ROUTES = {
  _meta: { generated_at: '2026-03-27' },
  routes: {
    'kimi-k2.5': { anthropic_base_url: 'http://kimi', api_key: 'k1', provider_id: 'xin', priority: 125 },
    'MiniMax-M2.7': { anthropic_base_url: 'http://mm', api_key: 'k2', provider_id: 'xin', priority: 125 },
    'glm-5-turbo': { anthropic_base_url: 'http://glm', api_key: 'k3', provider_id: 'glm-cn', priority: 100 },
    'qwen3-max': { anthropic_base_url: 'http://qwen', api_key: 'k4', provider_id: 'qwen', priority: 125 },
  },
};

let mockMmsContent: string | null = JSON.stringify(MOCK_MMS_ROUTES);

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      statSync: vi.fn((p: string) => {
        // Let model-capabilities.json through to real fs
        if (typeof p === 'string' && p.includes('model-capabilities')) {
          return actual.statSync(p);
        }
        if (typeof p === 'string' && p.includes('benchmark-policy')) {
          return actual.statSync(p);
        }
        if (typeof p === 'string' && p.includes('profiles')) {
          throw new Error('ENOENT');
        }
        if (typeof p === 'string' && p.includes('speed-stats')) {
          throw new Error('ENOENT');
        }
        if (mockMmsContent !== null && typeof p === 'string' && p.includes('model-routes')) {
          return { mtimeMs: 99999 };
        }
        throw new Error('ENOENT');
      }),
      readFileSync: vi.fn((p: string, enc?: string) => {
        // Let model-capabilities.json through to real fs
        if (typeof p === 'string' && p.includes('model-capabilities')) {
          return actual.readFileSync(p, enc as any);
        }
        if (typeof p === 'string' && p.includes('benchmark-policy')) {
          return actual.readFileSync(p, enc as any);
        }
        if (typeof p === 'string' && p.includes('model-routes') && mockMmsContent !== null) {
          return mockMmsContent;
        }
        throw new Error('ENOENT');
      }),
      existsSync: vi.fn((p: string) => {
        if (typeof p === 'string' && p.includes('model-capabilities')) return actual.existsSync(p);
        if (typeof p === 'string' && p.includes('benchmark-policy')) return actual.existsSync(p);
        return false;
      }),
    },
  };
});

// ── Import after mocks ──

import { buildTaskFingerprint } from '../orchestrator/task-fingerprint.js';
import { computeWeightedScore, getHardFilterFailures, type ScorerContext } from '../orchestrator/model-scorer.js';
import { getConfidenceFactor, applyTimeDecay, type BenchmarkPolicy } from '../orchestrator/profiler.js';
import { loadMmsRoutes, resolveModelByPrefix, invalidateCache } from '../orchestrator/mms-routes-loader.js';
import {
  looksLikeInfrastructureFailure, classifyReviewError, shouldAutoPass,
  isComplexityAtOrBelow, extractJsonObject,
} from '../orchestrator/review-utils.js';
import { resolveTierModel, DEFAULT_TIERS } from '../orchestrator/hive-config.js';

function makeTask(overrides: Partial<SubTask> = {}): SubTask {
  return {
    id: 'T1', description: 'Implement caching layer', category: 'api',
    complexity: 'medium', estimated_files: ['orchestrator/cache.ts'],
    depends_on: [], assigned_model: '', assignment_reason: '',
    discuss_threshold: 0.7,
    ...overrides,
  };
}

describe('integration: task → fingerprint → scoring', () => {
  beforeEach(() => {
    process.env.MMS_ROUTES_PATH = '/tmp/test-routes.json';
    mockMmsContent = JSON.stringify(MOCK_MMS_ROUTES);
    invalidateCache();
  });

  afterEach(() => {
    delete process.env.MMS_ROUTES_PATH;
    invalidateCache();
  });

  it('fingerprint feeds into scorer without errors', () => {
    const task = makeTask();
    const fp = buildTaskFingerprint(task);
    expect(fp.role).toBe('implementation');

    const model = {
      provider: 'xin', strengths: ['coding'],
      scores: { general: 0.82, coding: 0.88, planning: 0.75, review: 0.78, translation: 0.8 },
      context_window: 128000, cost_per_1k: 0.012,
    };

    const policy: BenchmarkPolicy = {
      schema_version: '1.0', min_samples_for_confidence: 10, half_life_days: 30,
      default_score: 0.5,
      hard_filters: { strict_boundary_min_scope_discipline: 0.4, integration_min_confidence: 0.3 },
      base_weights: {
        implementation: 1.0, review: 0.8, repair: 0.6, integration: 0.7,
        spec_adherence: 0.9, scope_discipline: 0.8, turnaround_speed: 0.5,
      },
      role_boost: 0.5, strict_boundary_boost: 0.3, fast_turnaround_boost: 0.4,
    };

    const ctx: ScorerContext = {
      policy,
      profiles: { profiles: {} },
      models: new Map([['kimi-k2.5', model]]),
      canResolveForModel: () => true,
    };

    const result = computeWeightedScore(ctx, 'kimi-k2.5', model, undefined, fp);
    expect(result.final_score).toBeGreaterThan(0);
    expect(result.model).toBe('kimi-k2.5');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('hard filters block unresolvable models', () => {
    const fp = buildTaskFingerprint(makeTask());
    const model = {
      provider: 'unknown', strengths: [],
      scores: { general: 0.8, coding: 0.8, planning: 0.8, review: 0.8, translation: 0.8 },
      context_window: 128000, cost_per_1k: 0.01,
    };

    const ctx: ScorerContext = {
      policy: {
        schema_version: '1.0', min_samples_for_confidence: 10, half_life_days: 30,
        default_score: 0.5,
        hard_filters: { strict_boundary_min_scope_discipline: 0.4, integration_min_confidence: 0.3 },
        base_weights: {
          implementation: 1.0, review: 0.8, repair: 0.6, integration: 0.7,
          spec_adherence: 0.9, scope_discipline: 0.8, turnaround_speed: 0.5,
        },
        role_boost: 0.5, strict_boundary_boost: 0.3, fast_turnaround_boost: 0.4,
      },
      profiles: { profiles: {} },
      models: new Map(),
      canResolveForModel: () => false,
    };

    const failures = getHardFilterFailures(ctx, 'unknown', model, undefined, fp);
    expect(failures).toContain('provider_resolution_failed');
  });

  it('repair task + fix description detected end-to-end', () => {
    const task = makeTask({ description: 'Fix race condition in cache invalidation' });
    const fp = buildTaskFingerprint(task);
    expect(fp.role).toBe('repair');
    expect(fp.is_repair_round).toBe(true);
  });
});

describe('integration: tier config resolution chain', () => {
  it('explicit model ID bypasses auto function', () => {
    const tierModel = resolveTierModel('kimi-k2.5', () => 'should-not-call');
    expect(tierModel).toBe('kimi-k2.5');
  });

  it('auto tier calls the auto function with arbitrary logic', () => {
    const tierModel = resolveTierModel('auto', () => {
      // Simulate registry auto-selection
      return 'qwen3-max';
    });
    expect(tierModel).toBe('qwen3-max');
  });

  it('auto with MMS-like selection logic', () => {
    // Simulates what happens when MMS routes drive model selection
    const mockModels = ['kimi-k2.5', 'qwen3-max', 'glm-5-turbo'];
    const selectBest = () => mockModels[0]; // highest scored

    const tierModel = resolveTierModel('auto', selectBest);
    expect(tierModel).toBe('kimi-k2.5');
  });

  it('auto function fallback when no models available', () => {
    const tierModel = resolveTierModel('auto', () => 'hardcoded-fallback');
    expect(tierModel).toBe('hardcoded-fallback');
  });
});

describe('integration: review pipeline helpers', () => {
  it('infrastructure failure → classifyReviewError → fallback decision', () => {
    const errorText = 'Request failed: 503 Service Unavailable';
    expect(looksLikeInfrastructureFailure(errorText)).toBe(true);

    const errorType = classifyReviewError({ status: 503 });
    expect(errorType).toBe('server_error');
  });

  it('auto-pass check integrates with complexity check', () => {
    const policy = {
      auto_pass_categories: ['docs'],
      cross_review: { min_confidence_to_skip: 0.85, min_pass_rate_for_skip: 0.9, max_complexity_for_skip: 'medium' },
      a2a: { max_reject_iterations: 1, contested_threshold: 'CONTESTED' },
      arbitration: { sonnet_max_iterations: 1 },
    };

    const task = makeTask({ category: 'docs', complexity: 'low' });
    const autoPass = shouldAutoPass(task, ['README.md'], policy);
    expect(autoPass).toBe(true);

    // Verify complexity check agrees
    expect(isComplexityAtOrBelow('low', policy.cross_review.max_complexity_for_skip)).toBe(true);
  });

  it('JSON extraction → parse review output', () => {
    const rawOutput = `
      Here is my review:
      {"verdict": "PASS", "findings": [], "confidence": 0.92}
      End of review.
    `;
    const json = extractJsonObject(rawOutput);
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!);
    expect(parsed.verdict).toBe('PASS');
    expect(parsed.confidence).toBe(0.92);
  });
});

describe('integration: profiler + scorer confidence chain', () => {
  it('confidence factor affects score interpretation', () => {
    const policy: BenchmarkPolicy = {
      schema_version: '1.0', min_samples_for_confidence: 10, half_life_days: 30,
      default_score: 0.5,
      hard_filters: { strict_boundary_min_scope_discipline: 0.4, integration_min_confidence: 0.3 },
      base_weights: {
        implementation: 1.0, review: 0.8, repair: 0.6, integration: 0.7,
        spec_adherence: 0.9, scope_discipline: 0.8, turnaround_speed: 0.5,
      },
      role_boost: 0.5, strict_boundary_boost: 0.3, fast_turnaround_boost: 0.4,
    };

    // No samples → confidence 0
    const noSamples = getConfidenceFactor(0, policy);
    expect(noSamples).toBe(0);

    // 10 samples → confidence 1.0
    const fullSamples = getConfidenceFactor(10, policy);
    expect(fullSamples).toBe(1);

    // Recent score stays close to original
    const decayed = applyTimeDecay(0.9, new Date().toISOString(), policy);
    expect(decayed).toBeCloseTo(0.9, 1);

    // Old score decays toward default
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60); // 2 half-lives
    const heavilyDecayed = applyTimeDecay(0.9, oldDate.toISOString(), policy);
    expect(heavilyDecayed).toBeLessThan(0.8);
    expect(heavilyDecayed).toBeGreaterThan(0.5);
  });
});

describe('integration: multi-tier auto selection chain', () => {
  it('all DEFAULT_TIERS resolve to auto, triggering auto functions', () => {
    const tiers = DEFAULT_TIERS;
    const selections: Record<string, string> = {};

    // Each tier calls its own auto function
    selections.translator = resolveTierModel(tiers.translator.model, () => 'glm-5-turbo');
    selections.planner = resolveTierModel(tiers.planner.model, () => 'qwen3-max');
    selections.executor = resolveTierModel(tiers.executor.model, () => 'kimi-k2.5');
    selections.crossReview = resolveTierModel(tiers.reviewer.cross_review.model, () => 'glm-5-turbo');
    selections.arbitration = resolveTierModel(tiers.reviewer.arbitration.model, () => 'kimi-k2.5');
    selections.finalReview = resolveTierModel(tiers.reviewer.final_review.model, () => 'qwen3-max');
    selections.reporter = resolveTierModel(tiers.reporter.model, () => 'kimi-k2.5');

    // All tiers should have resolved to their auto function results
    expect(selections.translator).toBe('glm-5-turbo');
    expect(selections.planner).toBe('qwen3-max');
    expect(selections.executor).toBe('kimi-k2.5');
    expect(selections.crossReview).toBe('glm-5-turbo');
    expect(selections.arbitration).toBe('kimi-k2.5');
    expect(selections.finalReview).toBe('qwen3-max');
    expect(selections.reporter).toBe('kimi-k2.5');
  });

  it('explicit tier config bypasses auto function', () => {
    const explicitTiers = {
      ...DEFAULT_TIERS,
      planner: { model: 'claude-opus-4-6' },
      reviewer: {
        ...DEFAULT_TIERS.reviewer,
        final_review: { model: 'claude-opus-4-6' },
      },
    };

    const planner = resolveTierModel(explicitTiers.planner.model, () => 'should-not-call');
    const finalReview = resolveTierModel(explicitTiers.reviewer.final_review.model, () => 'should-not-call');

    expect(planner).toBe('claude-opus-4-6');
    expect(finalReview).toBe('claude-opus-4-6');
  });
});
