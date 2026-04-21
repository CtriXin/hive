export interface RawMmsRouteLeaf {
  provider_id?: string;
  anthropic_base_url?: string;
  openai_base_url?: string;
  api_key?: string;
  use_count?: number;
  priority?: number;
  role?: string;
  capabilities?: string[];
  native_clis?: string[];
  bridge_clis?: string[];
  cli_modes?: Record<string, string>;
}

export interface RawMmsRouteEntry extends RawMmsRouteLeaf {
  primary?: RawMmsRouteLeaf;
  fallbacks?: RawMmsRouteLeaf[];
  fallback_routes?: RawMmsRouteLeaf[];
}

export interface NormalizedMmsRouteLeaf {
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

export interface NormalizedMmsRoute extends NormalizedMmsRouteLeaf {
  fallback_routes?: NormalizedMmsRouteLeaf[];
}

export interface NormalizedMmsRouteTable {
  _meta?: { generated_at: string; generator: string };
  routes: Record<string, NormalizedMmsRoute>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLeafRoute(
  value: unknown,
  fallbackRole: string,
): NormalizedMmsRouteLeaf | null {
  if (!isRecord(value)) return null;

  return {
    anthropic_base_url: typeof value.anthropic_base_url === 'string' ? value.anthropic_base_url : '',
    api_key: typeof value.api_key === 'string' ? value.api_key : '',
    provider_id: typeof value.provider_id === 'string' ? value.provider_id : '',
    ...(typeof value.use_count === 'number' ? { use_count: value.use_count } : {}),
    ...(typeof value.priority === 'number' ? { priority: value.priority } : {}),
    role: typeof value.role === 'string' && value.role.trim() ? value.role : fallbackRole,
    ...(typeof value.openai_base_url === 'string' ? { openai_base_url: value.openai_base_url } : {}),
    ...(Array.isArray(value.capabilities) ? { capabilities: value.capabilities.filter((item): item is string => typeof item === 'string') } : {}),
    ...(Array.isArray(value.native_clis) ? { native_clis: value.native_clis.filter((item): item is string => typeof item === 'string') } : {}),
    ...(Array.isArray(value.bridge_clis) ? { bridge_clis: value.bridge_clis.filter((item): item is string => typeof item === 'string') } : {}),
    ...(isRecord(value.cli_modes)
      ? {
        cli_modes: Object.fromEntries(
          Object.entries(value.cli_modes)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        ),
      }
      : {}),
  };
}

function normalizeRouteEntry(value: unknown): NormalizedMmsRoute | null {
  if (!isRecord(value)) return null;

  const rawPrimary = isRecord(value.primary) ? value.primary : value;
  const primary = normalizeLeafRoute(rawPrimary, 'primary');
  if (!primary) return null;

  const rawFallbacks = Array.isArray(value.fallbacks)
    ? value.fallbacks
    : (Array.isArray(value.fallback_routes) ? value.fallback_routes : []);
  const fallbackRoutes = rawFallbacks
    .map((fallback) => normalizeLeafRoute(fallback, 'fallback'))
    .filter((item): item is NormalizedMmsRouteLeaf => item !== null);

  return fallbackRoutes.length > 0
    ? { ...primary, fallback_routes: fallbackRoutes }
    : primary;
}

export function normalizeMmsRoutesPayload(raw: unknown): NormalizedMmsRouteTable | null {
  if (!isRecord(raw) || !isRecord(raw.routes)) {
    return null;
  }

  const normalizedRoutes: Record<string, NormalizedMmsRoute> = {};
  for (const [modelId, entry] of Object.entries(raw.routes)) {
    const normalized = normalizeRouteEntry(entry);
    if (normalized) {
      normalizedRoutes[modelId] = normalized;
    }
  }

  return {
    _meta: {
      generated_at:
        (isRecord(raw._meta) && typeof raw._meta.generated_at === 'string' ? raw._meta.generated_at : undefined)
        || (typeof raw.generated_at === 'string' ? raw.generated_at : '')
        || new Date(0).toISOString(),
      generator:
        (isRecord(raw._meta) && typeof raw._meta.generator === 'string' ? raw._meta.generator : undefined)
        || 'mms-contract',
    },
    routes: normalizedRoutes,
  };
}
