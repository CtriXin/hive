import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';

// Mock fs and dependent modules before importing
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((p: string) => false),
      statSync: vi.fn((p: string) => { throw new Error('ENOENT'); }),
      readFileSync: vi.fn((p: string) => { throw new Error('ENOENT'); }),
    },
  };
});

// Mock hive-config to avoid file system reads
vi.mock('../orchestrator/hive-config.js', () => ({
  loadConfig: () => ({
    orchestrator: 'claude-opus',
    high_tier: 'claude-opus',
    review_tier: 'claude-sonnet',
    default_worker: 'kimi-k2.5',
    fallback_worker: 'glm-5-turbo',
    overrides: {},
    budget: { monthly_limit_usd: 100, warn_at: 0.2, block: false, current_spent_usd: 0, reset_day: 1 },
    host: 'claude-code',
    tiers: {
      translator: { model: 'auto' },
      planner: { model: 'auto' },
      executor: { model: 'auto' },
      reviewer: { cross_review: { model: 'auto' }, arbitration: { model: 'auto' }, final_review: { model: 'auto' } },
      reporter: { model: 'auto' },
    },
  }),
  resolveTierModel: (m: string, fn: () => string) => m === 'auto' ? fn() : m,
}));

// Mock project-paths
vi.mock('../orchestrator/project-paths.js', () => ({
  resolveProjectPath: (...parts: string[]) => '/mock/project/' + parts.join('/'),
}));

// Mock mms-routes-loader
let mockMmsRoute: any = null;
vi.mock('../orchestrator/mms-routes-loader.js', () => ({
  resolveModelRoute: (modelId: string) => mockMmsRoute,
  invalidateCache: () => {},
}));

import {
  resolveProvider, resolveProviderForModel, reloadProviders,
} from '../orchestrator/provider-resolver.js';

describe('provider-resolver', () => {
  beforeEach(() => {
    mockMmsRoute = null;
    reloadProviders();
  });

  afterEach(() => {
    reloadProviders();
  });

  describe('resolveProvider — Level 1: MMS routes', () => {
    it('returns MMS route when modelId provided and route exists', () => {
      mockMmsRoute = { anthropic_base_url: 'http://mms-url', api_key: 'mms-key' };
      const result = resolveProvider('xin', 'kimi-k2.5');
      expect(result.baseUrl).toBe('http://mms-url');
      expect(result.apiKey).toBe('mms-key');
    });

    it('falls through to Level 2 when no MMS route', () => {
      mockMmsRoute = null;
      // Level 2 will throw because providers.json is mocked to not exist
      expect(() => resolveProvider('unknown-provider', 'some-model')).toThrow();
    });
  });

  describe('resolveProviderForModel', () => {
    it('returns MMS route for known model', () => {
      mockMmsRoute = { anthropic_base_url: 'http://route-url', api_key: 'route-key' };
      const result = resolveProviderForModel('kimi-k2.5');
      expect(result.baseUrl).toBe('http://route-url');
      expect(result.apiKey).toBe('route-key');
    });

    it('throws for unknown model without MMS route', () => {
      mockMmsRoute = null;
      expect(() => resolveProviderForModel('unknown-model')).toThrow(/No MMS route/);
    });
  });
});
