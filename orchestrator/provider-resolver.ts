// ═══════════════════════════════════════════════════════════════════
// orchestrator/provider-resolver.ts — Provider 解析
// ═══════════════════════════════════════════════════════════════════
// 2-level resolution: MMS model-routes.json → config/providers.json
// API key 通过 MMS 路由或环境变量注入
// ═══════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import type { ProviderEntry, ProvidersConfig } from './types.js';
import { loadConfig } from './hive-config.js';
import { normalizeModelId } from './model-defaults.js';
import { resolveProjectPath } from './project-paths.js';
import {
  isClaudeCodeDirectRoute,
  resolveModelRouteFull,
  invalidateCache as invalidateMmsCache,
} from './mms-routes-loader.js';

// ── 配置加载 ──

let providersCache: ProvidersConfig | null = null;
let providersPathCache: string | null = null;
let providersMtimeCache: number | null = null;

function getProvidersPath(): string {
  try {
    const config = loadConfig(process.cwd());
    if (config.providers_path) {
      return path.resolve(config.providers_path);
    }
  } catch {
    // ignore config read failure and fall back to project config
  }
  return resolveProjectPath('config', 'providers.json');
}

function loadProviders(): ProvidersConfig {
  const providersPath = getProvidersPath();
  const currentMtime = getFileMtimeMs(providersPath);
  if (!providersCache || providersPathCache !== providersPath || providersMtimeCache !== currentMtime) {
    try {
      const raw = fs.readFileSync(providersPath, 'utf-8');
      providersCache = JSON.parse(raw);
      providersPathCache = providersPath;
      providersMtimeCache = currentMtime;
    } catch (err: any) {
      throw new Error(
        `Failed to load providers.json from ${providersPath}: ${err.message}`
      );
    }
  }
  return providersCache!;
}

// ── Provider 解析 ──

export interface ResolvedProvider {
  baseUrl: string;
  apiKey: string;
  routeMode?: 'direct' | 'bridge';
  source?: 'mms' | 'providers';
  providerId?: string;
}

export class UnsupportedMmsTransportError extends Error {
  modelId: string;
  cliMode: string;

  constructor(modelId: string, cliMode: string) {
    super(
      `MMS route for model "${modelId}" requires ${cliMode} transport for Claude Code SDK; direct provider mode is not allowed.`,
    );
    this.name = 'UnsupportedMmsTransportError';
    this.modelId = modelId;
    this.cliMode = cliMode;
  }
}

export function isUnsupportedMmsTransportError(error: unknown): error is UnsupportedMmsTransportError {
  return error instanceof UnsupportedMmsTransportError;
}

function getFileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function assertDirectClaudeRoute(
  modelId: string,
  route: Parameters<typeof isClaudeCodeDirectRoute>[0],
): void {
  if (isClaudeCodeDirectRoute(route)) return;
  const cliMode = route.cli_modes?.claude?.trim()?.toLowerCase()
    || (Array.isArray(route.capabilities) && route.capabilities.includes('bridge_required') ? 'bridge' : 'unsupported');
  throw new UnsupportedMmsTransportError(modelId, cliMode);
}

function isGatewayFamilyModel(modelId: string): boolean {
  return /^(gpt-|gemini-|o[134]-)/i.test(normalizeModelId(modelId));
}

function normalizeProviderId(providerId?: string): string {
  return (providerId || '').trim().toLowerCase();
}

function assertResolvedRouteUrl(modelId: string, routeBaseUrl: string): void {
  if (!routeBaseUrl || !/^https?:\/\//i.test(routeBaseUrl)) {
    throw new Error(`Model "${modelId}" resolved to an invalid provider URL: ${routeBaseUrl || '(empty)'}`);
  }

  if (isGatewayFamilyModel(modelId)) {
    return;
  }

  let routePath = '';
  try {
    routePath = new URL(routeBaseUrl).pathname.replace(/\/+$/, '');
  } catch {
    routePath = '';
  }
  const routeLooksClaudeCompatible = routePath === ''
    || routePath === '/'
    || routePath.endsWith('/anthropic');
  if (!routeLooksClaudeCompatible) {
    throw new Error(
      `Model "${modelId}" resolved to non-Claude-compatible base URL "${routeBaseUrl}". `
      + 'Expected a direct Anthropic-compatible route ending with /anthropic.'
    );
  }
}

function buildResolvedProviderFromMms(
  modelId: string,
  route: {
    anthropic_base_url: string;
    api_key: string;
    provider_id: string;
    cli_modes?: Record<string, string>;
    capabilities?: string[];
    bridge_clis?: string[];
  },
): ResolvedProvider {
  assertDirectClaudeRoute(modelId, route);
  assertResolvedRouteUrl(modelId, route.anthropic_base_url);
  return {
    baseUrl: route.anthropic_base_url,
    apiKey: route.api_key,
    routeMode: 'direct',
    source: 'mms',
    providerId: route.provider_id,
  };
}

function selectPinnedMmsRoute(
  resolved: NonNullable<ReturnType<typeof resolveModelRouteFull>>,
  providerId: string,
): {
  anthropic_base_url: string;
  api_key: string;
  provider_id: string;
  cli_modes?: Record<string, string>;
  capabilities?: string[];
  bridge_clis?: string[];
} | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return resolved.route;
  }

  if (normalizeProviderId(resolved.route.provider_id) === normalizedProviderId) {
    return resolved.route;
  }

  const matchedFallback = (resolved.route.fallback_routes || []).find(
    (fallback) => normalizeProviderId(fallback.provider_id) === normalizedProviderId,
  );
  if (!matchedFallback) {
    return null;
  }

  return matchedFallback;
}

/**
 * 解析 provider 配置，返回可用的 baseUrl 和 apiKey
 *
 * 2-level resolution chain:
 *   1. MMS model-routes.json (per-model endpoint+key, highest priority)
 *   2. Hive config/providers.json (fallback)
 *
 * @param providerId - provider ID，如 "bailian-codingplan"、"deepseek"
 * @param modelId - optional model ID for MMS route lookup
 * @returns { baseUrl, apiKey }
 * @throws 如果 provider 不存在或配置不完整
 */
export function resolveProvider(
  providerId: string,
  modelId?: string,
): ResolvedProvider {
  // ── Level 1: MMS model-routes.json ──
  if (modelId) {
    const resolved = resolveModelRouteFull(modelId);
    if (resolved) {
      const selectedRoute = selectPinnedMmsRoute(resolved, providerId);
      if (selectedRoute) {
        return buildResolvedProviderFromMms(resolved.modelId, selectedRoute);
      }
    }
  }

  // ── Level 2: Hive config/providers.json ──
  const config = loadProviders();
  const provider = config.providers[providerId];

  if (!provider) {
    const known = Object.keys(config.providers).join(', ');
    throw new Error(
      `Unknown provider: "${providerId}". Known providers: ${known}`
    );
  }

  // 读取 API key（从环境变量）
  const apiKeyEnvVar = provider.api_key_env;
  const apiKey = process.env[apiKeyEnvVar] || '';

  if (!apiKey) {
    throw new Error(
      `API key not configured for provider "${providerId}".\n` +
      `Fix: export ${apiKeyEnvVar}="your-key"\n` +
      `Or add it to your shell profile (~/.zshrc / ~/.bashrc).`
    );
  }

  // 判断协议类型
  const protocol = provider.protocol || 'anthropic_native';

  // Anthropic 原生协议（或同时支持）
  if (protocol === 'anthropic_native' || protocol === 'both') {
    if (!provider.anthropic_base_url) {
      throw new Error(
        `Provider "${providerId}" claims anthropic_native but missing anthropic_base_url`
      );
    }
    return {
      baseUrl: provider.anthropic_base_url,
      apiKey,
      routeMode: 'direct',
      source: 'providers',
      providerId: provider.id,
    };
  }

  // OpenAI only 协议 → 需要本地 adapter
  if (protocol === 'openai_only') {
    return resolveOpenAIProvider(provider, apiKey);
  }

  throw new Error(
    `Provider "${providerId}": unknown protocol "${protocol}". ` +
    `Expected: anthropic_native | openai_only | both`
  );
}

/**
 * Resolve provider for a model ID directly (MMS-first, then providerId fallback).
 * Convenience wrapper for callers that only have a modelId.
 */
export function resolveProviderForModel(modelId: string): ResolvedProvider {
  // Try MMS route first
  const resolved = resolveModelRouteFull(modelId);
  if (resolved) {
    return buildResolvedProviderFromMms(resolved.modelId, resolved.route);
  }

  // No MMS route — caller needs to know the providerId
  throw new Error(
    `No MMS route found for model "${modelId}" and no providerId specified.\n` +
    `Fix: ensure ~/.config/mms/model-routes.json contains a route for "${modelId}",\n` +
    `or set MMS_ROUTES_PATH env var, or specify a providerId from config/providers.json.`
  );
}

export function getAllProviders(): Record<string, ProviderEntry> {
  return loadProviders().providers;
}

/**
 * 处理 openai_only 类型的 provider
 * 启动或复用本地 protocol adapter
 */
function resolveOpenAIProvider(
  provider: ProviderEntry,
  apiKey: string,
): ResolvedProvider {
  const envVarName = `CLI2CLI_ADAPTER_PORT_${provider.id.toUpperCase().replace(/-/g, '_')}`;
  const adapterPort = process.env[envVarName];

  // 已有 adapter 在运行
  if (adapterPort) {
    const port = parseInt(adapterPort, 10);
    if (!isNaN(port)) {
      return {
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey,
      };
    }
  }

  // MVP：提示用户手动启动 adapter
  // 未来可扩展为自动 spawn 子进程
  const port = 8901; // 默认端口
  throw new Error(
    `Provider "${provider.id}" only supports OpenAI protocol.\n` +
    `Start the protocol adapter first:\n\n` +
    `  ${envVarName}=${port} node dist/orchestrator/protocol-adapter.js --provider ${provider.id} --port ${port}\n\n` +
    `Or set the env var if already running:\n` +
    `  export ${envVarName}=${port}`
  );
}

// ── Health Check ──

export interface QuickPingResult {
  ok: boolean;
  ms: number;
  error?: string;
}

/**
 * Lightweight preflight check — POST /v1/messages with max_tokens:1.
 * Returns in < timeoutMs. Zero useful tokens consumed.
 * Non-Anthropic models (GPT, Gemini) need MMS gateway for protocol adaptation,
 * so ping through MMS gateway instead of direct endpoint.
 */
export async function quickPing(
  modelId: string,
  timeoutMs = 3000,
  providerId?: string,
): Promise<QuickPingResult> {
  const start = Date.now();
  try {
    const canonicalModelId = normalizeModelId(modelId);
    let url: string;
    let apiKey: string;
    try {
      const resolved = resolveProvider(providerId || '', canonicalModelId);
      url = resolved.baseUrl.replace(/\/v1\/?$/, '') + '/v1/messages';
      apiKey = resolved.apiKey;
    } catch (err) {
      if (!isGatewayFamilyModel(canonicalModelId)) {
        throw err;
      }
      const mmsBase = process.env.ANTHROPIC_BASE_URL;
      if (!mmsBase) return { ok: true, ms: 0 }; // Can't ping, assume ok
      url = mmsBase.replace(/\/v1\/?$/, '') + '/v1/messages';
      apiKey = process.env.ANTHROPIC_AUTH_TOKEN || '';
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: canonicalModelId,
        max_tokens: 1,
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - start;
    const ok = resp.status >= 200 && resp.status < 300;
    return { ok, ms, error: ok ? undefined : `HTTP ${resp.status}` };
  } catch (err: any) {
    const ms = Date.now() - start;
    const error = ms >= timeoutMs ? 'TIMEOUT' : err.message?.slice(0, 80);
    return { ok: false, ms, error };
  }
}

/**
 * 检查 provider 是否可达
 * 通过 MMS route 或 providers.json 解析后检查 /v1/models 端点
 */
export async function checkProviderHealth(providerId: string): Promise<boolean> {
  try {
    const { baseUrl, apiKey } = resolveProvider(providerId);
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'x-api-key': apiKey,
      },
      signal: AbortSignal.timeout(5000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

// ── 刷新缓存 ──

/**
 * 清除 provider 缓存，下次调用 resolveProvider 时重新加载
 */
export function reloadProviders(): void {
  providersCache = null;
  providersPathCache = null;
  invalidateMmsCache();
}

// ── 导出类型 ──

export type { ProviderEntry, ProvidersConfig };
