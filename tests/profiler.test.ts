import { describe, it, expect } from 'vitest';
import {
  getConfidenceFactor, applyTimeDecay, getEffectiveScore,
  PROFILE_SCORE_KEYS, type BenchmarkPolicy, type ModelProfile, type ObservedScore,
} from '../orchestrator/profiler.js';

const MOCK_POLICY: BenchmarkPolicy = {
  schema_version: '1.0',
  min_samples_for_confidence: 10,
  half_life_days: 30,
  default_score: 0.5,
  hard_filters: { strict_boundary_min_scope_discipline: 0.4, integration_min_confidence: 0.3 },
  base_weights: {
    implementation: 1.0, review: 0.8, repair: 0.6,
    integration: 0.7, spec_adherence: 0.9, scope_discipline: 0.8, turnaround_speed: 0.5,
  },
  role_boost: 0.5, strict_boundary_boost: 0.3, fast_turnaround_boost: 0.4,
};

function makeScore(value: number, samples: number, daysAgo = 0): ObservedScore {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return { value, samples, effective_samples: samples, last_updated: date.toISOString() };
}

function makeProfile(overrides: Partial<Record<string, ObservedScore>> = {}): ModelProfile {
  const scores = Object.fromEntries(
    PROFILE_SCORE_KEYS.map((k) => [k, overrides[k] ?? makeScore(0.5, 0)]),
  ) as ModelProfile['scores'];
  return { scores, domain_tags: [], avoid_tags: [] };
}

describe('profiler', () => {
  describe('getConfidenceFactor', () => {
    it('returns 0 for 0 samples', () => {
      expect(getConfidenceFactor(0, MOCK_POLICY)).toBe(0);
    });

    it('returns 1 for sufficient samples', () => {
      expect(getConfidenceFactor(10, MOCK_POLICY)).toBe(1);
    });

    it('partial confidence for few samples', () => {
      const cf = getConfidenceFactor(3, MOCK_POLICY);
      expect(cf).toBeGreaterThan(0);
      expect(cf).toBeLessThan(1);
    });

    it('scales with sqrt', () => {
      const cf2 = getConfidenceFactor(2, MOCK_POLICY);
      const cf8 = getConfidenceFactor(8, MOCK_POLICY);
      expect(cf8).toBeGreaterThan(cf2);
    });
  });

  describe('applyTimeDecay', () => {
    it('no decay for recent scores', () => {
      const decayed = applyTimeDecay(0.9, new Date().toISOString(), MOCK_POLICY);
      expect(decayed).toBeCloseTo(0.9, 1);
    });

    it('decays toward default over time', () => {
      const oneHalfLife = new Date();
      oneHalfLife.setDate(oneHalfLife.getDate() - 30);
      const decayed = applyTimeDecay(0.9, oneHalfLife.toISOString(), MOCK_POLICY);
      // After one half-life, should be midpoint between 0.9 and 0.5 = 0.7
      expect(decayed).toBeCloseTo(0.7, 1);
    });

    it('no decay for null lastUpdated', () => {
      expect(applyTimeDecay(0.8, null, MOCK_POLICY)).toBe(0.8);
    });
  });

  describe('getEffectiveScore', () => {
    it('returns default for empty profile', () => {
      const profile = makeProfile();
      const result = getEffectiveScore(profile, 'implementation', MOCK_POLICY);
      expect(result.value).toBe(0.5);
      expect(result.samples).toBe(0);
    });

    it('returns decayed value for populated score', () => {
      const profile = makeProfile({
        implementation: makeScore(0.85, 5, 0),
      });
      const result = getEffectiveScore(profile, 'implementation', MOCK_POLICY);
      expect(result.value).toBeCloseTo(0.85, 1);
      expect(result.samples).toBe(5);
    });
  });

  describe('PROFILE_SCORE_KEYS', () => {
    it('has 7 dimensions', () => {
      expect(PROFILE_SCORE_KEYS).toHaveLength(7);
    });

    it('includes all expected keys', () => {
      expect(PROFILE_SCORE_KEYS).toContain('implementation');
      expect(PROFILE_SCORE_KEYS).toContain('review');
      expect(PROFILE_SCORE_KEYS).toContain('turnaround_speed');
    });
  });
});
