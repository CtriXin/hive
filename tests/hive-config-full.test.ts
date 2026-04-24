import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  deepMerge, readJsonSafe, findRepoRoot, getBudgetWarning,
  resolveFallback, DEFAULT_CONFIG, loadConfig, recordSpending, writeJsonSafe,
} from '../orchestrator/hive-config.js';
import type { HiveConfig, SubTask } from '../orchestrator/types.js';

describe('hive-config (extended)', () => {
  describe('deepMerge', () => {
    it('merges flat objects', () => {
      const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
      expect(result).toEqual({ a: 1, b: 3, c: 4 });
    });

    it('deep merges nested objects', () => {
      const result = deepMerge(
        { nested: { a: 1, b: 2 } },
        { nested: { b: 3, c: 4 } },
      );
      expect(result).toEqual({ nested: { a: 1, b: 3, c: 4 } });
    });

    it('overwrites arrays (no array merge)', () => {
      const result = deepMerge({ arr: [1, 2] }, { arr: [3] });
      expect(result).toEqual({ arr: [3] });
    });

    it('handles three sources', () => {
      const result = deepMerge({ a: 1 }, { b: 2 }, { c: 3 });
      expect(result).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('skips undefined values', () => {
      const result = deepMerge({ a: 1 }, { a: undefined, b: 2 });
      expect(result).toEqual({ a: 1, b: 2 });
    });
  });

  describe('DEFAULT_CONFIG', () => {
    it('has all required fields', () => {
      expect(DEFAULT_CONFIG.orchestrator).toBeDefined();
      expect(DEFAULT_CONFIG.budget).toBeDefined();
      expect(DEFAULT_CONFIG.tiers).toBeDefined();
    });

    it('budget defaults are sensible', () => {
      expect(DEFAULT_CONFIG.budget.monthly_limit_usd).toBe(100);
      expect(DEFAULT_CONFIG.budget.block).toBe(false);
    });

    it('forces Claude family into the default blacklist', () => {
      expect(DEFAULT_CONFIG.model_blacklist).toContain('claude-*');
    });
  });

  describe('getBudgetWarning', () => {
    function makeConfig(overrides: Partial<HiveConfig['budget']> = {}): HiveConfig {
      return {
        ...DEFAULT_CONFIG,
        budget: { ...DEFAULT_CONFIG.budget, ...overrides },
      };
    }

    it('returns null when budget is healthy', () => {
      expect(getBudgetWarning(makeConfig())).toBeNull();
    });

    it('warns when near limit', () => {
      const warning = getBudgetWarning(makeConfig({ current_spent_usd: 85 }));
      expect(warning).toContain('Budget warning');
      expect(warning).toContain('15');
    });

    it('blocks when exhausted with block=true', () => {
      const warning = getBudgetWarning(makeConfig({
        current_spent_usd: 100, block: true,
      }));
      expect(warning).toContain('BLOCKED');
    });

    it('returns null when limit is 0', () => {
      expect(getBudgetWarning(makeConfig({ monthly_limit_usd: 0 }))).toBeNull();
    });

    it('records runtime spending outside ~/.hive/config.json', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-budget-state-'));
      const oldHome = process.env.HOME;
      const oldUser = process.env.USER;
      const oldLogname = process.env.LOGNAME;
      process.env.HOME = tmpHome;
      delete process.env.USER;
      delete process.env.LOGNAME;

      try {
        const configPath = path.join(tmpHome, '.hive', 'config.json');
        writeJsonSafe(configPath, {
          budget: {
            ...DEFAULT_CONFIG.budget,
            current_spent_usd: 1.25,
            last_reset: new Date().toISOString(),
            reset_day: 1,
          },
        });
        const before = fs.readFileSync(configPath, 'utf-8');

        const status = recordSpending(tmpHome, 2.5);

        expect(status?.current_spent_usd).toBe(3.75);
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);

        const runtimeState = JSON.parse(fs.readFileSync(path.join(tmpHome, '.hive', 'budget-state.json'), 'utf-8'));
        expect(runtimeState.current_spent_usd).toBe(3.75);
        expect(loadConfig(tmpHome).budget.current_spent_usd).toBe(3.75);
      } finally {
        if (oldHome === undefined) delete process.env.HOME;
        else process.env.HOME = oldHome;
        if (oldUser === undefined) delete process.env.USER;
        else process.env.USER = oldUser;
        if (oldLogname === undefined) delete process.env.LOGNAME;
        else process.env.LOGNAME = oldLogname;
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });
  });

  describe('resolveFallback', () => {
    const mockRegistry = {
      get: (model: string) => model === 'kimi-k2.5'
        ? { provider: 'xin' }
        : model === 'glm-5-turbo'
        ? { provider: 'bailian' }
        : undefined,
      rankModelsForTask: () => [
        { model: 'glm-5-turbo', final_score: 0.7, blocked_by: [] },
        { model: 'qwen3-max', final_score: 0.6, blocked_by: [] },
      ],
      canResolveForModel: () => true,
    } as any;

    const task: SubTask = {
      id: 'T1', description: 'test', category: 'api', complexity: 'medium',
      estimated_files: [], depends_on: [], assigned_model: 'kimi-k2.5',
      assignment_reason: '', discuss_threshold: 0.7,
    };

    it('picks alternate provider on rate_limit', () => {
      const result = resolveFallback('kimi-k2.5', 'rate_limit', task, DEFAULT_CONFIG, mockRegistry);
      expect(result).toBe('glm-5-turbo'); // different provider than kimi
    });

    it('returns non-claude model on quality_fail', () => {
      const result = resolveFallback('kimi-k2.5', 'quality_fail', task, DEFAULT_CONFIG, mockRegistry);
      // GPT fix: claude models filtered from fallback — picks from ranked list
      expect(result).toBe('glm-5-turbo');
    });

    it('returns fallback_worker when different from failed model', () => {
      const result = resolveFallback('qwen3-max', 'server_error', task, DEFAULT_CONFIG, {
        ...mockRegistry,
        get: (model: string) => model === 'qwen3-max' ? { provider: 'xin' } : { provider: 'bailian' },
        rankModelsForTask: () => [],
      } as any);
      expect(result).toBe('glm-5-turbo');
    });

    it('returns known safe model when fallback_worker is the failed model', () => {
      const result = resolveFallback('glm-5-turbo', 'server_error', task, DEFAULT_CONFIG, {
        ...mockRegistry,
        get: (id: string) => id === 'kimi-for-coding' ? { provider: 'kimi' } : { provider: 'bailian' },
        rankModelsForTask: () => [],
      } as any);
      // GPT fix: claude models blocked — falls through to knownSafe list
      expect(result).toBe('kimi-for-coding');
    });
  });
});
