import fs from 'fs';
import os from 'os';
import path from 'path';
import { getAllProviders } from './provider-resolver.js';
import { findRepoRoot } from './hive-config.js';

export interface ModelsCacheEntry {
  id: string;
  provider: string;
  context_window?: number;
}

export interface ModelsCache {
  last_pull: string;
  source: string;
  models: ModelsCacheEntry[];
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getCachePaths(cwd: string): { global: string; local: string | null } {
  const globalPath = path.join(os.homedir(), '.hive', 'models-cache.json');
  const repoRoot = findRepoRoot(cwd);
  return {
    global: globalPath,
    local: repoRoot ? path.join(repoRoot, '.hive', 'models-cache.json') : null,
  };
}

function readCacheSafe(filePath: string): ModelsCache | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ModelsCache;
  } catch {
    return null;
  }
}

function writeCacheSafe(filePath: string, cache: ModelsCache): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(cache, null, 2));
}

export function isCacheStale(cwd: string = process.cwd()): boolean {
  const { global: globalPath } = getCachePaths(cwd);
  const cache = readCacheSafe(globalPath);
  if (!cache) {
    return true;
  }
  return Date.now() - new Date(cache.last_pull).getTime() > CACHE_TTL_MS;
}

export async function pullModels(cwd: string = process.cwd()): Promise<ModelsCache> {
  const providers = getAllProviders();
  const models: ModelsCacheEntry[] = [];

  for (const [providerId, provider] of Object.entries(providers)) {
    const baseUrl = provider.anthropic_base_url || provider.openai_base_url;
    if (!baseUrl) {
      continue;
    }

    const apiKey = process.env[provider.api_key_env] || '';
    try {
      const response = await fetch(`${baseUrl}/v1/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'x-api-key': apiKey,
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        continue;
      }

      const data = await response.json() as { data?: Array<Record<string, unknown>>; models?: Array<Record<string, unknown>> };
      const entries = data.data || data.models || [];
      for (const model of entries) {
        const id = typeof model.id === 'string'
          ? model.id
          : typeof model.name === 'string'
            ? model.name
            : '';
        if (!id) {
          continue;
        }
        models.push({
          id,
          provider: providerId,
          context_window: typeof model.context_window === 'number' ? model.context_window : undefined,
        });
      }
    } catch {
      continue;
    }
  }

  const cache: ModelsCache = {
    last_pull: new Date().toISOString(),
    source: 'gateway /v1/models',
    models,
  };

  const paths = getCachePaths(cwd);
  writeCacheSafe(paths.global, cache);
  if (paths.local) {
    writeCacheSafe(paths.local, cache);
  }

  return cache;
}

export function getAvailableModels(cwd: string = process.cwd()): ModelsCacheEntry[] {
  const { global: globalPath } = getCachePaths(cwd);
  return readCacheSafe(globalPath)?.models ?? [];
}
