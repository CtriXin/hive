import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import {
  loadMmsRoutes, resolveModelRoute, resolveModelRouteFull,
  resolveModelByPrefix, getAvailableModelIds, isMmsAvailable, invalidateCache,
  getClaudeCliMode, isClaudeCodeDirectRoute,
} from '../orchestrator/mms-routes-loader.js';

const MOCK_ROUTES = {
  _meta: { generated_at: '2026-03-27', generator: 'test' },
  routes: {
    'gpt-5.4': { anthropic_base_url: 'https://example.com/openai', openai_base_url: 'https://example.com/openai', api_key: 'gpt-direct', provider_id: 'companycrsopenai', priority: 160, role: 'auto' },
    'gpt-5': { anthropic_base_url: 'http://gateway', openai_base_url: 'http://gateway', api_key: 'gpt-gateway', provider_id: 'xin', priority: 145, role: 'auto' },
    'MiniMax-M2': { anthropic_base_url: 'http://a', api_key: 'k1', provider_id: 'minimax-cn', priority: 85, role: 'auto', use_count: 0 },
    'MiniMax-M2.5': { anthropic_base_url: 'http://b', api_key: 'k2', provider_id: 'xin', priority: 125, role: 'auto', use_count: 3 },
    'MiniMax-M2.7': { anthropic_base_url: 'http://c', api_key: 'k3', provider_id: 'xin', priority: 125, role: 'auto', use_count: 12 },
    'kimi-k2.5': { anthropic_base_url: 'http://d', api_key: 'k4', provider_id: 'xin', priority: 125, role: 'auto' },
    'kimi-for-coding': { anthropic_base_url: 'http://e', api_key: 'k5', provider_id: 'xin', priority: 100, role: 'auto' },
    'qwen3-max': { anthropic_base_url: 'http://f', api_key: 'k6', provider_id: 'xin', priority: 125, role: 'auto' },
    'glm-5-turbo': {
      anthropic_base_url: 'http://g',
      api_key: 'k7',
      provider_id: 'xin',
      priority: 110,
      role: 'auto',
      capabilities: ['tool_use', 'bridge_required'],
      cli_modes: { claude: 'bridge' },
      bridge_clis: ['claude', 'codex'],
    },
    'claude-sonnet-4-6': {
      anthropic_base_url: 'http://claude-native',
      api_key: 'k8',
      provider_id: 'xin',
      priority: 200,
      role: 'auto',
      cli_modes: { claude: 'native', codex: 'bridge' },
      capabilities: ['tool_use', 'reasoning'],
    },
  },
};

const MOCK_V1_ROUTES = {
  version: 1,
  generated_at: '2026-04-21T13:38:53.000Z',
  routes: {
    'gpt-5.4': {
      primary: {
        provider_id: 'xin',
        anthropic_base_url: 'http://82.156.121.141:4001',
        openai_base_url: 'http://82.156.121.141:4001/openai',
        api_key: 'sk-xin',
      },
      fallbacks: [
        {
          provider_id: 'companycrsopenai',
          anthropic_base_url: 'https://relay.example.com',
          openai_base_url: 'https://relay.example.com/openai',
          api_key: 'sk-crs',
        },
      ],
    },
    'kimi-for-coding': {
      primary: {
        provider_id: 'tokyo',
        anthropic_base_url: 'https://kimi.example.com/anthropic',
        openai_base_url: 'https://kimi.example.com/openai',
        api_key: 'sk-kimi',
      },
    },
    'qwen3-max': {
      primary: {
        provider_id: 'qwen',
        anthropic_base_url: 'https://qwen.example.com/anthropic',
        openai_base_url: 'https://qwen.example.com/openai',
        api_key: 'sk-qwen',
      },
    },
  },
};

// Mock file system
let mockFileContent: string | null = null;

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      statSync: vi.fn((p: string) => {
        if (mockFileContent !== null) return { mtimeMs: 12345 };
        throw new Error('ENOENT');
      }),
      readFileSync: vi.fn((_p: string, _enc: string) => {
        if (mockFileContent !== null) return mockFileContent;
        throw new Error('ENOENT');
      }),
    },
  };
});

describe('mms-routes-loader', () => {
  beforeEach(() => {
    invalidateCache();
    process.env.MMS_ROUTES_PATH = '/tmp/test-routes.json';
    mockFileContent = JSON.stringify(MOCK_ROUTES);
  });

  afterEach(() => {
    delete process.env.MMS_ROUTES_PATH;
    mockFileContent = null;
  });

  describe('loadMmsRoutes', () => {
    it('loads and parses routes table', () => {
      const table = loadMmsRoutes();
      expect(table).not.toBeNull();
      expect(Object.keys(table!.routes)).toHaveLength(10);
    });

    it('returns null when file not found', () => {
      mockFileContent = null;
      const table = loadMmsRoutes();
      expect(table).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      mockFileContent = '{ invalid json }}}';
      const table = loadMmsRoutes();
      expect(table).toBeNull();
    });

    it('normalizes the new MMS v1 primary/fallback contract', () => {
      mockFileContent = JSON.stringify(MOCK_V1_ROUTES);
      const table = loadMmsRoutes();
      expect(table).not.toBeNull();
      expect(table!._meta?.generated_at).toBe('2026-04-21T13:38:53.000Z');
      expect(table!.routes['gpt-5.4'].provider_id).toBe('xin');
      expect(table!.routes['gpt-5.4'].openai_base_url).toBe('http://82.156.121.141:4001/openai');
      expect(table!.routes['gpt-5.4'].fallback_routes?.[0]?.provider_id).toBe('companycrsopenai');
      expect(table!.routes['gpt-5.4'].role).toBe('primary');
      expect(table!.routes['gpt-5.4'].fallback_routes?.[0]?.role).toBe('fallback');
    });
  });

  describe('resolveModelRoute', () => {
    it('exact match', () => {
      const route = resolveModelRoute('kimi-k2.5');
      expect(route).not.toBeNull();
      expect(route!.provider_id).toBe('xin');
    });

    it('normalizes OpenAI-only gpt route to an Anthropic-compatible gateway route', () => {
      const route = resolveModelRoute('gpt-5.4');
      expect(route).not.toBeNull();
      expect(route!.anthropic_base_url).toBe('http://gateway');
      expect(route!.api_key).toBe('gpt-gateway');
      expect(route!.provider_id).toBe('xin');
    });

    it('case-insensitive match', () => {
      const route = resolveModelRoute('KIMI-K2.5');
      expect(route).not.toBeNull();
      expect(route!.anthropic_base_url).toBe('http://d');
    });

    it('prefix fallback — minimax resolves to M2.7 (highest version at same priority)', () => {
      const route = resolveModelRoute('MiniMax');
      expect(route).not.toBeNull();
      expect(route!.anthropic_base_url).toBe('http://c'); // M2.7
    });

    it('returns null for unknown model', () => {
      expect(resolveModelRoute('unknown-model')).toBeNull();
    });
  });

  describe('resolveModelRouteFull', () => {
    it('returns resolved modelId for prefix match', () => {
      const result = resolveModelRouteFull('minimax');
      expect(result).not.toBeNull();
      expect(result!.modelId).toBe('MiniMax-M2.7');
    });

    it('returns exact modelId for exact match', () => {
      const result = resolveModelRouteFull('kimi-k2.5');
      expect(result!.modelId).toBe('kimi-k2.5');
    });

    it('keeps original modelId while normalizing the route transport', () => {
      const result = resolveModelRouteFull('gpt-5.4');
      expect(result).not.toBeNull();
      expect(result!.modelId).toBe('gpt-5.4');
      expect(result!.route.anthropic_base_url).toBe('http://gateway');
    });
  });

  describe('resolveModelByPrefix', () => {
    it('picks highest priority within prefix group', () => {
      // 'MiniMax-M2' is an exact key → exact match returns it directly
      const exact = resolveModelByPrefix('MiniMax-M2');
      expect(exact).not.toBeNull();
      expect(exact!.modelId).toBe('MiniMax-M2');

      // Pure prefix 'MiniMax' picks M2.7 (highest version at priority 125)
      const prefix = resolveModelByPrefix('MiniMax');
      expect(prefix).not.toBeNull();
      expect(prefix!.modelId).toBe('MiniMax-M2.7');
    });

    it('kimi prefix follows hive-discuss shorthand alias', () => {
      const result = resolveModelByPrefix('kimi');
      expect(result).not.toBeNull();
      expect(result!.modelId).toBe('kimi-for-coding');
      expect(result!.route.priority).toBe(100);
    });

    it('returns null for no match', () => {
      expect(resolveModelByPrefix('nonexistent')).toBeNull();
    });

    it('fuzzy matching still works against the new MMS v1 contract', () => {
      mockFileContent = JSON.stringify(MOCK_V1_ROUTES);
      const result = resolveModelByPrefix('qwen');
      expect(result).not.toBeNull();
      expect(result!.modelId).toBe('qwen3-max');
      expect(result!.route.provider_id).toBe('qwen');
    });
  });

  describe('getAvailableModelIds', () => {
    it('returns all model IDs sorted by priority desc', () => {
      const ids = getAvailableModelIds();
      expect(ids.length).toBe(10);
      // priority 125 models should come before 85/100
      const lastTwoIds = ids.slice(-2);
      expect(lastTwoIds).toContain('MiniMax-M2');
    });
  });

  describe('Claude transport metadata', () => {
    it('marks bridge-required routes as not direct-compatible for Claude Code SDK', () => {
      const route = resolveModelRoute('glm-5-turbo');
      expect(route).not.toBeNull();
      expect(getClaudeCliMode(route!)).toBe('bridge');
      expect(isClaudeCodeDirectRoute(route!)).toBe(false);
    });

    it('keeps legacy routes direct-compatible when no bridge metadata is present', () => {
      const route = resolveModelRoute('kimi-for-coding');
      expect(route).not.toBeNull();
      expect(getClaudeCliMode(route!)).toBe('direct');
      expect(isClaudeCodeDirectRoute(route!)).toBe(true);
    });

    it('treats native Claude routes as direct-compatible for Claude Code SDK', () => {
      const route = resolveModelRoute('claude-sonnet-4-6');
      expect(route).not.toBeNull();
      expect(getClaudeCliMode(route!)).toBe('native');
      expect(isClaudeCodeDirectRoute(route!)).toBe(true);
    });
  });

  describe('isMmsAvailable', () => {
    it('returns true when routes file exists', () => {
      expect(isMmsAvailable()).toBe(true);
    });

    it('returns false when routes file missing', () => {
      mockFileContent = null;
      invalidateCache();
      expect(isMmsAvailable()).toBe(false);
    });
  });
});
