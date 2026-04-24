import { describe, it, expect } from 'vitest';
import { resolveTierModel, DEFAULT_TIERS, DEFAULT_CONFIG, getModelForTask, ensureStageModelAllowed, resolveFallback } from '../orchestrator/hive-config.js';
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

    it('returns model directly when not auto and not blocked', () => {
      const result = resolveTierModel('claude-opus-4-6', () => 'should-not-be-called', undefined, undefined, { model_blacklist: [] });
      expect(result).toBe('claude-opus-4-6');
    });

    it('autoFn is only called when model is auto', () => {
      let called = false;
      resolveTierModel('qwen3-max', () => { called = true; return 'x'; });
      expect(called).toBe(false);
    });

    it('falls back to auto selection when configured model is blacklisted', () => {
      const result = resolveTierModel(
        'claude-opus-4-6',
        () => 'qwen3-max',
        undefined,
        undefined,
        { model_blacklist: ['claude-*'] },
      );
      expect(result).toBe('qwen3-max');
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

    it('skips non-direct configured defaults when only later runnable candidates remain', () => {
      const fakeRegistry = {
        rankModelsForTask: () => [],
        canResolveForModel: (modelId: string) => modelId === 'qwen3-max',
        get: (modelId: string) => ({ provider: modelId === 'qwen3-max' ? 'qwen' : 'glm-cn' }),
      } as unknown as ModelRegistry;

      const selected = getModelForTask(baseTask, DEFAULT_CONFIG, fakeRegistry);
      expect(selected).toBe('qwen3-max');
    });

    it('skips blacklisted ranked candidates', () => {
      const fakeRegistry = {
        rankModelsForTask: () => [
          { model: 'qwen3-max', blocked_by: [] },
          { model: 'glm-5-turbo', blocked_by: [] },
        ],
        canResolveForModel: () => true,
        get: (modelId: string) => ({ provider: modelId.startsWith('qwen') ? 'qwen' : 'glm-cn' }),
      } as unknown as ModelRegistry;

      const selected = getModelForTask(
        baseTask,
        { ...DEFAULT_CONFIG, model_blacklist: ['qwen*'] },
        fakeRegistry,
      );
      expect(selected).toBe('glm-5-turbo');
    });
  });

  describe('resolveFallback', () => {
    const task: SubTask = {
      id: 'task-fallback',
      description: 'Fix the execution path',
      complexity: 'medium',
      category: 'api',
      assigned_model: 'kimi-for-coding',
      assignment_reason: '',
      estimated_files: ['src/task.ts'],
      acceptance_criteria: ['task succeeds'],
      discuss_threshold: 0.7,
      depends_on: [],
      review_scale: 'auto',
    };

    it('skips unrunnable fallback candidates and returns the next direct-executable model', () => {
      const fakeRegistry = {
        rankModelsForTask: () => [
          { model: 'glm-5-turbo', blocked_by: [] },
          { model: 'qwen3-max', blocked_by: [] },
        ],
        canResolveForModel: (modelId: string) => modelId === 'qwen3-max',
        get: (modelId: string) => ({ provider: modelId === 'qwen3-max' ? 'qwen' : 'glm-cn' }),
      } as unknown as ModelRegistry;

      const selected = resolveFallback('kimi-for-coding', 'server_error', task, DEFAULT_CONFIG, fakeRegistry);
      expect(selected).toBe('qwen3-max');
    });

    it('skips blacklisted fallback candidates', () => {
      const fakeRegistry = {
        rankModelsForTask: () => [
          { model: 'qwen3-max', blocked_by: [] },
          { model: 'glm-5-turbo', blocked_by: [] },
        ],
        canResolveForModel: () => true,
        get: (modelId: string) => ({ provider: modelId.startsWith('qwen') ? 'qwen' : 'glm-cn' }),
      } as unknown as ModelRegistry;

      const selected = resolveFallback(
        'kimi-for-coding',
        'quality_fail',
        task,
        { ...DEFAULT_CONFIG, model_blacklist: ['qwen*'] },
        fakeRegistry,
      );
      expect(selected).toBe('glm-5-turbo');
    });
  });

  describe('ensureStageModelAllowed', () => {
    it('rejects explicit claude for every stage', () => {
      expect(() => ensureStageModelAllowed('planner', 'claude-opus-4-6', { model_blacklist: [] })).toThrow(/disabled/i);
      expect(() => ensureStageModelAllowed('final_review', 'claude-opus-4-6', { model_blacklist: [] })).toThrow(/disabled/i);
      expect(() => ensureStageModelAllowed('executor', 'claude-opus-4-6', { model_blacklist: [] })).toThrow(/disabled/i);
      expect(() => ensureStageModelAllowed('cross_review', 'claude-sonnet-4-6', { model_blacklist: [] })).toThrow(/disabled/i);
    });

    it('rejects models matched by model_blacklist', () => {
      expect(() => ensureStageModelAllowed(
        'planner',
        'claude-opus-4-6',
        { model_blacklist: ['claude-*'] },
      )).toThrow(/model_blacklist/);
    });
  });
});
