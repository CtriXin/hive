import fs from 'fs';
import os from 'os';
import path from 'path';
import type { HiveConfig, SubTask } from './types.js';
import type { ModelRegistry } from './model-registry.js';

export type FailureType = 'rate_limit' | 'server_error' | 'quality_fail';

export const DEFAULT_CONFIG: HiveConfig = {
  orchestrator: 'claude-opus',
  high_tier: 'claude-opus',
  review_tier: 'claude-sonnet',
  default_worker: 'kimi-k2.5',
  fallback_worker: 'glm-5-turbo',
  overrides: {},
  budget: {
    monthly_limit_usd: 100,
    warn_at: 0.2,
    block: false,
    current_spent_usd: 0,
    reset_day: 1,
  },
  host: 'claude-code',
};

export function findRepoRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

export function readJsonSafe<T>(filePath: string): Partial<T> {
  const cached = jsonFileCache.get(filePath);
  const mtimeMs = getFileMtimeMs(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.value as Partial<T>;
  }

  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<T>;
    jsonFileCache.set(filePath, { mtimeMs, value });
    return value;
  } catch {
    jsonFileCache.set(filePath, { mtimeMs, value: {} });
    return {};
  }
}

export function writeJsonSafe(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  jsonFileCache.set(filePath, { mtimeMs: getFileMtimeMs(filePath), value });
}

export function deepMerge<T>(...sources: Array<Partial<T>>): T {
  const result: Record<string, unknown> = {};

  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        result[key] &&
        typeof result[key] === 'object' &&
        !Array.isArray(result[key])
      ) {
        result[key] = deepMerge(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else if (value !== undefined) {
        result[key] = value;
      }
    }
  }

  return result as T;
}

export function getConfigSource(cwd: string): { global: string; local: string | null } {
  const globalPath = path.join(os.homedir(), '.hive', 'config.json');
  const repoRoot = findRepoRoot(cwd);
  const localPath = repoRoot ? path.join(repoRoot, '.hive', 'config.json') : null;
  return { global: globalPath, local: localPath };
}

interface JsonCacheEntry {
  mtimeMs: number | null;
  value: unknown;
}

const jsonFileCache = new Map<string, JsonCacheEntry>();

function getFileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

export function loadConfig(cwd: string = process.cwd()): HiveConfig {
  const { global: globalPath, local: localPath } = getConfigSource(cwd);
  const globalConfig = readJsonSafe<HiveConfig>(globalPath);
  const localConfig = localPath ? readJsonSafe<HiveConfig>(localPath) : {};
  return deepMerge<HiveConfig>(DEFAULT_CONFIG, globalConfig, localConfig);
}

export function getModelForTask(
  task: SubTask,
  config: HiveConfig,
  registry: ModelRegistry,
): string {
  if (config.overrides[task.id]) {
    return config.overrides[task.id];
  }

  if (task.complexity === 'high' || task.category.toLowerCase() === 'security') {
    return config.high_tier;
  }

  const ranked = registry.rankModelsForTask(task).filter((item) => !item.blocked_by?.length);
  if (ranked.length > 0) {
    return ranked[0].model;
  }

  if (config.default_worker) {
    return config.default_worker;
  }

  return config.fallback_worker;
}

export function getBudgetWarning(config: HiveConfig): string | null {
  const { budget } = config;
  if (budget.monthly_limit_usd <= 0) {
    return null;
  }

  const remaining = budget.monthly_limit_usd - budget.current_spent_usd;
  const ratio = remaining / budget.monthly_limit_usd;

  if (budget.block && ratio <= 0) {
    return `BLOCKED: Budget exhausted ($${budget.current_spent_usd.toFixed(2)} / $${budget.monthly_limit_usd.toFixed(2)})`;
  }

  if (ratio <= budget.warn_at) {
    return `Budget warning: ${(ratio * 100).toFixed(0)}% remaining ($${remaining.toFixed(2)} / $${budget.monthly_limit_usd.toFixed(2)})`;
  }

  return null;
}

export function resolveFallback(
  failedModel: string,
  errorType: FailureType,
  task: SubTask,
  config: HiveConfig,
  registry: ModelRegistry,
): string {
  if (errorType === 'rate_limit' || errorType === 'server_error') {
    const failedProvider = registry.get(failedModel)?.provider || null;
    const ranked = registry.rankModelsForTask(task)
      .filter((item) => !item.blocked_by?.length && item.model !== failedModel);

    const alternateProvider = ranked.find((item) => {
      const provider = registry.get(item.model)?.provider || null;
      return provider && provider !== failedProvider;
    });
    if (alternateProvider) {
      return alternateProvider.model;
    }
    if (ranked.length > 0) {
      return ranked[0].model;
    }
  }

  if (errorType === 'quality_fail') {
    return config.review_tier;
  }

  if (config.fallback_worker !== failedModel) {
    return config.fallback_worker;
  }

  return config.high_tier;
}
