import fs from 'fs';
import path from 'path';
import { getConfigSource, loadConfig, readJsonSafe } from './hive-config.js';
import { ModelRegistry } from './model-registry.js';
import { getMmsRoutesMeta, loadMmsRoutes } from './mms-routes-loader.js';
import { matchModelChannelMapEntry, resolveConfiguredChannelProvider } from './model-channel-policy.js';
import { quickPing, resolveProviderForModel } from './provider-resolver.js';
import type { HiveConfig } from './types.js';

export interface DoctorScopeSummary {
  scope: 'global' | 'project';
  path: string | null;
  exists: boolean;
  model_channel_rule_count: number;
  model_blacklist_count: number;
  channel_blacklist_count: number;
}

export interface DoctorModelCheck {
  model_id: string;
  configured_pattern?: string;
  configured_selector?: string;
  configured_status?: 'resolved' | 'missing' | 'ambiguous';
  routing_mode?: 'mapped' | 'auto';
  resolved_provider_id?: string;
  resolved_source?: 'mms' | 'providers';
  ping_ok?: boolean;
  ping_error?: string;
  transport_warning?: string;
  status: 'ok' | 'warn' | 'error';
}

export interface HiveDoctorReport {
  generated_at: string;
  cwd: string;
  repo_root: string | null;
  web_hint: string;
  mms: {
    file_path: string;
    exists: boolean;
    route_count: number;
    mtime_iso: string | null;
    size_bytes: number | null;
  };
  config: {
    global: DoctorScopeSummary;
    project: DoctorScopeSummary;
    effective: {
      model_channel_rule_count: number;
      model_blacklist_count: number;
      channel_blacklist_count: number;
    };
  };
  models: DoctorModelCheck[];
  warnings: string[];
  suggestions: string[];
}

interface BuildDoctorOptions {
  modelIds?: string[];
  ping?: boolean;
}

async function pingForDoctor(modelId: string): Promise<Awaited<ReturnType<typeof quickPing>>> {
  const attempts = [5000, 5000, 5000];
  let lastResult: Awaited<ReturnType<typeof quickPing>> | null = null;
  for (const timeoutMs of attempts) {
    const result = await quickPing(modelId, timeoutMs);
    lastResult = result;
    if (result.ok) {
      return result;
    }
    if (!/timeout|aborted/i.test(result.error || '')) {
      return result;
    }
  }
  return lastResult || { ok: false, ms: 0, error: 'TIMEOUT' };
}

function unique(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    items.push(normalized);
  }
  return items;
}

function buildScopeSummary(scope: 'global' | 'project', filePath: string | null): DoctorScopeSummary {
  const raw = filePath ? readJsonSafe<HiveConfig>(filePath) : {};
  const modelChannelMap = raw.model_channel_map && typeof raw.model_channel_map === 'object'
    ? Object.keys(raw.model_channel_map)
    : [];
  const modelBlacklist = Array.isArray(raw.model_blacklist) ? raw.model_blacklist : [];
  const channelBlacklist = Array.isArray(raw.channel_blacklist) ? raw.channel_blacklist : [];
  return {
    scope,
    path: filePath,
    exists: filePath ? fs.existsSync(filePath) : false,
    model_channel_rule_count: modelChannelMap.length,
    model_blacklist_count: modelBlacklist.length,
    channel_blacklist_count: channelBlacklist.length,
  };
}

function collectStageModels(config: HiveConfig): string[] {
  const registry = new ModelRegistry();
  const discussFallbackWorker = config.default_worker || config.fallback_worker || 'kimi-for-coding';
  const discussModel = Array.isArray(config.tiers.discuss.model)
    ? config.tiers.discuss.model[0]
    : config.tiers.discuss.model;
  return unique([
    config.tiers.translator.model === 'auto' ? registry.selectTranslator() : config.tiers.translator.model,
    config.tiers.planner.model === 'auto' ? registry.selectForPlanning() : config.tiers.planner.model,
    config.default_worker,
    config.fallback_worker,
    discussModel === 'auto' ? registry.selectDiscussPartner(discussFallbackWorker) : discussModel,
    config.tiers.reviewer.cross_review.model === 'auto' ? registry.selectReviewer() : config.tiers.reviewer.cross_review.model,
    config.tiers.reviewer.arbitration.model === 'auto' ? registry.selectForArbitration() : config.tiers.reviewer.arbitration.model,
    config.tiers.reviewer.final_review.model === 'auto' ? registry.selectForFinalReview() : config.tiers.reviewer.final_review.model,
    config.tiers.reporter.model === 'auto' ? registry.selectForReporter() : config.tiers.reporter.model,
  ]);
}

function collectDoctorModels(config: HiveConfig, options?: BuildDoctorOptions): string[] {
  const exactPolicyModels = Object.keys(config.model_channel_map || {}).filter((pattern) => !pattern.includes('*'));
  const table = loadMmsRoutes();
  const openaiFamily = table
    ? Object.keys(table.routes).filter((modelId) => /^(gpt-|gemini-|o[134]-)/i.test(modelId)).slice(0, 2)
    : [];
  return unique([
    ...(options?.modelIds || []),
    ...exactPolicyModels,
    ...collectStageModels(config),
    ...openaiFamily,
  ]).slice(0, 8);
}

function isGatewayFamilyModel(modelId: string): boolean {
  return /^(gpt-|gemini-|o[134]-)/i.test(modelId);
}

export async function buildDoctorReport(
  cwd: string = process.cwd(),
  options: BuildDoctorOptions = {},
): Promise<HiveDoctorReport> {
  const configSources = getConfigSource(cwd);
  const effectiveConfig = loadConfig(cwd);
  const mmsMeta = getMmsRoutesMeta();
  const mmsTable = loadMmsRoutes();
  const effectiveModelBlacklist = Array.isArray(effectiveConfig.model_blacklist) ? effectiveConfig.model_blacklist : [];
  const effectiveChannelBlacklist = Array.isArray(effectiveConfig.channel_blacklist) ? effectiveConfig.channel_blacklist : [];
  const effectiveModelChannelRules = Object.keys(effectiveConfig.model_channel_map || {}).length;
  const warnings: string[] = [];
  const suggestions: string[] = [];

  if (!mmsMeta.exists) {
    warnings.push(`未找到 MMS routes: ${mmsMeta.file_path}`);
    suggestions.push(`未找到 ${mmsMeta.file_path}；先执行 \`mms\` 刷新 model-routes，再重新运行 \`hive doctor\`。`);
    suggestions.push('如果你是在 Claude/MCP/CLI 里运行 Hive，再确认该进程拿到了正确的 HOME 和 MMS_ROUTES_PATH。');
  }

  const globalSummary = buildScopeSummary('global', configSources.global);
  const projectSummary = buildScopeSummary('project', configSources.local);

  if (!projectSummary.exists) {
    warnings.push('当前项目还没有 .hive/config.json。');
  }

  if (
    mmsMeta.exists
    && effectiveModelBlacklist.length === 0
    && effectiveChannelBlacklist.length === 0
    && effectiveModelChannelRules === 0
  ) {
    suggestions.push('已检测到 MMS routes，但当前还没有 Hive model-channel 映射；现在会默认按 auto 使用 MMS primary。');
    suggestions.push('如果你想手动指定模型走哪个 channel，请执行 `hive web --port 3100` 进入 Web 配置。');
  }

  const modelChecks: DoctorModelCheck[] = [];
  for (const modelId of collectDoctorModels(effectiveConfig, options)) {
    const matched = matchModelChannelMapEntry(effectiveConfig.model_channel_map, modelId);
    const configured = resolveConfiguredChannelProvider(effectiveConfig.model_channel_map, modelId);
    let resolvedProviderId = '';
    let resolvedSource: 'mms' | 'providers' | undefined;
    let providerError = '';
    let transportWarning = '';

    try {
      const resolved = resolveProviderForModel(modelId);
      resolvedProviderId = resolved.providerId || '';
      resolvedSource = resolved.source;
    } catch (error) {
      providerError = error instanceof Error ? error.message : String(error);
    }

    let pingOk: boolean | undefined;
    let pingError = providerError || '';
    if (!providerError && options.ping !== false) {
      const ping = await pingForDoctor(modelId);
      pingOk = ping.ok;
      if (!ping.ok) {
        pingError = ping.error || 'ping failed';
      }
    }

    const route = mmsTable?.routes[modelId];
    if (
      !providerError
      && isGatewayFamilyModel(modelId)
      && pingOk === false
      && /HTTP 404/i.test(pingError)
      && route
    ) {
      transportWarning = '当前 route 的 OpenAI bridge 探测失败；该通道的 chat/completions 端点不可用。';
      warnings.push(`${modelId}: ${transportWarning}`);
      suggestions.push('gpt/gemini/o-series 若 doctor 仍显示 HTTP 404，说明这条 channel 的 OpenAI chat/completions 本身不可用，不是 Hive 未走 bridge。');
    }

    let status: DoctorModelCheck['status'] = 'ok';
    if (providerError) {
      status = 'error';
    } else if (configured && configured.status !== 'resolved') {
      status = 'warn';
    } else if (pingOk === false && /timeout/i.test(pingError)) {
      status = 'warn';
    } else if (pingOk === false) {
      status = 'error';
    }

    if (providerError) {
      warnings.push(`${modelId}: ${providerError}`);
    } else if (pingOk === false) {
      warnings.push(`${modelId}: ${pingError}`);
    }

    modelChecks.push({
      model_id: modelId,
      configured_pattern: matched?.pattern,
      configured_selector: matched?.selector,
      configured_status: configured?.status,
      routing_mode: matched ? 'mapped' : (resolvedSource === 'mms' ? 'auto' : undefined),
      resolved_provider_id: resolvedProviderId || undefined,
      resolved_source: resolvedSource,
      ping_ok: pingOk,
      ping_error: pingError || undefined,
      transport_warning: transportWarning || undefined,
      status,
    });
  }

  if (modelChecks.some((item) => item.status === 'error')) {
    suggestions.push('先修复 doctor 里标红的模型 route / ping 问题，再依赖 Hive 的自动 fallback。');
  }

  return {
    generated_at: new Date().toISOString(),
    cwd,
    repo_root: configSources.local ? path.dirname(path.dirname(configSources.local)) : null,
    web_hint: 'hive web --port 3100',
    mms: mmsMeta,
    config: {
      global: globalSummary,
      project: projectSummary,
      effective: {
        model_channel_rule_count: Object.keys(effectiveConfig.model_channel_map || {}).length,
        model_blacklist_count: effectiveModelBlacklist.length,
        channel_blacklist_count: effectiveChannelBlacklist.length,
      },
    },
    models: modelChecks,
    warnings,
    suggestions: unique(suggestions),
  };
}

export function renderDoctorReport(report: HiveDoctorReport): string {
  const lines: string[] = [];
  lines.push('== Hive Doctor ==');
  lines.push(`- cwd: ${report.cwd}`);
  lines.push(`- repo: ${report.repo_root || '(not found)'}`);
  lines.push(`- generated: ${report.generated_at}`);
  lines.push('');
  lines.push('== MMS ==');
  lines.push(`- file: ${report.mms.file_path}`);
  lines.push(`- exists: ${report.mms.exists ? 'yes' : 'no'} | routes: ${report.mms.route_count}`);
  lines.push(`- updated: ${report.mms.mtime_iso || '-'}`);
  lines.push('');
  lines.push('== Config Layers ==');
  lines.push(`- global: ${report.config.global.exists ? 'yes' : 'no'} | ${report.config.global.path || '-'} | rules=${report.config.global.model_channel_rule_count} blacklist=${report.config.global.model_blacklist_count} hidden=${report.config.global.channel_blacklist_count}`);
  lines.push(`- project: ${report.config.project.exists ? 'yes' : 'no'} | ${report.config.project.path || '-'} | rules=${report.config.project.model_channel_rule_count} blacklist=${report.config.project.model_blacklist_count} hidden=${report.config.project.channel_blacklist_count}`);
  lines.push(`- effective: rules=${report.config.effective.model_channel_rule_count} blacklist=${report.config.effective.model_blacklist_count} hidden=${report.config.effective.channel_blacklist_count}`);
  lines.push('');
  lines.push('== Key Models ==');
  if (report.models.length === 0) {
    lines.push('- none');
  } else {
    for (const item of report.models) {
      const bits = [
        item.status === 'ok' ? 'OK' : item.status === 'warn' ? 'WARN' : 'ERROR',
        item.resolved_provider_id ? `provider=${item.resolved_provider_id}` : '',
        item.resolved_source ? `source=${item.resolved_source}` : '',
        item.configured_pattern && item.configured_selector
          ? `policy=${item.configured_pattern}->${item.configured_selector}${item.configured_status ? ` [${item.configured_status}]` : ''}`
          : (item.routing_mode === 'auto' ? 'policy=auto [MMS primary]' : ''),
        item.ping_ok === true ? 'ping=ok' : '',
        item.ping_ok === false ? `ping=${item.ping_error || 'failed'}` : '',
        item.transport_warning ? `transport=${item.transport_warning}` : '',
        !item.resolved_provider_id && item.ping_error && item.ping_ok === undefined ? `error=${item.ping_error}` : '',
      ].filter(Boolean);
      lines.push(`- ${item.model_id}: ${bits.join(' | ')}`);
    }
  }
  lines.push('');
  lines.push('== Findings ==');
  if (report.warnings.length === 0) {
    lines.push('- no blocking findings');
  } else {
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push('');
  lines.push('== Next ==');
  if (report.suggestions.length === 0) {
    lines.push('- configuration looks consistent');
  } else {
    for (const suggestion of report.suggestions) {
      lines.push(`- ${suggestion}`);
    }
  }
  return lines.join('\n');
}
