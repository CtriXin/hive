import { describe, expect, it } from 'vitest';
import {
  loadReviewAuthorityPolicy,
  normalizeReviewAuthorityPolicy,
} from '../orchestrator/authority-policy.js';

describe('authority-policy', () => {
  it('normalizes invalid values to safe defaults', () => {
    const policy = normalizeReviewAuthorityPolicy({
      default_mode: 'weird' as any,
      max_models: 99,
      low_confidence_threshold: 9,
      partial_result_policy: 'unknown' as any,
      synthesis_failure_policy: 'weird' as any,
    });

    expect(policy.default_mode).toBe('single');
    expect(policy.max_models).toBe(2);
    expect(policy.low_confidence_threshold).toBe(0.75);
    expect(policy.partial_result_policy).toBe('proceed_if_min_met');
    expect(policy.synthesis_failure_policy).toBe('fail_closed');
  });

  it('loads the repo authority policy', () => {
    const policy = loadReviewAuthorityPolicy();

    expect(policy.enabled).toBe(false);
    expect(policy.default_mode).toBe('single');
    expect(policy.max_models).toBe(2);
    expect(policy.escalate_on).not.toContain('strict_boundary');
    expect(policy.primary_candidates.length).toBeGreaterThan(0);
    expect(policy.synthesis_failure_policy).toBe('fail_closed');
  });
});
