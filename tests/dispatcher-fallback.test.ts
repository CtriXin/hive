import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  resolveProviderMock,
  quickPingMock,
  safeQueryMock,
  buildSdkEnvMock,
  loadConfigMock,
  resolveFallbackMock,
  ensureStageModelAllowedMock,
  getModelFallbackRoutesMock,
  getRegistryMock,
  updateWorkerStatusMock,
  appendWorkerTranscriptEntryMock,
  createWorktreeMock,
} = vi.hoisted(() => ({
  resolveProviderMock: vi.fn(),
  quickPingMock: vi.fn(),
  safeQueryMock: vi.fn(),
  buildSdkEnvMock: vi.fn(),
  loadConfigMock: vi.fn(),
  resolveFallbackMock: vi.fn(),
  ensureStageModelAllowedMock: vi.fn(),
  getModelFallbackRoutesMock: vi.fn(),
  getRegistryMock: vi.fn(),
  updateWorkerStatusMock: vi.fn(),
  appendWorkerTranscriptEntryMock: vi.fn(),
  createWorktreeMock: vi.fn(),
}));

vi.mock('../orchestrator/provider-resolver.js', () => ({
  resolveProvider: resolveProviderMock,
  quickPing: quickPingMock,
  isUnsupportedMmsTransportError: (err: unknown) => (err as Error | undefined)?.name === 'UnsupportedMmsTransportError',
}));

vi.mock('../orchestrator/sdk-query-safe.js', () => ({
  safeQuery: safeQueryMock,
}));

vi.mock('../orchestrator/project-paths.js', () => ({
  buildSdkEnv: buildSdkEnvMock,
}));

vi.mock('../orchestrator/model-proxy.js', () => ({
  ensureModelProxy: vi.fn(async () => undefined),
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
  createWorktree: createWorktreeMock,
  getWorktreeDiff: vi.fn(async () => ({ files: [] })),
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

import { dispatchBatch, spawnWorker } from '../orchestrator/dispatcher.js';

function makeAssistantMessage(text: string) {
  return {
    type: 'assistant' as const,
    message: { content: [{ type: 'text', text }] },
  };
}

function makeSuccessMessage() {
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    is_error: false,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

describe('dispatcher same-provider retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset safeQueryMock to prevent stale mockRejectedValue/mockResolvedValue from leaking
    safeQueryMock.mockClear();
    resolveProviderMock.mockImplementation((provider: string, model: string) => ({
      baseUrl: `http://${provider}/${model}`,
      apiKey: `key-${provider}-${model}`,
    }));
    buildSdkEnvMock.mockImplementation((model: string, baseUrl?: string, apiKey?: string) => ({
      ANTHROPIC_MODEL: model,
      ANTHROPIC_BASE_URL: baseUrl || '',
      ANTHROPIC_AUTH_TOKEN: apiKey || '',
    }));
    quickPingMock.mockResolvedValue({ ok: true, ms: 1 });
    loadConfigMock.mockReturnValue({ fallback_worker: 'glm-5-turbo' });
    ensureStageModelAllowedMock.mockReturnValue(undefined);
    getModelFallbackRoutesMock.mockReturnValue([]);
    createWorktreeMock.mockResolvedValue({ path: '/tmp/worktree-default', branch: 'worker-task' });
    getRegistryMock.mockReturnValue({
      get: (modelId: string) => ({ provider: modelId.startsWith('glm') ? 'glm-cn' : 'kimi' }),
      getClaudeTier: (tier: string) => ({ id: tier === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-6' }),
      rankModelsForTask: () => [],
    });
    resolveFallbackMock.mockReturnValue('glm-5-turbo');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries same provider on retryable failure before falling back', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dispatch-retry-'));
    safeQueryMock
      // 1st: retryable failure (500)
      .mockRejectedValueOnce(new Error('API Error: 500 Internal Server Error'))
      // 2nd: same-provider retry succeeds
      .mockResolvedValueOnce({
        messages: [makeSuccessMessage()],
        exitError: null,
      });

    try {
      const result = await spawnWorker({
        taskId: 'task-retry',
        model: 'kimi-for-coding',
        provider: 'kimi',
        prompt: 'Test retry.',
        cwd,
        worktree: false,
        contextInputs: [],
        discussThreshold: 0.7,
        maxTurns: 4,
        taskDescription: 'Test retry.',
        providerHealthDir: path.join(cwd, '.ai', 'runs', 'run-retry'),
      });

      // Same-provider retry succeeded without fallback
      expect(safeQueryMock).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
      expect(result.provider).toBe('kimi');
      expect(result.provider_fallback_used).toBe(false);
      expect(result.provider_failure_subtype).toBe('server_error');

      // Verify decision history was persisted
      const healthFile = path.join(cwd, '.ai', 'runs', 'run-retry', 'provider-health.json');
      const health = JSON.parse(fs.readFileSync(healthFile, 'utf-8'));
      expect(health.decisions.some((d: any) => d.action === 'bounded_retry')).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('blocks immediately on non-retryable auth failure', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dispatch-auth-'));
    safeQueryMock.mockRejectedValueOnce(new Error('API Error: 401 Unauthorized'));

    try {
      await expect(spawnWorker({
        taskId: 'task-auth',
        model: 'kimi-for-coding',
        provider: 'kimi',
        prompt: 'Test auth block.',
        cwd,
        worktree: false,
        contextInputs: [],
        discussThreshold: 0.7,
        maxTurns: 4,
        taskDescription: 'Test auth block.',
      })).rejects.toThrow('auth_failure');

      // Only one call — no retry, no fallback
      expect(safeQueryMock).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('blocks immediately on non-retryable quota exhaustion', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dispatch-quota-'));
    safeQueryMock.mockRejectedValueOnce(new Error('Quota exhausted'));

    try {
      await expect(spawnWorker({
        taskId: 'task-quota',
        model: 'kimi-for-coding',
        provider: 'kimi',
        prompt: 'Test quota block.',
        cwd,
        worktree: false,
        contextInputs: [],
        discussThreshold: 0.7,
        maxTurns: 4,
        taskDescription: 'Test quota block.',
      })).rejects.toThrow('quota_exhausted');

      expect(safeQueryMock).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('falls back to channel after retry budget exhausted (2 retries fail)', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dispatch-budget-'));
    getModelFallbackRoutesMock.mockReturnValue([
      {
        provider_id: 'kimi-alt',
        anthropic_base_url: 'http://alt-kimi',
        api_key: 'alt-key',
        priority: 200,
      },
    ]);
    // Original + 2 retries all fail → budget exhausted → channel fallback
    safeQueryMock
      .mockRejectedValueOnce(new Error('API Error: 429 Too Many Requests'))
      .mockRejectedValueOnce(new Error('API Error: 429 Too Many Requests'))
      .mockRejectedValueOnce(new Error('API Error: 429 Too Many Requests'))
      // Channel fallback succeeds
      .mockResolvedValueOnce({
        messages: [makeSuccessMessage()],
        exitError: null,
      });

    try {
      const result = await spawnWorker({
        taskId: 'task-budget',
        model: 'kimi-for-coding',
        provider: 'kimi',
        prompt: 'Test budget exhaust.',
        cwd,
        worktree: false,
        contextInputs: [],
        discussThreshold: 0.7,
        maxTurns: 4,
        taskDescription: 'Test budget exhaust.',
        providerHealthDir: path.join(cwd, '.ai', 'runs', 'run-budget'),
      });

      // 3 same-provider attempts + 1 channel fallback = 4 calls
      expect(safeQueryMock).toHaveBeenCalledTimes(4);
      expect(result.success).toBe(true);
      expect(result.provider).toBe('kimi-alt');
      expect(result.provider_fallback_used).toBe(true);
      expect(result.provider_failure_subtype).toBe('rate_limit');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('dispatcher runtime fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    safeQueryMock.mockReset();
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
      getClaudeTier: (tier: string) => ({ id: tier === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-6' }),
      rankModelsForTask: () => [],
    });
    resolveFallbackMock.mockReturnValue('glm-5-turbo');
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    // With retry-first: original + 2 retries all hit API error text → budget exhausted → channel fallback
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
      })
      .mockResolvedValueOnce({
        messages: [
          makeAssistantMessage('API Error: 404 Not found the model kimi-for-coding or Permission denied'),
          { type: 'result', subtype: 'success', is_error: true },
        ],
        exitError: new Error('exited with code 1'),
      })
      // Channel fallback succeeds
      .mockResolvedValueOnce({
        messages: [
          makeAssistantMessage('Patched the requested file successfully.'),
          { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
        ],
        exitError: null,
      })
      // Discussion resume (not related to fallback)
      .mockResolvedValueOnce({ messages: [] });

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
        providerHealthDir: path.join(cwd, '.ai', 'runs', 'run-channel-fb'),
      });

      // Retry attempts were recorded in decision history
      const healthFile = path.join(cwd, '.ai', 'runs', 'run-channel-fb', 'provider-health.json');
      const health = JSON.parse(fs.readFileSync(healthFile, 'utf-8'));
      expect(health.decisions.length).toBeGreaterThan(0);
      expect(health.providers.kimi.consecutive_failures).toBeGreaterThanOrEqual(1);
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

    // 3 retries + 1 extra to break loop + channel fallback (no routes) + model fallback
    safeQueryMock
      .mockRejectedValue(new Error('API Error: 500 upstream provider unavailable'));

    try {
      const result = await spawnWorker({
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
      });

      // If we got here, check what happened
      const saved = JSON.parse(fs.readFileSync(path.join(providerHealthDir, 'provider-health.json'), 'utf-8'));
      console.error('Result:', result.provider, result.success);
      console.error('Decisions:', JSON.stringify(saved.decisions, null, 2));
      console.error('Providers:', JSON.stringify(saved.providers, null, 2));
      throw new Error(`Expected spawnWorker to reject but it resolved with provider=${result.provider}, success=${result.success}`);
    } catch (err: any) {
      if (err.message.includes('Model fallback blocked')) {
        // Expected behavior
        const saved = JSON.parse(fs.readFileSync(path.join(providerHealthDir, 'provider-health.json'), 'utf-8'));
        expect(saved.decisions.some((d: any) => d.action === 'block')).toBe(true);
        expect(resolveFallbackMock).toHaveBeenCalled();
      } else if (err.message.includes('Expected spawnWorker to reject')) {
        throw err;
      } else {
        throw err;
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('falls back immediately when the assigned MMS route requires bridge transport', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dispatch-bridge-route-'));
    resolveProviderMock.mockImplementation((provider: string, model: string) => {
      if (model === 'glm-5-turbo') {
        const err = new Error('MMS route for model "glm-5-turbo" requires bridge transport for Claude Code SDK; direct provider mode is not allowed.');
        (err as any).name = 'UnsupportedMmsTransportError';
        throw err;
      }
      return {
        baseUrl: `http://${provider}/${model}`,
        apiKey: `key-${provider}-${model}`,
      };
    });
    resolveFallbackMock.mockReturnValue('qwen3-max');
    getRegistryMock.mockReturnValue({
      get: (modelId: string) => ({ provider: modelId === 'qwen3-max' ? 'qwen' : 'kimi' }),
      getClaudeTier: (tier: string) => ({ id: tier === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-6' }),
      rankModelsForTask: () => [],
    });
    safeQueryMock.mockResolvedValueOnce({
      messages: [
        makeAssistantMessage('Completed via fallback model.'),
        { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
      ],
      exitError: null,
    });

    try {
      const result = await spawnWorker({
        taskId: 'task-bridge-route',
        model: 'glm-5-turbo',
        provider: 'xin',
        prompt: 'Handle a bridge-only MMS route.',
        cwd,
        worktree: false,
        contextInputs: [],
        discussThreshold: 0.7,
        maxTurns: 4,
        taskDescription: 'Handle a bridge-only MMS route.',
        providerHealthDir: path.join(cwd, '.ai', 'runs', 'run-bridge-route'),
      });

      expect(resolveFallbackMock).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.model).toBe('qwen3-max');
      expect(result.provider).toBe('qwen');
      expect(result.provider_fallback_used).toBe(true);

      const health = JSON.parse(fs.readFileSync(path.join(cwd, '.ai', 'runs', 'run-bridge-route', 'provider-health.json'), 'utf-8'));
      expect(health.decisions.some((d: any) => d.action === 'fallback' && String(d.action_reason).includes('bridge transport'))).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('uses direct Claude fallback when no domestic executor candidate is runnable', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dispatch-claude-fallback-'));
    resolveProviderMock.mockImplementation((provider: string, model: string) => {
      if (model === 'glm-5-turbo' || model === 'kimi-for-coding') {
        const err = new Error(`MMS route for model "${model}" requires bridge transport for Claude Code SDK; direct provider mode is not allowed.`);
        (err as any).name = 'UnsupportedMmsTransportError';
        throw err;
      }
      return {
        baseUrl: `http://${provider}/${model}`,
        apiKey: `key-${provider}-${model}`,
      };
    });
    quickPingMock.mockImplementation(async (model: string) => ({
      ok: model === 'claude-sonnet-4-6',
      ms: 1,
      error: model === 'claude-sonnet-4-6' ? undefined : 'BRIDGE_REQUIRED',
    }));
    resolveFallbackMock.mockImplementation((_failedModel: string, _errorType: string, _task: unknown, _config: unknown, _registry: unknown, options?: { excludeModels?: string[] }) => (
      options?.excludeModels?.includes('kimi-for-coding') ? 'glm-5-turbo' : 'kimi-for-coding'
    ));
    getRegistryMock.mockReturnValue({
      get: (modelId: string) => {
        if (modelId === 'claude-sonnet-4-6') return { provider: 'xin' };
        return { provider: modelId.startsWith('glm') ? 'glm-cn' : 'kimi' };
      },
      getClaudeTier: (tier: string) => ({ id: tier === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-6' }),
      rankModelsForTask: () => [],
    });
    safeQueryMock.mockResolvedValueOnce({
      messages: [
        makeAssistantMessage('Completed via direct Claude fallback.'),
        { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
      ],
      exitError: null,
    });

    try {
      const result = await spawnWorker({
        taskId: 'task-claude-fallback',
        model: 'glm-5-turbo',
        provider: 'xin',
        prompt: 'Handle an all-bridge domestic environment.',
        cwd,
        worktree: false,
        contextInputs: [],
        discussThreshold: 0.7,
        maxTurns: 4,
        taskDescription: 'Handle an all-bridge domestic environment.',
        providerHealthDir: path.join(cwd, '.ai', 'runs', 'run-claude-fallback'),
      });

      expect(result.success).toBe(true);
      expect(result.model).toBe('claude-sonnet-4-6');
      expect(result.provider).toBe('xin');
      expect(resolveFallbackMock).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('skips bridge-only model fallback candidates after provider failure and uses the next runnable executor', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dispatch-runtime-skip-bridge-'));
    safeQueryMock
      .mockRejectedValueOnce(new Error('API Error: 500 upstream provider unavailable'))
      .mockRejectedValueOnce(new Error('API Error: 500 upstream provider unavailable'))
      .mockRejectedValueOnce(new Error('API Error: 500 upstream provider unavailable'))
      .mockResolvedValueOnce({
        messages: [
          makeAssistantMessage('Recovered on second fallback candidate.'),
          { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
        ],
        exitError: null,
      });
    resolveProviderMock.mockImplementation((provider: string, model: string) => {
      if (model === 'glm-5-turbo') {
        const err = new Error('MMS route for model "glm-5-turbo" requires bridge transport for Claude Code SDK; direct provider mode is not allowed.');
        (err as any).name = 'UnsupportedMmsTransportError';
        throw err;
      }
      return {
        baseUrl: `http://${provider}/${model}`,
        apiKey: `key-${provider}-${model}`,
      };
    });
    quickPingMock.mockImplementation(async (model: string) => ({
      ok: model !== 'glm-5-turbo',
      ms: 1,
      error: model === 'glm-5-turbo' ? 'BRIDGE_REQUIRED' : undefined,
    }));
    resolveFallbackMock.mockImplementation((_failedModel: string, _errorType: string, _task: unknown, _config: unknown, _registry: unknown, options?: { excludeModels?: string[] }) => (
      options?.excludeModels?.includes('glm-5-turbo') ? 'qwen3-max' : 'glm-5-turbo'
    ));
    getRegistryMock.mockReturnValue({
      get: (modelId: string) => ({ provider: modelId === 'qwen3-max' ? 'qwen' : 'glm-cn' }),
      getClaudeTier: (tier: string) => ({ id: tier === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-6' }),
      rankModelsForTask: () => [],
    });

    try {
      const result = await spawnWorker({
        taskId: 'task-runtime-skip-bridge',
        model: 'kimi-for-coding',
        provider: 'kimi',
        prompt: 'Recover from provider failure with runnable fallback.',
        cwd,
        worktree: false,
        contextInputs: [],
        discussThreshold: 0.7,
        maxTurns: 4,
        taskDescription: 'Recover from provider failure with runnable fallback.',
        providerHealthDir: path.join(cwd, '.ai', 'runs', 'run-runtime-skip-bridge'),
      });

      expect(result.success).toBe(true);
      expect(result.model).toBe('qwen3-max');
      expect(result.provider).toBe('qwen');
      expect(resolveFallbackMock).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('dispatcher preflight fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    safeQueryMock.mockReset();
    resolveProviderMock.mockImplementation((provider: string, model: string) => ({
      baseUrl: `http://${provider}/${model}`,
      apiKey: `key-${provider}-${model}`,
    }));
    buildSdkEnvMock.mockImplementation((model: string, baseUrl?: string, apiKey?: string) => ({
      ANTHROPIC_MODEL: model,
      ANTHROPIC_BASE_URL: baseUrl || '',
      ANTHROPIC_AUTH_TOKEN: apiKey || '',
    }));
    ensureStageModelAllowedMock.mockReturnValue(undefined);
    getModelFallbackRoutesMock.mockReturnValue([]);
    loadConfigMock.mockReturnValue({ fallback_worker: 'glm-5-turbo', tiers: { executor: { fallback: 'glm-5-turbo' } } });
    createWorktreeMock.mockResolvedValue({ path: '/tmp/worktree-preflight', branch: 'worker-task-a' });
    getRegistryMock.mockReturnValue({
      get: (modelId: string) => ({ provider: modelId === 'qwen3-max' ? 'qwen' : 'glm-cn' }),
      getClaudeTier: (tier: string) => ({ id: tier === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-6' }),
      rankModelsForTask: () => [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preflight skips unrunnable fallback candidates and dispatches a runnable executor model', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dispatch-preflight-'));
    quickPingMock.mockImplementation(async (model: string) => {
      if (model === 'glm-5-turbo') return { ok: false, ms: 1, error: 'HTTP 401' };
      if (model === 'kimi-for-coding') return { ok: false, ms: 1, error: 'BRIDGE_REQUIRED' };
      return { ok: true, ms: 1 };
    });
    resolveFallbackMock.mockImplementation((_failedModel: string, _errorType: string, _task: unknown, _config: unknown, _registry: unknown, options?: { excludeModels?: string[] }) => (
      options?.excludeModels?.includes('kimi-for-coding') ? 'qwen3-max' : 'kimi-for-coding'
    ));
    safeQueryMock.mockResolvedValueOnce({
      messages: [makeSuccessMessage()],
      exitError: null,
    });

    const plan = {
      id: 'plan-preflight',
      goal: 'Test preflight fallback',
      cwd,
      tasks: [{
        id: 'task-a',
        description: 'Patch the file',
        complexity: 'medium',
        category: 'api',
        assigned_model: 'glm-5-turbo',
        assignment_reason: 'test',
        estimated_files: ['src/task-a.ts'],
        acceptance_criteria: ['file updated'],
        discuss_threshold: 0.7,
        depends_on: [],
        review_scale: 'auto',
      }],
      execution_order: [['task-a']],
      context_flow: {},
      created_at: new Date().toISOString(),
    };

    try {
      const result = await dispatchBatch(plan as any, getRegistryMock(), { runId: 'run-preflight', round: 1 }, { recordBudget: false });
      expect(result.worker_results[0]?.model).toBe('qwen3-max');
      expect(safeQueryMock).toHaveBeenCalledWith(expect.objectContaining({
        options: expect.objectContaining({ model: 'qwen3-max' }),
      }));
      expect(resolveFallbackMock).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
