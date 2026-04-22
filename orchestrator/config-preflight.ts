import { buildSdkEnv } from './project-paths.js';
import {
  getConfigSource,
  loadConfig,
  matchModelBlacklistPattern,
  resolveTierModel,
} from './hive-config.js';
import { matchModelChannelMapEntry, resolveConfiguredChannelProvider } from './model-channel-policy.js';
import { ModelRegistry } from './model-registry.js';
import { quickPing, resolveProviderForModel } from './provider-resolver.js';
import { extractTextFromMessages, safeQuery } from './sdk-query-safe.js';
import type { HiveConfig, SubTask } from './types.js';

export interface ConfigPreflightSession {
  anthropic_base_url: boolean;
  anthropic_auth_token: boolean;
  mms_routes_path?: string;
}

export interface ConfigPreflightStageError {
  stage: string;
  error: string;
}

export interface ConfigPreflightModelRow {
  model_id: string;
  tiers: string[];
  policy_pattern?: string;
  channel_selector?: string;
  channel_status: 'auto' | 'resolved' | 'missing' | 'ambiguous';
  resolved_provider_id?: string;
  resolved_source?: 'mms' | 'providers';
  ping_ok?: boolean;
  ping_ms?: number;
  ping_error?: string;
  resolution_error?: string;
}

export interface ConfigPreflightWildcardRule {
  pattern: string;
  selector: string;
  matched_models: string[];
}

export interface ConfigPreflightProbeResult {
  stage: string;
  model_id: string;
  provider_id?: string;
  ok: boolean;
  output?: string;
  error?: string;
}

export interface ConfigPreflightReport {
  cwd: string;
  config_sources: { global: string; local: string | null };
  session: ConfigPreflightSession;
  models: ConfigPreflightModelRow[];
  stage_errors: ConfigPreflightStageError[];
  wildcard_rules: ConfigPreflightWildcardRule[];
  skipped_blacklisted_models: string[];
  probes: ConfigPreflightProbeResult[];
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function makePreviewTask(): SubTask {
  return {
    id: 'config-test-preview',
    description: 'Resolve executor model for config preflight.',
    complexity: 'medium',
    category: 'general',
    assigned_model: 'kimi-for-coding',
    assignment_reason: '',
    estimated_files: [],
    acceptance_criteria: [],
    discuss_threshold: 0.7,
    depends_on: [],
    review_scale: 'auto',
  };
}

function resolveDiscussModels(
  value: string | string[],
  registry: ModelRegistry,
  config: HiveConfig,
): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) => resolveTierModel(
    entry,
    () => registry.selectDiscussPartner('kimi-for-coding'),
    registry,
    'review',
    config,
  ));
}

function collectStageModels(config: HiveConfig): {
  stages: Array<{ stage: string; model_id: string }>;
  errors: ConfigPreflightStageError[];
} {
  const registry = new ModelRegistry();
  const errors: ConfigPreflightStageError[] = [];
  const stages: Array<{ stage: string; model_id: string }> = [];

  const tryPush = (stage: string, resolver: () => string | string[]): void => {
    try {
      const resolved = resolver();
      const models = Array.isArray(resolved) ? resolved : [resolved];
      models
        .filter(Boolean)
        .forEach((modelId, index) => {
          stages.push({
            stage: models.length > 1 ? `${stage}[${index + 1}]` : stage,
            model_id: modelId,
          });
        });
    } catch (error) {
      errors.push({ stage, error: shortError(error) });
    }
  };

  tryPush('translator', () => resolveTierModel(
    config.tiers.translator.model,
    () => registry.selectTranslator(),
    registry,
    'translation',
    config,
  ));
  tryPush('planner', () => resolveTierModel(
    config.tiers.planner.model,
    () => registry.selectForPlanning(),
    registry,
    'planning',
    config,
  ));
  tryPush('executor', () => resolveTierModel(
    config.tiers.executor.model,
    () => registry.assignModel(makePreviewTask()),
    registry,
    'implementation',
    config,
  ));
  tryPush('discuss', () => resolveDiscussModels(config.tiers.discuss.model, registry, config));
  tryPush('reviewer.cross_review', () => resolveTierModel(
    config.tiers.reviewer.cross_review.model,
    () => registry.selectReviewer(),
    registry,
    'review',
    config,
  ));
  tryPush('reviewer.arbitration', () => resolveTierModel(
    config.tiers.reviewer.arbitration.model,
    () => registry.selectForArbitration(),
    registry,
    'review',
    config,
  ));
  tryPush('reviewer.final_review', () => resolveTierModel(
    config.tiers.reviewer.final_review.model,
    () => registry.selectForFinalReview(),
    registry,
    'review',
    config,
  ));
  tryPush('reporter', () => resolveTierModel(
    config.tiers.reporter.model,
    () => registry.selectForReporter(),
    registry,
    'general',
    config,
  ));

  return { stages, errors };
}

async function evaluateModel(
  config: HiveConfig,
  modelId: string,
  tiers: string[],
): Promise<ConfigPreflightModelRow> {
  const policyMatch = matchModelChannelMapEntry(config.model_channel_map, modelId);
  const configuredChannel = resolveConfiguredChannelProvider(config.model_channel_map, modelId);
  const row: ConfigPreflightModelRow = {
    model_id: modelId,
    tiers: [...tiers].sort(),
    policy_pattern: policyMatch?.pattern,
    channel_selector: policyMatch?.selector,
    channel_status: configuredChannel?.status || 'auto',
  };

  try {
    const resolved = resolveProviderForModel(modelId);
    row.resolved_provider_id = resolved.providerId;
    row.resolved_source = resolved.source;

    const ping = await quickPing(modelId, 10_000, resolved.providerId);
    row.ping_ok = ping.ok;
    row.ping_ms = ping.ms;
    row.ping_error = ping.error;
  } catch (error) {
    row.resolution_error = shortError(error);
  }

  return row;
}

function collectWildcardRules(
  config: HiveConfig,
  rows: ConfigPreflightModelRow[],
): ConfigPreflightWildcardRule[] {
  return Object.entries(config.model_channel_map || {})
    .filter(([pattern]) => pattern.includes('*'))
    .map(([pattern, selector]) => ({
      pattern,
      selector,
      matched_models: rows
        .filter((row) => row.policy_pattern === pattern)
        .map((row) => row.model_id)
        .sort(),
    }))
    .sort((a, b) => a.pattern.localeCompare(b.pattern));
}

async function runStageProbe(
  stage: string,
  modelId: string,
  cwd: string,
): Promise<ConfigPreflightProbeResult> {
  try {
    const resolved = resolveProviderForModel(modelId);
    const env = buildSdkEnv(modelId, resolved.baseUrl, resolved.apiKey);
    const result = await safeQuery({
      prompt: [
        'This is a Hive config smoke test.',
        'Reply with exactly: OK',
        'Do not use tools.',
        'Do not inspect files.',
        'Do not explain.',
      ].join('\n'),
      options: {
        cwd,
        env,
        model: modelId,
        maxTurns: 1,
      },
      timeoutMs: 45_000,
    });
    const output = extractTextFromMessages(result.messages).replace(/\s+/g, ' ').trim();
    const ok = /^ok[.!]?$/i.test(output);
    return {
      stage,
      model_id: modelId,
      provider_id: resolved.providerId,
      ok,
      output: output.slice(0, 80) || '(empty)',
      error: ok ? undefined : result.exitError?.message || `Unexpected output: ${output.slice(0, 80) || '(empty)'}`,
    };
  } catch (error) {
    return {
      stage,
      model_id: modelId,
      ok: false,
      error: shortError(error),
    };
  }
}

export async function buildConfigPreflightReport(cwd: string = process.cwd()): Promise<ConfigPreflightReport> {
  const config = loadConfig(cwd);
  const configSources = getConfigSource(cwd);
  const session: ConfigPreflightSession = {
    anthropic_base_url: Boolean(process.env.ANTHROPIC_BASE_URL),
    anthropic_auth_token: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
    mms_routes_path: process.env.MMS_ROUTES_PATH,
  };

  const { stages, errors } = collectStageModels(config);
  const blacklisted = new Set<string>();
  const grouped = new Map<string, Set<string>>();

  for (const stage of stages) {
    const blockedPattern = matchModelBlacklistPattern(config, stage.model_id);
    if (blockedPattern) {
      blacklisted.add(`${stage.model_id} [${blockedPattern}]`);
      continue;
    }
    if (!grouped.has(stage.model_id)) grouped.set(stage.model_id, new Set<string>());
    grouped.get(stage.model_id)!.add(stage.stage);
  }

  for (const pattern of Object.keys(config.model_channel_map || {})) {
    if (pattern.includes('*')) continue;
    if (matchModelBlacklistPattern(config, pattern)) {
      blacklisted.add(`${pattern} [policy-blacklist]`);
      continue;
    }
    if (!grouped.has(pattern)) grouped.set(pattern, new Set<string>(['policy-only']));
  }

  const models: ConfigPreflightModelRow[] = [];
  for (const [modelId, tiers] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    models.push(await evaluateModel(config, modelId, [...tiers]));
  }

  const probes: ConfigPreflightProbeResult[] = [];
  const seenProbeModels = new Set<string>();
  for (const preferredStage of ['planner', 'executor', 'reviewer.final_review']) {
    const target = stages.find((stage) => stage.stage === preferredStage && !seenProbeModels.has(stage.model_id));
    if (!target) continue;
    const row = models.find((item) => item.model_id === target.model_id);
    if (!row || row.resolution_error || row.ping_ok === false) continue;
    seenProbeModels.add(target.model_id);
    probes.push(await runStageProbe(target.stage, target.model_id, cwd));
  }

  return {
    cwd,
    config_sources: configSources,
    session,
    models,
    stage_errors: errors,
    wildcard_rules: collectWildcardRules(config, models),
    skipped_blacklisted_models: [...blacklisted].sort(),
    probes,
  };
}

export function renderConfigPreflightReport(report: ConfigPreflightReport): string {
  const lines: string[] = [];
  const pingPass = report.models.filter((row) => row.ping_ok).length;
  const pingFail = report.models.filter((row) => row.resolution_error || row.ping_ok === false).length;
  const probePass = report.probes.filter((probe) => probe.ok).length;
  const probeFail = report.probes.filter((probe) => !probe.ok).length;

  lines.push('== Hive Config Test ==');
  lines.push(`- cwd: ${report.cwd}`);
  lines.push(`- global config: ${report.config_sources.global}`);
  lines.push(`- project config: ${report.config_sources.local || '-'}`);
  lines.push(
    `- session: ANTHROPIC_BASE_URL=${report.session.anthropic_base_url ? 'yes' : 'no'}`
    + ` | ANTHROPIC_AUTH_TOKEN=${report.session.anthropic_auth_token ? 'yes' : 'no'}`
    + (report.session.mms_routes_path ? ` | MMS_ROUTES_PATH=${report.session.mms_routes_path}` : ''),
  );
  lines.push('');

  if (report.models.length > 0) {
    lines.push('== Tier / Model Route ==');
    for (const row of report.models) {
      const tierText = row.tiers.join(',');
      const channelText = row.channel_status === 'auto'
        ? 'auto'
        : `${row.channel_selector || '-'}${row.policy_pattern ? ` (${row.policy_pattern})` : ''} [${row.channel_status}]`;
      const routeText = row.resolved_provider_id
        ? `${row.resolved_provider_id}${row.resolved_source ? ` [${row.resolved_source}]` : ''}`
        : '-';
      const statusText = row.resolution_error
        ? `ERROR | ${row.resolution_error}`
        : row.ping_ok
          ? `OK | ${row.ping_ms}ms`
          : `ERROR | ${row.ping_error || 'ping failed'}`;
      lines.push(`- ${row.model_id} | tiers=${tierText} | channel=${channelText} | route=${routeText} | ${statusText}`);
    }
    lines.push('');
  }

  if (report.stage_errors.length > 0) {
    lines.push('== Tier Config Errors ==');
    for (const item of report.stage_errors) {
      lines.push(`- ${item.stage}: ${item.error}`);
    }
    lines.push('');
  }

  if (report.wildcard_rules.length > 0) {
    lines.push('== Wildcard Rules ==');
    for (const rule of report.wildcard_rules) {
      lines.push(`- ${rule.pattern} -> ${rule.selector} | matched=${rule.matched_models.join(', ') || '(none)'}`);
    }
    lines.push('');
  }

  if (report.skipped_blacklisted_models.length > 0) {
    lines.push('== Skipped Blacklisted ==');
    for (const item of report.skipped_blacklisted_models) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  if (report.probes.length > 0) {
    lines.push('== Runtime Smoke ==');
    for (const probe of report.probes) {
      if (probe.ok) {
        lines.push(`- ${probe.stage} -> ${probe.model_id}${probe.provider_id ? ` @ ${probe.provider_id}` : ''} | OK | ${probe.output || 'OK'}`);
      } else {
        lines.push(`- ${probe.stage} -> ${probe.model_id}${probe.provider_id ? ` @ ${probe.provider_id}` : ''} | ERROR | ${probe.error || 'probe failed'}`);
      }
    }
    lines.push('');
  }

  lines.push('== Summary ==');
  lines.push(`- route checks: ${pingPass} ok / ${pingFail} fail`);
  lines.push(`- runtime smoke: ${probePass} ok / ${probeFail} fail`);
  if (!report.session.anthropic_base_url || !report.session.anthropic_auth_token) {
    lines.push('- note: current shell does not look like an MMS-started Claude CLI session; route checks still work, but session env is not inherited.');
  }
  return lines.join('\n');
}

