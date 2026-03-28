import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

  // Override Anthropic-specific vars
  env.ANTHROPIC_MODEL = model;
  if (baseUrl) {
    env.ANTHROPIC_BASE_URL = baseUrl;
  } else {
    delete env.ANTHROPIC_BASE_URL;
  }
  if (apiKey) {
    env.ANTHROPIC_AUTH_TOKEN = apiKey;
  } else {
    delete env.ANTHROPIC_AUTH_TOKEN;
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
