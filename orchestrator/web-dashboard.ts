import fs from 'fs';
import path from 'path';
import {
  listRuns,
  loadRunSpec,
  loadRunState,
} from './run-store.js';
import { listWorkerStatusSnapshots } from './worker-status-store.js';
import {
  loadHiveShellDashboard,
  resolveHiveShellRunId,
} from './hiveshell-dashboard.js';
import { submitSteeringAction } from './steering-store.js';
import { buildCompactPacket, renderCompactPacket } from './compact-packet.js';
import { generateRunSummary } from './operator-summary.js';
import { deriveTaskCues } from './collab-cues.js';
import { ModelRegistry } from './model-registry.js';
import {
  DEFAULT_CONFIG,
  deepMerge,
  getConfigSource,
  loadConfig,
  readJsonSafe,
  writeJsonSafe,
} from './hive-config.js';
import {
  getClaudeCliMode,
  getModelFallbackRoutes,
  resolveModelRouteFull,
} from './mms-routes-loader.js';
import {
  loadRunModelOverrides,
  resetRunModelOverrides,
  resolveEffectiveRunModelPolicy,
  saveRunModelOverrides,
  type RunModelPolicyPatch,
  type RunModelPolicySource,
  type RunModelPolicyStage,
  updateRunModelOverrides,
} from './run-model-policy.js';
import { listGlobalProjects } from './global-run-registry.js';
import type {
  DiscussTierConfig,
  HiveConfig,
  ReviewerTierConfig,
  SteeringActionType,
  TierConfig,
} from './types.js';

export interface WebRunListItem {
  id: string;
  status: string;
  goal: string;
  updated_at: string;
  is_latest: boolean;
  source: 'run' | 'worker';
  is_active: boolean;
}

export interface WebProjectListItem {
  id: string;
  cwd: string;
  name: string;
  updated_at: string;
  active_count: number;
  active_run_id?: string;
  active_status?: string;
  active_goal?: string;
  recent_run_id?: string;
  recent_status?: string;
  recent_goal?: string;
}

export interface WebActiveRunListItem {
  project: {
    cwd: string;
    name: string;
  };
  run_id: string;
  status: string;
  goal: string;
  updated_at: string;
  source: 'run' | 'worker';
  needs_user: boolean;
  attention_count: number;
  headline: string;
  why_stopped: string;
  suggested_action?: {
    label: string;
    action_type?: string;
  };
}

export interface WebProviderSurface {
  summary: string;
  healthy: number;
  degraded: number;
  open: number;
  probing: number;
  unhealthy: Array<{
    provider: string;
    breaker: string;
    subtype?: string;
  }>;
}

export interface WebTaskItem {
  task_id: string;
  status: string;
  model: string;
  summary: string;
  provider_failure?: string;
  provider_fallback?: string;
}

export interface WebAttentionTask extends WebTaskItem {
  cue: 'needs_human' | 'blocked' | 'needs_review' | 'watch';
  cue_reason: string;
  retry_count: number;
  suggested_actions: Array<{
    label: string;
    action_type: SteeringActionType;
    scope: 'run' | 'task';
    reason: string;
  }>;
}

export interface WebCompactData {
  markdown: string;
  goal: string;
  status: string;
  round: number;
  next_action: string;
  score?: number;
  authority_warning?: string;
}

type WebVerdictState = 'success' | 'failure' | 'blocked' | 'partial' | 'paused' | 'running' | 'unknown';
type WebVerdictSeverity = 'critical' | 'warning' | 'info' | 'ok';

export interface WebOperatorFocus {
  scope: 'run' | 'task' | 'done';
  title: string;
  message: string;
  checks: string[];
}

export interface WebModelOption {
  id: string;
  provider: string;
  route_summary: string;
}

export interface WebModelPolicyStage {
  stage: string;
  label: string;
  configured_model: string;
  configured_fallback: string;
  effective_model: string;
  effective_fallback: string;
  effective_source: string;
  source: string;
  route_summary: string;
  route_note: string;
}

export interface WebModelPolicyLayer {
  scope: 'global' | 'project' | 'run';
  title: string;
  path: string;
  priority: number;
  summary: string;
  writable: boolean;
  blocked_reason?: string;
  mode?: 'start-run' | 'runtime-next-stage';
  impact: string;
  stages: WebModelPolicyStage[];
}

export interface WebPolicySaveResult {
  scope: 'global' | 'project' | 'run';
  path: string;
  impact: string;
  message: string;
}

export interface WebModelPolicySurface {
  override_active: boolean;
  override_summary?: string;
  note: string;
  precedence: string;
  layers: WebModelPolicyLayer[];
  stages: WebModelPolicyStage[];
  save_result?: WebPolicySaveResult;
}

export interface WebConfigPolicyPayload {
  patch: RunModelPolicyPatch;
}

export interface WebConfigPolicyResetResult {
  scope: 'global' | 'project';
  path: string;
  message: string;
}

export interface WebConfigPolicySurface {
  precedence: string;
  note: string;
  layers: WebModelPolicyLayer[];
}

interface ConfigLayerContext {
  scope: 'global' | 'project';
  title: string;
  path: string;
  config: Partial<HiveConfig>;
  merged: HiveConfig;
}

interface StageConfigValues {
  model?: string | string[];
  fallback?: string;
}

interface ResolvedLayerPolicySet {
  translator: TierConfig;
  planner: TierConfig;
  executor: TierConfig;
  discuss: DiscussTierConfig;
  reviewer: ReviewerTierConfig;
}

interface PolicyStageDescriptor {
  stage: RunModelPolicyStage;
  label: string;
}

const POLICY_STAGE_DESCRIPTORS: PolicyStageDescriptor[] = [
  { stage: 'translator', label: '翻译' },
  { stage: 'planner', label: '规划' },
  { stage: 'executor', label: '执行' },
  { stage: 'discuss', label: '讨论' },
  { stage: 'reviewer.cross_review', label: '交叉评审' },
  { stage: 'reviewer.arbitration', label: '仲裁评审' },
  { stage: 'reviewer.final_review', label: '最终评审' },
];

const POLICY_PRECEDENCE = 'Run > Project > Global > Default';
const ACTIVE_RUN_FRESHNESS_MS = 24 * 60 * 60 * 1000;

const RUN_SOURCE_LABELS: Record<string, string> = {
  'start-run': 'Run（start-run）',
  'runtime-next-stage': 'Run（runtime-next-stage）',
  project: 'Project',
  global: 'Global',
  default: 'Default',
};

const RUN_SAVE_IMPACT: Record<RunModelPolicySource, string> = {
  'start-run': '影响当前 run 的后续阶段；已经开始的阶段不会回滚。',
  'runtime-next-stage': '只影响下一阶段；到安全切点后并入当前 run。',
};

const CONFIG_SAVE_IMPACT: Record<'global' | 'project', string> = {
  project: '影响这个 repo 后续新建的 run；不改其他项目。',
  global: '影响这台机器上的 Hive 全局默认；会被 Project 和 Run 覆盖。',
};

const GLOBAL_CONFIG_WARNING = 'Global 配置会写入真实 ~/.hive/config.json，并影响这台机器后续所有 Hive run。';

const EMPTY_CONFIG_POLICY_RESULT: WebConfigPolicyResetResult = {
  scope: 'project',
  path: '-',
  message: '',
};

let lastConfigPolicyResult: WebConfigPolicyResetResult | null = null;
let lastPolicySaveResult: WebPolicySaveResult | null = null;

function clearPolicySaveResult(): void {
  lastPolicySaveResult = null;
}

function clearConfigPolicyResult(): void {
  lastConfigPolicyResult = null;
}

function setPolicySaveResult(result: WebPolicySaveResult): void {
  lastPolicySaveResult = result;
}

function setConfigPolicyResult(result: WebConfigPolicyResetResult): void {
  lastConfigPolicyResult = result;
}

function readPolicySaveResult(): WebPolicySaveResult | null {
  return lastPolicySaveResult;
}

function readConfigPolicyResult(): WebConfigPolicyResetResult | null {
  return lastConfigPolicyResult;
}

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function emptyPolicyPatch(): RunModelPolicyPatch {
  return {};
}

function hasOwnValues(value: unknown): boolean {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length > 0;
}

function normalizeStageValues(value: StageConfigValues | undefined): StageConfigValues {
  return {
    ...(value?.model !== undefined ? { model: value.model } : {}),
    ...(value?.fallback !== undefined ? { fallback: value.fallback } : {}),
  };
}

function isStageConfigEqual(left: StageConfigValues, right: StageConfigValues): boolean {
  return JSON.stringify(normalizeStageValues(left)) === JSON.stringify(normalizeStageValues(right));
}

function formatSourceLabel(source: string): string {
  return RUN_SOURCE_LABELS[source] || source;
}

function buildRouteNote(configuredModel: string, effectiveModel: string): string {
  if (configuredModel === '-' && effectiveModel === '-') {
    return '当前没有显式配置 model，route 会按默认策略解析。';
  }
  if (configuredModel === effectiveModel) {
    return 'configured model 先解析成 route，再由 channel / provider 健康状态决定实际 transport。';
  }
  return 'effective model 可能来自更高优先级层，route 仍会再经过 channel / provider fallback。';
}

function impactTextForRun(mode: RunModelPolicySource): string {
  return RUN_SAVE_IMPACT[mode];
}

function impactTextForConfig(scope: 'global' | 'project'): string {
  return CONFIG_SAVE_IMPACT[scope];
}

function stagePathForConfig(stage: RunModelPolicyStage): string[] {
  if (stage.startsWith('reviewer.')) {
    return ['tiers', 'reviewer', stage.split('.')[1] || ''];
  }
  return ['tiers', stage];
}

function getNestedValue(target: Record<string, unknown>, pathParts: string[]): unknown {
  let cursor: unknown = target;
  for (const part of pathParts) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function setNestedValue(target: Record<string, unknown>, pathParts: string[], value: unknown): void {
  let cursor = target;
  for (const part of pathParts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[pathParts[pathParts.length - 1] || ''] = value;
}

function deleteNestedValue(target: Record<string, unknown>, pathParts: string[]): void {
  const stack: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let cursor = target;
  for (const part of pathParts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return;
    stack.push({ parent: cursor, key: part });
    cursor = next as Record<string, unknown>;
  }
  delete cursor[pathParts[pathParts.length - 1] || ''];
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const { parent, key } = stack[index] || {} as { parent: Record<string, unknown>; key: string };
    const value = parent[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) {
      delete parent[key];
      continue;
    }
    break;
  }
}

function pickPolicyStageValues(policy: ResolvedLayerPolicySet, stage: RunModelPolicyStage): StageConfigValues {
  if (stage === 'translator') return { model: policy.translator.model, fallback: policy.translator.fallback };
  if (stage === 'planner') return { model: policy.planner.model, fallback: policy.planner.fallback };
  if (stage === 'executor') return { model: policy.executor.model, fallback: policy.executor.fallback };
  if (stage === 'discuss') return { model: policy.discuss.model, fallback: policy.discuss.fallback };
  if (stage === 'reviewer.cross_review') return { model: policy.reviewer.cross_review.model, fallback: policy.reviewer.cross_review.fallback };
  if (stage === 'reviewer.arbitration') return { model: policy.reviewer.arbitration.model, fallback: policy.reviewer.arbitration.fallback };
  return { model: policy.reviewer.final_review.model, fallback: policy.reviewer.final_review.fallback };
}

function makePolicySet(config: HiveConfig | ResolvedLayerPolicySet): ResolvedLayerPolicySet {
  if ('tiers' in config) {
    return {
      translator: cloneConfig(config.tiers.translator),
      planner: cloneConfig(config.tiers.planner),
      executor: cloneConfig(config.tiers.executor),
      discuss: cloneConfig(config.tiers.discuss),
      reviewer: cloneConfig(config.tiers.reviewer),
    };
  }
  return {
    translator: cloneConfig(config.translator),
    planner: cloneConfig(config.planner),
    executor: cloneConfig(config.executor),
    discuss: cloneConfig(config.discuss),
    reviewer: cloneConfig(config.reviewer),
  };
}

function configPathExists(filePath: string | null): string {
  return filePath || '-';
}

function describeConfigScope(scope: 'global' | 'project'): string {
  return scope === 'global' ? '全局默认' : '项目默认';
}

function humanizeRunMode(mode: RunModelPolicySource): string {
  return mode === 'runtime-next-stage' ? '下一阶段' : '当前 run';
}

function createRunSaveResult(source: RunModelPolicySource, cwd: string, runId: string): WebPolicySaveResult {
  const pathText = path.join(cwd, '.ai', 'runs', runId, 'model-overrides.json');
  return {
    scope: 'run',
    path: pathText,
    impact: impactTextForRun(source),
    message: `已写入 Run 层（${humanizeRunMode(source)}），文件 ${pathText}。${impactTextForRun(source)}`,
  };
}

function createConfigSaveResult(scope: 'global' | 'project', filePath: string): WebConfigPolicyResetResult {
  return {
    scope,
    path: filePath,
    message: `已写入 ${describeConfigScope(scope)}，文件 ${filePath}。${impactTextForConfig(scope)}`,
  };
}

function buildRunSaveResult(source: RunModelPolicySource, cwd: string, runId: string): WebPolicySaveResult {
  return createRunSaveResult(source, cwd, runId);
}

function buildConfigResetResult(scope: 'global' | 'project', filePath: string, action: 'write' | 'delete'): WebConfigPolicyResetResult {
  return {
    scope,
    path: filePath,
    message: action === 'delete'
      ? `已清空 ${describeConfigScope(scope)}，文件 ${filePath}。${impactTextForConfig(scope)}`
      : `已写入 ${describeConfigScope(scope)}，文件 ${filePath}。${impactTextForConfig(scope)}`,
  };
}

function pickConfigTargetPath(cwd: string, scope: 'global' | 'project'): string | null {
  const source = getConfigSource(cwd);
  return scope === 'global' ? source.global : source.local;
}

function projectConfigPath(cwd: string): string {
  return pickConfigTargetPath(cwd, 'project') || path.join(cwd, '.hive', 'config.json');
}

function readConfigLayerContexts(cwd: string): ConfigLayerContext[] {
  const source = getConfigSource(cwd);
  const globalRaw = readJsonSafe<HiveConfig>(source.global);
  const projectPath = source.local || path.join(cwd, '.hive', 'config.json');
  const projectRaw = readJsonSafe<HiveConfig>(projectPath);
  const globalMerged = deepMerge<HiveConfig>(DEFAULT_CONFIG, globalRaw);
  const projectMerged = deepMerge<HiveConfig>(globalMerged, projectRaw);
  return [
    {
      scope: 'global',
      title: 'Global',
      path: source.global,
      config: globalRaw,
      merged: globalMerged,
    },
    {
      scope: 'project',
      title: 'Project',
      path: projectPath,
      config: projectRaw,
      merged: projectMerged,
    },
  ];
}

function buildConfigLayerStages(
  context: ConfigLayerContext,
  effectivePolicy: ReturnType<typeof resolveEffectiveRunModelPolicy>,
): WebModelPolicyStage[] {
  return POLICY_STAGE_DESCRIPTORS.map((descriptor) => {
    const configured = pickPolicyStageValues(makePolicySet(context.merged), descriptor.stage);
    const effective = pickPolicyStageValues(makePolicySet(effectivePolicy.effective_policy), descriptor.stage);
    const effectiveSource = effectivePolicy.stages.find((stage) => stage.stage === descriptor.stage)?.source || 'default';
    const pathParts = stagePathForConfig(descriptor.stage);
    const explicitValue = getNestedValue(context.config as unknown as Record<string, unknown>, pathParts) as StageConfigValues | undefined;
    const configuredText = formatPolicyValue(explicitValue?.model ?? configured.model);
    const fallbackText = explicitValue?.fallback || configured.fallback || '-';
    return {
      stage: descriptor.stage,
      label: descriptor.label,
      configured_model: configuredText,
      configured_fallback: fallbackText,
      effective_model: formatPolicyValue(effective.model),
      effective_fallback: effective.fallback || '-',
      effective_source: formatSourceLabel(effectiveSource),
      source: hasOwnValues(explicitValue) ? context.title : '继承',
      route_summary: summarizeRoute(effective.model),
      route_note: buildRouteNote(configuredText, formatPolicyValue(effective.model)),
    };
  });
}

function buildRunLayerStages(
  policy: ReturnType<typeof resolveEffectiveRunModelPolicy>,
  mode: RunModelPolicySource,
): WebModelPolicyStage[] {
  const patch = mode === 'runtime-next-stage' ? policy.runtime_override : policy.run_override;
  return POLICY_STAGE_DESCRIPTORS.map((descriptor) => {
    const stage = policy.stages.find((entry) => entry.stage === descriptor.stage);
    const configured = stage?.config as StageConfigValues | undefined;
    const effective = stage?.effective as StageConfigValues | undefined;
    const explicitValue = mode === 'runtime-next-stage'
      ? descriptor.stage === 'translator'
        ? patch?.translator
        : descriptor.stage === 'planner'
          ? patch?.planner
          : descriptor.stage === 'executor'
            ? patch?.executor
            : descriptor.stage === 'discuss'
              ? patch?.discuss
              : descriptor.stage === 'reviewer.cross_review'
                ? patch?.reviewer?.cross_review
                : descriptor.stage === 'reviewer.arbitration'
                  ? patch?.reviewer?.arbitration
                  : patch?.reviewer?.final_review
      : descriptor.stage === 'translator'
        ? patch?.translator
        : descriptor.stage === 'planner'
          ? patch?.planner
          : descriptor.stage === 'executor'
            ? patch?.executor
            : descriptor.stage === 'discuss'
              ? patch?.discuss
              : descriptor.stage === 'reviewer.cross_review'
                ? patch?.reviewer?.cross_review
                : descriptor.stage === 'reviewer.arbitration'
                  ? patch?.reviewer?.arbitration
                  : patch?.reviewer?.final_review;
    const configuredText = formatPolicyValue(explicitValue?.model ?? configured?.model);
    const effectiveText = formatPolicyValue(effective?.model);
    return {
      stage: descriptor.stage,
      label: descriptor.label,
      configured_model: configuredText,
      configured_fallback: explicitValue?.fallback || configured?.fallback || '-',
      effective_model: effectiveText,
      effective_fallback: effective?.fallback || '-',
      effective_source: formatSourceLabel(stage?.source || 'default'),
      source: hasOwnValues(explicitValue) ? formatSourceLabel(mode) : '继承',
      route_summary: summarizeRoute(effective?.model),
      route_note: buildRouteNote(configuredText, effectiveText),
    };
  });
}

function applyPatchToConfig(rawConfig: Partial<HiveConfig>, patch: RunModelPolicyPatch): Partial<HiveConfig> {
  const next = cloneConfig(rawConfig);
  for (const descriptor of POLICY_STAGE_DESCRIPTORS) {
    const stagePatch = descriptor.stage === 'translator'
      ? patch.translator
      : descriptor.stage === 'planner'
        ? patch.planner
        : descriptor.stage === 'executor'
          ? patch.executor
          : descriptor.stage === 'discuss'
            ? patch.discuss
            : descriptor.stage === 'reviewer.cross_review'
              ? patch.reviewer?.cross_review
              : descriptor.stage === 'reviewer.arbitration'
                ? patch.reviewer?.arbitration
                : patch.reviewer?.final_review;
    if (!stagePatch) continue;
    setNestedValue(next as unknown as Record<string, unknown>, stagePathForConfig(descriptor.stage), stagePatch);
  }
  return next;
}

function removePatchedFieldsFromConfig(rawConfig: Partial<HiveConfig>, patch: RunModelPolicyPatch): Partial<HiveConfig> {
  const next = cloneConfig(rawConfig);
  for (const descriptor of POLICY_STAGE_DESCRIPTORS) {
    const stagePatch = descriptor.stage === 'translator'
      ? patch.translator
      : descriptor.stage === 'planner'
        ? patch.planner
        : descriptor.stage === 'executor'
          ? patch.executor
          : descriptor.stage === 'discuss'
            ? patch.discuss
            : descriptor.stage === 'reviewer.cross_review'
              ? patch.reviewer?.cross_review
              : descriptor.stage === 'reviewer.arbitration'
                ? patch.reviewer?.arbitration
                : patch.reviewer?.final_review;
    if (!stagePatch) continue;
    const current = getNestedValue(next as unknown as Record<string, unknown>, stagePathForConfig(descriptor.stage));
    if (!current || typeof current !== 'object' || Array.isArray(current)) continue;
    const merged = { ...(current as Record<string, unknown>) };
    if ('model' in stagePatch) delete merged.model;
    if ('fallback' in stagePatch) delete merged.fallback;
    if (Object.keys(merged).length === 0) {
      deleteNestedValue(next as unknown as Record<string, unknown>, stagePathForConfig(descriptor.stage));
    } else {
      setNestedValue(next as unknown as Record<string, unknown>, stagePathForConfig(descriptor.stage), merged);
    }
  }
  return next;
}

function removeAllConfigPolicyFields(rawConfig: Partial<HiveConfig>): Partial<HiveConfig> {
  const next = cloneConfig(rawConfig);
  for (const descriptor of POLICY_STAGE_DESCRIPTORS) {
    deleteNestedValue(next as unknown as Record<string, unknown>, stagePathForConfig(descriptor.stage));
  }
  return next;
}

function buildConfigPolicyLayers(cwd: string, runId: string): WebModelPolicyLayer[] {
  const contexts = readConfigLayerContexts(cwd);
  const effectiveRun = resolveEffectiveRunModelPolicy(cwd, runId);
  return contexts.map((context, index) => ({
    scope: context.scope,
    title: context.title,
    path: configPathExists(context.path),
    priority: index + 2,
    summary: context.scope === 'global' ? '跨项目默认值' : '当前 repo 的默认值',
    writable: true,
    blocked_reason: context.scope === 'global' ? GLOBAL_CONFIG_WARNING : undefined,
    impact: impactTextForConfig(context.scope),
    stages: buildConfigLayerStages(context, effectiveRun),
  }));
}

function buildRunPolicyLayers(cwd: string, runId: string): WebModelPolicyLayer[] {
  const policy = resolveEffectiveRunModelPolicy(cwd, runId);
  const runPath = path.join(cwd, '.ai', 'runs', runId, 'model-overrides.json');
  return [
    {
      scope: 'run',
      title: 'Run（start-run）',
      path: runPath,
      priority: 1,
      summary: '当前 run 的持续覆盖',
      writable: true,
      mode: 'start-run',
      impact: impactTextForRun('start-run'),
      stages: buildRunLayerStages(policy, 'start-run'),
    },
    {
      scope: 'run',
      title: 'Run（runtime-next-stage）',
      path: runPath,
      priority: 1,
      summary: '只影响下一阶段的临时覆盖',
      writable: true,
      mode: 'runtime-next-stage',
      impact: impactTextForRun('runtime-next-stage'),
      stages: buildRunLayerStages(policy, 'runtime-next-stage'),
    },
  ];
}

function buildTopStages(cwd: string, runId: string): WebModelPolicyStage[] {
  const policy = resolveEffectiveRunModelPolicy(cwd, runId);
  return POLICY_STAGE_DESCRIPTORS.map((descriptor) => {
    const stage = policy.stages.find((entry) => entry.stage === descriptor.stage);
    const configured = stage?.config as StageConfigValues | undefined;
    const effective = stage?.effective as StageConfigValues | undefined;
    const configuredText = formatPolicyValue(configured?.model);
    const effectiveText = formatPolicyValue(effective?.model);
    return {
      stage: descriptor.stage,
      label: descriptor.label,
      configured_model: configuredText,
      configured_fallback: configured?.fallback || '-',
      effective_model: effectiveText,
      effective_fallback: effective?.fallback || '-',
      effective_source: formatSourceLabel(stage?.source || 'default'),
      source: formatSourceLabel(stage?.source || 'default'),
      route_summary: summarizeRoute(effective?.model),
      route_note: buildRouteNote(configuredText, effectiveText),
    };
  });
}

function buildConfigPolicySurface(cwd: string, runId: string): WebConfigPolicySurface {
  return {
    precedence: POLICY_PRECEDENCE,
    note: 'channel / provider 仅做说明：实际 route 可能因为 MMS route、transport 能力和 runtime fallback 与 configured model 不同。',
    layers: buildConfigPolicyLayers(cwd, runId),
  };
}

function writeConfigPolicy(scope: 'global' | 'project', cwd: string, patch: RunModelPolicyPatch): WebConfigPolicySurface {
  const targetPath = configPolicyPathForScope(cwd, scope);
  const current = readJsonSafe<HiveConfig>(targetPath);
  const next = applyPatchToConfig(current, patch);
  writeJsonSafe(targetPath, next);
  setConfigPolicyResult(buildConfigResetResult(scope, targetPath, 'write'));
  return buildConfigPolicySurface(cwd, resolveHiveShellRunId(cwd) || listRuns(cwd)[0]?.id || '');
}

function resetConfigPolicy(scope: 'global' | 'project', cwd: string): WebConfigPolicySurface {
  const targetPath = configPolicyPathForScope(cwd, scope);
  if (!fs.existsSync(targetPath)) {
    setConfigPolicyResult(buildConfigResetResult(scope, targetPath, 'delete'));
    return buildConfigPolicySurface(cwd, resolveHiveShellRunId(cwd) || listRuns(cwd)[0]?.id || '');
  }
  fs.unlinkSync(targetPath);
  setConfigPolicyResult(buildConfigResetResult(scope, targetPath, 'delete'));
  return buildConfigPolicySurface(cwd, resolveHiveShellRunId(cwd) || listRuns(cwd)[0]?.id || '');
}

function loadConfigPolicy(cwd: string, runId: string): WebConfigPolicySurface {
  return buildConfigPolicySurface(cwd, runId);
}

function buildSaveResult(scope: 'global' | 'project', filePath: string): WebPolicySaveResult {
  return {
    scope,
    path: filePath,
    impact: impactTextForConfig(scope),
    message: `已写入 ${describeConfigScope(scope)}，文件 ${filePath}。${impactTextForConfig(scope)}`,
  };
}

function buildResetSaveResult(scope: 'global' | 'project', filePath: string): WebPolicySaveResult {
  return {
    scope,
    path: filePath,
    impact: impactTextForConfig(scope),
    message: `已清空 ${describeConfigScope(scope)}，文件 ${filePath}。${impactTextForConfig(scope)}`,
  };
}

function projectOrGlobalSaveResult(): WebPolicySaveResult | null {
  const result = readConfigPolicyResult();
  if (!result) return null;
  return {
    scope: result.scope,
    path: result.path,
    impact: impactTextForConfig(result.scope),
    message: result.message,
  };
}

function selectSurfaceSaveResult(): WebPolicySaveResult | null {
  return readPolicySaveResult() || projectOrGlobalSaveResult();
}

function setRunPolicySaveResult(source: RunModelPolicySource, cwd: string, runId: string): void {
  setPolicySaveResult(buildRunSaveResult(source, cwd, runId));
}

function setConfigPolicySaveResult(scope: 'global' | 'project', filePath: string, reset = false): void {
  setPolicySaveResult(reset ? buildResetSaveResult(scope, filePath) : buildSaveResult(scope, filePath));
}

function currentRunIdFallback(cwd: string, runId?: string): string {
  if (runId) return runId;
  return resolveHiveShellRunId(cwd) || listRuns(cwd)[0]?.id || '';
}

function ensureRunId(cwd: string, runId?: string): string {
  return currentRunIdFallback(cwd, runId);
}

function resetPolicyFeedback(): void {
  clearPolicySaveResult();
  clearConfigPolicyResult();
}

function maybeRunId(cwd: string, runId?: string): string | undefined {
  const resolved = ensureRunId(cwd, runId);
  return resolved || undefined;
}

function buildCombinedPolicyLayers(cwd: string, runId: string): WebModelPolicyLayer[] {
  return [
    ...buildRunPolicyLayers(cwd, runId),
    ...buildConfigPolicyLayers(cwd, runId),
  ];
}

function buildPolicySummary(policy: ReturnType<typeof resolveEffectiveRunModelPolicy>): string | undefined {
  return policy.override_summary;
}

function buildPolicyNote(): string {
  return '优先级固定为 Run > Project > Global > Default。MMS route / channel 只读展示 route summary，不支持手动 pin。';
}

function getContextRunId(cwd: string, runId: string): string {
  return runId || resolveHiveShellRunId(cwd) || listRuns(cwd)[0]?.id || '';
}

function buildRunPath(cwd: string, runId: string): string {
  return path.join(cwd, '.ai', 'runs', runId, 'model-overrides.json');
}

function combineSaveResult(runResult: WebPolicySaveResult | null, configResult: WebPolicySaveResult | null): WebPolicySaveResult | undefined {
  return runResult || configResult || undefined;
}

function isProjectScope(scope: 'global' | 'project'): boolean {
  return scope === 'project';
}

function isGlobalScope(scope: 'global' | 'project'): boolean {
  return scope === 'global';
}

function fallbackRunIdForConfig(cwd: string, runId?: string): string {
  return runId || resolveHiveShellRunId(cwd) || listRuns(cwd)[0]?.id || '';
}

function currentConfigPolicy(cwd: string, runId?: string): WebConfigPolicySurface {
  return buildConfigPolicySurface(cwd, fallbackRunIdForConfig(cwd, runId));
}

function currentModelPolicy(cwd: string, runId: string): WebModelPolicySurface {
  return buildModelPolicy(cwd, runId);
}

function configPolicyPathForScope(cwd: string, scope: 'global' | 'project'): string {
  return scope === 'project' ? projectConfigPath(cwd) : getConfigSource(cwd).global;
}

function touchedConfigStages(rawConfig: Partial<HiveConfig>): number {
  return POLICY_STAGE_DESCRIPTORS.filter((descriptor) => {
    const value = getNestedValue(rawConfig as unknown as Record<string, unknown>, stagePathForConfig(descriptor.stage));
    return hasOwnValues(value);
  }).length;
}

function layerSummary(scope: 'global' | 'project', rawConfig: Partial<HiveConfig>): string {
  const count = touchedConfigStages(rawConfig);
  if (count === 0) return scope === 'global' ? '当前没有显式全局 model 配置' : '当前没有显式项目 model 配置';
  return `${count} 个 stage 有显式 ${scope === 'global' ? 'Global' : 'Project'} 配置`;
}

function rebuildConfigLayers(cwd: string, runId: string): WebModelPolicyLayer[] {
  const contexts = readConfigLayerContexts(cwd);
  const effectiveRun = resolveEffectiveRunModelPolicy(cwd, runId);
  return contexts.map((context, index) => ({
    scope: context.scope,
    title: context.title,
    path: configPathExists(context.path),
    priority: index + 2,
    summary: layerSummary(context.scope, context.config),
    writable: true,
    blocked_reason: context.scope === 'global' ? GLOBAL_CONFIG_WARNING : undefined,
    impact: impactTextForConfig(context.scope),
    stages: buildConfigLayerStages(context, effectiveRun),
  }));
}

function rebuildAllLayers(cwd: string, runId: string): WebModelPolicyLayer[] {
  return [...buildRunPolicyLayers(cwd, runId), ...rebuildConfigLayers(cwd, runId)];
}

function clearTransientPolicyResults(): void {
  clearConfigPolicyResult();
}

function clearTransientRunResults(): void {
  clearPolicySaveResult();
}

function buildLayerPriority(scope: 'global' | 'project' | 'run', mode?: RunModelPolicySource): number {
  if (scope === 'run' && mode === 'runtime-next-stage') return 1;
  if (scope === 'run') return 2;
  if (scope === 'project') return 3;
  return 4;
}

function sortLayers(layers: WebModelPolicyLayer[]): WebModelPolicyLayer[] {
  return [...layers].sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
}

function finalizeLayers(layers: WebModelPolicyLayer[]): WebModelPolicyLayer[] {
  return sortLayers(layers).map((layer) => ({
    ...layer,
    priority: buildLayerPriority(layer.scope, layer.mode),
  }));
}

function layerTitle(scope: 'global' | 'project', pathText: string): string {
  return `${describeConfigScope(scope)} · ${pathText}`;
}

function runLayerTitle(mode: RunModelPolicySource): string {
  return mode === 'runtime-next-stage' ? 'Run · 下一阶段' : 'Run · 当前 run';
}

function buildLayerSummary(layer: WebModelPolicyLayer): string {
  return layer.summary;
}

function enrichLayerPresentation(layer: WebModelPolicyLayer): WebModelPolicyLayer {
  return {
    ...layer,
    title: layer.scope === 'run'
      ? runLayerTitle(layer.mode || 'start-run')
      : layerTitle(layer.scope, layer.path),
    summary: buildLayerSummary(layer),
  };
}

function presentLayers(layers: WebModelPolicyLayer[]): WebModelPolicyLayer[] {
  return finalizeLayers(layers).map(enrichLayerPresentation);
}

function stageSourceText(stage: WebModelPolicyStage): string {
  return stage.effective_source;
}

function policyStageRows(stages: WebModelPolicyStage[]): WebModelPolicyStage[] {
  return stages.map((stage) => ({
    ...stage,
    effective_source: stageSourceText(stage),
  }));
}

function preparedTopStages(cwd: string, runId: string): WebModelPolicyStage[] {
  return policyStageRows(buildTopStages(cwd, runId));
}

function stageCountLabel(layer: WebModelPolicyLayer): string {
  return `${layer.stages.length} 个 stage`;
}

function layerSummaryWithCount(layer: WebModelPolicyLayer): string {
  return `${layer.summary} · ${stageCountLabel(layer)}`;
}

function attachLayerSummary(layer: WebModelPolicyLayer): WebModelPolicyLayer {
  return {
    ...layer,
    summary: layerSummaryWithCount(layer),
  };
}

function attachLayerSummaries(layers: WebModelPolicyLayer[]): WebModelPolicyLayer[] {
  return layers.map(attachLayerSummary);
}

function topLevelLayers(cwd: string, runId: string): WebModelPolicyLayer[] {
  return attachLayerSummaries(presentLayers(rebuildAllLayers(cwd, runId)));
}

function configWriteResult(scope: 'global' | 'project', cwd: string, reset = false): WebPolicySaveResult {
  const filePath = configPolicyPathForScope(cwd, scope);
  return reset ? buildResetSaveResult(scope, filePath) : buildSaveResult(scope, filePath);
}

function currentPolicyFeedback(cwd: string): WebPolicySaveResult | undefined {
  return combineSaveResult(readPolicySaveResult(), projectOrGlobalSaveResult());
}

function currentConfigResult(scope: 'global' | 'project', cwd: string, reset = false): WebConfigPolicyResetResult {
  return {
    scope,
    path: configPolicyPathForScope(cwd, scope),
    message: reset
      ? `已清空 ${describeConfigScope(scope)}，文件 ${configPolicyPathForScope(cwd, scope)}。${impactTextForConfig(scope)}`
      : `已写入 ${describeConfigScope(scope)}，文件 ${configPolicyPathForScope(cwd, scope)}。${impactTextForConfig(scope)}`,
  };
}

function applyConfigWriteFeedback(scope: 'global' | 'project', cwd: string, reset = false): void {
  const result = currentConfigResult(scope, cwd, reset);
  setConfigPolicyResult(result);
  setPolicySaveResult({
    scope,
    path: result.path,
    impact: impactTextForConfig(scope),
    message: result.message,
  });
}

function writeScopedConfigPolicy(scope: 'global' | 'project', cwd: string, patch: RunModelPolicyPatch): void {
  const targetPath = configPolicyPathForScope(cwd, scope);
  const current = readJsonSafe<HiveConfig>(targetPath);
  const next = applyPatchToConfig(current, patch);
  writeJsonSafe(targetPath, next);
  applyConfigWriteFeedback(scope, cwd, false);
}

function resetScopedConfigPolicy(scope: 'global' | 'project', cwd: string): void {
  const targetPath = configPolicyPathForScope(cwd, scope);
  const current = readJsonSafe<HiveConfig>(targetPath);
  const next = removeAllConfigPolicyFields(current);
  if (Object.keys(next).length === 0) {
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    applyConfigWriteFeedback(scope, cwd, true);
    return;
  }
  writeJsonSafe(targetPath, next);
  applyConfigWriteFeedback(scope, cwd, false);
}

function configPolicyForRun(cwd: string, runId: string): WebConfigPolicySurface {
  return buildConfigPolicySurface(cwd, runId);
}

function createModelPolicySurface(cwd: string, runId: string): WebModelPolicySurface {
  const policy = resolveEffectiveRunModelPolicy(cwd, runId);
  return {
    override_active: policy.override_active,
    override_summary: buildPolicySummary(policy),
    note: buildPolicyNote(),
    precedence: POLICY_PRECEDENCE,
    layers: topLevelLayers(cwd, runId),
    stages: preparedTopStages(cwd, runId),
    save_result: currentPolicyFeedback(cwd),
  };
}

function updateProjectOrGlobalConfig(scope: 'global' | 'project', cwd: string, patch: RunModelPolicyPatch): WebConfigPolicySurface {
  writeScopedConfigPolicy(scope, cwd, patch);
  return currentConfigPolicy(cwd);
}

function resetProjectOrGlobalConfig(scope: 'global' | 'project', cwd: string): WebConfigPolicySurface {
  resetScopedConfigPolicy(scope, cwd);
  return currentConfigPolicy(cwd);
}

function singleStagePatch(stage: RunModelPolicyStage): RunModelPolicyPatch {
  if (stage === 'translator') return { translator: { model: '', fallback: '' } };
  if (stage === 'planner') return { planner: { model: '', fallback: '' } };
  if (stage === 'executor') return { executor: { model: '', fallback: '' } };
  if (stage === 'discuss') return { discuss: { model: '', fallback: '' } };
  if (stage === 'reviewer.cross_review') return { reviewer: { cross_review: { model: '', fallback: '' } } };
  if (stage === 'reviewer.arbitration') return { reviewer: { arbitration: { model: '', fallback: '' } } };
  return { reviewer: { final_review: { model: '', fallback: '' } } };
}

function clearStageFromRunPatch(patch: RunModelPolicyPatch | null | undefined, stage: RunModelPolicyStage): RunModelPolicyPatch | null {
  if (!patch) return null;
  const next = cloneConfig(patch);
  if (stage === 'translator') delete next.translator;
  else if (stage === 'planner') delete next.planner;
  else if (stage === 'executor') delete next.executor;
  else if (stage === 'discuss') delete next.discuss;
  else if (stage === 'reviewer.cross_review' && next.reviewer) delete next.reviewer.cross_review;
  else if (stage === 'reviewer.arbitration' && next.reviewer) delete next.reviewer.arbitration;
  else if (stage === 'reviewer.final_review' && next.reviewer) delete next.reviewer.final_review;
  if (next.reviewer && Object.keys(next.reviewer).length === 0) delete next.reviewer;
  return Object.keys(next).length > 0 ? next : null;
}

function clearRunPolicyStage(cwd: string, runId: string, source: RunModelPolicySource, stage: RunModelPolicyStage): WebModelPolicySurface {
  const current = loadRunModelOverrides(cwd, runId) || { updated_at: new Date().toISOString() };
  const next = {
    start_time: source === 'start-run'
      ? clearStageFromRunPatch(current.start_time, stage) || undefined
      : current.start_time,
    runtime_next_stage: source === 'runtime-next-stage'
      ? clearStageFromRunPatch(current.runtime_next_stage, stage) || undefined
      : current.runtime_next_stage,
    updated_at: new Date().toISOString(),
  };
  if (!next.start_time && !next.runtime_next_stage) {
    resetRunModelOverrides(cwd, runId);
  } else {
    saveRunModelOverrides(cwd, runId, next);
  }
  setRunPolicySaveResult(source, cwd, runId);
  return buildModelPolicy(cwd, runId);
}

function clearConfigPolicyStage(scope: 'global' | 'project', cwd: string, stage: RunModelPolicyStage): WebConfigPolicySurface {
  const targetPath = configPolicyPathForScope(cwd, scope);
  const current = readJsonSafe<HiveConfig>(targetPath);
  const next = removePatchedFieldsFromConfig(current, singleStagePatch(stage));
  if (Object.keys(next).length === 0) {
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    applyConfigWriteFeedback(scope, cwd, true);
  } else {
    writeJsonSafe(targetPath, next);
    applyConfigWriteFeedback(scope, cwd, false);
  }
  return currentConfigPolicy(cwd);
}

function resetConfigMessageScope(scope: 'global' | 'project', cwd: string, reset = false): void {
  applyConfigWriteFeedback(scope, cwd, reset);
}

function noteForConfigPolicy(): string {
  return 'Project 和 Global 都可编辑。保存后会明确告诉你写到了哪一层、影响哪个范围；其中 Global 会写入真实 ~/.hive/config.json。';
}

function currentConfigPolicySurface(cwd: string, runId: string): WebConfigPolicySurface {
  const surface = configPolicyForRun(cwd, runId);
  return {
    ...surface,
    note: `${surface.note} ${noteForConfigPolicy()}`,
  };
}

function currentCombinedPolicy(cwd: string, runId: string): WebModelPolicySurface {
  return createModelPolicySurface(cwd, runId);
}

function currentPolicy(cwd: string, runId: string): WebModelPolicySurface {
  return currentCombinedPolicy(cwd, runId);
}

function contextRunId(cwd: string, runId: string): string {
  return getContextRunId(cwd, runId);
}

function policySurface(cwd: string, runId: string): WebModelPolicySurface {
  return currentPolicy(cwd, contextRunId(cwd, runId));
}

function configSurface(cwd: string, runId: string): WebConfigPolicySurface {
  return currentConfigPolicySurface(cwd, contextRunId(cwd, runId));
}

function clearOneShotPolicyFeedback(): void {
  clearTransientRunResults();
  clearTransientPolicyResults();
}

function pullOneShotPolicyFeedback(): WebPolicySaveResult | undefined {
  const result = currentPolicyFeedback('');
  clearOneShotPolicyFeedback();
  return result;
}

function hasLayerOverrides(layer: WebModelPolicyLayer): boolean {
  return layer.stages.some((stage) => stage.source !== '继承');
}

function compactLayerSummary(layer: WebModelPolicyLayer): string {
  return hasLayerOverrides(layer) ? layer.summary : `${layer.summary}（当前无显式覆盖）`;
}

function decorateLayers(layers: WebModelPolicyLayer[]): WebModelPolicyLayer[] {
  return layers.map((layer) => ({
    ...layer,
    summary: compactLayerSummary(layer),
  }));
}

function finalModelPolicy(cwd: string, runId: string): WebModelPolicySurface {
  const surface = policySurface(cwd, runId);
  return {
    ...surface,
    layers: decorateLayers(surface.layers),
  };
}
export interface WebDashboardSnapshot {
  project: {
    cwd: string;
    name: string;
  };
  runId: string;
  updated_at: string;
  attention: {
    paused: boolean;
    primary_blocker?: string;
    authority_degradation?: string;
    pending_steering: number;
  };
  truth: {
    goal: string;
    status: string;
    round: number;
    max_rounds?: number;
    effective_mode: string;
    next_action: string;
    next_reason: string;
    summary: string;
    score?: number;
    score_best?: number;
  };
  authority: {
    mode?: string;
    members?: string[];
    reviewer_runtime_failures?: string[];
  };
  provider: WebProviderSurface | null;
  tasks: WebTaskItem[];
  attention_tasks: WebAttentionTask[];
  focus: WebOperatorFocus;
  model_policy: WebModelPolicySurface;
  compact: WebCompactData | null;
  steering: Array<{
    action_id: string;
    action_type: string;
    status: string;
    scope: string;
    outcome?: string;
  }>;
  verdict: {
    state: WebVerdictState;
    headline: string;
    severity: WebVerdictSeverity;
    why_stopped: string;
    needs_user: boolean;
    suggested_action: {
      label: string;
      action_type?: string;
    };
  };
}

function truncate(text: string | undefined, limit: number): string {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '-';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function humanizeReason(reason: string | undefined): string {
  const text = (reason || '').trim();
  if (!text) return '';

  const replanBudget = text.match(/^Replan budget exhausted \((\d+)\/(\d+)\)\. Human intervention needed\.$/);
  if (replanBudget) {
    return `自动重规划次数已用完（${replanBudget[1]}/${replanBudget[2]}），现在需要你决定是否继续。`;
  }

  if (text === 'Run is paused — resume or apply steering actions') {
    return '运行已暂停；继续运行或先下达新的指令。';
  }

  const maxRounds = text.match(/^Max rounds reached \((\d+)\)\. Status: ([^.]+)\.$/);
  if (maxRounds) {
    return `已达到最大轮次（${maxRounds[1]}），当前状态是 ${maxRounds[2]}。`;
  }

  return text
    .replace(/Human intervention needed/gi, '需要人工处理')
    .replace(/Replan budget exhausted/gi, '自动重规划次数已用完')
    .replace(/Run is paused/gi, '运行已暂停')
    .replace(/resume or apply steering actions/gi, '继续运行或先下达新的指令')
    .replace(/\s+/g, ' ')
    .trim();
}

function translateNextAction(kind: string | undefined): string {
  const map: Record<string, string> = {
    request_human: '需要你确认',
    repair_task: '自动修复任务',
    dispatch: '继续执行',
    replan: '重新规划',
    compact: '准备收口',
    pause_run: '暂停运行',
    resume_run: '继续运行',
  };
  return map[kind || ''] || (kind || '-');
}

function buildVerdict(
  status: string,
  attention: WebDashboardSnapshot['attention'],
  nextAction: { kind?: string; reason?: string } | undefined,
): WebDashboardSnapshot['verdict'] {
  const s = status || 'unknown';

  let state: WebVerdictState = 'unknown';
  let headline = '状态未知';
  let severity: WebVerdictSeverity = 'info';

  if (s === 'done' || s === 'completed' || s === 'success') {
    state = 'success';
    headline = '运行完成';
    severity = 'ok';
  } else if (s === 'init' || s === 'planning') {
    state = 'running';
    headline = '正在准备运行';
    severity = 'info';
  } else if (s === 'executing' || s === 'verifying' || s === 'repairing' || s === 'replanning') {
    state = 'running';
    headline = '运行中';
    severity = 'info';
  } else if (s === 'failed' || s === 'failure' || s === 'fail') {
    state = 'failure';
    headline = '运行失败';
    severity = 'critical';
  } else if (s === 'blocked') {
    state = 'blocked';
    headline = '运行被阻塞';
    severity = 'warning';
  } else if (s === 'partial') {
    state = 'partial';
    headline = '部分完成';
    severity = 'warning';
  } else if (s === 'running') {
    state = 'running';
    headline = '运行中';
    severity = 'info';
  }

  const whyParts: string[] = [];
  if (attention.paused) whyParts.push('运行已被手动暂停');
  if (attention.primary_blocker) whyParts.push(attention.primary_blocker);
  if (attention.authority_degradation) whyParts.push(`评审异常：${attention.authority_degradation}`);

  let why_stopped = whyParts.map((part) => humanizeReason(part)).join('；');
  if (!why_stopped) {
    if (state === 'success') why_stopped = '目标已达成';
    else if (state === 'failure') why_stopped = humanizeReason(nextAction?.reason) || '执行过程中出现错误';
    else if (state === 'blocked') why_stopped = humanizeReason(nextAction?.reason) || '等待外部条件或用户确认';
    else if (state === 'running') why_stopped = humanizeReason(nextAction?.reason) || (s === 'init' || s === 'planning' ? '正在准备计划和执行环境' : '正在执行中');
    else why_stopped = '暂无更多信息';
  }

  if (attention.paused) {
    state = 'paused';
    headline = '运行已暂停';
    severity = 'warning';
  }

  const needs_user =
    attention.paused ||
    state === 'blocked' ||
    state === 'failure' ||
    attention.pending_steering > 0 ||
    nextAction?.kind === 'request_human';

  let suggested_action: { label: string; action_type?: string } = { label: '刷新状态' };
  if (attention.paused) {
    suggested_action = { label: '继续运行', action_type: 'resume_run' };
  } else if (nextAction?.kind === 'request_human' || state === 'blocked') {
    suggested_action = { label: '查看并处理', action_type: undefined };
  } else if (state === 'failure') {
    suggested_action = { label: '请求重新规划', action_type: 'request_replan' };
  } else if (state === 'success') {
    suggested_action = { label: '运行已完成' };
  } else if (state === 'running') {
    suggested_action = { label: '暂停运行', action_type: 'pause_run' };
  }

  return { state, headline, severity, why_stopped, needs_user, suggested_action };
}

function summarizeProvider(data: ReturnType<typeof loadHiveShellDashboard>): WebProviderSurface | null {
  if (!data?.providerHealth) return null;
  const providers = Object.entries(data.providerHealth.providers);
  const summary: Record<string, number> = {};
  for (const [, state] of providers) {
    summary[state.breaker] = (summary[state.breaker] || 0) + 1;
  }
  const unhealthy = providers
    .filter(([, s]) => s.breaker !== 'healthy')
    .map(([provider, s]) => ({
      provider,
      breaker: s.breaker,
      subtype: s.last_failure_subtype,
    }));
  return {
    summary: `${providers.length} total`,
    healthy: summary.healthy || 0,
    degraded: summary.degraded || 0,
    open: summary.open || 0,
    probing: summary.probing || 0,
    unhealthy,
  };
}

function buildTasks(data: ReturnType<typeof loadHiveShellDashboard>): WebTaskItem[] {
  if (!data?.workerSnapshot) return [];
  return data.workerSnapshot.workers.map((w) => {
    const model = w.assigned_model === w.active_model
      ? w.active_model
      : `${w.assigned_model} -> ${w.active_model}`;
    const fallback = w.provider_fallback_used
      ? `${w.assigned_model}->${w.active_model}`
      : undefined;
    return {
      task_id: w.task_id,
      status: w.status,
      model,
      summary: truncate(w.task_summary || w.last_message, 120),
      provider_failure: w.provider_failure_subtype,
      provider_fallback: fallback,
    };
  });
}

function deriveWorkerRunStatus(cwd: string, runId: string): string {
  const snapshot = listWorkerStatusSnapshots(cwd).find((entry) => entry.run_id === runId);
  if (!snapshot) return 'unknown';
  const workers = snapshot.workers || [];
  if (workers.some((worker) => ['queued', 'starting', 'running', 'discussing'].includes(worker.status))) {
    return 'running';
  }
  if (workers.some((worker) => worker.status === 'failed')) return 'failed';
  if (workers.length > 0 && workers.every((worker) => worker.status === 'completed')) return 'completed';
  return 'partial';
}

function deriveWorkerRunGoal(cwd: string, runId: string): string {
  const snapshot = listWorkerStatusSnapshots(cwd).find((entry) => entry.run_id === runId);
  if (!snapshot) return '-';
  return truncate(snapshot.goal || snapshot.workers?.[0]?.task_description || snapshot.workers?.[0]?.task_summary, 140);
}

function latestIsoTimestamp(...values: Array<string | undefined>): string {
  return values
    .map((value) => (value || '').trim())
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left))[0] || '';
}

function resolveSurfaceUpdatedAt(
  stateUpdatedAt?: string,
  workerUpdatedAt?: string,
  specCreatedAt?: string,
): string {
  return latestIsoTimestamp(stateUpdatedAt, workerUpdatedAt) || (specCreatedAt || '');
}

function isActiveSurfaceStatus(status: string): boolean {
  return ['init', 'planning', 'running', 'executing', 'verifying', 'repairing', 'replanning', 'blocked', 'paused'].includes(status);
}

function isFreshActiveRun(updatedAt: string): boolean {
  const time = new Date(updatedAt || '').getTime();
  if (!Number.isFinite(time) || time <= 0) return false;
  return Date.now() - time <= ACTIVE_RUN_FRESHNESS_MS;
}

function fallbackActiveHeadline(status: string): string {
  if (status === 'paused') return '运行已暂停';
  if (status === 'blocked') return '运行被阻塞';
  if (status === 'init' || status === 'planning') return '正在准备运行';
  return '运行中';
}

function fallbackActiveReason(status: string, goal: string): string {
  if (status === 'paused') return '运行当前处于暂停状态，等待继续或新的指令。';
  if (status === 'blocked') return '运行当前卡住了，需要你进入详情判断下一步。';
  if (status === 'init' || status === 'planning') return 'Hive 正在准备计划和首轮执行。';
  return goal && goal !== '-' ? goal : 'Hive 正在自动推进。';
}

function suggestedTaskActions(task: {
  cue: WebAttentionTask['cue'];
  task_id: string;
  cue_reason: string;
}): WebAttentionTask['suggested_actions'] {
  if (task.cue === 'needs_review') {
    return [
      { label: '请求重试此任务', action_type: 'retry_task', scope: 'task', reason: `${task.task_id}: ${task.cue_reason}` },
      { label: '标记为需人工判断', action_type: 'mark_requires_human', scope: 'task', reason: `${task.task_id}: ${task.cue_reason}` },
    ];
  }
  if (task.cue === 'blocked') {
    return [
      { label: '请求重试此任务', action_type: 'retry_task', scope: 'task', reason: `${task.task_id}: ${task.cue_reason}` },
      { label: '请求重新规划', action_type: 'request_replan', scope: 'run', reason: `${task.task_id}: ${task.cue_reason}` },
    ];
  }
  if (task.cue === 'needs_human') {
    return [
      { label: '标记为需人工判断', action_type: 'mark_requires_human', scope: 'task', reason: `${task.task_id}: ${task.cue_reason}` },
      { label: '请求重新规划', action_type: 'request_replan', scope: 'run', reason: `${task.task_id}: ${task.cue_reason}` },
    ];
  }
  return [
    { label: '请求重试此任务', action_type: 'retry_task', scope: 'task', reason: `${task.task_id}: ${task.cue_reason}` },
  ];
}

function buildAttentionTasks(
  data: ReturnType<typeof loadHiveShellDashboard>,
): WebAttentionTask[] {
  if (!data || !data.state) return [];

  const cues = deriveTaskCues({
    taskStates: data.state.task_states,
    steeringActions: data.steeringStore?.actions,
    nextAction: data.state.next_action,
    providerHealth: data.providerHealth,
  });

  const cuePriority: Record<string, number> = {
    needs_human: 0,
    blocked: 1,
    needs_review: 2,
    watch: 3,
  };

  const attentionCues = cues.filter(
    (c) => c.cue !== 'ready' && c.cue !== 'passive',
  );
  const workers = data.workerSnapshot?.workers || [];

  return attentionCues
    .map((cue) => {
      const worker = workers.find((w) => w.task_id === cue.task_id);
      const model =
        worker && worker.assigned_model === worker.active_model
          ? worker.active_model
          : worker
            ? `${worker.assigned_model} -> ${worker.active_model}`
            : '-';
      const fallback = worker?.provider_fallback_used
        ? `${worker.assigned_model}->${worker.active_model}`
        : undefined;
      const taskState = data.state?.task_states?.[cue.task_id];
      return {
        task_id: cue.task_id,
        status: worker?.status || taskState?.status || cue.cue,
        model,
        summary: truncate(
          worker?.task_summary || worker?.last_message,
          120,
        ),
        provider_failure: worker?.provider_failure_subtype,
        provider_fallback: fallback,
        cue: cue.cue as WebAttentionTask['cue'],
        cue_reason: cue.reason,
        retry_count: taskState?.retry_count ?? 0,
        suggested_actions: suggestedTaskActions({
          cue: cue.cue as WebAttentionTask['cue'],
          task_id: cue.task_id,
          cue_reason: cue.reason,
        }),
      };
    })
    .sort((a, b) => cuePriority[a.cue] - cuePriority[b.cue]);
}

function buildCompact(data: ReturnType<typeof loadHiveShellDashboard>): WebCompactData | null {
  if (!data || !data.state) return null;
  const latest = data.scoreHistory?.rounds.at(-1);
  const score = latest?.score;
  const packet = buildCompactPacket(data);
  const markdown = packet ? renderCompactPacket(packet) : '-';
  return {
    markdown,
    goal: data.spec?.goal || data.workerSnapshot?.goal || '-',
    status: data.state?.status || 'unknown',
    round: data.state?.round ?? data.workerSnapshot?.round ?? 0,
    next_action: data.state?.next_action?.kind || '-',
    score,
    authority_warning: packet?.authority_warning,
  };
}

function formatPolicyValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(', ');
  return value || '-';
}

function summarizeRoute(modelValue: string | string[] | undefined): string {
  const models = Array.isArray(modelValue) ? modelValue : [modelValue];
  const parts = models
    .filter((model): model is string => Boolean(model && model.trim()))
    .map((model) => {
      const resolved = resolveModelRouteFull(model);
      if (!resolved) return `${model}：无 route`;
      const transport = getClaudeCliMode(resolved.route);
      const fallbackChannels = getModelFallbackRoutes(resolved.modelId)
        .map((route) => route.provider_id)
        .filter(Boolean);
      const channelText = fallbackChannels.length > 0
        ? `，备选通道 ${fallbackChannels.join(', ')}`
        : '';
      return `${resolved.modelId} → ${resolved.route.provider_id} / ${transport}${channelText}`;
    });
  return parts.length > 0 ? parts.join('；') : '-';
}

function buildModelPolicy(cwd: string, runId: string): WebModelPolicySurface {
  return finalModelPolicy(cwd, runId);
}

function buildOperatorFocus(params: {
  spec: ReturnType<typeof loadRunSpec> | undefined;
  state: ReturnType<typeof loadRunState> | undefined;
  verdict: WebDashboardSnapshot['verdict'];
  attentionTasks: WebAttentionTask[];
}): WebOperatorFocus {
  const { spec, state, verdict, attentionTasks } = params;
  const taskStates = Object.values(state?.task_states || {});
  const allTasksVerified = taskStates.length > 0 && taskStates.every((task) => task.status === 'verified' || task.status === 'merged');
  const noMergedTasks = (state?.merged_task_ids || []).length === 0;
  const replanExhausted = verdict.why_stopped.includes('自动重规划次数已用完');

  if (attentionTasks.length > 0) {
    return {
      scope: 'task',
      title: '先看这些任务，其他任务先不用管',
      message: `当前只有 ${attentionTasks.length} 个任务值得你看；不要先钻进 Provider、Compact 或完整状态。`,
      checks: attentionTasks.slice(0, 3).map((task) => `${task.task_id}：${task.cue_reason}`),
    };
  }

  if (verdict.state === 'success') {
    return {
      scope: 'done',
      title: '先看结果是否可交付',
      message: '任务已经完成；此时优先确认代码结果或产物是否符合你的预期。',
      checks: [
        '先看代码 diff 或最终产物',
        '确认测试 / 验证已经通过',
        '不需要先看 Provider 或全部任务',
      ],
    };
  }

  if (verdict.needs_user) {
    const checks = replanExhausted
      ? [
        '这不是 task 级故障，先不要钻进任务列表',
        allTasksVerified && noMergedTasks && !spec?.allow_auto_merge
          ? '结果可能已经在 worker worktree 里，但主 repo 还没自动落地'
          : '先确认当前 repo 结果是否已经够用',
        '如果结果不够，再决定是否请求重新规划',
      ]
      : [
        '先读上面的停住原因，不要先看所有细节',
        '只有出现红/黄任务时，才进入任务明细',
        'Provider 和 Compact 只在排障时再看',
      ];
    return {
      scope: 'run',
      title: '这是运行级决策，不是任务海',
      message: replanExhausted
        ? '当前停在 run 级决策：Hive 不能再自动往前走，需要你判断结果是否已够用。'
        : '当前需要你做的是 run 级判断；不是所有内部状态都值得看。',
      checks,
    };
  }

  return {
    scope: 'run',
    title: '先看是否在自动推进',
    message: '当前没有需要你立刻处理的点；只要看是否还在推进即可。',
    checks: [
      '顶部结论是否仍在变化',
      '只有出现需要关注的任务时再下钻',
      'Provider / Compact 默认可以忽略',
    ],
  };
}

export function listWebRuns(cwd: string): WebRunListItem[] {
  const runMap = new Map<string, WebRunListItem>();
  const latestId = resolveHiveShellRunId(cwd) || listRuns(cwd)[0]?.id;

  for (const run of listRuns(cwd)) {
    const status = run.state?.status || deriveWorkerRunStatus(cwd, run.id);
    runMap.set(run.id, {
      id: run.id,
      status,
      goal: run.spec?.goal || deriveWorkerRunGoal(cwd, run.id),
      updated_at: resolveSurfaceUpdatedAt(run.state?.updated_at, undefined, run.spec?.created_at),
      is_latest: run.id === latestId,
      source: 'run',
      is_active: isActiveSurfaceStatus(status),
    });
  }

  for (const snapshot of listWorkerStatusSnapshots(cwd)) {
    const existing = runMap.get(snapshot.run_id);
    const workerStatus = deriveWorkerRunStatus(cwd, snapshot.run_id);
    const candidate: WebRunListItem = {
      id: snapshot.run_id,
      status: existing?.status && existing.status !== 'unknown' ? existing.status : workerStatus,
      goal: existing?.goal && existing.goal !== '-' ? existing.goal : deriveWorkerRunGoal(cwd, snapshot.run_id),
      updated_at: latestIsoTimestamp(existing?.updated_at, snapshot.updated_at),
      is_latest: snapshot.run_id === latestId,
      source: existing ? existing.source : 'worker',
      is_active: existing?.is_active ?? isActiveSurfaceStatus(workerStatus),
    };
    if (!existing || candidate.updated_at > existing.updated_at) {
      runMap.set(snapshot.run_id, candidate);
    }
  }

  return [...runMap.values()].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

export function listWebProjects(baseCwd?: string): WebProjectListItem[] {
  return listGlobalProjects(baseCwd).map((project) => ({ ...project }));
}

export function listWebActiveRuns(baseCwd?: string): WebActiveRunListItem[] {
  const items: WebActiveRunListItem[] = [];
  for (const project of listWebProjects(baseCwd)) {
    for (const run of listWebRuns(project.cwd)) {
      if (!run.is_active || !isFreshActiveRun(run.updated_at)) continue;
      const snapshot = loadWebDashboardSnapshot(project.cwd, run.id);
      items.push({
        project: {
          cwd: project.cwd,
          name: project.name,
        },
        run_id: run.id,
        status: snapshot?.truth.status || run.status,
        goal: snapshot?.truth.goal || run.goal,
        updated_at: snapshot?.updated_at || run.updated_at,
        source: run.source,
        needs_user: snapshot?.verdict.needs_user || run.status === 'blocked' || run.status === 'paused',
        attention_count: snapshot?.attention_tasks.length || 0,
        headline: snapshot?.verdict.headline || fallbackActiveHeadline(run.status),
        why_stopped: snapshot?.verdict.why_stopped || fallbackActiveReason(run.status, run.goal),
        suggested_action: snapshot?.verdict.suggested_action,
      });
    }
  }
  return items.sort((left, right) => {
    if (left.needs_user !== right.needs_user) return left.needs_user ? -1 : 1;
    if (left.attention_count !== right.attention_count) return right.attention_count - left.attention_count;
    return right.updated_at.localeCompare(left.updated_at);
  });
}

export function loadWebDashboardSnapshot(
  cwd: string,
  runId?: string,
): WebDashboardSnapshot | null {
  if (runId) {
    const hasSpec = loadRunSpec(cwd, runId);
    const hasState = loadRunState(cwd, runId);
    const hasDir = fs.existsSync(path.join(cwd, '.ai', 'runs', runId));
    if (!hasSpec && !hasState && !hasDir) return null;
  }

  const data = loadHiveShellDashboard(cwd, runId);
  if (!data) return null;
  if (runId && data.runId !== runId) return null;
  if (!data.spec && !data.state && !data.workerSnapshot) return null;

  const state = data.state;
  const spec = data.spec;
  const workerSnapshot = data.workerSnapshot;
  const latestScore = data.scoreHistory?.rounds.at(-1);
  const surfaceStatus = state?.status || (workerSnapshot ? deriveWorkerRunStatus(cwd, data.runId) : 'unknown');

  const goal = spec?.goal || workerSnapshot?.goal || '-';
  const round = state?.round ?? workerSnapshot?.round ?? 0;
  const maxRounds = spec?.max_rounds;
  const effectiveMode = state?.runtime_mode_override || spec?.execution_mode || 'auto';
  const nextAction = state?.next_action || (workerSnapshot && surfaceStatus === 'running'
    ? { kind: 'dispatch', reason: '正在执行 worker 任务' }
    : undefined);
  const summary = state?.final_summary || workerSnapshot?.workers?.[0]?.task_summary || (workerSnapshot ? 'worker 任务运行中' : '-');

  const reviews = data.result?.review_results || [];
  const lastReview = reviews.at(-1);
  const authority = lastReview?.authority;
  const failures: string[] = [];
  if (lastReview?.authority?.reviewer_runtime_failures) {
    for (const f of lastReview.authority.reviewer_runtime_failures) {
      failures.push(`${f.model || 'reviewer'}: ${f.reason}`);
    }
  }

  const steeringStore = data.steeringStore;
  const pendingSteering = steeringStore?.actions.filter((a) => a.status === 'pending').length || 0;

  const provider = summarizeProvider(data);

  const runSummary = generateRunSummary({
    runId: data.runId,
    spec,
    state,
    progress: data.loopProgress,
    plan: data.plan || undefined,
    reviewResults: reviews,
    providerHealth: data.providerHealth,
    steeringStore: data.steeringStore || undefined,
  });

  const attention = {
    paused: state?.steering?.paused ?? false,
    primary_blocker: humanizeReason(runSummary.primary_blocker?.description),
    authority_degradation: failures.length > 0 ? failures.join('; ') : undefined,
    pending_steering: pendingSteering,
  };

  const verdict = buildVerdict(surfaceStatus, attention, nextAction);
  const attentionTasks = buildAttentionTasks(data);

  return {
    project: {
      cwd,
      name: path.basename(path.resolve(cwd)) || cwd,
    },
    runId: data.runId,
    updated_at: resolveSurfaceUpdatedAt(state?.updated_at, workerSnapshot?.updated_at, spec?.created_at),
    attention,
    truth: {
      goal,
      status: surfaceStatus,
      round,
      max_rounds: maxRounds,
      effective_mode: effectiveMode,
      next_action: nextAction?.kind || '-',
      next_reason: truncate(humanizeReason(nextAction?.reason), 200),
      summary: truncate(summary, 200),
      score: latestScore?.score,
      score_best: data.scoreHistory?.best_score ?? latestScore?.score,
    },
    authority: {
      mode: authority?.mode,
      members: authority?.members,
      reviewer_runtime_failures: failures.length > 0 ? failures : undefined,
    },
    provider,
    tasks: buildTasks(data),
    attention_tasks: attentionTasks,
    focus: buildOperatorFocus({ spec, state, verdict, attentionTasks }),
    model_policy: buildModelPolicy(cwd, data.runId),
    compact: buildCompact(data),
    steering: (steeringStore?.actions.slice(-6) || []).map((a) => ({
      action_id: a.action_id,
      action_type: a.action_type,
      status: a.status,
      scope: a.scope,
      outcome: a.outcome,
    })),
    verdict,
  };
}

export function submitWebSteeringAction(
  cwd: string,
  runId: string,
  actionType: SteeringActionType,
  reason?: string,
  taskId?: string,
): ReturnType<typeof submitSteeringAction> {
  return submitSteeringAction(cwd, runId, {
    run_id: runId,
    task_id: taskId,
    action_type: actionType,
    scope: taskId ? 'task' : 'run',
    payload: { reason },
    requested_by: 'web',
  });
}

export function listWebModelOptions(): WebModelOption[] {
  const registry = new ModelRegistry();
  return registry.getAll()
    .map((model) => ({
      id: model.id,
      provider: model.provider,
      route_summary: summarizeRoute(model.id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function loadWebModelPolicy(
  cwd: string,
  runId: string,
): WebModelPolicySurface | null {
  const snapshot = loadWebDashboardSnapshot(cwd, runId);
  if (!snapshot) return null;
  return buildModelPolicy(cwd, runId);
}

export function loadWebConfigPolicy(
  cwd: string,
  runId: string,
): WebConfigPolicySurface | null {
  return configSurface(cwd, runId);
}

export function updateWebModelPolicy(
  cwd: string,
  runId: string,
  source: RunModelPolicySource,
  patch: RunModelPolicyPatch,
): WebModelPolicySurface | null {
  const snapshot = loadWebDashboardSnapshot(cwd, runId);
  if (!snapshot) return null;
  updateRunModelOverrides(cwd, runId, source, patch);
  setRunPolicySaveResult(source, cwd, runId);
  return buildModelPolicy(cwd, runId);
}

export function clearWebModelPolicyStage(
  cwd: string,
  runId: string,
  source: RunModelPolicySource,
  stage: RunModelPolicyStage,
): WebModelPolicySurface | null {
  const snapshot = loadWebDashboardSnapshot(cwd, runId);
  if (!snapshot) return null;
  return clearRunPolicyStage(cwd, runId, source, stage);
}

export function resetWebModelPolicy(
  cwd: string,
  runId: string,
  source?: RunModelPolicySource,
): WebModelPolicySurface | null {
  const snapshot = loadWebDashboardSnapshot(cwd, runId);
  if (!snapshot) return null;
  resetRunModelOverrides(cwd, runId, source);
  if (source) setRunPolicySaveResult(source, cwd, runId);
  return buildModelPolicy(cwd, runId);
}

export function updateWebConfigPolicy(
  cwd: string,
  runId: string,
  scope: 'global' | 'project',
  patch: RunModelPolicyPatch,
): WebConfigPolicySurface | null {
  return updateProjectOrGlobalConfig(scope, cwd, patch);
}

export function clearWebConfigPolicyStage(
  cwd: string,
  runId: string,
  scope: 'global' | 'project',
  stage: RunModelPolicyStage,
): WebConfigPolicySurface | null {
  return clearConfigPolicyStage(scope, cwd, stage);
}

export function resetWebConfigPolicy(
  cwd: string,
  runId: string,
  scope: 'global' | 'project',
): WebConfigPolicySurface | null {
  return resetProjectOrGlobalConfig(scope, cwd);
}

export function consumePolicySaveResult(): WebPolicySaveResult | undefined {
  return pullOneShotPolicyFeedback();
}
