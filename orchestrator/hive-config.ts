import fs from 'fs';
import os from 'os';
import path from 'path';
import type { HiveConfig, SubTask, TiersConfig } from './types.js';
import type { ModelRegistry } from './model-registry.js';

export type FailureType = 'rate_limit' | 'server_error' | 'quality_fail';

export const DEFAULT_TIERS: TiersConfig = {
  translator: { model: 'auto', fallback: 'glm-5-turbo' },
  planner: { model: 'auto', fallback: 'qwen3-max' },
  discuss: { model: 'auto', fallback: 'kimi-k2.5', mode: 'auto' },
  executor: { model: 'auto', fallback: 'glm-5-turbo' },
  reviewer: {
    cross_review: { model: 'auto' },
    arbitration: { model: 'auto', fallback: 'kimi-for-coding' },
    final_review: { model: 'auto', fallback: 'qwen3-max' },
  },
  reporter: { model: 'auto', fallback: 'kimi-for-coding' },
};

export const DEFAULT_CONFIG: HiveConfig = {
  orchestrator: 'claude-opus',
  high_tier: 'claude-opus',
  review_tier: 'claude-sonnet',
  default_worker: 'kimi-for-coding',
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
  tiers: DEFAULT_TIERS,
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
  // In sandboxed environments, os.homedir() may return a nested sandbox dir.
  // Try sandbox home first, then real user home as fallback.
  const sandboxHome = path.join(os.homedir(), '.hive', 'config.json');
  const realUser = process.env.USER || process.env.LOGNAME || '';
  const realHome = realUser ? path.join('/Users', realUser, '.hive', 'config.json') : '';

  let globalPath = sandboxHome;
  if (!fs.existsSync(sandboxHome) && realHome && fs.existsSync(realHome)) {
    globalPath = realHome;
  }

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
  const merged = deepMerge<HiveConfig>(DEFAULT_CONFIG, globalConfig, localConfig);

  // Backward compat: if user set legacy fields but not tiers, map them
  if (!globalConfig.tiers && !localConfig.tiers) {
    if (merged.orchestrator !== DEFAULT_CONFIG.orchestrator) {
      merged.tiers.planner.model = merged.orchestrator;
    }
    if (merged.high_tier !== DEFAULT_CONFIG.high_tier) {
      merged.tiers.reviewer.final_review.model = merged.high_tier;
    }
    if (merged.review_tier !== DEFAULT_CONFIG.review_tier) {
      merged.tiers.reviewer.arbitration.model = merged.review_tier;
    }
    if (merged.default_worker !== DEFAULT_CONFIG.default_worker) {
      merged.tiers.executor.model = merged.default_worker;
    }
    if (merged.fallback_worker !== DEFAULT_CONFIG.fallback_worker) {
      merged.tiers.executor.fallback = merged.fallback_worker;
    }
    if (merged.translator_model) {
      merged.tiers.translator.model = merged.translator_model;
    }
  }

  return merged;
}

/**
 * Resolve tier model with 3-way matching:
 * - 'auto' → call autoFn (registry-based selection)
 * - exact model ID (e.g. 'qwen3-max') → return as-is
 * - provider shorthand (e.g. 'qwen', 'kimi', 'glm') → best model from that provider for the given role
 *
 * When registry/role are omitted, falls back to the legacy 2-arg behavior (auto or exact only).
 */
export function resolveTierModel(
  tierModel: string,
  autoFn: () => string,
  registry?: ModelRegistry,
  role?: string,
): string {
  if (tierModel === 'auto') return autoFn();

  // If registry is available, try provider shorthand resolution
  if (registry) {
    // Check if it's an exact model ID first
    const exact = registry.get(tierModel);
    if (exact) return tierModel;

    // Treat as provider shorthand — find best model from that provider for the role
    const resolved = registry.resolveProviderShorthand(tierModel, role);
    if (resolved) return resolved;
  }

  // Fallback: return as-is (assume exact model ID even if not in registry)
  return tierModel;
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

/**
 * Record spending and write back to global config.
 * Auto-resets on budget.reset_day if month has changed.
 */
export function recordSpending(cwd: string, amountUsd: number): void {
  if (amountUsd <= 0) return;
  const { global: globalPath } = getConfigSource(cwd);
  const raw = readJsonSafe<HiveConfig>(globalPath);
  const budget = raw.budget || DEFAULT_CONFIG.budget;

  // Auto-reset: if today >= reset_day and last_reset is a different month
  const now = new Date();
  const lastReset = budget.last_reset ? new Date(budget.last_reset) : null;
  const needsReset = now.getDate() >= (budget.reset_day || 1)
    && (!lastReset || lastReset.getMonth() !== now.getMonth()
      || lastReset.getFullYear() !== now.getFullYear());

  if (needsReset) {
    budget.current_spent_usd = 0;
    budget.last_reset = now.toISOString();
  }

  budget.current_spent_usd = (budget.current_spent_usd || 0) + amountUsd;
  raw.budget = budget;
  writeJsonSafe(globalPath, raw);
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
    // Exclude Claude models from fallback — they require local Keychain auth
    // and will hang in non-interactive environments (codex, CI, etc.)
    const ranked = registry.rankModelsForTask(task)
      .filter((item) => !item.blocked_by?.length
        && item.model !== failedModel
        && !item.model.startsWith('claude-'));

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
