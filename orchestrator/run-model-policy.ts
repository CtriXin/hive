import fs from 'fs';
import path from 'path';
import type {
  DiscussTierConfig,
  HiveConfig,
  ReviewerTierConfig,
  RunSpec,
  RunState,
  TierConfig,
} from './types.js';
import { loadConfig, resolveTierModel } from './hive-config.js';
import { ModelRegistry } from './model-registry.js';

export type RunModelPolicyStage =
  | 'translator'
  | 'planner'
  | 'executor'
  | 'discuss'
  | 'reviewer.cross_review'
  | 'reviewer.arbitration'
  | 'reviewer.final_review';

export type RunModelPolicySource = 'start-run' | 'runtime-next-stage';

export interface RunModelPolicyPatch {
  translator?: Partial<TierConfig>;
  planner?: Partial<TierConfig>;
  executor?: Partial<TierConfig>;
  discuss?: Partial<DiscussTierConfig>;
  reviewer?: {
    cross_review?: Partial<TierConfig>;
    arbitration?: Partial<TierConfig>;
    final_review?: Partial<TierConfig>;
  };
}

export interface RunModelPolicyOverrides {
  start_time?: RunModelPolicyPatch;
  runtime_next_stage?: RunModelPolicyPatch;
  updated_at: string;
}

export interface EffectiveStagePolicy {
  stage: RunModelPolicyStage;
  config: unknown;
  effective: unknown;
  overridden: boolean;
  source: RunModelPolicySource | 'default';
}

export interface EffectiveRunModelPolicy {
  base_policy: {
    translator: TierConfig;
    planner: TierConfig;
    executor: TierConfig;
    discuss: DiscussTierConfig;
    reviewer: ReviewerTierConfig;
  };
  run_override: RunModelPolicyPatch | null;
  runtime_override: RunModelPolicyPatch | null;
  effective_policy: {
    translator: TierConfig;
    planner: TierConfig;
    executor: TierConfig;
    discuss: DiscussTierConfig;
    reviewer: ReviewerTierConfig;
  };
  stages: EffectiveStagePolicy[];
  override_active: boolean;
  override_summary?: string;
}

function runDir(cwd: string, runId: string): string {
  return path.join(cwd, '.ai', 'runs', runId);
}

function artifactPath(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'model-overrides.json');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeDefined<T>(base: T, patch?: Partial<T>): T {
  return { ...clone(base), ...(patch || {}) };
}

function mergePatch(base: RunModelPolicyPatch | null | undefined, patch: RunModelPolicyPatch): RunModelPolicyPatch {
  return {
    translator: mergeDefined(base?.translator || {}, patch.translator),
    planner: mergeDefined(base?.planner || {}, patch.planner),
    executor: mergeDefined(base?.executor || {}, patch.executor),
    discuss: mergeDefined(base?.discuss || {}, patch.discuss),
    reviewer: {
      cross_review: mergeDefined(base?.reviewer?.cross_review || {}, patch.reviewer?.cross_review),
      arbitration: mergeDefined(base?.reviewer?.arbitration || {}, patch.reviewer?.arbitration),
      final_review: mergeDefined(base?.reviewer?.final_review || {}, patch.reviewer?.final_review),
    },
  };
}

function hasEntries(value?: object | null): boolean {
  return Boolean(value) && Object.keys(value as object).length > 0;
}

function patchHasValues(patch: RunModelPolicyPatch | null | undefined): boolean {
  if (!patch) return false;
  return [
    patch.translator,
    patch.planner,
    patch.executor,
    patch.discuss,
    patch.reviewer?.cross_review,
    patch.reviewer?.arbitration,
    patch.reviewer?.final_review,
  ].some((entry) => hasEntries(entry));
}

function normalizePatch(patch?: RunModelPolicyPatch | null): RunModelPolicyPatch | null {
  if (!patchHasValues(patch)) return null;
  return {
    ...(hasEntries(patch?.translator) ? { translator: patch?.translator } : {}),
    ...(hasEntries(patch?.planner) ? { planner: patch?.planner } : {}),
    ...(hasEntries(patch?.executor) ? { executor: patch?.executor } : {}),
    ...(hasEntries(patch?.discuss) ? { discuss: patch?.discuss } : {}),
    ...((hasEntries(patch?.reviewer?.cross_review) || hasEntries(patch?.reviewer?.arbitration) || hasEntries(patch?.reviewer?.final_review))
      ? {
        reviewer: {
          ...(hasEntries(patch?.reviewer?.cross_review) ? { cross_review: patch?.reviewer?.cross_review } : {}),
          ...(hasEntries(patch?.reviewer?.arbitration) ? { arbitration: patch?.reviewer?.arbitration } : {}),
          ...(hasEntries(patch?.reviewer?.final_review) ? { final_review: patch?.reviewer?.final_review } : {}),
        },
      }
      : {}),
  };
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function loadRunModelOverrides(cwd: string, runId: string): RunModelPolicyOverrides | null {
  return readJson<RunModelPolicyOverrides>(artifactPath(cwd, runId));
}

export function saveRunModelOverrides(cwd: string, runId: string, overrides: RunModelPolicyOverrides): void {
  writeJson(artifactPath(cwd, runId), overrides);
}

export function updateRunModelOverrides(
  cwd: string,
  runId: string,
  source: RunModelPolicySource,
  patch: RunModelPolicyPatch,
): RunModelPolicyOverrides {
  const current = loadRunModelOverrides(cwd, runId) || { updated_at: new Date(0).toISOString() };
  const next: RunModelPolicyOverrides = {
    start_time: source === 'start-run' ? normalizePatch(mergePatch(current.start_time, patch)) || undefined : current.start_time,
    runtime_next_stage: source === 'runtime-next-stage' ? normalizePatch(mergePatch(current.runtime_next_stage, patch)) || undefined : current.runtime_next_stage,
    updated_at: new Date().toISOString(),
  };
  saveRunModelOverrides(cwd, runId, next);
  return next;
}

export function resetRunModelOverrides(
  cwd: string,
  runId: string,
  source?: RunModelPolicySource,
): RunModelPolicyOverrides {
  const current = loadRunModelOverrides(cwd, runId) || { updated_at: new Date().toISOString() };
  const next: RunModelPolicyOverrides = {
    start_time: source === 'runtime-next-stage' ? current.start_time : undefined,
    runtime_next_stage: source === 'start-run' ? current.runtime_next_stage : undefined,
    updated_at: new Date().toISOString(),
  };
  if (!patchHasValues(next.start_time) && !patchHasValues(next.runtime_next_stage)) {
    const filePath = artifactPath(cwd, runId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { updated_at: next.updated_at };
  }
  saveRunModelOverrides(cwd, runId, next);
  return next;
}

function basePolicy(config: HiveConfig): EffectiveRunModelPolicy['base_policy'] {
  return {
    translator: clone(config.tiers.translator),
    planner: clone(config.tiers.planner),
    executor: clone(config.tiers.executor),
    discuss: clone(config.tiers.discuss),
    reviewer: clone(config.tiers.reviewer),
  };
}

function applyPatch(base: EffectiveRunModelPolicy['base_policy'], patch?: RunModelPolicyPatch | null): EffectiveRunModelPolicy['base_policy'] {
  if (!patch) return clone(base);
  return {
    translator: mergeDefined(base.translator, patch.translator),
    planner: mergeDefined(base.planner, patch.planner),
    executor: mergeDefined(base.executor, patch.executor),
    discuss: mergeDefined(base.discuss, patch.discuss),
    reviewer: {
      cross_review: mergeDefined(base.reviewer.cross_review, patch.reviewer?.cross_review),
      arbitration: mergeDefined(base.reviewer.arbitration, patch.reviewer?.arbitration),
      final_review: mergeDefined(base.reviewer.final_review, patch.reviewer?.final_review),
    },
  };
}

function stageConfigList(
  base: EffectiveRunModelPolicy['base_policy'],
  runOverride: RunModelPolicyPatch | null | undefined,
  runtimeOverride: RunModelPolicyPatch | null | undefined,
  effective: EffectiveRunModelPolicy['effective_policy'],
): EffectiveStagePolicy[] {
  return [
    { stage: 'translator', config: base.translator, effective: effective.translator, overridden: hasEntries(runOverride?.translator) || hasEntries(runtimeOverride?.translator), source: hasEntries(runtimeOverride?.translator) ? 'runtime-next-stage' : hasEntries(runOverride?.translator) ? 'start-run' : 'default' },
    { stage: 'planner', config: base.planner, effective: effective.planner, overridden: hasEntries(runOverride?.planner) || hasEntries(runtimeOverride?.planner), source: hasEntries(runtimeOverride?.planner) ? 'runtime-next-stage' : hasEntries(runOverride?.planner) ? 'start-run' : 'default' },
    { stage: 'executor', config: base.executor, effective: effective.executor, overridden: hasEntries(runOverride?.executor) || hasEntries(runtimeOverride?.executor), source: hasEntries(runtimeOverride?.executor) ? 'runtime-next-stage' : hasEntries(runOverride?.executor) ? 'start-run' : 'default' },
    { stage: 'discuss', config: base.discuss, effective: effective.discuss, overridden: hasEntries(runOverride?.discuss) || hasEntries(runtimeOverride?.discuss), source: hasEntries(runtimeOverride?.discuss) ? 'runtime-next-stage' : hasEntries(runOverride?.discuss) ? 'start-run' : 'default' },
    { stage: 'reviewer.cross_review', config: base.reviewer.cross_review, effective: effective.reviewer.cross_review, overridden: hasEntries(runOverride?.reviewer?.cross_review) || hasEntries(runtimeOverride?.reviewer?.cross_review), source: hasEntries(runtimeOverride?.reviewer?.cross_review) ? 'runtime-next-stage' : hasEntries(runOverride?.reviewer?.cross_review) ? 'start-run' : 'default' },
    { stage: 'reviewer.arbitration', config: base.reviewer.arbitration, effective: effective.reviewer.arbitration, overridden: hasEntries(runOverride?.reviewer?.arbitration) || hasEntries(runtimeOverride?.reviewer?.arbitration), source: hasEntries(runtimeOverride?.reviewer?.arbitration) ? 'runtime-next-stage' : hasEntries(runOverride?.reviewer?.arbitration) ? 'start-run' : 'default' },
    { stage: 'reviewer.final_review', config: base.reviewer.final_review, effective: effective.reviewer.final_review, overridden: hasEntries(runOverride?.reviewer?.final_review) || hasEntries(runtimeOverride?.reviewer?.final_review), source: hasEntries(runtimeOverride?.reviewer?.final_review) ? 'runtime-next-stage' : hasEntries(runOverride?.reviewer?.final_review) ? 'start-run' : 'default' },
  ];
}

function modelLabel(value: unknown): string {
  if (Array.isArray(value)) return value.join(',');
  if (value && typeof value === 'object' && 'model' in (value as Record<string, unknown>)) {
    return modelLabel((value as Record<string, unknown>).model);
  }
  return String(value ?? '-');
}

function overrideSummary(stages: EffectiveStagePolicy[]): string | undefined {
  const active = stages.filter((stage) => stage.overridden);
  if (active.length === 0) return undefined;
  return active.map((stage) => `${stage.stage}=${modelLabel(stage.effective)}`).join(', ');
}

export function resolveEffectiveRunModelPolicy(cwd: string, runId?: string): EffectiveRunModelPolicy {
  const config = loadConfig(cwd);
  const base = basePolicy(config);
  const overrides = runId ? loadRunModelOverrides(cwd, runId) : null;
  const runOverride = overrides?.start_time || null;
  const runtimeOverride = overrides?.runtime_next_stage || null;
  const withRunOverride = applyPatch(base, runOverride);
  const effective = applyPatch(withRunOverride, runtimeOverride);
  const stages = stageConfigList(base, runOverride, runtimeOverride, effective);
  return {
    base_policy: base,
    run_override: runOverride,
    runtime_override: runtimeOverride,
    effective_policy: effective,
    stages,
    override_active: stages.some((stage) => stage.overridden),
    override_summary: overrideSummary(stages),
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

export function previewResolvedModelPolicy(cwd: string, patch?: RunModelPolicyPatch | null): EffectiveRunModelPolicy {
  const config = loadConfig(cwd);
  const base = basePolicy(config);
  const normalizedPatch = normalizePatch(patch);
  const effective = applyPatch(base, normalizedPatch);
  const registry = new ModelRegistry();
  const resolvedStages = stageConfigList(base, normalizedPatch, null, effective).map((stage) => ({
    ...stage,
    effective: stage.stage === 'translator'
      ? {
        model: resolveTierModel(effective.translator.model, () => registry.selectTranslator(), registry, 'translation', config),
        fallback: effective.translator.fallback,
      }
      : stage.stage === 'planner'
        ? {
          model: resolveTierModel(effective.planner.model, () => registry.selectForPlanning(), registry, 'planning', config),
          fallback: effective.planner.fallback,
        }
        : stage.stage === 'executor'
          ? {
            model: resolveTierModel(effective.executor.model, () => registry.assignModel({
              id: 'preview',
              description: 'preview',
              complexity: 'medium',
              category: 'general',
              assigned_model: 'kimi-for-coding',
              assignment_reason: '',
              estimated_files: [],
              acceptance_criteria: [],
              discuss_threshold: 0.7,
              depends_on: [],
              review_scale: 'auto',
            }), registry, 'implementation', config),
            fallback: effective.executor.fallback,
          }
          : stage.stage === 'discuss'
            ? {
              model: resolveDiscussModels(effective.discuss.model, registry, config),
              fallback: effective.discuss.fallback,
              mode: effective.discuss.mode,
            }
            : stage.stage === 'reviewer.cross_review'
              ? {
                model: resolveTierModel(effective.reviewer.cross_review.model, () => registry.selectReviewer(), registry, 'review', config),
                fallback: effective.reviewer.cross_review.fallback,
              }
              : stage.stage === 'reviewer.arbitration'
                ? {
                  model: resolveTierModel(effective.reviewer.arbitration.model, () => registry.selectReviewer(), registry, 'review', config),
                  fallback: effective.reviewer.arbitration.fallback,
                }
                : {
                  model: resolveTierModel(effective.reviewer.final_review.model, () => registry.selectForFinalReview(), registry, 'review', config),
                  fallback: effective.reviewer.final_review.fallback,
                },
  }));
  return {
    base_policy: base,
    run_override: normalizedPatch,
    runtime_override: null,
    effective_policy: effective,
    stages: resolvedStages,
    override_active: Boolean(normalizedPatch),
    override_summary: overrideSummary(resolvedStages),
  };
}

export function consumeRuntimeModelOverrides(spec: RunSpec, state: RunState): boolean {
  const overrides = loadRunModelOverrides(spec.cwd, spec.id);
  if (!overrides?.runtime_next_stage) return false;
  updateRunModelOverrides(spec.cwd, spec.id, 'start-run', overrides.runtime_next_stage);
  resetRunModelOverrides(spec.cwd, spec.id, 'runtime-next-stage');
  state.updated_at = new Date().toISOString();
  return true;
}
