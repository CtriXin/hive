// orchestrator/model-registry.ts — Model registry with MMS discovery and profiler-backed ranking
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SubTask, Complexity } from './types.js';
import type { BenchmarkPolicy, ModelProfile, ProfileScoreKey } from './profiler.js';
import {
  getEffectiveScore,
  loadBenchmarkPolicy,
  loadProfiles,
  mergeAvoidTags,
  updateObservedScore,
} from './profiler.js';
import type { TaskFingerprint } from './task-fingerprint.js';
import { buildTaskFingerprint } from './task-fingerprint.js';
import { getModelForTask, loadConfig } from './hive-config.js';
import { resolveProjectPath } from './project-paths.js';
import { resolveProvider as resolveConfiguredProvider } from './provider-resolver.js';
import { loadMmsRoutes, resolveModelRoute } from './mms-routes-loader.js';
import type { StaticModelConfig, StaticClaudeTierConfig, StaticCapabilitiesConfig } from './model-defaults.js';
import { normalizeModelId, titleCaseModelId, inferMaxComplexity, guessProviderFamily } from './model-defaults.js';
import {
  type RankedAssignment,
  type ScorerContext,
  clamp,
  computeWeightedScore,
  getHardFilterFailures,
  EXPECTED_ITERATIONS,
  COMPLEXITY_INFO_WEIGHT,
  FAILURE_WEIGHT,
} from './model-scorer.js';

// Re-export for consumers
export type { RankedAssignment } from './model-scorer.js';

export interface LegacyModelView {
  id: string;
  provider: string;
  display_name: string;
  coding: number;
  tool_use_reliability: number;
  reasoning: number;
  chinese: number;
  pass_rate: number;
  avg_iterations: number;
  total_tasks_completed: number;
  last_updated: string;
  context_window: number;
  cost_per_mtok_input: number;
  cost_per_mtok_output: number;
  max_complexity: Complexity;
  sweet_spot: string[];
  avoid: string[];
}

// mms speed-stats.json format (producer: ccs_speed_stats.py)
interface SpeedStatsEntry {
  ttfb_avg_ms?: number;
  ttfb_avg?: number;
  tps_avg: number | null;
  samples: number;
  tps_samples?: number;
  warming_up?: boolean;
  last_updated?: string;
}

function getDefaultConfigPath(): string {
  return resolveProjectPath('config', 'model-capabilities.json');
}

export class ModelRegistry {
  private models = new Map<string, StaticModelConfig>();
  private claudeTiers = new Map<'opus' | 'sonnet' | 'haiku', StaticClaudeTierConfig>();
  private policy: BenchmarkPolicy;
  private profiles = loadProfiles();
  private configPath: string;
  private speedStatsCache: Record<string, SpeedStatsEntry> | null = null;
  private providerResolutionCache = new Map<string, boolean>();

  constructor(configPath: string = getDefaultConfigPath()) {
    this.configPath = configPath;
    this.policy = loadBenchmarkPolicy();
    this.reload();
  }

  reload(): void {
    const raw = fs.readFileSync(this.configPath, 'utf-8');
    const config = JSON.parse(raw) as StaticCapabilitiesConfig;

    this.models = new Map(Object.entries(config.models || {}));

    for (const [tier, tierConfig] of Object.entries(config.claude_tiers || {})) {
      const claudeId = tierConfig.id;
      if (!this.models.has(claudeId)) {
        this.models.set(claudeId, {
          provider: `claude-${tier}`,
          strengths: tierConfig.strengths,
          scores: tierConfig.scores,
          context_window: tierConfig.context_window,
          cost_per_1k: tierConfig.cost_per_1k,
          speed_tier: tier === 'haiku' ? 'fast' : 'strong',
        });
      }
    }

    this.claudeTiers = new Map(
      Object.entries(config.claude_tiers || {}).map(([tier, value]) => [
        tier as 'opus' | 'sonnet' | 'haiku',
        value,
      ]),
    );

    this.mergeMmsModels();
    this.policy = loadBenchmarkPolicy();
    this.profiles = loadProfiles();
    this.providerResolutionCache.clear();
  }

  private mergeMmsModels(): void {
    const mmsTable = loadMmsRoutes();
    if (!mmsTable) return;

    for (const [modelId, route] of Object.entries(mmsTable.routes)) {
      if (this.models.has(modelId) || modelId.startsWith('_')) continue;

      const family = guessProviderFamily(modelId, route.provider_id);
      this.models.set(modelId, {
        provider: route.provider_id,
        strengths: family.strengths,
        scores: family.scores,
        context_window: family.context_window,
        cost_per_1k: family.cost_per_1k,
        speed_tier: 'balanced',
      });
    }
  }

  // ── Accessors ──

  getAll(): LegacyModelView[] {
    return [...this.models.entries()].map(([id, m]) => this.toLegacyModelView(id, m));
  }

  /** Return only models that have a working provider (MMS route or providers.json). */
  getResolvable(): LegacyModelView[] {
    return [...this.models.entries()]
      .filter(([id]) => this.canResolveForModel(id))
      .map(([id, m]) => this.toLegacyModelView(id, m));
  }

  get(id: string): LegacyModelView | undefined {
    const cid = normalizeModelId(id);
    const model = this.models.get(cid);
    return model ? this.toLegacyModelView(cid, model) : undefined;
  }

  getModel(id: string): LegacyModelView | undefined {
    return this.get(id);
  }

  getClaudeTier(tier: 'opus' | 'sonnet' | 'haiku'): StaticClaudeTierConfig | undefined {
    return this.claudeTiers.get(tier);
  }

  // ── Ranking ──

  rankModelsForTask(input: SubTask | TaskFingerprint): RankedAssignment[] {
    const fingerprint = this.isSubTask(input) ? buildTaskFingerprint(input) : input;
    const ctx = this.scorerContext();
    const assignments: RankedAssignment[] = [];

    for (const [modelId, model] of this.models.entries()) {
      const profile = this.profiles.profiles[modelId];
      const blockedBy = getHardFilterFailures(ctx, modelId, model, profile, fingerprint);
      if (blockedBy.length > 0) {
        assignments.push({
          model: modelId, final_score: 0, confidence: 0, domain_bonus: 0,
          reasons: ['filtered by hard constraints'], blocked_by: blockedBy,
        });
        continue;
      }
      assignments.push(computeWeightedScore(ctx, modelId, model, profile, fingerprint));
    }

    return assignments.sort((a, b) => b.final_score - a.final_score);
  }

  assignModel(task: SubTask): string {
    return getModelForTask(task, loadConfig(process.cwd()), this);
  }

  /**
   * Resolve a provider shorthand (e.g. 'qwen', 'kimi', 'glm', 'minimax') to
   * the best model from that provider for the given role.
   * Returns undefined if no models match the provider name.
   */
  resolveProviderShorthand(shorthand: string, role?: string): string | undefined {
    const lower = shorthand.toLowerCase();
    const fingerprint: TaskFingerprint = {
      role: (role as TaskFingerprint['role']) || 'general',
      domains: ['typescript'],
      complexity: 'medium',
      needs_strict_boundary: false,
      needs_fast_turnaround: false,
      is_repair_round: false,
    };

    // Match models whose provider starts with or contains the shorthand
    const matching = [...this.models.entries()].filter(([_id, m]) => {
      const p = m.provider.toLowerCase().replace(/-cn$/, '').replace(/-en$/, '');
      return p === lower || p.startsWith(lower);
    });

    if (matching.length === 0) return undefined;

    // Rank matched models and pick the best unblocked one
    const ctx = this.scorerContext();
    const ranked = matching
      .map(([modelId, model]) => {
        const profile = this.profiles.profiles[modelId];
        const blocked = getHardFilterFailures(ctx, modelId, model, profile, fingerprint);
        if (blocked.length > 0) return { model: modelId, score: 0 };
        const scored = computeWeightedScore(ctx, modelId, model, profile, fingerprint);
        return { model: modelId, score: scored.final_score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.model;
  }

  // ── Tier selection methods ──

  selectCrossReviewer(workerModelId: string): string {
    const workerProvider = this.models.get(workerModelId)?.provider;
    const ranked = this.rankModelsForTask({
      role: 'review', domains: ['typescript', 'tests'], complexity: 'medium',
      needs_strict_boundary: true, needs_fast_turnaround: false, is_repair_round: false,
    }).filter((c) => !c.model.startsWith('claude-')); // Auto review = domestic only
    return ranked.find((c) => {
      const p = this.models.get(c.model)?.provider;
      return p && p !== workerProvider && !c.blocked_by?.length;
    })?.model || ranked.find((c) => !c.blocked_by?.length)?.model || this.firstKnownModel(['kimi-for-coding', 'kimi-k2.5']);
  }

  selectDiscussPartner(workerModelId: string): string {
    const ranked = this.rankModelsForTask({
      role: 'review', domains: ['typescript', 'architecture'], complexity: 'medium',
      needs_strict_boundary: false, needs_fast_turnaround: false, is_repair_round: false,
    });
    return ranked.find((c) => c.model !== workerModelId && !c.blocked_by?.length)?.model
      || this.firstKnownModel(['kimi-for-coding', 'kimi-k2.5', 'qwen3-max']);
  }

  selectReviewer(): string {
    const ranked = this.rankModelsForTask({
      role: 'review', domains: ['typescript', 'tests'], complexity: 'medium',
      needs_strict_boundary: false, needs_fast_turnaround: false, is_repair_round: false,
    });
    return ranked.find((c) => !c.blocked_by?.length)?.model || this.firstKnownModel(['kimi-for-coding', 'kimi-k2.5']);
  }

  selectForPlanning(): string {
    const ranked = this.rankModelsForTask({
      role: 'planning', domains: ['typescript', 'architecture'], complexity: 'high',
      needs_strict_boundary: true, needs_fast_turnaround: false, is_repair_round: false,
    });
    return ranked.find((c) => !c.blocked_by?.length)?.model
      || this.firstKnownModel(['claude-opus-4-6', 'qwen3-max']);
  }

  selectForArbitration(): string {
    const ranked = this.rankModelsForTask({
      role: 'review', domains: ['typescript', 'tests'], complexity: 'medium-high',
      needs_strict_boundary: true, needs_fast_turnaround: false, is_repair_round: false,
    });
    return ranked.find((c) => !c.blocked_by?.length)?.model
      || this.firstKnownModel(['claude-sonnet-4-6', 'kimi-for-coding', 'kimi-k2.5']);
  }

  selectForFinalReview(): string {
    const ranked = this.rankModelsForTask({
      role: 'review', domains: ['typescript', 'architecture', 'integration'], complexity: 'high',
      needs_strict_boundary: true, needs_fast_turnaround: false, is_repair_round: false,
    });
    return ranked.find((c) => !c.blocked_by?.length)?.model
      || this.firstKnownModel(['claude-opus-4-6', 'qwen3-max']);
  }

  selectForReporter(): string {
    const ranked = this.rankModelsForTask({
      role: 'planning', domains: ['general'], complexity: 'low',
      needs_strict_boundary: false, needs_fast_turnaround: true, is_repair_round: false,
    });
    const candidates = ranked.filter((c) => !c.blocked_by?.length);
    const withChinese = candidates
      .map((c) => ({ model: c.model, score: c.final_score + (this.models.get(c.model)?.scores.translation ?? 0) * 0.3 }))
      .sort((a, b) => b.score - a.score);
    return withChinese[0]?.model || this.firstKnownModel(['kimi-for-coding', 'kimi-k2.5', 'glm-5-turbo']);
  }

  selectA2aLensModels(workerModelId: string): string[] {
    const ranked = this.rankModelsForTask({
      role: 'review', domains: ['typescript', 'integration'], complexity: 'medium-high',
      needs_strict_boundary: true, needs_fast_turnaround: false, is_repair_round: false,
    }).filter((c) => !c.model.startsWith('claude-')); // Auto review = domestic only

    const selected: string[] = [];
    const seenProviders = new Set<string>();

    for (const c of ranked) {
      if (c.blocked_by?.length || c.model === workerModelId) continue;
      const provider = this.models.get(c.model)?.provider || '';
      if (!seenProviders.has(provider)) {
        selected.push(c.model);
        seenProviders.add(provider);
      }
      if (selected.length === 3) break;
    }

    for (const c of ranked) {
      if (selected.length >= 3) break;
      if (c.blocked_by?.length || c.model === workerModelId || selected.includes(c.model)) continue;
      selected.push(c.model);
    }

    return selected;
  }

  // ── Speed & translator ──

  getSpeedTier(modelId: string): 'fast' | 'balanced' | 'strong' | 'unknown' {
    const stats = this.resolveSpeedEntry(modelId);
    if (stats && stats.samples >= 3) {
      const ttfb = stats.ttfb_avg_ms ?? stats.ttfb_avg ?? Infinity;
      if (ttfb < 500) return 'fast';
      if (ttfb < 2000) return 'balanced';
      return 'strong';
    }
    return this.models.get(normalizeModelId(modelId))?.speed_tier || 'unknown';
  }

  selectTranslator(): string {
    const config = loadConfig(process.cwd());
    if (config.translator_model) return config.translator_model;

    const fastModels = [...this.models.entries()]
      .filter(([id]) => this.getSpeedTier(id) === 'fast')
      .map(([id, m]) => ({ id, chinese: m.scores.translation }))
      .sort((a, b) => b.chinese - a.chinese);

    if (fastModels.length > 0) return fastModels[0].id;

    const allByChinese = this.getAll().sort((a, b) => b.chinese - a.chinese);
    return allByChinese[0]?.id || this.firstKnownModel(['glm-5-turbo', 'kimi-for-coding', 'kimi-k2.5']);
  }

  getModelsBySpeedTier(tier: 'fast' | 'balanced' | 'strong'): string[] {
    return [...this.models.keys()].filter((id) => this.getSpeedTier(id) === tier);
  }

  selectTranslatorFallback(failedModel: string): string {
    const fast = this.getModelsBySpeedTier('fast').filter((id) => id !== failedModel);
    if (fast.length > 0) {
      const best = fast.map((id) => ({ id, c: this.get(id)?.chinese || 0 })).sort((a, b) => b.c - a.c);
      return best[0].id;
    }
    const balanced = this.getModelsBySpeedTier('balanced').filter((id) => id !== failedModel);
    if (balanced.length > 0) return balanced[0];
    return this.getAll().filter((m) => m.id !== failedModel).sort((a, b) => b.chinese - a.chinese)[0]?.id
      || this.firstKnownModel(['glm-5-turbo', 'kimi-for-coding', 'kimi-k2.5']);
  }

  // ── Score update ──

  updateScore(
    modelId: string, passed: boolean, iterations: number,
    complexity: Complexity, role: TaskFingerprint['role'],
    needsFastTurnaround: boolean, needsStrictBoundary: boolean,
  ): void {
    const cid = normalizeModelId(modelId);
    if (!this.models.has(cid)) return;

    const baseAlpha = 0.2;
    const passSignal = passed ? 1 : 0;
    const expected = EXPECTED_ITERATIONS[complexity];
    const repairSignal = clamp(1 - Math.max(0, iterations - expected) * 0.25, 0, 1);
    const effectiveAlpha = passed
      ? Math.min(baseAlpha * COMPLEXITY_INFO_WEIGHT[complexity], 0.4)
      : Math.min(baseAlpha * FAILURE_WEIGHT[complexity], 0.4);
    const sampleWeight = clamp(
      passed ? COMPLEXITY_INFO_WEIGHT[complexity] : FAILURE_WEIGHT[complexity], 0.75, 1.35,
    );

    if (role !== 'planning') {
      updateObservedScore(this.profiles, cid, 'implementation', passSignal, this.policy, effectiveAlpha, sampleWeight);
    }
    if (role === 'repair' || needsFastTurnaround) {
      updateObservedScore(this.profiles, cid, 'turnaround_speed', repairSignal, this.policy, effectiveAlpha / 2, sampleWeight);
    }
    if (role === 'integration' || needsStrictBoundary) {
      updateObservedScore(this.profiles, cid, 'integration', repairSignal, this.policy, effectiveAlpha, sampleWeight);
    }
    if (role === 'repair') {
      updateObservedScore(this.profiles, cid, 'repair', repairSignal, this.policy, effectiveAlpha, sampleWeight);
    }
    this.saveProfiles();
  }

  // ── Provider resolution ──

  canResolveForModel(modelId: string): boolean {
    const cacheKey = `model:${modelId}`;
    const cached = this.providerResolutionCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const mmsRoute = resolveModelRoute(modelId);
    if (mmsRoute) { this.providerResolutionCache.set(cacheKey, true); return true; }

    const model = this.models.get(modelId);
    if (model) return this.canResolveProvider(model.provider);

    this.providerResolutionCache.set(cacheKey, false);
    return false;
  }

  // ── Private helpers ──

  private scorerContext(): ScorerContext {
    return {
      policy: this.policy,
      profiles: this.profiles,
      models: this.models,
      canResolveForModel: (id) => this.canResolveForModel(id),
    };
  }

  private saveProfiles(): void {
    fs.writeFileSync(resolveProjectPath('config', 'model-profiles.json'), JSON.stringify(this.profiles, null, 2));
  }

  private loadSpeedStats(): Record<string, SpeedStatsEntry> {
    if (this.speedStatsCache) return this.speedStatsCache;

    const candidates = [
      path.join(os.homedir(), '.config', 'mms', 'speed-stats.json'),
      path.join(os.homedir(), '.hive', 'speed-stats.json'),
    ];

    let rawData: Record<string, unknown> = {};
    for (const p of candidates) {
      try { rawData = JSON.parse(fs.readFileSync(p, 'utf-8')); break; } catch { /* next */ }
    }

    const entries: Record<string, SpeedStatsEntry> = {};
    for (const [key, value] of Object.entries(rawData)) {
      if (key.startsWith('_')) continue;
      if (typeof value === 'object' && value !== null && 'samples' in value) {
        entries[key] = value as SpeedStatsEntry;
      }
    }

    const scoped = rawData._scoped_models as Record<string, Record<string, unknown>> | undefined;
    if (scoped && typeof scoped === 'object') {
      for (const entry of Object.values(scoped)) {
        const name = entry.model as string | undefined;
        const samples = entry.samples as number | undefined;
        if (name && typeof samples === 'number') {
          if (!entries[name] || samples > (entries[name].samples || 0)) {
            entries[name] = entry as unknown as SpeedStatsEntry;
          }
        }
      }
    }

    this.speedStatsCache = entries;
    return entries;
  }

  private firstKnownModel(preferredIds: string[]): string {
    for (const id of preferredIds) {
      const cid = normalizeModelId(id);
      if (this.models.has(cid)) return cid;
    }
    return [...this.models.keys()][0] || '';
  }

  private canResolveProvider(providerId: string): boolean {
    const cached = this.providerResolutionCache.get(providerId);
    if (cached !== undefined) return cached;
    let ok = true;
    try { resolveConfiguredProvider(providerId); } catch { ok = false; }
    this.providerResolutionCache.set(providerId, ok);
    return ok;
  }

  private resolveSpeedEntry(hiveModelId: string): SpeedStatsEntry | undefined {
    const stats = this.loadSpeedStats();
    const cid = normalizeModelId(hiveModelId);

    if (stats[cid]) return stats[cid];
    if (stats[hiveModelId]) return stats[hiveModelId];

    const lower = cid.toLowerCase();
    for (const [key, entry] of Object.entries(stats)) {
      if (key.toLowerCase() === lower) return entry;
    }

    const model = this.models.get(cid);
    if (!model) return undefined;

    const providerBase = model.provider.replace(/-cn$/, '').toLowerCase();
    const versionTokens = cid.toLowerCase().match(/\d+(?:\.\d+)?/g) ?? [];
    const keywordTokens = cid.toLowerCase().match(/\b(max|turbo|plus|pro|lite|mini)\b/g) ?? [];

    let bestMatch: SpeedStatsEntry | undefined;
    let bestScore = 0;

    for (const [mmsName, entry] of Object.entries(stats)) {
      const mmsLower = mmsName.toLowerCase();
      if (!mmsLower.includes(providerBase)) continue;
      let score = 1;
      for (const t of versionTokens) { if (mmsLower.includes(t)) score += 3; }
      for (const t of keywordTokens) { if (mmsLower.includes(t)) score += 2; }
      if (score > bestScore) { bestScore = score; bestMatch = entry; }
    }

    return bestScore > 1 ? bestMatch : undefined;
  }

  private toLegacyModelView(id: string, model: StaticModelConfig): LegacyModelView {
    const profile = this.profiles.profiles[id];
    const impl = profile ? getEffectiveScore(profile, 'implementation', this.policy).value : this.policy.default_score;
    const integ = profile ? getEffectiveScore(profile, 'integration', this.policy).value : this.policy.default_score;
    const rev = profile ? getEffectiveScore(profile, 'review', this.policy).value : this.policy.default_score;

    // Normalize cost to USD. Domestic model cost_per_1k is in ¥ (CNY);
    // Claude/GPT/Gemini cost_per_1k is already in USD.
    const isDomestic = /^(kimi|qwen|glm|minimax)/i.test(id);
    const cnyToUsd = isDomestic ? 1 / 7.2 : 1;
    const costPerMtokUsd = model.cost_per_1k * 1000 * cnyToUsd;

    return {
      id, provider: model.provider, display_name: titleCaseModelId(id),
      coding: model.scores.coding,
      tool_use_reliability: clamp((model.scores.general + impl) / 2, 0, 1),
      reasoning: clamp((model.scores.planning + rev + integ) / 3, 0, 1),
      chinese: model.scores.translation,
      pass_rate: impl,
      avg_iterations: clamp(2 - integ, 0.5, 3),
      total_tasks_completed: profile ? Object.values(profile.scores).reduce((s, sc) => s + sc.samples, 0) : 0,
      last_updated: profile
        ? Object.values(profile.scores).map((s) => s.last_updated).filter((v): v is string => Boolean(v)).sort().at(-1) || new Date(0).toISOString()
        : new Date(0).toISOString(),
      context_window: model.context_window,
      cost_per_mtok_input: costPerMtokUsd,
      cost_per_mtok_output: costPerMtokUsd,
      max_complexity: inferMaxComplexity(model),
      sweet_spot: model.strengths,
      avoid: mergeAvoidTags(model.avoid_tags ?? [], profile?.avoid_tags ?? []),
    };
  }

  private isSubTask(input: SubTask | TaskFingerprint): input is SubTask {
    return 'assigned_model' in input;
  }
}

// ── Module-level convenience exports ──

let sharedRegistry: ModelRegistry | null = null;

export function getRegistry(): ModelRegistry {
  if (!sharedRegistry) sharedRegistry = new ModelRegistry();
  return sharedRegistry;
}

export function assignModel(task: SubTask): string { return getRegistry().assignModel(task); }
export function rankModelsForTask(task: SubTask | TaskFingerprint): RankedAssignment[] { return getRegistry().rankModelsForTask(task); }
export function selectCrossReviewer(workerModelId: string): string { return getRegistry().selectCrossReviewer(workerModelId); }
export function selectDiscussPartner(workerModelId: string): string { return getRegistry().selectDiscussPartner(workerModelId); }
export function selectA2aLensModels(workerModelId: string): string[] { return getRegistry().selectA2aLensModels(workerModelId); }
