import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BudgetStatus, HiveConfig, SubTask, TiersConfig } from './types.js';
import type { ModelRegistry } from './model-registry.js';
import type { TaskFingerprint } from './task-fingerprint.js';
import { normalizeModelChannelMap } from './model-channel-policy.js';
import { resolveModelRoute } from './mms-routes-loader.js';

export type FailureType = 'rate_limit' | 'server_error' | 'quality_fail';
interface FallbackResolveOptions {
  excludeModels?: string[];
  excludeProviders?: string[];
}
export type ModelStage =
  | 'translator'
  | 'planner'
  | 'discuss'
  | 'executor'
  | 'cross_review'
  | 'arbitration'
  | 'final_review'
  | 'reporter';

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

export const FORCED_MODEL_BLACKLIST = ['claude-*'];

export const DEFAULT_CONFIG: HiveConfig = {
  orchestrator: 'qwen3-max',
  high_tier: 'qwen3-max',
  review_tier: 'kimi-for-coding',
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
  model_blacklist: FORCED_MODEL_BLACKLIST,
  channel_blacklist: [],
  model_channel_map: {},
};

interface BudgetRuntimeState {
  current_spent_usd?: number;
  last_reset?: string;
}

type BlacklistConfig = Pick<HiveConfig, 'model_blacklist'> | undefined;

function escapeRegex(pattern: string): string {
  return pattern.replace(/[|\\{}()[\]^$+?.*]/g, '\\$&');
}

export function normalizeModelBlacklist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(normalized)];
}

export function normalizeChannelBlacklist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(normalized)];
}

export function matchModelBlacklistPattern(
  config: BlacklistConfig,
  modelId: string,
): string | null {
  const patterns = normalizeModelBlacklist(config?.model_blacklist);
  if (patterns.length === 0) return null;
  const normalizedModel = String(modelId || '').trim().toLowerCase();
  if (!normalizedModel) return null;
  for (const pattern of patterns) {
    if (pattern === normalizedModel) return pattern;
    const regex = new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, '.*')}$`, 'i');
    if (regex.test(normalizedModel)) {
      return pattern;
    }
  }
  return null;
}

export function isModelBlacklisted(
  config: BlacklistConfig,
  modelId: string,
): boolean {
  return Boolean(matchModelBlacklistPattern(config, modelId));
}

export function isChannelBlacklisted(
  config: Pick<HiveConfig, 'channel_blacklist'> | undefined,
  channelId: string,
): boolean {
  if (!config?.channel_blacklist?.length) return false;
  const normalized = String(channelId || '').trim().toLowerCase();
  if (!normalized) return false;
  return config.channel_blacklist.some(
    (p) => String(p || '').trim().toLowerCase() === normalized,
  );
}

function buildBlacklistFallbackFingerprint(role?: string): TaskFingerprint {
  if (role === 'planning') {
    return {
      role: 'planning',
      domains: ['typescript', 'architecture'],
      complexity: 'high',
      needs_strict_boundary: true,
      needs_fast_turnaround: false,
      is_repair_round: false,
    };
  }
  if (role === 'review') {
    return {
      role: 'review',
      domains: ['typescript', 'integration'],
      complexity: 'medium-high',
      needs_strict_boundary: true,
      needs_fast_turnaround: false,
      is_repair_round: false,
    };
  }
  if (role === 'translation') {
    return {
      role: 'implementation',
      domains: ['docs'],
      complexity: 'low',
      needs_strict_boundary: false,
      needs_fast_turnaround: true,
      is_repair_round: false,
    };
  }
  return {
    role: role === 'general' ? 'implementation' : 'implementation',
    domains: ['typescript'],
    complexity: 'medium',
    needs_strict_boundary: false,
    needs_fast_turnaround: false,
    is_repair_round: false,
  };
}

function selectBlacklistedFallbackModel(
  registry: ModelRegistry,
  config: BlacklistConfig,
  role?: string,
): string | undefined {
  if (role === 'translation') {
    const candidates = registry.getAll()
      .filter((item) => !isModelBlacklisted(config, item.id) && registry.canResolveForModel(item.id))
      .sort((a, b) => b.chinese - a.chinese || b.reasoning - a.reasoning);
    return candidates[0]?.id;
  }

  const ranked = registry.rankModelsForTask(buildBlacklistFallbackFingerprint(role))
    .filter((item) =>
      !item.blocked_by?.length
      && !isModelBlacklisted(config, item.model)
      && registry.canResolveForModel(item.model));

  return ranked[0]?.model;
}

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

function budgetRuntimeStatePath(cwd: string): string {
  const { global: globalPath } = getConfigSource(cwd);
  return path.join(path.dirname(globalPath), 'budget-state.json');
}

function loadBudgetRuntimeState(cwd: string): BudgetRuntimeState {
  return readJsonSafe<BudgetRuntimeState>(budgetRuntimeStatePath(cwd));
}

function applyBudgetRuntimeState(config: HiveConfig, cwd: string): HiveConfig {
  const runtime = loadBudgetRuntimeState(cwd);
  const merged = deepMerge<HiveConfig>(config);
  merged.budget = {
    ...merged.budget,
    current_spent_usd: typeof runtime.current_spent_usd === 'number'
      ? runtime.current_spent_usd
      : merged.budget.current_spent_usd,
    last_reset: typeof runtime.last_reset === 'string'
      ? runtime.last_reset
      : merged.budget.last_reset,
  };
  return merged;
}

function persistBudgetRuntimeState(cwd: string, state: BudgetRuntimeState): void {
  writeJsonSafe(budgetRuntimeStatePath(cwd), state);
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
  // Prefer real user home first (same as findMmsRoutesPath), sandbox as fallback.
  const sandboxHome = path.join(os.homedir(), '.hive', 'config.json');
  const realUser = process.env.USER || process.env.LOGNAME || '';
  const realHome = realUser ? path.join('/Users', realUser, '.hive', 'config.json') : '';

  let globalPath = sandboxHome;
  if (realHome && fs.existsSync(realHome)) {
    globalPath = realHome;
  } else if (realHome && !fs.existsSync(sandboxHome)) {
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

  merged.model_blacklist = normalizeModelBlacklist([
    ...(merged.model_blacklist || []),
    ...FORCED_MODEL_BLACKLIST,
  ]);
  merged.channel_blacklist = normalizeChannelBlacklist(merged.channel_blacklist);
  merged.model_channel_map = normalizeModelChannelMap(merged.model_channel_map);

  return applyBudgetRuntimeState(merged, cwd);
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
  config: BlacklistConfig = DEFAULT_CONFIG,
): string {
  const finalizeModel = (candidate: string): string => {
    const blockedPattern = matchModelBlacklistPattern(config, candidate);
    if (!blockedPattern) return candidate;

    const autoCandidate = autoFn();
    if (autoCandidate && autoCandidate !== candidate && !isModelBlacklisted(config, autoCandidate)) {
      return autoCandidate;
    }

    if (registry) {
      const fallback = selectBlacklistedFallbackModel(registry, config, role);
      if (fallback && fallback !== candidate) {
        return fallback;
      }
    }

    throw new Error(`Model "${candidate}" is blocked by model_blacklist pattern "${blockedPattern}"`);
  };

  if (tierModel === 'auto') return finalizeModel(autoFn());

  // If registry is available, try provider shorthand resolution
  let resolved = tierModel;
  if (registry) {
    // Check if it's an exact model ID first
    const exact = registry.get(tierModel);
    if (exact) {
      resolved = tierModel;
      return finalizeModel(resolved);
    }

    // Treat as provider shorthand — find best model from that provider for the role
    const providerResolved = registry.resolveProviderShorthand(tierModel, role);
    if (providerResolved) {
      resolved = providerResolved;
      return finalizeModel(resolved);
    }
  }

  // Fallback: return as-is (assume exact model ID even if not in registry)
  return finalizeModel(resolved);
}

export function getModelForTask(
  task: SubTask,
  config: HiveConfig,
  registry: ModelRegistry,
): string {
  if (
    config.overrides[task.id]
    && !config.overrides[task.id].startsWith('claude-')
    && !isModelBlacklisted(config, config.overrides[task.id])
  ) {
    return config.overrides[task.id];
  }

  const ranked = registry.rankModelsForTask(task)
    .filter((item) =>
      !item.blocked_by?.length
      && !item.model.startsWith('claude-')
      && !isModelBlacklisted(config, item.model));
  if (ranked.length > 0) {
    return ranked[0].model;
  }

  return pickExecutableModelCandidate(
    [
      config.default_worker,
      config.tiers.executor.fallback,
      config.fallback_worker,
      config.high_tier,
      'qwen3-max',
      'qwen3.5-plus',
      'kimi-k2.5',
      'glm-5-turbo',
      'kimi-for-coding',
    ],
    registry,
    new Set(),
    new Set(),
    config,
  ) || config.fallback_worker;
}

export function isClaudeModel(modelId: string): boolean {
  return modelId.startsWith('claude-');
}

export function ensureStageModelAllowed(
  stage: ModelStage,
  modelId: string,
  config: BlacklistConfig = DEFAULT_CONFIG,
): void {
  const blockedPattern = matchModelBlacklistPattern(config, modelId);
  if (blockedPattern) {
    throw new Error(`Model "${modelId}" is blocked by model_blacklist pattern "${blockedPattern}"`);
  }
  if (!isClaudeModel(modelId)) return;
  throw new Error(
    `Claude model "${modelId}" is globally disabled in Hive runtime and cannot run in stage "${stage}".`,
  );
}

export function getBudgetWarning(config: HiveConfig): string | null {
  return getBudgetStatus(config)?.warning ?? null;
}

export function getBudgetStatus(config: HiveConfig): BudgetStatus | null {
  const { budget } = config;
  if (budget.monthly_limit_usd <= 0) {
    return null;
  }

  const remaining = budget.monthly_limit_usd - budget.current_spent_usd;
  const ratio = remaining / budget.monthly_limit_usd;
  const blocked = budget.block && ratio <= 0;
  let warning: string | null = null;

  if (blocked) {
    warning = `BLOCKED: Budget exhausted ($${budget.current_spent_usd.toFixed(2)} / $${budget.monthly_limit_usd.toFixed(2)})`;
  } else if (ratio <= budget.warn_at) {
    warning = `Budget warning: ${(ratio * 100).toFixed(0)}% remaining ($${remaining.toFixed(2)} / $${budget.monthly_limit_usd.toFixed(2)})`;
  }

  return {
    monthly_limit_usd: budget.monthly_limit_usd,
    current_spent_usd: budget.current_spent_usd,
    remaining_usd: remaining,
    remaining_ratio: ratio,
    warn_at: budget.warn_at,
    block: budget.block,
    blocked,
    warning,
  };
}

/**
 * Record spending in a separate runtime state file.
 * Global ~/.hive/config.json stays human-reviewed and is never auto-mutated.
 * Auto-resets on budget.reset_day if month has changed.
 */
export function recordSpending(cwd: string, amountUsd: number): BudgetStatus | null {
  if (amountUsd <= 0) {
    return getBudgetStatus(loadConfig(cwd));
  }
  const config = loadConfig(cwd);
  const budget = {
    ...DEFAULT_CONFIG.budget,
    ...config.budget,
  };

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
  persistBudgetRuntimeState(cwd, {
    current_spent_usd: budget.current_spent_usd,
    last_reset: budget.last_reset,
  });
  return getBudgetStatus({
    ...config,
    budget,
  });
}

export function resolveFallback(
  failedModel: string,
  errorType: FailureType,
  task: SubTask,
  config: HiveConfig,
  registry: ModelRegistry,
  options: FallbackResolveOptions = {},
): string {
  const excludedModels = new Set(options.excludeModels || []);
  excludedModels.add(failedModel);
  const excludedProviders = new Set(options.excludeProviders || []);
  const safeRanked = registry.rankModelsForTask(task)
    .filter((item) => !item.blocked_by?.length
      && !excludedModels.has(item.model)
      && !item.model.startsWith('claude-')
      && !isModelBlacklisted(config, item.model));

  const rankedCandidateModels = safeRanked
    .map((item) => item.model)
    .filter((modelId) => {
      const provider = registry.get(modelId)?.provider;
      return !provider || !excludedProviders.has(provider);
    });

  if (errorType === 'rate_limit' || errorType === 'server_error') {
    const failedProvider = registry.get(failedModel)?.provider || null;
    if (failedProvider) {
      excludedProviders.add(failedProvider);
    }

    // Prefer a different provider to avoid hitting the same rate limit
    const alternateProvider = safeRanked.find((item) => {
      const provider = registry.get(item.model)?.provider || null;
      return provider
        && provider !== failedProvider
        && !excludedProviders.has(provider);
    });
    if (alternateProvider) {
      return alternateProvider.model;
    }
    const rankedFallback = pickExecutableModelCandidate(
      rankedCandidateModels,
      registry,
      excludedProviders,
      excludedModels,
      config,
    );
    if (rankedFallback) {
      return rankedFallback;
    }
  }

  if (errorType === 'quality_fail') {
    const rankedFallback = pickExecutableModelCandidate(rankedCandidateModels, registry, excludedProviders, excludedModels, config);
    if (rankedFallback) {
      return rankedFallback;
    }
  }

  const configuredFallback = pickExecutableModelCandidate(
    [
      config.tiers.executor.fallback,
      config.fallback_worker,
      config.default_worker,
      config.high_tier,
      'qwen3-max',
      'qwen3.5-plus',
      'kimi-k2.5',
      'glm-5-turbo',
      'kimi-for-coding',
    ],
    registry,
    excludedProviders,
    excludedModels,
    config,
  );
  if (configuredFallback) {
    return configuredFallback;
  }

  return failedModel;
}

function pickExecutableModelCandidate(
  candidates: Array<string | undefined>,
  registry: ModelRegistry,
  excludedProviders: Set<string> = new Set(),
  excludedModels: Set<string> = new Set(),
  config: BlacklistConfig = DEFAULT_CONFIG,
): string | undefined {
  for (const candidate of candidates) {
    if (!candidate || candidate.startsWith('claude-') || excludedModels.has(candidate)) continue;
    if (isModelBlacklisted(config, candidate)) continue;
    const provider = registry.get(candidate)?.provider;
    if (provider && excludedProviders.has(provider)) continue;
    if (registry.canResolveForModel(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
