import { describe, it, expect } from 'vitest';
import {
  clamp, resolveRoleScoreKey, computeWeightedScore, getHardFilterFailures,
  EXPECTED_ITERATIONS, COMPLEXITY_INFO_WEIGHT, FAILURE_WEIGHT,
  type ScorerContext,
} from '../orchestrator/model-scorer.js';
import type { TaskFingerprint } from '../orchestrator/task-fingerprint.js';
import type { BenchmarkPolicy } from '../orchestrator/profiler.js';

const MOCK_POLICY: BenchmarkPolicy = {
  schema_version: '1.0',
  min_samples_for_confidence: 10,
  half_life_days: 30,
  default_score: 0.5,
  hard_filters: {
    strict_boundary_min_scope_discipline: 0.4,
    integration_min_confidence: 0.3,
  },
  base_weights: {
    implementation: 1.0, review: 0.8, repair: 0.6,
    integration: 0.7, spec_adherence: 0.9, scope_discipline: 0.8,
    turnaround_speed: 0.5,
  },
  role_boost: 0.5,
  strict_boundary_boost: 0.3,
  fast_turnaround_boost: 0.4,
};

function makeCtx(overrides: Partial<ScorerContext> = {}): ScorerContext {
  return {
    policy: MOCK_POLICY,
    profiles: { profiles: {} },
    models: new Map(),
    canResolveForModel: () => true,
    ...overrides,
  };
}

describe('model-scorer', () => {
  describe('clamp', () => {
    it('clamps below min', () => expect(clamp(-1, 0, 1)).toBe(0));
    it('clamps above max', () => expect(clamp(5, 0, 1)).toBe(1));
    it('passes through in range', () => expect(clamp(0.5, 0, 1)).toBe(0.5));
  });

  describe('resolveRoleScoreKey', () => {
    it('maps planning to spec_adherence', () => expect(resolveRoleScoreKey('planning')).toBe('spec_adherence'));
    it('maps review to review', () => expect(resolveRoleScoreKey('review')).toBe('review'));
    it('defaults to implementation', () => expect(resolveRoleScoreKey('unknown')).toBe('implementation'));
  });

  describe('constants', () => {
    it('EXPECTED_ITERATIONS increases with complexity', () => {
      expect(EXPECTED_ITERATIONS.low).toBeLessThan(EXPECTED_ITERATIONS.high);
    });

    it('COMPLEXITY_INFO_WEIGHT increases with complexity', () => {
      expect(COMPLEXITY_INFO_WEIGHT.low).toBeLessThan(COMPLEXITY_INFO_WEIGHT.high);
    });

    it('FAILURE_WEIGHT decreases with complexity', () => {
      expect(FAILURE_WEIGHT.low).toBeGreaterThan(FAILURE_WEIGHT.high);
    });
  });

  describe('computeWeightedScore', () => {
    it('returns score for model without profile (uses defaults)', () => {
      const ctx = makeCtx();
      const model = {
        provider: 'test', strengths: ['coding'], scores: { general: 0.8, coding: 0.85, planning: 0.8, review: 0.75, translation: 0.7 },
        context_window: 128000, cost_per_1k: 0.005,
      };
      const fp: TaskFingerprint = {
        role: 'implementation', domains: ['typescript'], complexity: 'medium',
        needs_strict_boundary: false, needs_fast_turnaround: false, is_repair_round: false,
      };
      const result = computeWeightedScore(ctx, 'test-model', model, undefined, fp);
      expect(result.model).toBe('test-model');
      expect(result.final_score).toBeGreaterThan(0);
      expect(result.reasons.length).toBeGreaterThan(0);
    });
  });

  describe('getHardFilterFailures', () => {
    it('passes for well-configured model', () => {
      const ctx = makeCtx();
      const model = {
        provider: 'test', strengths: [], scores: { general: 0.8, coding: 0.85, planning: 0.8, review: 0.75, translation: 0.7 },
        context_window: 128000, cost_per_1k: 0.005,
      };
      const fp: TaskFingerprint = {
        role: 'implementation', domains: ['typescript'], complexity: 'medium',
        needs_strict_boundary: false, needs_fast_turnaround: false, is_repair_round: false,
      };
      const failures = getHardFilterFailures(ctx, 'test-model', model, undefined, fp);
      expect(failures).toEqual([]);
    });

    it('blocks model with insufficient complexity capacity', () => {
      const ctx = makeCtx();
      const model = {
        provider: 'test', strengths: [], scores: { general: 0.5, coding: 0.5, planning: 0.5, review: 0.5, translation: 0.5 },
        context_window: 32000, cost_per_1k: 0.005,
      };
      const fp: TaskFingerprint = {
        role: 'implementation', domains: ['typescript'], complexity: 'high',
        needs_strict_boundary: false, needs_fast_turnaround: false, is_repair_round: false,
      };
      const failures = getHardFilterFailures(ctx, 'weak-model', model, undefined, fp);
      expect(failures).toContain('insufficient_complexity_capacity');
    });

    it('blocks model with unresolvable provider', () => {
      const ctx = makeCtx({ canResolveForModel: () => false });
      const model = {
        provider: 'unknown', strengths: [], scores: { general: 0.8, coding: 0.85, planning: 0.8, review: 0.8, translation: 0.8 },
        context_window: 128000, cost_per_1k: 0.01,
      };
      const fp: TaskFingerprint = {
        role: 'implementation', domains: ['typescript'], complexity: 'medium',
        needs_strict_boundary: false, needs_fast_turnaround: false, is_repair_round: false,
      };
      const failures = getHardFilterFailures(ctx, 'test', model, undefined, fp);
      expect(failures).toContain('provider_resolution_failed');
    });
  });
});
