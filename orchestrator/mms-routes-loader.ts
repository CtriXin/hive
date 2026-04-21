// orchestrator/mms-routes-loader.ts — Read MMS model-routes.json (read-only, never writes)
// Fuzzy matching delegated to discuss-lib's fuzzyResolveModel for single-source logic.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fuzzyResolveModel } from './discuss-lib/config.js';
import { normalizeMmsRoutesPayload } from './mms-routes-contract.js';

export interface MmsRoute {
  anthropic_base_url: string;
  api_key: string;
  provider_id: string;
  use_count?: number;
  priority?: number;
  role: string;
  openai_base_url?: string;
  capabilities?: string[];
  native_clis?: string[];
  bridge_clis?: string[];
  cli_modes?: Record<string, string>;
  fallback_routes?: MmsFallbackRoute[];
}

export interface MmsFallbackRoute {
  anthropic_base_url: string;
  api_key: string;
  provider_id: string;
  use_count?: number;
  priority?: number;
  role: string;
  openai_base_url?: string;
  capabilities?: string[];
  native_clis?: string[];
  bridge_clis?: string[];
  cli_modes?: Record<string, string>;
}

export interface MmsRouteTable {
  _meta?: { generated_at: string; generator: string };
  routes: Record<string, MmsRoute>;
}

interface RouteCache {
  mtimeMs: number;
  table: MmsRouteTable;
}

function modelGatewayFamily(modelId: string): 'gpt' | 'gemini' | 'o-series' | null {
  if (/^gpt-/i.test(modelId)) return 'gpt';
  if (/^gemini-/i.test(modelId)) return 'gemini';
  if (/^o[134]-/i.test(modelId)) return 'o-series';
  return null;
}

function needsAnthropicShim(modelId: string): boolean {
  return modelGatewayFamily(modelId) !== null;
}

function isOpenAIOnlyRoute(route: MmsRoute): boolean {
  const raw = route.anthropic_base_url || '';
  if (!raw) return false;

  try {
    const pathname = new URL(raw).pathname.toLowerCase();
    return pathname === '/openai' || pathname.startsWith('/openai/');
  } catch {
    return /\/openai(?:\/|$)/i.test(raw);
  }
}

function findAnthropicShimFallback(
  table: MmsRouteTable,
  targetModelId: string,
): MmsRoute | null {
  const family = modelGatewayFamily(targetModelId);
  const candidates = Object.entries(table.routes)
    .filter(([id, route]) => {
      if (isOpenAIOnlyRoute(route)) return false;
      if (!needsAnthropicShim(id)) return false;
      return modelGatewayFamily(id) === family;
    })
    .sort((a, b) => (b[1].priority ?? 0) - (a[1].priority ?? 0));

  if (candidates.length > 0) {
    return candidates[0][1];
  }

  const genericGateway = Object.values(table.routes)
    .filter((route) => !isOpenAIOnlyRoute(route))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  return genericGateway[0] ?? null;
}

function normalizeResolvedRoute(
  modelId: string,
  route: MmsRoute,
  table: MmsRouteTable,
): MmsRoute {
  if (!needsAnthropicShim(modelId) || !isOpenAIOnlyRoute(route)) {
    return route;
  }

  const fallback = findAnthropicShimFallback(table, modelId);
  if (!fallback) {
    return route;
  }

  return {
    ...route,
    anthropic_base_url: fallback.anthropic_base_url,
    api_key: fallback.api_key,
    provider_id: fallback.provider_id,
  };
}

/**
 * Resolve the MMS config directory.
 * In sandboxed environments (e.g. Claude Code gateway), os.homedir() may point
 * to a nested sandbox dir. We check multiple candidate paths.
 */
function findMmsRoutesPath(): string {
  // env override
  if (process.env.MMS_ROUTES_PATH) {
    return process.env.MMS_ROUTES_PATH;
  }

  const candidates = [
    // Real user home (outside sandbox) — highest priority
    '/Users/' + (process.env.USER || process.env.LOGNAME || '') + '/.config/mms/model-routes.json',
    // Standard path (may be sandboxed)
    path.join(os.homedir(), '.config', 'mms', 'model-routes.json'),
  ];

  for (const candidate of candidates) {
    if (candidate && getMtimeMs(candidate) !== null) {
      return candidate;
    }
  }

  return candidates[0];
}

let resolvedPath: string | null = null;

function getMmsRoutesPath(): string {
  if (process.env.MMS_ROUTES_PATH) {
    return process.env.MMS_ROUTES_PATH;
  }
  if (!resolvedPath) {
    resolvedPath = findMmsRoutesPath();
  }
  return resolvedPath;
}

let cache: RouteCache | null = null;

function getMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

export function loadMmsRoutes(): MmsRouteTable | null {
  const routesPath = getMmsRoutesPath();
  const mtimeMs = getMtimeMs(routesPath);
  if (mtimeMs === null) {
    return null;
  }

  if (cache && cache.mtimeMs === mtimeMs) {
    return cache.table;
  }

  try {
    const raw = fs.readFileSync(routesPath, 'utf-8');
    const parsed = normalizeMmsRoutesPayload(JSON.parse(raw)) as MmsRouteTable | null;
    if (!parsed || !parsed.routes || typeof parsed.routes !== 'object') {
      return null;
    }
    cache = { mtimeMs, table: parsed };
    return parsed;
  } catch {
    return null;
  }
}

export interface ResolvedModelRoute {
  modelId: string;   // actual model ID resolved (may differ from input)
  route: MmsRoute;
}

function hasCapability(route: Pick<MmsRoute, 'capabilities'>, capability: string): boolean {
  return Array.isArray(route.capabilities) && route.capabilities.includes(capability);
}

export function getClaudeCliMode(route: Pick<MmsRoute, 'cli_modes' | 'capabilities' | 'bridge_clis'>): string {
  const cliMode = route.cli_modes?.claude?.trim().toLowerCase();
  if (cliMode) return cliMode;
  if (hasCapability(route, 'bridge_required')) return 'bridge';
  if (Array.isArray(route.bridge_clis) && route.bridge_clis.includes('claude')) return 'bridge';
  return 'direct';
}

export function isClaudeCodeDirectRoute(route: Pick<MmsRoute, 'cli_modes' | 'capabilities' | 'bridge_clis'>): boolean {
  const mode = getClaudeCliMode(route);
  return mode === 'direct' || mode === 'compat' || mode === 'native';
}

/**
 * Resolve a model ID to its MMS route.
 * Tries exact → case-insensitive → prefix (highest priority).
 * Returns both the resolved model ID and the route.
 */
export function resolveModelRouteFull(modelId: string): ResolvedModelRoute | null {
  const table = loadMmsRoutes();
  if (!table) {
    return null;
  }

  // Exact match
  if (table.routes[modelId]) {
    return { modelId, route: normalizeResolvedRoute(modelId, table.routes[modelId], table) };
  }

  // Case-insensitive match
  const lower = modelId.toLowerCase();
  for (const [key, route] of Object.entries(table.routes)) {
    if (key.toLowerCase() === lower) {
      return { modelId: key, route: normalizeResolvedRoute(key, route, table) };
    }
  }

  // Prefix fallback — 'minimax' → MiniMax-M2.7 (highest priority)
  return resolveModelByPrefix(modelId);
}

/**
 * Resolve a model ID with channel blacklist support.
 * If the primary route's provider is blacklisted, falls back to the first
 * non-blacklisted fallback route.
 */
export function resolveModelRouteFullWithBlacklist(
  modelId: string,
  blacklist?: string[],
): ResolvedModelRoute | null {
  const resolved = resolveModelRouteFull(modelId);
  if (!resolved || !blacklist?.length) {
    return resolved;
  }

  const isBlocked = (pid: string) =>
    blacklist.some((b) => b.trim().toLowerCase() === pid.trim().toLowerCase());

  if (!isBlocked(resolved.route.provider_id)) {
    return resolved;
  }

  // Primary blocked — try fallbacks in order
  for (const fb of resolved.route.fallback_routes || []) {
    if (!isBlocked(fb.provider_id)) {
      return {
        modelId: resolved.modelId,
        route: {
          ...resolved.route,
          anthropic_base_url: fb.anthropic_base_url,
          api_key: fb.api_key,
          provider_id: fb.provider_id,
          priority: fb.priority,
          role: fb.role,
        },
      };
    }
  }

  // All blocked
  return null;
}

/** Convenience: returns just the route (backward compat) */
export function resolveModelRoute(modelId: string): MmsRoute | null {
  return resolveModelRouteFull(modelId)?.route ?? null;
}

export function getAvailableModelIds(): string[] {
  const table = loadMmsRoutes();
  if (!table) {
    return [];
  }

  return Object.entries(table.routes)
    .sort((a, b) => (b[1].priority ?? 0) - (a[1].priority ?? 0))
    .map(([id]) => id);
}

/**
 * Resolve a fuzzy prefix (e.g. 'minimax', 'kimi', 'qwen') to the best
 * specific model ID in MMS routes. Picks the highest-priority match.
 *
 * Delegates matching to discuss-lib's fuzzyResolveModel (single-source),
 * then looks up the route in hive's own loaded MMS table.
 */
export function resolveModelByPrefix(
  prefix: string,
): { modelId: string; route: MmsRoute } | null {
  const table = loadMmsRoutes();
  if (!table) return null;

  // Fast path: exact match (no delegation needed)
  if (table.routes[prefix]) {
    return { modelId: prefix, route: normalizeResolvedRoute(prefix, table.routes[prefix], table) };
  }

  // Delegate fuzzy matching to discuss-lib, passing the same routes file
  const resolved = fuzzyResolveModel(prefix, {
    model_routes_path: getMmsRoutesPath(),
  });
  if (resolved && table.routes[resolved]) {
    return { modelId: resolved, route: normalizeResolvedRoute(resolved, table.routes[resolved], table) };
  }

  return null;
}

/**
 * Get fallback routes for a model (alternate channels for same model).
 * Used for channel retry before model downgrade on 429.
 */
export function getModelFallbackRoutes(modelId: string): MmsFallbackRoute[] {
  const route = resolveModelRoute(modelId);
  return route?.fallback_routes ?? [];
}

export function isMmsAvailable(): boolean {
  return loadMmsRoutes() !== null;
}

export function invalidateCache(): void {
  cache = null;
  resolvedPath = null;
}

export interface MmsRoutesMeta {
  file_path: string;
  exists: boolean;
  route_count: number;
  mtime_iso: string | null;
  size_bytes: number | null;
}

export function getMmsRoutesMeta(): MmsRoutesMeta {
  const routesPath = getMmsRoutesPath();
  const table = loadMmsRoutes();
  let mtimeIso: string | null = null;
  let sizeBytes: number | null = null;
  try {
    const stat = fs.statSync(routesPath);
    mtimeIso = new Date(stat.mtimeMs).toISOString();
    sizeBytes = stat.size;
  } catch {
    // ignore
  }
  return {
    file_path: routesPath,
    exists: getMtimeMs(routesPath) !== null,
    route_count: table ? Object.keys(table.routes).length : 0,
    mtime_iso: mtimeIso,
    size_bytes: sizeBytes,
  };
}

// ── MMS Channel Cache (read-only scan of ~/.config/mms/cache/models_*.json) ──

export interface MmsChannelCache {
  raw_models: string[];
  working_url: string | null;
  base_source: string;
  error: string | null;
  error_kind: string | null;
}

export interface MmsChannelInfo {
  id: string;
  raw_models: string[];
  model_count: number;
  working_url: string | null;
  base_source: string;
  error: string | null;
  error_kind: string | null;
  anthropic_base_url?: string;
  route_role: 'main' | 'fallback' | 'none';
}

function getMmsCacheDir(): string {
  const routesPath = getMmsRoutesPath();
  return path.join(path.dirname(routesPath), 'cache');
}

function loadMmsChannelCache(channelId: string): MmsChannelCache | null {
  const cacheDir = getMmsCacheDir();
  const filePath = path.join(cacheDir, `models_${channelId}.json`);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as MmsChannelCache;
  } catch {
    return null;
  }
}

export function listMmsChannels(): MmsChannelInfo[] {
  const cacheDir = getMmsCacheDir();
  if (!fs.existsSync(cacheDir)) return [];

  const table = loadMmsRoutes();
  const mainProviders = new Set<string>();
  const fallbackProviders = new Set<string>();

  if (table) {
    for (const route of Object.values(table.routes)) {
      mainProviders.add(route.provider_id);
      for (const fb of route.fallback_routes || []) {
        fallbackProviders.add(fb.provider_id);
      }
    }
  }

  // Load anthropic_base_urls.json for URL mapping
  // Values may be {url, ts} objects (not plain strings)
  let baseUrls: Record<string, { url: string; ts?: string }> = {};
  try {
    const baseUrlPath = path.join(cacheDir, 'anthropic_base_urls.json');
    const raw = fs.readFileSync(baseUrlPath, 'utf-8');
    baseUrls = JSON.parse(raw) as Record<string, { url: string; ts?: string }>;
  } catch {
    // ignore
  }

  const channels: MmsChannelInfo[] = [];

  for (const file of fs.readdirSync(cacheDir)) {
    const match = file.match(/^models_(.+)\.json$/);
    if (!match) continue;

    const channelId = match[1];
    const cache = loadMmsChannelCache(channelId);
    if (!cache) continue;

    const baseUrlKey = Object.keys(baseUrls).find((k) => k.startsWith(channelId + '::'));
    const baseUrlEntry = baseUrlKey ? baseUrls[baseUrlKey] : undefined;
    const anthropicBaseUrl = baseUrlEntry
      ? (typeof baseUrlEntry === 'string' ? baseUrlEntry : baseUrlEntry.url)
      : undefined;

    let role: 'main' | 'fallback' | 'none' = 'none';
    if (mainProviders.has(channelId)) role = 'main';
    else if (fallbackProviders.has(channelId)) role = 'fallback';

    channels.push({
      id: channelId,
      raw_models: cache.raw_models,
      model_count: cache.raw_models.length,
      working_url: cache.working_url,
      base_source: cache.base_source,
      error: cache.error,
      error_kind: cache.error_kind,
      anthropic_base_url: anthropicBaseUrl,
      route_role: role,
    });
  }

  return channels.sort((a, b) => {
    const roleOrder = { main: 0, fallback: 1, none: 2 };
    if (roleOrder[a.route_role] !== roleOrder[b.route_role]) {
      return roleOrder[a.route_role] - roleOrder[b.route_role];
    }
    return a.id.localeCompare(b.id);
  });
}
