// ═══════════════════════════════════════════════════════════════════
// orchestrator/provider-resolver.ts — 自包含 Provider 解析
// ═══════════════════════════════════════════════════════════════════
// 替代原 mms-bridge-resolver.ts
// 不依赖 MMS credentials.sh，从 config/providers.json 读取配置
// API key 通过环境变量注入
// ═══════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import type { ProviderEntry, ProvidersConfig } from './types.js';
import { loadConfig } from './hive-config.js';
import { resolveProjectPath } from './project-paths.js';

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
}

// ── Gateway mode 检测 ──

let gatewayCache: { url: string; token: string } | null | undefined = undefined;
let gatewayCacheKey: string | null = null;

function getFileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function getGatewayCacheKey(): string {
  const envUrl = process.env.HIVE_GATEWAY_URL || '';
  const envToken = process.env.HIVE_GATEWAY_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || '';
  const config = loadConfig(process.cwd());
  return JSON.stringify({
    envUrl,
    envToken,
    configUrl: config.gateway?.url || '',
    configTokenEnv: config.gateway?.auth_token_env || '',
  });
}

/**
 * 检测是否配置了 gateway 模式
 * 优先级: env HIVE_GATEWAY_URL > hive-config.json gateway 字段
 */
function resolveGateway(): { url: string; token: string } | null {
  const cacheKey = getGatewayCacheKey();
  if (gatewayCache !== undefined && gatewayCacheKey === cacheKey) {
    return gatewayCache;
  }

  // 1. 环境变量优先
  const envUrl = process.env.HIVE_GATEWAY_URL;
  const envToken = process.env.HIVE_GATEWAY_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || '';
  if (envUrl) {
    gatewayCacheKey = cacheKey;
    gatewayCache = { url: envUrl.replace(/\/+$/, ''), token: envToken };
    return gatewayCache;
  }

  // 2. 从 hive config 读
  try {
    const config = loadConfig(process.cwd());
    if (config.gateway?.url) {
      const token = process.env[config.gateway.auth_token_env] || '';
      gatewayCacheKey = cacheKey;
      gatewayCache = { url: config.gateway.url.replace(/\/+$/, ''), token };
      return gatewayCache;
    }
  } catch {
    // ignore
  }

  gatewayCacheKey = cacheKey;
  gatewayCache = null;
  return null;
}

/**
 * 是否处于 gateway 模式
 */
export function isGatewayMode(): boolean {
  return resolveGateway() !== null;
}

/**
 * 解析 provider 配置，返回可用的 baseUrl 和 apiKey
 *
 * Gateway 模式：所有 provider 统一走 gateway，不需要单独 API key
 * 直连模式：从 providers.json 读取各 provider 端点和 API key
 *
 * @param providerId - provider ID，如 "bailian-codingplan"、"deepseek"
 * @returns { baseUrl, apiKey }
 * @throws 如果 provider 不存在或配置不完整
 */
export function resolveProvider(providerId: string): ResolvedProvider {
  // ── Gateway 模式：所有 provider 走网关 ──
  const gateway = resolveGateway();
  if (gateway) {
    return { baseUrl: gateway.url, apiKey: gateway.token };
  }

  // ── 直连模式：按 provider 解析 ──
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
    console.warn(
      `⚠️ API key not set for provider "${providerId}": ` +
      `export ${apiKeyEnvVar}="your-key"`
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
    return { baseUrl: provider.anthropic_base_url, apiKey };
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

/**
 * 检查 provider 是否可达
 *
 * Gateway 模式下检查网关本身是否可达（只检查一次，缓存结果）
 * 直连模式下检查各 provider 的 /v1/models 端点
 *
 * @param providerId - provider ID
 * @returns true 如果端点可达（非 5xx 错误）
 */
let gatewayHealthCache: boolean | null = null;

export async function checkProviderHealth(providerId: string): Promise<boolean> {
  try {
    const gateway = resolveGateway();

    // Gateway 模式：检查网关可达性（缓存结果避免重复请求）
    if (gateway) {
      if (gatewayHealthCache !== null) return gatewayHealthCache;
      const response = await fetch(`${gateway.url}/v1/models`, {
        headers: {
          'Authorization': `Bearer ${gateway.token}`,
          'x-api-key': gateway.token,
        },
        signal: AbortSignal.timeout(5000),
      });
      gatewayHealthCache = response.status < 500;
      return gatewayHealthCache;
    }

    // 直连模式
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
  gatewayCache = undefined;
  gatewayHealthCache = null;
}

// ── 导出类型 ──

export type { ProviderEntry, ProvidersConfig };
