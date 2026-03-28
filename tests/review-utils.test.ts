import { describe, it, expect } from 'vitest';
import {
  looksLikeInfrastructureFailure, classifyReviewError, shouldAutoPass,
  isComplexityAtOrBelow, normalizeSeverity, truncateDiff, extractJsonObject,
} from '../orchestrator/review-utils.js';
import type { SubTask } from '../orchestrator/types.js';

function makeTask(overrides: Partial<SubTask> = {}): SubTask {
  return {
    id: 'T1', description: 'Implement feature', category: 'api',
    complexity: 'medium', estimated_files: ['src/foo.ts'],
    depends_on: [], assigned_model: '', assignment_reason: '',
    discuss_threshold: 0.7,
    ...overrides,
  };
}

describe('review-utils', () => {
  describe('looksLikeInfrastructureFailure', () => {
    it('detects rate limit', () => {
      expect(looksLikeInfrastructureFailure('Rate limit exceeded')).toBe(true);
    });

    it('detects timeout', () => {
      expect(looksLikeInfrastructureFailure('Request timeout after 30s')).toBe(true);
    });

    it('detects connection errors', () => {
      expect(looksLikeInfrastructureFailure('ECONNREFUSED 127.0.0.1')).toBe(true);
    });

    it('detects HTTP error codes', () => {
      expect(looksLikeInfrastructureFailure('Server returned 503')).toBe(true);
      expect(looksLikeInfrastructureFailure('Error 429: Too many requests')).toBe(true);
    });

    it('returns false for normal errors', () => {
      expect(looksLikeInfrastructureFailure('SyntaxError: unexpected token')).toBe(false);
    });
  });

  describe('classifyReviewError', () => {
    it('classifies 429 as rate_limit', () => {
      expect(classifyReviewError({ status: 429 })).toBe('rate_limit');
    });

    it('classifies overloaded message as rate_limit', () => {
      expect(classifyReviewError({ message: 'Server overloaded' })).toBe('rate_limit');
    });

    it('classifies 500+ as server_error', () => {
      expect(classifyReviewError({ status: 502 })).toBe('server_error');
    });

    it('classifies timeout as server_error', () => {
      expect(classifyReviewError({ message: 'timeout after 30s' })).toBe('server_error');
    });

    it('defaults to quality_fail', () => {
      expect(classifyReviewError({ message: 'bad output format' })).toBe('quality_fail');
      expect(classifyReviewError({})).toBe('quality_fail');
    });
  });

  describe('shouldAutoPass', () => {
    const policy = {
      auto_pass_categories: ['docs', 'comments', 'formatting', 'i18n'],
      cross_review: { min_confidence_to_skip: 0.85, min_pass_rate_for_skip: 0.9, max_complexity_for_skip: 'medium' },
      a2a: { max_reject_iterations: 1, contested_threshold: 'CONTESTED' },
      arbitration: { sonnet_max_iterations: 1 },
    };

    it('auto-passes docs task with md files', () => {
      const task = makeTask({ category: 'docs' });
      expect(shouldAutoPass(task, ['README.md', 'CHANGELOG.md'], policy)).toBe(true);
    });

    it('rejects non-doc category', () => {
      const task = makeTask({ category: 'api' });
      expect(shouldAutoPass(task, ['README.md'], policy)).toBe(false);
    });

    it('rejects if any file is non-doc', () => {
      const task = makeTask({ category: 'docs' });
      expect(shouldAutoPass(task, ['README.md', 'src/index.ts'], policy)).toBe(false);
    });

    it('auto-passes i18n with locale files', () => {
      const task = makeTask({ category: 'i18n' });
      expect(shouldAutoPass(task, ['locale/en.json', 'i18n/zh.json'], policy)).toBe(true);
    });
  });

  describe('isComplexityAtOrBelow', () => {
    it('low <= medium', () => {
      expect(isComplexityAtOrBelow('low', 'medium')).toBe(true);
    });

    it('high > medium', () => {
      expect(isComplexityAtOrBelow('high', 'medium')).toBe(false);
    });

    it('medium <= medium', () => {
      expect(isComplexityAtOrBelow('medium', 'medium')).toBe(true);
    });

    it('medium-high <= high', () => {
      expect(isComplexityAtOrBelow('medium-high', 'high')).toBe(true);
    });

    it('defaults invalid threshold to medium', () => {
      expect(isComplexityAtOrBelow('low', 'invalid')).toBe(true);
      expect(isComplexityAtOrBelow('high', 'invalid')).toBe(false);
    });
  });

  describe('normalizeSeverity', () => {
    it('passes through valid severities', () => {
      expect(normalizeSeverity('red')).toBe('red');
      expect(normalizeSeverity('yellow')).toBe('yellow');
      expect(normalizeSeverity('green')).toBe('green');
    });

    it('defaults unknown to yellow', () => {
      expect(normalizeSeverity('critical')).toBe('yellow');
      expect(normalizeSeverity(undefined)).toBe('yellow');
      expect(normalizeSeverity(42)).toBe('yellow');
    });
  });

  describe('truncateDiff', () => {
    it('returns short diff unchanged', () => {
      expect(truncateDiff('abc', 100)).toBe('abc');
    });

    it('truncates long diff with message', () => {
      const long = 'x'.repeat(200);
      const result = truncateDiff(long, 50);
      expect(result.length).toBeLessThan(200);
      expect(result).toContain('[DIFF TRUNCATED');
      expect(result).toContain('50 characters of 200');
    });

    it('exact limit returns unchanged', () => {
      const exact = 'a'.repeat(100);
      expect(truncateDiff(exact, 100)).toBe(exact);
    });
  });

  describe('extractJsonObject', () => {
    it('extracts simple object', () => {
      const result = extractJsonObject('prefix {"key": "value"} suffix');
      expect(result).toBe('{"key": "value"}');
    });

    it('extracts nested object', () => {
      const result = extractJsonObject('{"a": {"b": 1}, "c": 2}');
      expect(result).toBe('{"a": {"b": 1}, "c": 2}');
    });

    it('handles escaped quotes', () => {
      const result = extractJsonObject('{"msg": "say \\"hello\\""}');
      expect(result).toBe('{"msg": "say \\"hello\\""}');
    });

    it('handles braces in strings', () => {
      const result = extractJsonObject('{"code": "if (x) { y }"}');
      expect(result).toBe('{"code": "if (x) { y }"}');
    });

    it('returns null for no object', () => {
      expect(extractJsonObject('no json here')).toBeNull();
    });

    it('returns null for incomplete object', () => {
      expect(extractJsonObject('{"key": "value"')).toBeNull();
    });

    it('extracts first object from multiple', () => {
      const result = extractJsonObject('{"a": 1} {"b": 2}');
      expect(result).toBe('{"a": 1}');
    });
  });
});
