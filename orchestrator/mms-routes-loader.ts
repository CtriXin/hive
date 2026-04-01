// orchestrator/mms-routes-loader.ts — Read MMS model-routes.json (read-only, never writes)
// Fuzzy matching delegated to discuss-lib's fuzzyResolveModel for single-source logic.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fuzzyResolveModel } from './discuss-lib/config.js';

export interface MmsRoute {
  anthropic_base_url: string;
  api_key: string;
  provider_id: string;
  priority: number;
  role: string;
  openai_base_url?: string;
  fallback_routes?: MmsFallbackRoute[];
}

export interface MmsFallbackRoute {
  anthropic_base_url: string;
  api_key: string;
  provider_id: string;
  priority: number;
  role: string;
  openai_base_url?: string;
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
    // Standard path
    path.join(os.homedir(), '.config', 'mms', 'model-routes.json'),
    // Real user home (outside sandbox)
    '/Users/' + (process.env.USER || process.env.LOGNAME || '') + '/.config/mms/model-routes.json',
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
    const parsed = JSON.parse(raw) as MmsRouteTable;
    if (!parsed.routes || typeof parsed.routes !== 'object') {
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
