import { describe, it, expect } from 'vitest';
import { resolveTierModel, DEFAULT_TIERS, DEFAULT_CONFIG, getModelForTask, ensureStageModelAllowed } from '../orchestrator/hive-config.js';
import { ModelRegistry } from '../orchestrator/model-registry.js';
import type { SubTask } from '../orchestrator/types.js';

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

  describe('getModelForTask', () => {
    const registry = new ModelRegistry();
    const baseTask: SubTask = {
      id: 'task-a',
      description: 'High complexity runtime change',
      complexity: 'high',
      category: 'api',
      assigned_model: '',
      assignment_reason: '',
      estimated_files: ['orchestrator/driver.ts'],
      acceptance_criteria: ['build passes'],
      discuss_threshold: 0.7,
      depends_on: [],
      review_scale: 'auto',
    };

    it('does not auto-return claude for high complexity tasks', () => {
      const selected = getModelForTask(baseTask, DEFAULT_CONFIG, registry);
      expect(selected).not.toMatch(/^claude-/);
    });

    it('does not allow executor override to force claude', () => {
      const config = {
        ...DEFAULT_CONFIG,
        overrides: { [baseTask.id]: 'claude-opus-4-6' },
      };
      const selected = getModelForTask(baseTask, config, registry);
      expect(selected).not.toMatch(/^claude-/);
    });
  });

  describe('ensureStageModelAllowed', () => {
    it('allows explicit claude for planner and final_review only', () => {
      expect(() => ensureStageModelAllowed('planner', 'claude-opus-4-6')).not.toThrow();
      expect(() => ensureStageModelAllowed('final_review', 'claude-opus-4-6')).not.toThrow();
      expect(() => ensureStageModelAllowed('executor', 'claude-opus-4-6')).toThrow(/not allowed/);
      expect(() => ensureStageModelAllowed('cross_review', 'claude-sonnet-4-6')).toThrow(/not allowed/);
    });
  });
});
