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
  });

  describe('MMS gateway path', () => {
    it('strips /v1 from inherited ANTHROPIC_BASE_URL for GPT models', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/v1';
      process.env.ANTHROPIC_AUTH_TOKEN = 'tok';
      const env = buildSdkEnv('gpt-5', 'https://other.com', 'key');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example.com');
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

    it('prefers explicit provider baseUrl for kimi-for-coding', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/v1';
      process.env.ANTHROPIC_AUTH_TOKEN = 'tok';
      const env = buildSdkEnv('kimi-for-coding', 'https://api.kimi.com/coding/', 'key');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.kimi.com/coding/');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('key');
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
