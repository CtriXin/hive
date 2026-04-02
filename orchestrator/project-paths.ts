import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getModelProxyPort, isModelProxyRunning } from './model-proxy.js';
import { normalizeModelId } from './model-defaults.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Build env for Claude Code SDK query() calls.
 * Inherits full parent process env to preserve PATH (~/.bun/bin, nvm, etc.),
 * then overrides only the Anthropic-specific variables.
 * Ensures the current process's node binary dir is at the front of PATH
 * to avoid .nvmrc / .node-version in child cwd pulling in an older node.
 */
export function buildSdkEnv(model: string, baseUrl?: string, apiKey?: string): Record<string, string> {
  const env: Record<string, string> = {};
  const canonicalModel = normalizeModelId(model);
  // Inherit all parent env (preserves PATH, HOME, NVM_DIR, etc.)
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

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

  // GPT/Gemini/O-series need MMS gateway for protocol adaptation.
  const needsMmsGateway = /^(gpt-|gemini-|o[134]-)/i.test(canonicalModel);
  const mmsBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const mmsToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const inheritedToken = process.env.ANTHROPIC_AUTH_TOKEN || '';

  // Non-Claude domestic models: route through local model proxy.
  // Claude Code CLI lowercases model names (e.g. "MiniMax-M2.7" → "minimax-m2.7")
  // which breaks case-sensitive provider APIs. The model proxy restores
  // correct casing from MMS model-routes.json before forwarding.
  const needsModelProxy = !canonicalModel.startsWith('claude-')
    && !needsMmsGateway
    && isModelProxyRunning();

  if (needsModelProxy) {
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${getModelProxyPort()}`;
    env.ANTHROPIC_AUTH_TOKEN = 'proxy-managed';
  } else if (needsMmsGateway && mmsBaseUrl) {
    env.ANTHROPIC_BASE_URL = mmsBaseUrl;
    env.ANTHROPIC_AUTH_TOKEN = mmsToken || inheritedToken;
  } else if (baseUrl) {
    env.ANTHROPIC_BASE_URL = baseUrl.replace(/\/v1\/?$/, '');
    env.ANTHROPIC_AUTH_TOKEN = apiKey || inheritedToken;
  } else {
    if (inheritedToken) {
      env.ANTHROPIC_AUTH_TOKEN = inheritedToken;
    }
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
