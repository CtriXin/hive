import { listMmsChannels, loadMmsRoutes } from './mms-routes-loader.js';

export type ModelChannelMap = Record<string, string>;

export interface ModelChannelPolicyMatch {
  pattern: string;
  selector: string;
}

export interface ChannelSelectorOption {
  provider_id: string;
  display_name: string;
  aliases: string[];
  anthropic_base_url?: string;
  openai_base_url?: string;
  working_url?: string | null;
  route_role: 'main' | 'fallback' | 'none';
}

export type ChannelSelectorResolution =
  | {
    status: 'resolved';
    selector: string;
    provider_id: string;
    matched_by: 'provider_id' | 'alias' | 'host' | 'contains';
    option: ChannelSelectorOption;
  }
  | {
    status: 'missing';
    selector: string;
    candidates: string[];
  }
  | {
    status: 'ambiguous';
    selector: string;
    candidates: string[];
  };

const KEYWORD_ALIASES = [
  'newapi',
  'crs',
  'cpa',
  'openai',
  'anthropic',
  'codex',
  'azure',
  'tokyo',
  'singapore',
  'sg',
  'hk',
  'us',
  'local',
];

const STOPWORDS = new Set([
  'api',
  'apps',
  'https',
  'http',
  'www',
  'com',
  'xyz',
  'ai',
  'io',
  'cn',
  'net',
  'org',
]);

function escapeRegex(pattern: string): string {
  return pattern.replace(/[|\\{}()[\]^$+?.*]/g, '\\$&');
}

function addAlias(target: Set<string>, value: string | null | undefined): void {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized.length < 2) return;
  target.add(normalized);
}

function extractHost(rawUrl?: string | null): string | undefined {
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function collectTextTokens(value: string | null | undefined): string[] {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return [];

  const tokens = new Set<string>();
  normalized
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .forEach((token) => {
      if (!STOPWORDS.has(token) && token.length >= 2) {
        tokens.add(token);
      }
    });

  for (const keyword of KEYWORD_ALIASES) {
    if (normalized.includes(keyword)) {
      tokens.add(keyword);
    }
  }

  return [...tokens];
}

export function normalizeModelChannelMap(value: unknown): ModelChannelMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalizedEntries = Object.entries(value as Record<string, unknown>)
    .map(([pattern, selector]) => [
      String(pattern || '').trim().toLowerCase(),
      String(selector || '').trim().toLowerCase(),
    ] as const)
    .filter(([pattern, selector]) => Boolean(pattern) && Boolean(selector));

  return Object.fromEntries(normalizedEntries);
}

export function matchModelChannelMapEntry(
  modelChannelMap: ModelChannelMap | undefined,
  modelId: string,
): ModelChannelPolicyMatch | null {
  const normalizedMap = normalizeModelChannelMap(modelChannelMap);
  const normalizedModelId = String(modelId || '').trim().toLowerCase();
  if (!normalizedModelId) return null;

  let best: { pattern: string; selector: string; exact: boolean; specificity: number } | null = null;

  for (const [pattern, selector] of Object.entries(normalizedMap)) {
    const regex = new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, '.*')}$`, 'i');
    if (!regex.test(normalizedModelId)) continue;

    const exact = !pattern.includes('*') && pattern === normalizedModelId;
    const specificity = pattern.replace(/\*/g, '').length;
    if (!best
      || (exact && !best.exact)
      || (exact === best.exact && specificity > best.specificity)
    ) {
      best = { pattern, selector, exact, specificity };
    }
  }

  return best ? { pattern: best.pattern, selector: best.selector } : null;
}

export function listModelChannelOptions(): ChannelSelectorOption[] {
  const byProvider = new Map<string, {
    provider_id: string;
    display_name: string;
    aliases: Set<string>;
    anthropic_base_url?: string;
    openai_base_url?: string;
    working_url?: string | null;
    route_role: 'main' | 'fallback' | 'none';
  }>();

  for (const channel of listMmsChannels()) {
    const entry = byProvider.get(channel.id) || {
      provider_id: channel.id,
      display_name: channel.id,
      aliases: new Set<string>(),
      route_role: channel.route_role,
    };
    entry.route_role = entry.route_role === 'main' ? 'main' : channel.route_role;
    entry.anthropic_base_url ||= channel.anthropic_base_url;
    entry.working_url ||= channel.working_url;

    addAlias(entry.aliases, channel.id);
    addAlias(entry.aliases, extractHost(channel.anthropic_base_url));
    addAlias(entry.aliases, extractHost(channel.working_url || undefined));
    collectTextTokens(channel.id).forEach((token) => addAlias(entry.aliases, token));
    collectTextTokens(extractHost(channel.anthropic_base_url)).forEach((token) => addAlias(entry.aliases, token));
    collectTextTokens(extractHost(channel.working_url || undefined)).forEach((token) => addAlias(entry.aliases, token));
    byProvider.set(channel.id, entry);
  }

  const table = loadMmsRoutes();
  if (table) {
    const registerRoute = (
      providerId: string,
      anthropicBaseUrl?: string,
      openaiBaseUrl?: string,
      routeRole: 'main' | 'fallback' = 'main',
    ) => {
      const entry = byProvider.get(providerId) || {
        provider_id: providerId,
        display_name: providerId,
        aliases: new Set<string>(),
        route_role: routeRole,
      };
      if (entry.route_role !== 'main') {
        entry.route_role = routeRole;
      }
      entry.anthropic_base_url ||= anthropicBaseUrl;
      entry.openai_base_url ||= openaiBaseUrl;
      addAlias(entry.aliases, providerId);
      addAlias(entry.aliases, extractHost(anthropicBaseUrl));
      addAlias(entry.aliases, extractHost(openaiBaseUrl));
      collectTextTokens(providerId).forEach((token) => addAlias(entry.aliases, token));
      collectTextTokens(extractHost(anthropicBaseUrl)).forEach((token) => addAlias(entry.aliases, token));
      collectTextTokens(extractHost(openaiBaseUrl)).forEach((token) => addAlias(entry.aliases, token));
      byProvider.set(providerId, entry);
    };

    for (const route of Object.values(table.routes)) {
      registerRoute(route.provider_id, route.anthropic_base_url, route.openai_base_url, 'main');
      for (const fallbackRoute of route.fallback_routes || []) {
        registerRoute(
          fallbackRoute.provider_id,
          fallbackRoute.anthropic_base_url,
          fallbackRoute.openai_base_url,
          'fallback',
        );
      }
    }
  }

  return [...byProvider.values()]
    .map((entry) => ({
      provider_id: entry.provider_id,
      display_name: entry.display_name,
      aliases: [...entry.aliases].sort(),
      anthropic_base_url: entry.anthropic_base_url,
      openai_base_url: entry.openai_base_url,
      working_url: entry.working_url,
      route_role: entry.route_role,
    }))
    .sort((a, b) => a.provider_id.localeCompare(b.provider_id));
}

export function resolveChannelSelector(selector: string): ChannelSelectorResolution {
  const normalizedSelector = String(selector || '').trim().toLowerCase();
  const options = listModelChannelOptions();
  if (!normalizedSelector) {
    return { status: 'missing', selector: normalizedSelector, candidates: [] };
  }

  const exactMatches = options.filter((option) =>
    option.provider_id.toLowerCase() === normalizedSelector
    || option.aliases.includes(normalizedSelector)
    || extractHost(option.anthropic_base_url) === normalizedSelector
    || extractHost(option.openai_base_url) === normalizedSelector
    || extractHost(option.working_url || undefined) === normalizedSelector,
  );

  if (exactMatches.length === 1) {
    const [option] = exactMatches;
    const matchedBy = option.provider_id.toLowerCase() === normalizedSelector
      ? 'provider_id'
      : (option.aliases.includes(normalizedSelector) ? 'alias' : 'host');
    return {
      status: 'resolved',
      selector: normalizedSelector,
      provider_id: option.provider_id,
      matched_by: matchedBy,
      option,
    };
  }

  if (exactMatches.length > 1) {
    return {
      status: 'ambiguous',
      selector: normalizedSelector,
      candidates: exactMatches.map((option) => option.provider_id).sort(),
    };
  }

  const fuzzyMatches = options.filter((option) =>
    option.provider_id.toLowerCase().includes(normalizedSelector)
    || option.aliases.some((alias) => alias.includes(normalizedSelector)),
  );

  if (fuzzyMatches.length === 1) {
    const [option] = fuzzyMatches;
    return {
      status: 'resolved',
      selector: normalizedSelector,
      provider_id: option.provider_id,
      matched_by: 'contains',
      option,
    };
  }

  if (fuzzyMatches.length > 1) {
    return {
      status: 'ambiguous',
      selector: normalizedSelector,
      candidates: fuzzyMatches.map((option) => option.provider_id).sort(),
    };
  }

  return {
    status: 'missing',
    selector: normalizedSelector,
    candidates: options.map((option) => option.provider_id).sort(),
  };
}

export function resolveConfiguredChannelProvider(
  modelChannelMap: ModelChannelMap | undefined,
  modelId: string,
): (ModelChannelPolicyMatch & ChannelSelectorResolution) | null {
  const match = matchModelChannelMapEntry(modelChannelMap, modelId);
  if (!match) return null;
  const resolution = resolveChannelSelector(match.selector);
  return { ...match, ...resolution };
}

export function validateModelChannelMap(modelChannelMap: ModelChannelMap | undefined): void {
  const normalized = normalizeModelChannelMap(modelChannelMap);
  const table = loadMmsRoutes();
  for (const [pattern, selector] of Object.entries(normalized)) {
    const resolution = resolveChannelSelector(selector);
    if (resolution.status === 'ambiguous') {
      throw new Error(
        `model_channel_map "${pattern}" -> "${selector}" is ambiguous; matches: ${resolution.candidates.join(', ')}`,
      );
    }
    if (resolution.status === 'missing') {
      throw new Error(
        `model_channel_map "${pattern}" -> "${selector}" does not match any MMS channel`,
      );
    }

    if (!table?.routes) continue;

    const regex = new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, '.*')}$`, 'i');
    for (const [modelId, route] of Object.entries(table.routes)) {
      if (!regex.test(modelId)) continue;
      const availableProviders = new Set<string>([
        route.provider_id,
        ...(route.fallback_routes || []).map((fallbackRoute) => fallbackRoute.provider_id),
      ]);
      if (!availableProviders.has(resolution.provider_id)) {
        throw new Error(
          `model_channel_map "${pattern}" -> "${selector}" is not available for model "${modelId}" in MMS routes`,
        );
      }
    }
  }
}
