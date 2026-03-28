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

    it('returns at least 1 model', () => {
      const models = registry.selectA2aLensModels('glm-5-turbo');
      expect(models.length).toBeGreaterThanOrEqual(1);
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
});
