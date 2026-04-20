import { describe, it, expect } from 'vitest';
import { ModelRegistry } from '../orchestrator/model-registry.js';

describe('model-registry claude filter', () => {
  const registry = new ModelRegistry();

  describe('selectCrossReviewer', () => {
    it('never returns a claude-* model', () => {
      // Try with several worker models to cover different provider paths
      const workerModels = ['glm-5-turbo', 'kimi-for-coding', 'kimi-k2.5', 'qwen3-max'];
      for (const worker of workerModels) {
        const reviewer = registry.selectCrossReviewer(worker);
        expect(reviewer, `cross-reviewer for worker=${worker}`).not.toMatch(/^claude-/);
      }
    });
  });

  describe('auto tier selectors', () => {
    it('planning auto selector falls back to an allowed planner model', () => {
      const model = registry.selectForPlanning();
      expect(model).toBeTruthy();
      expect(model.startsWith('claude-') || registry.canResolveForModel(model)).toBe(true);
    });

    it('arbitration auto selector never returns a claude-* model', () => {
      expect(registry.selectForArbitration()).not.toMatch(/^claude-/);
    });

    it('final review auto selector falls back to an allowed final-review model', () => {
      const model = registry.selectForFinalReview();
      expect(model).toBeTruthy();
      expect(model.startsWith('claude-') || registry.canResolveForModel(model)).toBe(true);
    });

    it('discuss auto partner never returns a claude-* model', () => {
      expect(registry.selectDiscussPartner('glm-5-turbo')).not.toMatch(/^claude-/);
    });

    it('translator auto selector never returns a claude-* model', () => {
      expect(registry.selectTranslator()).not.toMatch(/^claude-/);
    });
  });

  describe('selectA2aLensModels', () => {
    it('never returns claude-* models', () => {
      const workerModels = ['glm-5-turbo', 'kimi-for-coding', 'kimi-k2.5'];
      for (const worker of workerModels) {
        const lensModels = registry.selectA2aLensModels(worker);
        for (const model of lensModels) {
          expect(model, `a2a lens for worker=${worker}`).not.toMatch(/^claude-/);
        }
      }
    });

    it('returns an array even when all domestic lens routes are filtered', () => {
      const models = registry.selectA2aLensModels('glm-5-turbo');
      expect(Array.isArray(models)).toBe(true);
    });

    it('prefers distinct providers', () => {
      const models = registry.selectA2aLensModels('glm-5-turbo');
      if (models.length >= 2) {
        // At least check they're not all the same model
        const unique = new Set(models);
        expect(unique.size).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('domestic model provider resolution', () => {
    it('kimi-k2.5 has a resolvable provider (kimi exists in providers.json)', () => {
      expect(registry.canResolveForModel('kimi-k2.5')).toBe(true);
    });

    it('MiniMax-M2.5 has a resolvable provider (minimax-cn exists in providers.json)', () => {
      expect(registry.canResolveForModel('MiniMax-M2.5')).toBe(true);
    });

    it('unknown model with no provider and no MMS route is not resolvable', () => {
      expect(registry.canResolveForModel('totally-unknown-model-xyz')).toBe(false);
    });

    it('domestic models appear in ranked list without provider_resolution_failed block', () => {
      const ranked = registry.rankModelsForTask({
        role: 'review',
        domains: ['typescript'],
        complexity: 'medium',
        needs_strict_boundary: false,
        needs_fast_turnaround: false,
        is_repair_round: false,
      });
      const kimi = ranked.find((r) => r.model === 'kimi-k2.5');
      const minimax = ranked.find((r) => r.model === 'MiniMax-M2.5');
      // They may be blocked by other filters (e.g. complexity), but NOT by provider_resolution_failed
      expect(kimi?.blocked_by ?? []).not.toContain('provider_resolution_failed');
      expect(minimax?.blocked_by ?? []).not.toContain('provider_resolution_failed');
    });
  });
});
