import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

const {
  ensureModelProxyMock,
  getModelProxyPortMock,
  registerModelProxyRouteMock,
} = vi.hoisted(() => ({
  ensureModelProxyMock: vi.fn(async () => 40123),
  getModelProxyPortMock: vi.fn(() => 40123),
  registerModelProxyRouteMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-code', () => ({
  query: queryMock,
}));

vi.mock('../orchestrator/model-proxy.js', () => ({
  ensureModelProxy: ensureModelProxyMock,
  getModelProxyPort: getModelProxyPortMock,
  registerModelProxyRoute: registerModelProxyRouteMock,
}));

import { safeQuery } from '../orchestrator/sdk-query-safe.js';

function singleMessageStream(message: Record<string, unknown>) {
  return (async function* () {
    yield message;
  })();
}

describe('safeQuery Claude manual-only guard', () => {
  beforeEach(() => {
    queryMock.mockReset();
    ensureModelProxyMock.mockClear();
    getModelProxyPortMock.mockClear();
    registerModelProxyRouteMock.mockClear();
  });

  it('blocks Claude launches without explicit route env', async () => {
    await expect(safeQuery({
      prompt: 'hello',
      options: {
        cwd: '/tmp/hive-safe-query',
        env: {
          HOME: '/tmp/hive-safe-query/home',
          CLAUDE_CONFIG_DIR: '/tmp/hive-safe-query/home/.claude',
        },
        model: 'claude-sonnet-4-6',
      },
    })).rejects.toThrow(/manual-only/i);

    expect(queryMock).not.toHaveBeenCalled();
  });

  it('allows Claude launches with explicit route env and isolated config env', async () => {
    queryMock.mockReturnValue(singleMessageStream({
      type: 'result',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));

    const result = await safeQuery({
      prompt: 'hello',
      options: {
        cwd: '/tmp/hive-safe-query',
        env: {
          HOME: '/tmp/hive-safe-query/home',
          CLAUDE_CONFIG_DIR: '/tmp/hive-safe-query/home/.claude',
          ANTHROPIC_BASE_URL: 'https://relay.example.com',
          ANTHROPIC_AUTH_TOKEN: 'route-token',
        },
        model: 'claude-sonnet-4-6',
      },
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(result.exitError).toBeNull();
    expect(result.messages).toHaveLength(1);
  });

  it('rewrites OpenAI bridge routes to the local model proxy before query', async () => {
    queryMock.mockReturnValue(singleMessageStream({
      type: 'result',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));

    await safeQuery({
      prompt: 'hello',
      options: {
        cwd: '/tmp/hive-safe-query',
        env: {
          HOME: '/tmp/hive-safe-query/home',
          CLAUDE_CONFIG_DIR: '/tmp/hive-safe-query/home/.claude',
          HIVE_MODEL_PROXY_MODE: 'openai-chat',
          HIVE_MODEL_PROXY_BASE_URL: 'http://127.0.0.1:19300/openai',
          HIVE_MODEL_PROXY_API_KEY: 'route-token',
        },
        model: 'gpt-5.4',
      },
    });

    expect(ensureModelProxyMock).toHaveBeenCalledTimes(1);
    expect(registerModelProxyRouteMock).toHaveBeenCalledWith(
      'gpt-5.4',
      'http://127.0.0.1:19300/openai',
      'route-token',
      'openai-chat',
    );
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0]?.[0]?.options?.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:40123');
    expect(queryMock.mock.calls[0]?.[0]?.options?.env?.ANTHROPIC_AUTH_TOKEN).toBe('proxy-managed');
    expect(queryMock.mock.calls[0]?.[0]?.options?.env?.HIVE_MODEL_PROXY_MODE).toBeUndefined();
  });

  it('rewrites direct domestic routes to the local model proxy before query', async () => {
    queryMock.mockReturnValue(singleMessageStream({
      type: 'result',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));

    await safeQuery({
      prompt: 'hello',
      options: {
        cwd: '/tmp/hive-safe-query',
        env: {
          HOME: '/tmp/hive-safe-query/home',
          CLAUDE_CONFIG_DIR: '/tmp/hive-safe-query/home/.claude',
          HIVE_MODEL_PROXY_MODE: 'direct',
          HIVE_MODEL_PROXY_BASE_URL: 'http://161.33.197.51:4001',
          HIVE_MODEL_PROXY_API_KEY: 'route-token',
        },
        model: 'K2.6',
      },
    });

    expect(ensureModelProxyMock).toHaveBeenCalledTimes(1);
    expect(registerModelProxyRouteMock).toHaveBeenCalledWith(
      'K2.6',
      'http://161.33.197.51:4001',
      'route-token',
      'direct',
    );
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0]?.[0]?.options?.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:40123');
    expect(queryMock.mock.calls[0]?.[0]?.options?.env?.ANTHROPIC_AUTH_TOKEN).toBe('proxy-managed');
    expect(queryMock.mock.calls[0]?.[0]?.options?.env?.HIVE_MODEL_PROXY_MODE).toBeUndefined();
  });
});
