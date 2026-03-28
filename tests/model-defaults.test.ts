import { describe, it, expect } from 'vitest';
import {
  normalizeModelId, titleCaseModelId, inferMaxComplexity, guessProviderFamily,
} from '../orchestrator/model-defaults.js';

describe('model-defaults', () => {
  describe('normalizeModelId', () => {
    it('resolves known aliases', () => {
      expect(normalizeModelId('kimi-coding')).toBe('kimi-for-coding');
      expect(normalizeModelId('glm5-turbo')).toBe('glm-5-turbo');
      expect(normalizeModelId('qwen3.5')).toBe('qwen-3.5');
    });

    it('passes through unknown IDs', () => {
      expect(normalizeModelId('custom-model')).toBe('custom-model');
    });
  });

  describe('titleCaseModelId', () => {
    it('title cases hyphenated IDs', () => {
      expect(titleCaseModelId('kimi-k2.5')).toBe('Kimi K2.5');
      expect(titleCaseModelId('glm-5-turbo')).toBe('Glm 5 Turbo');
    });
  });

  describe('inferMaxComplexity', () => {
    it('high for top-tier scores', () => {
      const model = { provider: 'x', strengths: [], scores: { general: 0.9, coding: 0.95, planning: 0.9, review: 0.9, translation: 0.8 }, context_window: 128000, cost_per_1k: 0.01 };
      expect(inferMaxComplexity(model)).toBe('high');
    });

    it('low for weak scores', () => {
      const model = { provider: 'x', strengths: [], scores: { general: 0.5, coding: 0.5, planning: 0.5, review: 0.5, translation: 0.5 }, context_window: 32000, cost_per_1k: 0.005 };
      expect(inferMaxComplexity(model)).toBe('low');
    });

    it('medium for mid-range coding', () => {
      const model = { provider: 'x', strengths: [], scores: { general: 0.7, coding: 0.82, planning: 0.7, review: 0.7, translation: 0.7 }, context_window: 64000, cost_per_1k: 0.003 };
      expect(inferMaxComplexity(model)).toBe('medium');
    });
  });

  describe('guessProviderFamily', () => {
    it('detects Claude family', () => {
      const result = guessProviderFamily('claude-opus-4-6', 'anthropic');
      expect(result.scores.coding).toBeGreaterThanOrEqual(0.88);
      expect(result.strengths).toContain('planning');
    });

    it('detects Kimi family', () => {
      const result = guessProviderFamily('kimi-k2.5', 'xin');
      expect(result.scores.coding).toBe(0.88);
      expect(result.strengths).toContain('coding');
    });

    it('detects kimi-for-coding family', () => {
      const result = guessProviderFamily('kimi-for-coding', 'kimi');
      expect(result.scores.coding).toBe(0.90);
      expect(result.strengths).toContain('coding');
    });

    it('returns defaults for unknown model', () => {
      const result = guessProviderFamily('custom-unknown', 'custom');
      expect(result.scores.coding).toBe(0.5);
    });
  });
});
