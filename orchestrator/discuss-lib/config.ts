// ═══════════════════════════════════════════════════════════════════
// discuss-lib/config.ts — Configuration loader with model-routes.json
// ═══════════════════════════════════════════════════════════════════
// Priority: function args > ~/.hive/discuss.json > model-routes.json > bare

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DiscussConfig, ModelRoute } from './types.js';
import { normalizeMmsRoutesPayload } from '../mms-routes-contract.js';

// ── Resolve real user home ──
// claude-gateway overrides $HOME to its session dir (e.g. ~/.config/mms/claude-gateway/s/NNN).
// Detect this and fall back to the actual user home from /etc/passwd or known paths.
function getRealHome(): string {
  const home = process.env['HOME'] || '';
  // If HOME points to an MMS gateway session dir, strip it back to the real user home.
  const gatewayMarker = '/.config/mms/';
  const markerIdx = home.indexOf(gatewayMarker);
  if (markerIdx > 0) {
    const gatewayTail = home.slice(markerIdx + gatewayMarker.length);
    if (gatewayTail.startsWith('claude-gateway/') || gatewayTail.startsWith('codex-gateway/')) {
      return home.slice(0, markerIdx);
    }
  }
  return home || '/tmp';
}

// ── mtime cache for file reads ──

interface FileCacheEntry<T> {
  path: string;
  mtimeMs: number | null;
  value: T;
}

function getFileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

// ── model-routes.json ──

let routesCache: FileCacheEntry<Record<string, ModelRoute>> | null = null;

function findExistingPath(candidates: string[]): string {
  for (const candidate of candidates) {
    if (candidate && getFileMtimeMs(candidate) !== null) {
      return candidate;
    }
  }
  return candidates[0];
}

function getDefaultRoutesPath(): string {
  if (process.env.MMS_ROUTES_PATH) {
    return process.env.MMS_ROUTES_PATH;
  }

  const user = process.env.USER || process.env.LOGNAME || '';
  return findExistingPath([
    path.join(getRealHome(), '.config', 'mms', 'model-routes.json'),
    path.join(os.homedir(), '.config', 'mms', 'model-routes.json'),
    user ? path.join('/Users', user, '.config', 'mms', 'model-routes.json') : '',
  ]);
}

function loadModelRoutes(routesPath: string): Record<string, ModelRoute> {
  const mtimeMs = getFileMtimeMs(routesPath);
  if (routesCache && routesCache.path === routesPath && routesCache.mtimeMs === mtimeMs) {
    return routesCache.value;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(routesPath, 'utf-8'));
    const normalized = normalizeMmsRoutesPayload(raw);
    const routes: Record<string, ModelRoute> = normalized?.routes || {};
    routesCache = { path: routesPath, mtimeMs, value: routes };
    return routes;
  } catch {
    return {};
  }
}

// ── discuss.json ──

let configCache: FileCacheEntry<Partial<DiscussConfig>> | null = null;

function getDefaultConfigPath(): string {
  const user = process.env.USER || process.env.LOGNAME || '';
  return findExistingPath([
    path.join(getRealHome(), '.hive', 'discuss.json'),
    path.join(os.homedir(), '.hive', 'discuss.json'),
    user ? path.join('/Users', user, '.hive', 'discuss.json') : '',
  ]);
}

function loadDiscussConfig(): Partial<DiscussConfig> {
  const configPath = getDefaultConfigPath();
  const mtimeMs = getFileMtimeMs(configPath);
  if (configCache && configCache.path === configPath && configCache.mtimeMs === mtimeMs) {
    return configCache.value;
  }

  try {
    const value = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    configCache = { path: configPath, mtimeMs, value };
    return value;
  } catch {
    return {};
  }
}

// ── Public API ──

const DEFAULT_MODELS = ['kimi-k2.5', 'qwen3.5-plus', 'glm-5-turbo'];

/**
 * Resolve baseUrl + apiKey for a given model.
 *
 * Priority:
 * 1. config.providers (direct injection)
 * 2. model-routes.json (MMS export)
 * 3. No config → only set ANTHROPIC_MODEL, let SDK handle
 */
export function resolveModelRoute(
  modelId: string,
  config?: Partial<DiscussConfig>,
): { baseUrl?: string; apiKey?: string } {
  // 1. Direct injection
  if (config?.providers?.[modelId]) {
    const p = config.providers[modelId];
    return { baseUrl: p.base_url, apiKey: p.api_key };
  }

  // 2. model-routes.json
  const routesPath = config?.model_routes_path || getDefaultRoutesPath();
  const routes = loadModelRoutes(routesPath);
  const route = routes[modelId];
  if (route) {
    return { baseUrl: route.anthropic_base_url, apiKey: route.api_key };
  }

  // 3. No config — bare modelId
  return {};
}

/**
 * Get the list of default models to use.
 *
 * Priority: config.default_models > discuss.json > hardcoded defaults
 */
export function getDefaultModels(config?: Partial<DiscussConfig>): string[] {
  if (config?.default_models?.length) return config.default_models;
  const diskConfig = loadDiscussConfig();
  if (diskConfig.default_models?.length) return diskConfig.default_models;
  return DEFAULT_MODELS;
}

/**
 * Get the fallback model.
 */
export function getFallbackModel(config?: Partial<DiscussConfig>): string {
  if (config?.fallback_model) return config.fallback_model;
  const diskConfig = loadDiscussConfig();
  return diskConfig.fallback_model || DEFAULT_MODELS[0];
}

/**
 * List all available model IDs from model-routes.json, sorted by priority (desc).
 */
export function listAvailableModels(config?: Partial<DiscussConfig>): string[] {
  const routesPath = config?.model_routes_path || getDefaultRoutesPath();
  const routes = loadModelRoutes(routesPath);
  return Object.entries(routes)
    .sort((a, b) => (b[1].priority ?? 0) - (a[1].priority ?? 0) || a[0].localeCompare(b[0]))
    .map(([id]) => id);
}

const FOREIGN_PREFIXES = ['claude', 'gpt-', 'gemini', 'o1-', 'o3-', 'o4-'];

function isForeignModel(modelId: string): boolean {
  return FOREIGN_PREFIXES.some(p => modelId.startsWith(p) || modelId === p.replace(/-$/, ''));
}

/**
 * List only domestic (non-Claude/GPT/Gemini) models, sorted by priority (desc).
 */
export function listDomesticModels(config?: Partial<DiscussConfig>): string[] {
  const routesPath = config?.model_routes_path || getDefaultRoutesPath();
  const routes = loadModelRoutes(routesPath);
  return Object.entries(routes)
    .filter(([id]) => !isForeignModel(id))
    .sort((a, b) => (b[1].priority ?? 0) - (a[1].priority ?? 0) || a[0].localeCompare(b[0]))
    .map(([id]) => id);
}

/**
 * Resolve a specific model, or pick the best domestic model by priority.
 */
export function resolveModelOrBest(
  modelId?: string,
  config?: Partial<DiscussConfig>,
): { modelId: string; baseUrl?: string; apiKey?: string } | null {
  if (modelId) {
    const route = resolveModelRoute(modelId, config);
    return { modelId, ...route };
  }
  const domestic = listDomesticModels(config);
  if (domestic.length === 0) return null;
  const best = domestic[0];
  const route = resolveModelRoute(best, config);
  return { modelId: best, ...route };
}

/**
 * List all models with their priority and provider info (for --list-models display).
 */
export function listModelsWithInfo(config?: Partial<DiscussConfig>): Array<{
  modelId: string;
  priority: number;
  providerId: string;
  domestic: boolean;
}> {
  const routesPath = config?.model_routes_path || getDefaultRoutesPath();
  const routes = loadModelRoutes(routesPath);
  return Object.entries(routes)
    .map(([id, route]) => ({
      modelId: id,
      priority: route.priority ?? 0,
      providerId: route.provider_id ?? 'unknown',
      domestic: !isForeignModel(id),
    }))
    .sort((a, b) => b.priority - a.priority || a.modelId.localeCompare(b.modelId));
}

/**
 * Fuzzy-resolve a model alias to the best exact model ID.
 *
 * Matching strategy (in order):
 * 1. Exact match → return as-is
 * 2. Case-insensitive exact match
 * 3. Scored fuzzy match: prefix > substring, then priority desc, then version desc
 *
 * When priorities are equal, prefers higher version numbers (M2.7 > M2.5 > M2.1).
 * Returns null if no match found.
 */
export function fuzzyResolveModel(
  alias: string,
  config?: Partial<DiscussConfig>,
): string | null {
  const routesPath = config?.model_routes_path || getDefaultRoutesPath();
  const routes = loadModelRoutes(routesPath);
  const entries = Object.entries(routes);
  const lowerAlias = alias.toLowerCase();

  if (entries.length === 0) return null;

  // 1. Exact match
  if (routes[alias]) return alias;

  // 2. Case-insensitive exact
  const exactCi = entries.find(([id]) => id.toLowerCase() === lowerAlias);
  if (exactCi) return exactCi[0];

  // 2.5 Common shorthand aliases — keep this table tiny and explicit.
  if (lowerAlias === 'kimi' && routes['kimi-for-coding']) {
    return 'kimi-for-coding';
  }

  // 3. Scored fuzzy match — use_count first (matches MMS TUI behavior)
  type Candidate = { id: string; priority: number; useCount: number; matchScore: number };
  const candidates: Candidate[] = [];

  for (const [id, route] of entries) {
    const lower = id.toLowerCase();
    let matchScore = 0;
    if (lower.startsWith(lowerAlias)) {
      matchScore = 50; // prefix match: "qwen" matches "qwen3.5-plus"
    } else if (lower.includes(lowerAlias)) {
      matchScore = 10; // substring: weaker signal
    }
    if (matchScore > 0) {
      candidates.push({
        id,
        priority: route.priority ?? 0,
        useCount: (route as any).use_count ?? 0,
        matchScore,
      });
    }
  }

  if (candidates.length === 0) return null;

  // Sort: matchScore desc → use_count desc → priority desc
  // Matches MMS TUI: most-used model within the family wins
  candidates.sort((a, b) =>
    b.matchScore - a.matchScore
    || b.useCount - a.useCount
    || b.priority - a.priority
    || a.id.localeCompare(b.id),
  );

  return candidates[0].id;
}
