import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  loadConfigMock,
  getConfigSourceMock,
  resolveProviderForModelMock,
  quickPingMock,
  buildSdkEnvMock,
  safeQueryMock,
  extractTextFromMessagesMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  getConfigSourceMock: vi.fn(),
  resolveProviderForModelMock: vi.fn(),
  quickPingMock: vi.fn(),
  buildSdkEnvMock: vi.fn(),
  safeQueryMock: vi.fn(),
  extractTextFromMessagesMock: vi.fn(),
}));

vi.mock('../orchestrator/hive-config.js', () => ({
  loadConfig: loadConfigMock,
  getConfigSource: getConfigSourceMock,
  resolveTierModel: (tierModel: string, autoFn: () => string) => (tierModel === 'auto' ? autoFn() : tierModel),
  matchModelBlacklistPattern: (config: { model_blacklist?: string[] }, modelId: string) => {
    for (const pattern of config.model_blacklist || []) {
      const regex = new RegExp(`^${pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
      if (regex.test(modelId)) return pattern;
    }
    return null;
  },
}));

vi.mock('../orchestrator/model-registry.js', () => ({
  ModelRegistry: class {
    selectTranslator() { return 'translator-model'; }
    selectForPlanning() { return 'gpt-5.4'; }
    assignModel() { return 'executor-model'; }
    selectDiscussPartner() { return 'discuss-model'; }
    selectReviewer() { return 'reviewer-model'; }
    selectForArbitration() { return 'arb-model'; }
    selectForFinalReview() { return 'claude-sonnet-4-6'; }
    selectForReporter() { return 'reporter-model'; }
  },
}));

vi.mock('../orchestrator/model-channel-policy.js', () => {
  const escapeRegex = (pattern: string) => pattern.replace(/[|\\{}()[\]^$+?.*]/g, '\\$&');
  const matchModelChannelMapEntry = (modelChannelMap: Record<string, string> | undefined, modelId: string) => {
    const entries = Object.entries(modelChannelMap || {});
    for (const [pattern, selector] of entries) {
      const regex = new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, '.*')}$`, 'i');
      if (regex.test(modelId)) return { pattern, selector };
    }
    return null;
  };
  return {
    matchModelChannelMapEntry,
    resolveConfiguredChannelProvider: (modelChannelMap: Record<string, string> | undefined, modelId: string) => {
      const match = matchModelChannelMapEntry(modelChannelMap, modelId);
      if (!match) return null;
      if (match.selector === 'missing-route') {
        return { ...match, status: 'missing', candidates: ['fallback-a', 'fallback-b'] };
      }
      return {
        ...match,
        status: 'resolved',
        provider_id: `${match.selector}-provider`,
        matched_by: 'provider_id',
        option: { provider_id: `${match.selector}-provider` },
      };
    },
  };
});

vi.mock('../orchestrator/provider-resolver.js', () => ({
  resolveProviderForModel: resolveProviderForModelMock,
  quickPing: quickPingMock,
}));

vi.mock('../orchestrator/project-paths.js', () => ({
  buildSdkEnv: buildSdkEnvMock,
}));

vi.mock('../orchestrator/sdk-query-safe.js', () => ({
  safeQuery: safeQueryMock,
  extractTextFromMessages: extractTextFromMessagesMock,
}));

import {
  buildConfigPreflightReport,
  renderConfigPreflightReport,
} from '../orchestrator/config-preflight.js';

describe('config-preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfigSourceMock.mockReturnValue({
      global: '/Users/test/.hive/config.json',
      local: '/repo/.hive/config.json',
    });
    loadConfigMock.mockReturnValue({
      model_channel_map: {
        'gpt-*': 'cpa',
        'executor-model': 'tokyo',
        'orphan-model': 'missing-route',
      },
      model_blacklist: ['claude-*'],
      tiers: {
        translator: { model: 'auto' },
        planner: { model: 'auto' },
        executor: { model: 'auto' },
        discuss: { model: 'auto', mode: 'auto' },
        reviewer: {
          cross_review: { model: 'auto' },
          arbitration: { model: 'auto' },
          final_review: { model: 'auto' },
        },
        reporter: { model: 'auto' },
      },
    });
    resolveProviderForModelMock.mockImplementation((modelId: string) => {
      if (modelId === 'orphan-model') {
        throw new Error('model_channel_map "orphan-model" -> "missing-route" does not match any MMS channel');
      }
      return {
        baseUrl: `http://route/${modelId}`,
        apiKey: `key-${modelId}`,
        providerId: `provider-${modelId}`,
        source: 'mms',
      };
    });
    quickPingMock.mockImplementation(async (modelId: string, _timeout: number, providerId?: string) => ({
      ok: true,
      ms: modelId.length * 10,
      error: providerId ? undefined : undefined,
    }));
    buildSdkEnvMock.mockImplementation((modelId: string, baseUrl: string, apiKey: string) => ({
      MODEL: modelId,
      BASE: baseUrl,
      KEY: apiKey,
    }));
    safeQueryMock.mockResolvedValue({ messages: [{ type: 'assistant' }], exitError: null });
    extractTextFromMessagesMock.mockReturnValue('OK');
  });

  it('builds model rows from actual tier models instead of wildcard patterns or auto markers', async () => {
    const report = await buildConfigPreflightReport('/repo');

    expect(report.models.map((row) => row.model_id)).toContain('gpt-5.4');
    expect(report.models.map((row) => row.model_id)).not.toContain('gpt-*');
    expect(report.models.map((row) => row.model_id)).not.toContain('auto');

    const planner = report.models.find((row) => row.model_id === 'gpt-5.4');
    expect(planner?.tiers).toContain('planner');
    expect(planner?.channel_selector).toBe('cpa');
    expect(planner?.policy_pattern).toBe('gpt-*');
  });

  it('skips blacklisted models and reports wildcard matches plus policy-only failures', async () => {
    const report = await buildConfigPreflightReport('/repo');

    expect(report.skipped_blacklisted_models).toContain('claude-sonnet-4-6 [claude-*]');

    const wildcard = report.wildcard_rules.find((rule) => rule.pattern === 'gpt-*');
    expect(wildcard?.matched_models).toEqual(['gpt-5.4']);

    const orphan = report.models.find((row) => row.model_id === 'orphan-model');
    expect(orphan?.tiers).toEqual(['policy-only']);
    expect(orphan?.resolution_error).toContain('missing-route');
  });

  it('runs runtime smoke for planner and executor only when route checks passed', async () => {
    const report = await buildConfigPreflightReport('/repo');

    expect(report.probes.map((item) => item.stage)).toEqual(['planner', 'executor']);
    expect(buildSdkEnvMock).toHaveBeenCalledWith('gpt-5.4', 'http://route/gpt-5.4', 'key-gpt-5.4');
    expect(buildSdkEnvMock).toHaveBeenCalledWith('executor-model', 'http://route/executor-model', 'key-executor-model');
    expect(safeQueryMock).toHaveBeenCalledTimes(2);
  });

  it('renders a readable summary with route and runtime sections', async () => {
    const report = await buildConfigPreflightReport('/repo');
    const text = renderConfigPreflightReport(report);

    expect(text).toContain('== Hive Config Test ==');
    expect(text).toContain('== Tier / Model Route ==');
    expect(text).toContain('gpt-5.4 | tiers=planner');
    expect(text).toContain('channel=cpa (gpt-*) [resolved]');
    expect(text).toContain('orphan-model | tiers=policy-only');
    expect(text).toContain('== Runtime Smoke ==');
    expect(text).toContain('planner -> gpt-5.4');
    expect(text).toContain('route fail models: orphan-model');
  });
});
