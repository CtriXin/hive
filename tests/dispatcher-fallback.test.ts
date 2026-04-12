import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  resolveProviderMock,
  safeQueryMock,
  buildSdkEnvMock,
  loadConfigMock,
  resolveFallbackMock,
  ensureStageModelAllowedMock,
  getModelFallbackRoutesMock,
  getRegistryMock,
  updateWorkerStatusMock,
  appendWorkerTranscriptEntryMock,
} = vi.hoisted(() => ({
  resolveProviderMock: vi.fn(),
  safeQueryMock: vi.fn(),
  buildSdkEnvMock: vi.fn(),
  loadConfigMock: vi.fn(),
  resolveFallbackMock: vi.fn(),
  ensureStageModelAllowedMock: vi.fn(),
  getModelFallbackRoutesMock: vi.fn(),
  getRegistryMock: vi.fn(),
  updateWorkerStatusMock: vi.fn(),
  appendWorkerTranscriptEntryMock: vi.fn(),
}));

vi.mock('../orchestrator/provider-resolver.js', () => ({
  resolveProvider: resolveProviderMock,
  quickPing: vi.fn(),
}));

vi.mock('../orchestrator/sdk-query-safe.js', () => ({
  safeQuery: safeQueryMock,
}));

vi.mock('../orchestrator/project-paths.js', () => ({
  buildSdkEnv: buildSdkEnvMock,
}));

vi.mock('../orchestrator/hive-config.js', async () => {
  const actual = await vi.importActual<typeof import('../orchestrator/hive-config.js')>(
    '../orchestrator/hive-config.js',
  );
  return {
    ...actual,
    loadConfig: loadConfigMock,
    resolveFallback: resolveFallbackMock,
    ensureStageModelAllowed: ensureStageModelAllowedMock,
  };
});

vi.mock('../orchestrator/mms-routes-loader.js', () => ({
  getModelFallbackRoutes: getModelFallbackRoutesMock,
}));

vi.mock('../orchestrator/model-registry.js', () => ({
  getRegistry: getRegistryMock,
}));

vi.mock('../orchestrator/context-recycler.js', () => ({
  buildContextPacket: vi.fn(),
  formatContextForWorker: vi.fn(() => ''),
}));

vi.mock('../orchestrator/worktree-manager.js', () => ({
  createWorktree: vi.fn(),
  getWorktreeDiff: vi.fn(async () => ({ files: [] })),
}));

vi.mock('../orchestrator/result-store.js', () => ({
  saveWorkerResult: vi.fn(),
  saveCheckpoint: vi.fn(),
  loadCheckpoint: vi.fn(),
  loadWorkerResult: vi.fn(),
}));

vi.mock('../orchestrator/worker-status-store.js', () => ({
  updateWorkerStatus: updateWorkerStatusMock,
  appendWorkerTranscriptEntry: appendWorkerTranscriptEntryMock,
}));

vi.mock('../orchestrator/discuss-bridge.js', () => ({
  triggerDiscussion: vi.fn(),
}));

vi.mock('../orchestrator/agentbus-adapter.js', () => ({
  buildRoomRef: vi.fn(),
}));

vi.mock('../orchestrator/worker-discuss-handler.js', () => ({
  handleDiscussTrigger: vi.fn(),
}));

import { spawnWorker } from '../orchestrator/dispatcher.js';

function makeAssistantMessage(text: string) {
  return {
    type: 'assistant' as const,
    message: { content: [{ type: 'text', text }] },
  };
}

describe('dispatcher runtime fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveProviderMock.mockImplementation((provider: string, model: string) => ({
      baseUrl: `http://${provider}/${model}`,
      apiKey: `key-${provider}-${model}`,
    }));
    buildSdkEnvMock.mockImplementation((model: string, baseUrl?: string, apiKey?: string) => ({
      ANTHROPIC_MODEL: model,
      ANTHROPIC_BASE_URL: baseUrl || '',
      ANTHROPIC_AUTH_TOKEN: apiKey || '',
    }));
    loadConfigMock.mockReturnValue({ fallback_worker: 'glm-5-turbo' });
    ensureStageModelAllowedMock.mockReturnValue(undefined);
    getModelFallbackRoutesMock.mockReturnValue([]);
    getRegistryMock.mockReturnValue({
      get: (modelId: string) => ({ provider: modelId.startsWith('glm') ? 'glm-cn' : 'kimi' }),
      rankModelsForTask: () => [],
    });
    resolveFallbackMock.mockReturnValue('glm-5-turbo');
  });

  it('retries the same model on an alternate MMS channel when SDK returns model-not-found text', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dispatch-fb-'));
    getModelFallbackRoutesMock.mockReturnValue([
      {
        provider_id: 'kimi-alt',
        anthropic_base_url: 'http://alt-kimi',
        api_key: 'alt-key',
        priority: 200,
      },
    ]);
    safeQueryMock
      .mockResolvedValueOnce({
        messages: [
          makeAssistantMessage('API Error: 404 Not found the model kimi-for-coding or Permission denied'),
          { type: 'result', subtype: 'success', is_error: true },
        ],
        exitError: new Error('exited with code 1'),
      })
      .mockResolvedValueOnce({
        messages: [
          makeAssistantMessage('Patched the requested file successfully.'),
          { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
        ],
        exitError: null,
      });

    try {
      const result = await spawnWorker({
        taskId: 'task-a',
        model: 'kimi-for-coding',
        provider: 'kimi',
        prompt: 'Fix the failing worker task.',
        cwd,
        worktree: false,
        contextInputs: [],
        discussThreshold: 0.7,
        maxTurns: 4,
        taskDescription: 'Fix the failing worker task.',
      });

      expect(getModelFallbackRoutesMock).toHaveBeenCalledWith('kimi-for-coding');
      expect(resolveFallbackMock).not.toHaveBeenCalled();
      expect(buildSdkEnvMock.mock.calls[0]).toEqual([
        'kimi-for-coding',
        'http://kimi/kimi-for-coding',
        'key-kimi-kimi-for-coding',
      ]);
      expect(buildSdkEnvMock.mock.calls[1]).toEqual([
        'kimi-for-coding',
        'http://alt-kimi',
        'alt-key',
      ]);
      expect(result.model).toBe('kimi-for-coding');
      expect(result.provider).toBe('kimi-alt');
      expect(result.requested_model).toBe('kimi-for-coding');
      expect(result.requested_provider).toBe('kimi');
      expect(result.provider_fallback_used).toBe(true);
      expect(result.provider_failure_subtype).toBe('server_error');
      expect(result.execution_contract).toBe('implementation');
      expect(result.success).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('preserves provider failure metadata when same-model channel retries still end in API errors', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dispatch-model-fb-'));
    getModelFallbackRoutesMock.mockReturnValue([
      {
        provider_id: 'kimi-alt',
        anthropic_base_url: 'http://alt-kimi',
        api_key: 'alt-key',
        priority: 200,
      },
    ]);
    resolveFallbackMock.mockReturnValue('kimi-k2.5');
    safeQueryMock
      .mockResolvedValueOnce({
        messages: [
          makeAssistantMessage('API Error: 404 Not found the model kimi-for-coding or Permission denied'),
          { type: 'result', subtype: 'success', is_error: true },
        ],
        exitError: new Error('exited with code 1'),
      })
      .mockResolvedValueOnce({
        messages: [
          makeAssistantMessage('API Error: 404 Not found the model kimi-for-coding or Permission denied'),
          { type: 'result', subtype: 'success', is_error: true },
        ],
        exitError: new Error('exited with code 1'),
      });

    try {
      const result = await spawnWorker({
        taskId: 'task-b',
        model: 'kimi-for-coding',
        provider: 'kimi',
        prompt: 'Repair the worker after provider failure.',
        cwd,
        worktree: false,
        contextInputs: [],
        discussThreshold: 0.7,
        maxTurns: 4,
        taskDescription: 'Repair the worker after provider failure.',
      });

      expect(getModelFallbackRoutesMock).toHaveBeenCalledWith('kimi-for-coding');
      expect(resolveFallbackMock).not.toHaveBeenCalled();
      expect(buildSdkEnvMock.mock.calls[2]).toBeUndefined();
      expect(result.model).toBe('kimi-for-coding');
      expect(result.provider).toBe('kimi');
      expect(result.requested_model).toBe('kimi-for-coding');
      expect(result.requested_provider).toBe('kimi');
      expect(result.provider_fallback_used).toBe(false);
      expect(result.provider_failure_subtype).toBe('server_error');
      expect(result.execution_contract).toBe('implementation');
      expect(result.success).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('blocks model fallback when the fallback provider breaker is already open and still persists provider health data', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dispatch-open-breaker-'));
    const providerHealthDir = path.join(cwd, '.ai', 'runs', 'run-open-breaker');
    fs.mkdirSync(providerHealthDir, { recursive: true });
    fs.writeFileSync(path.join(providerHealthDir, 'provider-health.json'), JSON.stringify({
      providers: {
        'glm-cn': {
          breaker: 'open',
          consecutive_failures: 2,
          cycle_failures: 2,
          last_failure_at: Date.now(),
          last_success_at: Date.now() - 1000,
          probe_count: 0,
          last_failure_subtype: 'server_error',
          opened_at: Date.now() - 1000,
        },
      },
      decisions: [],
      updated_at: new Date().toISOString(),
    }, null, 2));

    safeQueryMock.mockRejectedValueOnce(new Error('API Error: 500 upstream provider unavailable'));

    try {
      await expect(spawnWorker({
        taskId: 'task-c',
        model: 'kimi-for-coding',
        provider: 'kimi',
        prompt: 'Retry after breaker opens.',
        cwd,
        worktree: false,
        contextInputs: [],
        discussThreshold: 0.7,
        maxTurns: 4,
        taskDescription: 'Retry after breaker opens.',
        providerHealthDir,
      })).rejects.toThrow('Model fallback blocked');

      const saved = JSON.parse(fs.readFileSync(path.join(providerHealthDir, 'provider-health.json'), 'utf-8'));
      expect(saved.providers.kimi.breaker).toBe('degraded');
      expect(saved.decisions.some((d: any) => d.action === 'block' && d.provider === 'kimi')).toBe(true);
      expect(resolveFallbackMock).toHaveBeenCalled();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
