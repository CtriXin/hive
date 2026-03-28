import { describe, it, expect } from 'vitest';
import { resolveTierModel, DEFAULT_TIERS } from '../orchestrator/hive-config.js';

describe('hive-config', () => {
  describe('DEFAULT_TIERS', () => {
    it('all tiers default to auto', () => {
      expect(DEFAULT_TIERS.translator.model).toBe('auto');
      expect(DEFAULT_TIERS.planner.model).toBe('auto');
      expect(DEFAULT_TIERS.executor.model).toBe('auto');
      expect(DEFAULT_TIERS.reviewer.cross_review.model).toBe('auto');
      expect(DEFAULT_TIERS.reviewer.arbitration.model).toBe('auto');
      expect(DEFAULT_TIERS.reviewer.final_review.model).toBe('auto');
      expect(DEFAULT_TIERS.discuss.model).toBe('auto');
      expect(DEFAULT_TIERS.reporter.model).toBe('auto');
    });

    it('has fallbacks for key tiers', () => {
      expect(DEFAULT_TIERS.planner.fallback).toBe('qwen3-max');
      expect(DEFAULT_TIERS.discuss.fallback).toBe('kimi-k2.5');
      expect(DEFAULT_TIERS.reviewer.arbitration.fallback).toBe('kimi-for-coding');
      expect(DEFAULT_TIERS.reviewer.final_review.fallback).toBe('qwen3-max');
    });
  });

  describe('resolveTierModel', () => {
    it('returns autoFn result when model is auto', () => {
      const result = resolveTierModel('auto', () => 'kimi-k2.5');
      expect(result).toBe('kimi-k2.5');
    });

    it('returns model directly when not auto', () => {
      const result = resolveTierModel('claude-opus-4-6', () => 'should-not-be-called');
      expect(result).toBe('claude-opus-4-6');
    });

    it('autoFn is only called when model is auto', () => {
      let called = false;
      resolveTierModel('qwen3-max', () => { called = true; return 'x'; });
      expect(called).toBe(false);
    });
  });
});
