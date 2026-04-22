import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSdkEnv } from '../orchestrator/project-paths.js';

describe('buildSdkEnv — ANTHROPIC_BASE_URL normalization', () => {
  const savedBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;

  beforeEach(() => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  afterEach(() => {
    if (savedBaseUrl !== undefined) process.env.ANTHROPIC_BASE_URL = savedBaseUrl;
    else delete process.env.ANTHROPIC_BASE_URL;
    if (savedToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
    else delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  describe('direct baseUrl (Claude models)', () => {
    it('strips /v1 suffix', () => {
      const env = buildSdkEnv('claude-sonnet-4-6', 'https://example.com/v1', 'key');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://example.com');
    });

    it('strips /v1/ trailing slash', () => {
      const env = buildSdkEnv('claude-sonnet-4-6', 'https://example.com/v1/', 'key');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://example.com');
    });

    it('strips /openapi/v1 path', () => {
      const env = buildSdkEnv('claude-sonnet-4-6', 'https://chat.example.com/openapi/v1', 'key');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://chat.example.com/openapi');
    });

    it('leaves plain host unchanged', () => {
      const env = buildSdkEnv('claude-sonnet-4-6', 'https://api.example.com', 'key');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com');
    });

    it('leaves /anthropic path unchanged', () => {
      const env = buildSdkEnv('claude-sonnet-4-6', 'https://api.moonshot.ai/anthropic', 'key');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    });

    it('strips /v1 from provider prefix like /openai/v1', () => {
      const env = buildSdkEnv('claude-sonnet-4-6', 'http://host:3000/openai/v1', 'key');
      expect(env.ANTHROPIC_BASE_URL).toBe('http://host:3000/openai');
    });

    it('blocks ambient OAuth fallback when Claude route is missing', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://global.example.com/v1';
      process.env.ANTHROPIC_AUTH_TOKEN = 'global-token';
      expect(() => buildSdkEnv('claude-sonnet-4-6')).toThrow(/manual-only/i);
    });

    it('seeds isolated Claude config dirs instead of reusing parent HOME', () => {
      const env = buildSdkEnv('claude-sonnet-4-6', 'https://example.com/v1', 'key');
      expect(env.HOME).toBeTruthy();
      expect(env.CLAUDE_CONFIG_DIR).toBeTruthy();
      expect(env.XDG_CONFIG_HOME).toBeTruthy();
      expect(env.CLAUDE_CONFIG_DIR.startsWith(env.HOME)).toBe(true);
    });
  });

  describe('MMS gateway path', () => {
    it('marks explicit OpenAI-style GPT routes for local bridge instead of sending /v1/messages directly', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/v1';
      process.env.ANTHROPIC_AUTH_TOKEN = 'tok';
      const env = buildSdkEnv('gpt-5', 'https://other.com/v1', 'key');
      expect(env.HIVE_MODEL_PROXY_MODE).toBe('openai-chat');
      expect(env.HIVE_MODEL_PROXY_BASE_URL).toBe('https://other.com');
      expect(env.HIVE_MODEL_PROXY_API_KEY).toBe('key');
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    it('falls back to inherited gateway env for GPT models without explicit route', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/v1';
      process.env.ANTHROPIC_AUTH_TOKEN = 'tok';
      const env = buildSdkEnv('gpt-5');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example.com');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('tok');
    });

    it('prefers explicit provider baseUrl for domestic models', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/openapi/v1';
      process.env.ANTHROPIC_AUTH_TOKEN = 'tok';
      const env = buildSdkEnv('kimi-k2.5', 'https://api.moonshot.ai/anthropic/', 'key');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic/');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('key');
    });

    it('falls back to inherited gateway for domestic models without explicit baseUrl', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/openapi/v1';
      process.env.ANTHROPIC_AUTH_TOKEN = 'tok';
      const env = buildSdkEnv('kimi-k2.5');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example.com/openapi');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('tok');
    });

    it('marks explicit non-anthropic domestic routes for local proxy handling', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/v1';
      process.env.ANTHROPIC_AUTH_TOKEN = 'tok';
      const env = buildSdkEnv('kimi-for-coding', 'https://api.kimi.com/coding/', 'key');
      expect(env.HIVE_MODEL_PROXY_MODE).toBe('direct');
      expect(env.HIVE_MODEL_PROXY_BASE_URL).toBe('https://api.kimi.com/coding/');
      expect(env.HIVE_MODEL_PROXY_API_KEY).toBe('key');
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    it('routes non-gateway non-claude families through direct proxy mode on OpenAI-compatible routes', () => {
      const cases = ['kimi-for-coding', 'glm-5-turbo', 'qwen3-max', 'MiniMax-M2.5'];
      process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/v1';
      process.env.ANTHROPIC_AUTH_TOKEN = 'tok';

      for (const modelId of cases) {
        const env = buildSdkEnv(modelId, `https://relay.example.com/${modelId}/openapi/v1`, 'key');
        expect(env.HIVE_MODEL_PROXY_MODE).toBe('direct');
        expect(env.HIVE_MODEL_PROXY_BASE_URL).toBe(`https://relay.example.com/${modelId}/openapi`);
        expect(env.HIVE_MODEL_PROXY_API_KEY).toBe('key');
        expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      }
    });

    it('routes gateway families through openai-chat bridge mode on OpenAI-compatible routes', () => {
      const cases = ['gpt-5.4', 'gemini-2.5-pro', 'o3-mini'];
      process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/v1';
      process.env.ANTHROPIC_AUTH_TOKEN = 'tok';

      for (const modelId of cases) {
        const env = buildSdkEnv(modelId, `https://relay.example.com/${modelId}/openapi/v1`, 'key');
        expect(env.HIVE_MODEL_PROXY_MODE).toBe('openai-chat');
        expect(env.HIVE_MODEL_PROXY_BASE_URL).toBe(`https://relay.example.com/${modelId}/openapi`);
        expect(env.HIVE_MODEL_PROXY_API_KEY).toBe('key');
        expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      }
    });

    it('does not override explicit anthropic route with inherited gateway env', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/openapi/v1';
      process.env.ANTHROPIC_AUTH_TOKEN = 'tok';
      const env = buildSdkEnv('glm-5-turbo', 'http://127.0.0.1:4001/anthropic', 'route-key');
      expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4001/anthropic');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('route-key');
    });
  });
});
