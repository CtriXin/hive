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
let mockHiveConfig: any = null;
vi.mock('../orchestrator/hive-config.js', () => ({
  loadConfig: () => mockHiveConfig,
  resolveTierModel: (m: string, fn: () => string) => m === 'auto' ? fn() : m,
}));

// Mock project-paths
vi.mock('../orchestrator/project-paths.js', () => ({
  resolveProjectPath: (...parts: string[]) => '/mock/project/' + parts.join('/'),
}));

// Mock mms-routes-loader
let mockResolvedRoute: any = null;
let mockMmsRoutesTable: any = null;
let mockMmsChannels: any[] = [];
vi.mock('../orchestrator/mms-routes-loader.js', () => ({
  resolveModelRouteFullWithBlacklist: (_modelId: string) => mockResolvedRoute,
  loadMmsRoutes: () => mockMmsRoutesTable,
  listMmsChannels: () => mockMmsChannels,
  isClaudeCodeDirectRoute: (route: any) => !(route?.cli_modes?.claude === 'bridge' || route?.capabilities?.includes?.('bridge_required')),
  invalidateCache: () => {},
}));

import {
  quickPing,
  resolveProvider, resolveProviderForModel, reloadProviders,
} from '../orchestrator/provider-resolver.js';

describe('provider-resolver', () => {
  beforeEach(() => {
    mockHiveConfig = {
      orchestrator: 'claude-opus',
      high_tier: 'claude-opus',
      review_tier: 'claude-sonnet',
      default_worker: 'kimi-k2.5',
      fallback_worker: 'glm-5-turbo',
      overrides: {},
      budget: { monthly_limit_usd: 100, warn_at: 0.2, block: false, current_spent_usd: 0, reset_day: 1 },
      host: 'claude-code',
      model_channel_map: {},
      tiers: {
        translator: { model: 'auto' },
        planner: { model: 'auto' },
        discuss: { model: 'auto', mode: 'auto' },
        executor: { model: 'auto' },
        reviewer: { cross_review: { model: 'auto' }, arbitration: { model: 'auto' }, final_review: { model: 'auto' } },
        reporter: { model: 'auto' },
      },
    };
    mockResolvedRoute = null;
    mockMmsRoutesTable = null;
    mockMmsChannels = [];
    reloadProviders();
  });

  afterEach(() => {
    reloadProviders();
  });

  describe('resolveProvider — Level 1: MMS routes', () => {
    it('returns MMS route when modelId provided and route exists', () => {
      mockResolvedRoute = {
        modelId: 'kimi-k2.5',
        route: { anthropic_base_url: 'http://mms-url/anthropic', api_key: 'mms-key', provider_id: 'xin' },
      };
      const result = resolveProvider('xin', 'kimi-k2.5');
      expect(result.baseUrl).toBe('http://mms-url/anthropic');
      expect(result.apiKey).toBe('mms-key');
      expect(result.source).toBe('mms');
      expect(result.routeMode).toBe('direct');
      expect(result.providerId).toBe('xin');
    });

    it('keeps explicit direct anthropic MMS routes for glm workers', () => {
      mockResolvedRoute = {
        modelId: 'glm-5-turbo',
        route: { anthropic_base_url: 'http://127.0.0.1:4001/anthropic', api_key: 'mms-key', provider_id: 'glm-cn' },
      };
      const result = resolveProvider('glm-cn', 'glm-5-turbo');
      expect(result.baseUrl).toBe('http://127.0.0.1:4001/anthropic');
      expect(result.routeMode).toBe('direct');
      expect(result.providerId).toBe('glm-cn');
    });

    it('respects explicit provider pin by selecting matching fallback route', () => {
      mockResolvedRoute = {
        modelId: 'gpt-5.4',
        route: {
          anthropic_base_url: 'http://82.156.121.141:4001',
          api_key: 'primary-key',
          provider_id: 'xin',
          fallback_routes: [
            { anthropic_base_url: 'https://crs.adsconflux.xyz/openai', api_key: 'fallback-key', provider_id: 'companycrsopenai' },
          ],
        },
      };
      const result = resolveProvider('companycrsopenai', 'gpt-5.4');
      expect(result.baseUrl).toBe('https://crs.adsconflux.xyz/openai');
      expect(result.apiKey).toBe('fallback-key');
      expect(result.source).toBe('mms');
      expect(result.providerId).toBe('companycrsopenai');
    });

    it('treats generic openai provider pins as auto selection for gateway models', () => {
      mockHiveConfig.model_channel_map = { 'gpt-5.4': 'uscrsopenai' };
      mockResolvedRoute = {
        modelId: 'gpt-5.4',
        route: {
          anthropic_base_url: 'http://82.156.121.141:4001',
          api_key: 'primary-key',
          provider_id: 'xin',
          fallback_routes: [
            { anthropic_base_url: 'http://127.0.0.1:19300/openai', api_key: 'bridge-key', provider_id: 'uscrsopenai' },
          ],
        },
      };
      mockMmsRoutesTable = {
        routes: {
          'gpt-5.4': mockResolvedRoute.route,
        },
      };
      const result = resolveProvider('openai', 'gpt-5.4');
      expect(result.baseUrl).toBe('http://127.0.0.1:19300/openai');
      expect(result.apiKey).toBe('bridge-key');
      expect(result.providerId).toBe('uscrsopenai');
    });

    it('respects configured model_channel_map when no explicit provider is passed', () => {
      mockHiveConfig.model_channel_map = { 'gpt-5.4': 'cpa' };
      mockResolvedRoute = {
        modelId: 'gpt-5.4',
        route: {
          anthropic_base_url: 'http://82.156.121.141:4001',
          api_key: 'primary-key',
          provider_id: 'xin',
          fallback_routes: [
            { anthropic_base_url: 'http://127.0.0.1:18317/v1', api_key: 'cpa-key', provider_id: 'us-cpa-local-codex' },
          ],
        },
      };
      mockMmsRoutesTable = {
        routes: {
          'gpt-5.4': mockResolvedRoute.route,
        },
      };
      const result = resolveProvider('', 'gpt-5.4');
      expect(result.baseUrl).toBe('http://127.0.0.1:18317/v1');
      expect(result.apiKey).toBe('cpa-key');
      expect(result.providerId).toBe('us-cpa-local-codex');
    });

    it('falls through to Level 2 when no MMS route', () => {
      mockResolvedRoute = null;
      // Level 2 will throw because providers.json is mocked to not exist
      expect(() => resolveProvider('unknown-provider', 'some-model')).toThrow();
    });

    it('falls through to Level 2 when explicit provider pin is not in MMS route set', () => {
      mockResolvedRoute = {
        modelId: 'gpt-5.4',
        route: {
          anthropic_base_url: 'http://82.156.121.141:4001',
          api_key: 'primary-key',
          provider_id: 'xin',
          fallback_routes: [
            { anthropic_base_url: 'https://crs.adsconflux.xyz/openai', api_key: 'fallback-key', provider_id: 'companycrsopenai' },
          ],
        },
      };
      expect(() => resolveProvider('missing-provider', 'gpt-5.4')).toThrow(/not available for model|providers\.json|Unknown provider/);
    });

    it('rejects bridge-required MMS routes for Claude Code direct transport', () => {
      mockResolvedRoute = {
        modelId: 'glm-5-turbo',
        route: {
          anthropic_base_url: 'http://bridge-only',
          api_key: 'bridge-key',
          provider_id: 'xin',
          capabilities: ['bridge_required'],
          cli_modes: { claude: 'bridge' },
        },
      };
      expect(() => resolveProvider('xin', 'glm-5-turbo')).toThrow(/requires bridge transport/);
    });
  });

  describe('resolveProviderForModel', () => {
    it('returns MMS route for known model', () => {
      mockResolvedRoute = {
        modelId: 'kimi-k2.5',
        route: { anthropic_base_url: 'http://route-url/anthropic', api_key: 'route-key', provider_id: 'kimi' },
      };
      const result = resolveProviderForModel('kimi-k2.5');
      expect(result.baseUrl).toBe('http://route-url/anthropic');
      expect(result.apiKey).toBe('route-key');
      expect(result.source).toBe('mms');
      expect(result.routeMode).toBe('direct');
      expect(result.providerId).toBe('kimi');
    });

    it('throws for unknown model without MMS route', () => {
      mockResolvedRoute = null;
      expect(() => resolveProviderForModel('unknown-model')).toThrow(/No MMS route/);
    });

    it('throws for bridge-required model routes', () => {
      mockResolvedRoute = {
        modelId: 'glm-5-turbo',
        route: {
          anthropic_base_url: 'http://bridge-only',
          api_key: 'bridge-key',
          provider_id: 'xin',
          capabilities: ['bridge_required'],
          cli_modes: { claude: 'bridge' },
        },
      };
      expect(() => resolveProviderForModel('glm-5-turbo')).toThrow(/requires bridge transport/);
    });
  });

  describe('quickPing', () => {
    it('pings OpenAI-style gateway family routes via /chat/completions', async () => {
      mockResolvedRoute = {
        modelId: 'gpt-5.4',
        route: {
          anthropic_base_url: 'http://127.0.0.1:19300/openai',
          api_key: 'bridge-key',
          provider_id: 'uscrsopenai',
        },
      };
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        status: 200,
        ok: true,
      } as any);

      const result = await quickPing('gpt-5.4', 1000);

      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:19300/openai/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer bridge-key',
            'x-api-key': 'bridge-key',
          }),
        }),
      );

      fetchMock.mockRestore();
    });
  });
});
