import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getModelProxyPort, isModelProxyRunning } from './model-proxy.js';
import { normalizeModelId } from './model-defaults.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Build env for Claude Code SDK query() calls.
 * Copies a sanitized parent env, strips auth-bearing Claude variables,
 * and seeds an isolated Claude config HOME so Hive cannot drift into global OAuth.
 * Also normalizes any trailing `/v1` path segment
 * that would be duplicated by the Anthropic SDK appending `/v1/messages`.
 * Handles: `/v1`, `/v1/`, `/openapi/v1`, `/openai/v1/`, etc.
 */
function stripV1Suffix(url: string): string {
  return url.replace(/\/v1\/?$/, '');
}

const SDK_ENV_BLOCKED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_'];
const SDK_ENV_BLOCKED_KEYS = new Set([
  'CLAUDE_CONFIG_DIR',
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
]);

export class ManualOnlyClaudeOAuthError extends Error {
  modelId: string;

  constructor(modelId: string, detail: string) {
    super(`Claude OAuth is manual-only for "${modelId}". ${detail}`);
    this.name = 'ManualOnlyClaudeOAuthError';
    this.modelId = modelId;
  }
}

export function isManualOnlyClaudeOAuthError(error: unknown): error is ManualOnlyClaudeOAuthError {
  return error instanceof ManualOnlyClaudeOAuthError;
}

function copyParentEnvForSdk(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SDK_ENV_BLOCKED_KEYS.has(key)) continue;
    if (SDK_ENV_BLOCKED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  return env;
}

function ensureSdkIsolationEnv(env: Record<string, string>): void {
  const sandboxRoot = path.join(os.tmpdir(), 'hive-claude-sdk', String(process.pid));
  const sandboxHome = path.join(sandboxRoot, 'home');
  const claudeConfigDir = path.join(sandboxHome, '.claude');
  const xdgConfigHome = path.join(sandboxHome, '.config');
  const xdgCacheHome = path.join(sandboxHome, '.cache');
  const xdgDataHome = path.join(sandboxHome, '.local', 'share');
  const xdgStateHome = path.join(sandboxHome, '.local', 'state');

  for (const dir of [claudeConfigDir, xdgConfigHome, xdgCacheHome, xdgDataHome, xdgStateHome]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  env.HOME = sandboxHome;
  env.USERPROFILE = sandboxHome;
  env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  env.XDG_CONFIG_HOME = xdgConfigHome;
  env.XDG_CACHE_HOME = xdgCacheHome;
  env.XDG_DATA_HOME = xdgDataHome;
  env.XDG_STATE_HOME = xdgStateHome;
}

export function buildSdkEnv(model: string, baseUrl?: string, apiKey?: string): Record<string, string> {
  const env = copyParentEnvForSdk();
  const canonicalModel = normalizeModelId(model);
  const isClaudeModel = canonicalModel.startsWith('claude-');
  const explicitApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  const normalizedExplicitBaseUrl = baseUrl ? stripV1Suffix(baseUrl) : undefined;
  const hasExplicitRoute = typeof normalizedExplicitBaseUrl === 'string' && normalizedExplicitBaseUrl.length > 0;
  const explicitLooksDirectAnthropic = !!normalizedExplicitBaseUrl && /\/anthropic\/?$/i.test(normalizedExplicitBaseUrl);
  const explicitNeedsProxy = hasExplicitRoute && !explicitLooksDirectAnthropic;
  ensureSdkIsolationEnv(env);

  // Pin current node version: prepend this process's node bin dir to PATH
  // so child processes don't resolve to a different node via .nvmrc
  const nodeBinDir = path.dirname(process.execPath);
  const currentPath = env.PATH || '';
  if (!currentPath.startsWith(nodeBinDir)) {
    env.PATH = nodeBinDir + ':' + currentPath;
  }

  // Override ALL model-related vars — force Claude Code SDK internal calls
  // (small-fast, subagent, reasoning, permissions) to use the target model,
  // not inherited MMS gateway values like claude-opus-4-6
  env.ANTHROPIC_MODEL = canonicalModel;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = canonicalModel;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = canonicalModel;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = canonicalModel;
  env.ANTHROPIC_REASONING_MODEL = canonicalModel;
  env.CLAUDE_CODE_SUBAGENT_MODEL = canonicalModel;

  // Non-Claude models need protocol adaptation.
  // GPT/Gemini/O-series always need MMS gateway.
  // Domestic models (kimi/qwen/glm/minimax) prefer local model proxy,
  // but fall back to MMS gateway when proxy is not running.
  const isNonClaude = !canonicalModel.startsWith('claude-');
  const needsMmsGateway = /^(gpt-|gemini-|o[134]-)/i.test(canonicalModel);
  const mmsBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const mmsToken = process.env.ANTHROPIC_AUTH_TOKEN;

  // Local model proxy handles case-restoration + protocol adaptation.
  const needsModelProxy = isNonClaude
    && !needsMmsGateway
    && isModelProxyRunning();

  if (hasExplicitRoute && needsMmsGateway && explicitNeedsProxy) {
    env.HIVE_MODEL_PROXY_MODE = 'openai-chat';
    env.HIVE_MODEL_PROXY_BASE_URL = normalizedExplicitBaseUrl;
    if (explicitApiKey) {
      env.HIVE_MODEL_PROXY_API_KEY = explicitApiKey;
    }
  } else if (hasExplicitRoute && isNonClaude && !needsMmsGateway && explicitNeedsProxy) {
    env.HIVE_MODEL_PROXY_MODE = 'direct';
    env.HIVE_MODEL_PROXY_BASE_URL = normalizedExplicitBaseUrl;
    if (explicitApiKey) {
      env.HIVE_MODEL_PROXY_API_KEY = explicitApiKey;
    }
  } else if (hasExplicitRoute) {
    env.ANTHROPIC_BASE_URL = normalizedExplicitBaseUrl;
    if (explicitApiKey) {
      env.ANTHROPIC_AUTH_TOKEN = explicitApiKey;
    } else if (isClaudeModel) {
      throw new ManualOnlyClaudeOAuthError(
        canonicalModel,
        'Explicit Claude routes must include an explicit apiKey; ambient token fallback is blocked.',
      );
    }
  } else if (isClaudeModel) {
    throw new ManualOnlyClaudeOAuthError(
      canonicalModel,
      'Automatic Claude SDK launches now require an explicit baseUrl + apiKey; ambient OAuth fallback is blocked.',
    );
  } else if (needsModelProxy) {
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${getModelProxyPort()}`;
    env.ANTHROPIC_AUTH_TOKEN = 'proxy-managed';
  } else if (needsMmsGateway && mmsBaseUrl) {
    env.ANTHROPIC_BASE_URL = stripV1Suffix(mmsBaseUrl);
    if (mmsToken) env.ANTHROPIC_AUTH_TOKEN = mmsToken;
  } else if (isNonClaude && mmsBaseUrl) {
    env.ANTHROPIC_BASE_URL = stripV1Suffix(mmsBaseUrl);
    if (mmsToken) env.ANTHROPIC_AUTH_TOKEN = mmsToken;
  }
  return env;
}

export function resolveProjectPath(...segments: string[]): string {
  const relativePath = path.join(...segments);
  const candidates = [
    path.resolve(process.cwd(), relativePath),
    path.resolve(__dirname, '..', relativePath),
    path.resolve(__dirname, '../..', relativePath),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}
