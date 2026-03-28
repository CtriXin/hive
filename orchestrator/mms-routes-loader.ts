// orchestrator/mms-routes-loader.ts — Read MMS model-routes.json (read-only, never writes)
// Fuzzy matching delegated to hive-discuss's fuzzyResolveModel for single-source logic.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fuzzyResolveModel } from 'hive-discuss';

export interface MmsRoute {
  anthropic_base_url: string;
  api_key: string;
  provider_id: string;
  priority: number;
  role: string;
}

export interface MmsRouteTable {
  _meta?: { generated_at: string; generator: string };
  routes: Record<string, MmsRoute>;
}

interface RouteCache {
  mtimeMs: number;
  table: MmsRouteTable;
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
    return { modelId, route: table.routes[modelId] };
  }

  // Case-insensitive match
  const lower = modelId.toLowerCase();
  for (const [key, route] of Object.entries(table.routes)) {
    if (key.toLowerCase() === lower) {
      return { modelId: key, route };
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
 * Delegates matching to hive-discuss's fuzzyResolveModel (single-source),
 * then looks up the route in hive's own loaded MMS table.
 */
export function resolveModelByPrefix(
  prefix: string,
): { modelId: string; route: MmsRoute } | null {
  const table = loadMmsRoutes();
  if (!table) return null;

  // Fast path: exact match (no delegation needed)
  if (table.routes[prefix]) {
    return { modelId: prefix, route: table.routes[prefix] };
  }

  // Delegate fuzzy matching to hive-discuss, passing the same routes file
  const resolved = fuzzyResolveModel(prefix, {
    model_routes_path: getMmsRoutesPath(),
  });
  if (resolved && table.routes[resolved]) {
    return { modelId: resolved, route: table.routes[resolved] };
  }

  return null;
}

export function isMmsAvailable(): boolean {
  return loadMmsRoutes() !== null;
}

export function invalidateCache(): void {
  cache = null;
  resolvedPath = null;
}
