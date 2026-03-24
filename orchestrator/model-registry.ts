import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SubTask, Complexity } from './types.js';
import {
  BenchmarkPolicy,
  ModelProfile,
  ProfileScoreKey,
  getConfidenceFactor,
  getEffectiveScore,
  loadBenchmarkPolicy,
  loadProfiles,
  mergeAvoidTags,
  updateObservedScore,
} from './profiler.js';
import {
  TaskFingerprint,
  buildTaskFingerprint,
} from './task-fingerprint.js';
import { getModelForTask, loadConfig } from './hive-config.js';
import { resolveProjectPath } from './project-paths.js';
import { resolveProvider as resolveConfiguredProvider } from './provider-resolver.js';

function getDefaultConfigPath(): string {
  return resolveProjectPath('config', 'model-capabilities.json');
}

interface StaticScoreSet {
  general: number;
  coding: number;
  planning: number;
  review: number;
  translation: number;
}

interface StaticModelConfig {
  provider: string;
  strengths: string[];
  avoid_tags?: string[];
  speed_tier?: 'fast' | 'balanced' | 'strong';
  scores: StaticScoreSet;
  context_window: number;
  cost_per_1k: number;
}

interface StaticClaudeTierConfig {
  id: string;
  role: string;
  strengths: string[];
  scores: StaticScoreSet;
  context_window: number;
  cost_per_1k: number;
}

interface StaticCapabilitiesConfig {
  _doc?: string;
  models: Record<string, StaticModelConfig>;
  claude_tiers: Record<'sonnet' | 'opus' | 'haiku', StaticClaudeTierConfig>;
}

export interface RankedAssignment {
  model: string;
  final_score: number;
  confidence: number;
  domain_bonus: number;
  reasons: string[];
  blocked_by?: string[];
}

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

interface RoleScoreKeyMap {
  planning: ProfileScoreKey;
  implementation: ProfileScoreKey;
  review: ProfileScoreKey;
  repair: ProfileScoreKey;
  integration: ProfileScoreKey;
}

const ROLE_TO_SCORE_KEY: RoleScoreKeyMap = {
  planning: 'spec_adherence',
  implementation: 'implementation',
  review: 'review',
  repair: 'repair',
  integration: 'integration',
};

// mms speed-stats.json format (producer: ccs_speed_stats.py)
interface SpeedStatsEntry {
  ttfb_avg_ms?: number;   // mms 字段名
  ttfb_avg?: number;      // 旧格式兼容
  tps_avg: number | null;
  samples: number;
  tps_samples?: number;
  warming_up?: boolean;
  last_updated?: string;
}

const EXPECTED_ITERATIONS: Record<Complexity, number> = {
  low: 1.0,
  medium: 1.25,
  'medium-high': 1.75,
  high: 2.4,
};

const COMPLEXITY_INFO_WEIGHT: Record<Complexity, number> = {
  low: 0.85,
  medium: 1.0,
  'medium-high': 1.15,
  high: 1.3,
};

const FAILURE_WEIGHT: Record<Complexity, number> = {
  low: 1.25,
  medium: 1.0,
  'medium-high': 0.9,
  high: 0.8,
};

const EXPLORATION_BONUS_SCALE = 0.03;

const MODEL_ID_ALIASES: Record<string, string> = {
  'kimi-coding': 'kimi-k2.5',
  'kimi-k2.5': 'kimi-k2.5',
  'glm5-turbo': 'glm-5-turbo',
  'glm-5-turbo': 'glm-5-turbo',
  'qwen3.5': 'qwen-3.5',
  'qwen-3.5': 'qwen-3.5',
  'qwen-max': 'qwen-max',
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function titleCaseModelId(id: string): string {
  return id
    .split('-')
    .map((part) => part.toUpperCase() === part ? part : part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function inferMaxComplexity(model: StaticModelConfig): Complexity {
  if (model.scores.coding >= 0.93 || model.scores.planning >= 0.93 || model.scores.review >= 0.9) {
    return 'high';
  }
  if (model.scores.coding >= 0.88 || model.scores.planning >= 0.88) {
    return 'medium-high';
  }
  if (model.scores.coding >= 0.8 || model.scores.review >= 0.78) {
    return 'medium';
  }
  return 'low';
}

function hasDomainOverlap(tags: string[], domains: string[]): number {
  const tagSet = new Set(tags);
  return domains.filter((domain) => tagSet.has(domain)).length;
}

function normalizeModelId(modelId: string): string {
  return MODEL_ID_ALIASES[modelId] || modelId;
}

function resolveRoleScoreKey(role: string): ProfileScoreKey {
  return ROLE_TO_SCORE_KEY[role as keyof RoleScoreKeyMap] || 'implementation';
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
    this.claudeTiers = new Map(
      Object.entries(config.claude_tiers || {}).map(([tier, value]) => [
        tier as 'opus' | 'sonnet' | 'haiku',
        value,
      ]),
    );
    this.policy = loadBenchmarkPolicy();
    this.profiles = loadProfiles();
  }

  getAll(): LegacyModelView[] {
    return [...this.models.entries()].map(([id, model]) => this.toLegacyModelView(id, model));
  }

  get(id: string): LegacyModelView | undefined {
    const canonicalId = normalizeModelId(id);
    const model = this.models.get(canonicalId);
    if (!model) {
      return undefined;
    }
    return this.toLegacyModelView(canonicalId, model);
  }

  getModel(id: string): LegacyModelView | undefined {
    return this.get(id);
  }

  getClaudeTier(tier: 'opus' | 'sonnet' | 'haiku'): StaticClaudeTierConfig | undefined {
    return this.claudeTiers.get(tier);
  }

  rankModelsForTask(input: SubTask | TaskFingerprint): RankedAssignment[] {
    const fingerprint = this.isSubTask(input) ? buildTaskFingerprint(input) : input;
    const assignments: RankedAssignment[] = [];

    for (const [modelId, model] of this.models.entries()) {
      const profile = this.profiles.profiles[modelId];
      const blockedBy = this.getHardFilterFailures(modelId, model, profile, fingerprint);
      if (blockedBy.length > 0) {
        assignments.push({
          model: modelId,
          final_score: 0,
          confidence: 0,
          domain_bonus: 0,
          reasons: ['filtered by hard constraints'],
          blocked_by: blockedBy,
        });
        continue;
      }

      const scoreBreakdown = this.computeWeightedScore(modelId, model, profile, fingerprint);
      assignments.push(scoreBreakdown);
    }

    return assignments.sort((a, b) => b.final_score - a.final_score);
  }

  assignModel(task: SubTask): string {
    const config = loadConfig(process.cwd());
    return getModelForTask(task, config, this);
  }

  selectCrossReviewer(workerModelId: string): string {
    const workerProvider = this.models.get(workerModelId)?.provider;
    const ranked = this.rankModelsForTask({
      role: 'review',
      domains: ['typescript', 'tests'],
      complexity: 'medium',
      needs_strict_boundary: true,
      needs_fast_turnaround: false,
      is_repair_round: false,
    });

    return ranked.find((candidate) => {
      const provider = this.models.get(candidate.model)?.provider;
      return provider && provider !== workerProvider && !candidate.blocked_by?.length;
    })?.model || ranked.find((candidate) => !candidate.blocked_by?.length)?.model || this.firstKnownModel(['kimi-k2.5']);
  }

  selectDiscussPartner(workerModelId: string): string {
    const ranked = this.rankModelsForTask({
      role: 'review',
      domains: ['typescript', 'architecture'],
      complexity: 'medium',
      needs_strict_boundary: false,
      needs_fast_turnaround: true,
      is_repair_round: false,
    });
    return ranked.find((candidate) =>
      candidate.model !== workerModelId && !candidate.blocked_by?.length,
    )?.model || this.firstKnownModel(['qwen-3.5', 'kimi-k2.5']);
  }

  selectReviewer(): string {
    const ranked = this.rankModelsForTask({
      role: 'review',
      domains: ['typescript', 'tests'],
      complexity: 'medium',
      needs_strict_boundary: false,
      needs_fast_turnaround: false,
      is_repair_round: false,
    });
    return ranked.find((candidate) => !candidate.blocked_by?.length)?.model || this.firstKnownModel(['kimi-k2.5']);
  }

  getSpeedTier(modelId: string): 'fast' | 'balanced' | 'strong' | 'unknown' {
    const stats = this.resolveSpeedEntry(modelId);

    if (stats && stats.samples >= 3) {
      const ttfb = stats.ttfb_avg_ms ?? stats.ttfb_avg ?? Infinity;
      if (ttfb < 500) {
        return 'fast';
      }
      if (ttfb < 2000) {
        return 'balanced';
      }
      return 'strong';
    }

    const model = this.models.get(normalizeModelId(modelId));
    return model?.speed_tier || 'unknown';
  }

  selectTranslator(): string {
    const config = loadConfig(process.cwd());
    if (config.translator_model) {
      return config.translator_model;
    }

    const fastModels = [...this.models.entries()]
      .filter(([id]) => this.getSpeedTier(id) === 'fast')
      .map(([id, model]) => ({ id, chinese: model.scores.translation }))
      .sort((a, b) => b.chinese - a.chinese);

    if (fastModels.length > 0) {
      return fastModels[0]?.id || this.firstKnownModel(['glm-5-turbo', 'kimi-k2.5']);
    }

    const allByChinese = this.getAll().sort((a, b) => b.chinese - a.chinese);
    return allByChinese[0]?.id || this.firstKnownModel(['glm-5-turbo', 'kimi-k2.5']);
  }

  getModelsBySpeedTier(tier: 'fast' | 'balanced' | 'strong'): string[] {
    return [...this.models.keys()].filter((id) => this.getSpeedTier(id) === tier);
  }

  selectTranslatorFallback(failedModel: string): string {
    const fastModels = this.getModelsBySpeedTier('fast').filter((id) => id !== failedModel);
    if (fastModels.length > 0) {
      const best = fastModels
        .map((id) => ({ id, chinese: this.get(id)?.chinese || 0 }))
        .sort((a, b) => b.chinese - a.chinese);
      return best[0]?.id || this.firstKnownModel(['glm-5-turbo', 'kimi-k2.5']);
    }

    const balanced = this.getModelsBySpeedTier('balanced').filter((id) => id !== failedModel);
    if (balanced.length > 0) {
      return balanced[0] || this.firstKnownModel(['glm-5-turbo', 'kimi-k2.5']);
    }

    return this.getAll()
      .filter((model) => model.id !== failedModel)
      .sort((a, b) => b.chinese - a.chinese)[0]?.id || this.firstKnownModel(['glm-5-turbo', 'kimi-k2.5']);
  }

  selectA2aLensModels(workerModelId: string): string[] {
    const ranked = this.rankModelsForTask({
      role: 'review',
      domains: ['typescript', 'integration'],
      complexity: 'medium-high',
      needs_strict_boundary: true,
      needs_fast_turnaround: false,
      is_repair_round: false,
    });

    const selected: string[] = [];
    const seenProviders = new Set<string>();

    for (const candidate of ranked) {
      if (candidate.blocked_by?.length || candidate.model === workerModelId) {
        continue;
      }
      const provider = this.models.get(candidate.model)?.provider || '';
      if (!seenProviders.has(provider)) {
        selected.push(candidate.model);
        seenProviders.add(provider);
      }
      if (selected.length === 3) {
        break;
      }
    }

    if (selected.length < 3) {
      for (const candidate of ranked) {
        if (candidate.blocked_by?.length || candidate.model === workerModelId) {
          continue;
        }
        if (!selected.includes(candidate.model)) {
          selected.push(candidate.model);
        }
        if (selected.length === 3) {
          break;
        }
      }
    }

    return selected;
  }

  updateScore(
    modelId: string,
    passed: boolean,
    iterations: number,
    complexity: Complexity,
    role: TaskFingerprint['role'],
    needsFastTurnaround: boolean,
    needsStrictBoundary: boolean,
  ): void {
    const canonicalModelId = normalizeModelId(modelId);
    if (!this.models.has(canonicalModelId)) {
      return;
    }

    const baseAlpha = 0.2;
    const passSignal = passed ? 1 : 0;
    const expected = EXPECTED_ITERATIONS[complexity];
    const repairSignal = clamp(1 - Math.max(0, iterations - expected) * 0.25, 0, 1);
    const effectiveAlpha = passed
      ? Math.min(baseAlpha * COMPLEXITY_INFO_WEIGHT[complexity], 0.4)
      : Math.min(baseAlpha * FAILURE_WEIGHT[complexity], 0.4);
    const sampleWeight = clamp(
      passed ? COMPLEXITY_INFO_WEIGHT[complexity] : FAILURE_WEIGHT[complexity],
      0.75,
      1.35,
    );

    if (role !== 'planning') {
      updateObservedScore(
        this.profiles,
        canonicalModelId,
        'implementation',
        passSignal,
        this.policy,
        effectiveAlpha,
        sampleWeight,
      );
    }

    if (role === 'repair' || needsFastTurnaround) {
      updateObservedScore(
        this.profiles,
        canonicalModelId,
        'turnaround_speed',
        repairSignal,
        this.policy,
        effectiveAlpha / 2,
        sampleWeight,
      );
    }

    if (role === 'integration' || needsStrictBoundary) {
      updateObservedScore(
        this.profiles,
        canonicalModelId,
        'integration',
        repairSignal,
        this.policy,
        effectiveAlpha,
        sampleWeight,
      );
    }

    if (role === 'repair') {
      updateObservedScore(
        this.profiles,
        canonicalModelId,
        'repair',
        repairSignal,
        this.policy,
        effectiveAlpha,
        sampleWeight,
      );
    }

    this.saveProfiles();
  }

  private saveProfiles(): void {
    const profilesPath = resolveProjectPath('config', 'model-profiles.json');
    fs.writeFileSync(profilesPath, JSON.stringify(this.profiles, null, 2));
  }

  /**
   * Load raw speed-stats from mms. Stores entries keyed by mms model names
   * (no normalization — matching happens in resolveSpeedEntry).
   */
  private loadSpeedStats(): Record<string, SpeedStatsEntry> {
    if (this.speedStatsCache) {
      return this.speedStatsCache;
    }

    const candidates = [
      path.join(os.homedir(), '.config', 'mms', 'speed-stats.json'),
      path.join(os.homedir(), '.hive', 'speed-stats.json'),
    ];

    let rawData: Record<string, unknown> = {};
    for (const statsPath of candidates) {
      try {
        rawData = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
        break;
      } catch {
        // try next
      }
    }

    const entries: Record<string, SpeedStatsEntry> = {};

    // Top-level entries (schema v1 compat + aggregated view)
    for (const [key, value] of Object.entries(rawData)) {
      if (key.startsWith('_')) continue;
      if (typeof value === 'object' && value !== null && 'samples' in value) {
        entries[key] = value as SpeedStatsEntry;
      }
    }

    // _scoped_models (schema v2) — prefer these, higher precision
    const scopedModels = rawData._scoped_models as Record<string, Record<string, unknown>> | undefined;
    if (scopedModels && typeof scopedModels === 'object') {
      for (const scopedEntry of Object.values(scopedModels)) {
        const modelName = scopedEntry.model as string | undefined;
        const samples = scopedEntry.samples as number | undefined;
        if (modelName && typeof samples === 'number') {
          if (!entries[modelName] || samples > (entries[modelName].samples || 0)) {
            entries[modelName] = scopedEntry as unknown as SpeedStatsEntry;
          }
        }
      }
    }

    this.speedStatsCache = entries;
    return entries;
  }

  private firstKnownModel(preferredIds: string[]): string {
    for (const preferredId of preferredIds) {
      const canonical = normalizeModelId(preferredId);
      if (this.models.has(canonical)) {
        return canonical;
      }
    }
    return [...this.models.keys()][0] || '';
  }

  private canResolveProvider(providerId: string): boolean {
    const cached = this.providerResolutionCache.get(providerId);
    if (cached !== undefined) {
      return cached;
    }
    let resolved = true;
    try {
      resolveConfiguredProvider(providerId);
    } catch {
      resolved = false;
    }
    this.providerResolutionCache.set(providerId, resolved);
    return resolved;
  }

  /**
   * Auto-match a Hive model ID to a speed-stats entry.
   * Strategy: exact → case-insensitive → fuzzy (provider + version tokens).
   * Zero manual config needed — mms model names auto-resolve.
   */
  private resolveSpeedEntry(hiveModelId: string): SpeedStatsEntry | undefined {
    const stats = this.loadSpeedStats();
    const canonicalId = normalizeModelId(hiveModelId);

    // 1. Exact match
    if (stats[canonicalId]) return stats[canonicalId];
    if (stats[hiveModelId]) return stats[hiveModelId];

    // 2. Case-insensitive match
    const lower = canonicalId.toLowerCase();
    for (const [key, entry] of Object.entries(stats)) {
      if (key.toLowerCase() === lower) return entry;
    }

    // 3. Fuzzy match: provider base + version/keyword tokens
    const model = this.models.get(canonicalId);
    if (!model) return undefined;

    const providerBase = model.provider.replace(/-cn$/, '').toLowerCase();
    const versionTokens = canonicalId.toLowerCase().match(/\d+(?:\.\d+)?/g) ?? [];
    const keywordTokens = canonicalId.toLowerCase().match(/\b(max|turbo|plus|pro|lite|mini)\b/g) ?? [];

    let bestMatch: SpeedStatsEntry | undefined;
    let bestScore = 0;

    for (const [mmsName, entry] of Object.entries(stats)) {
      const mmsLower = mmsName.toLowerCase();
      if (!mmsLower.includes(providerBase)) continue;

      let score = 1; // provider matches
      for (const token of versionTokens) {
        if (mmsLower.includes(token)) score += 3;
      }
      for (const token of keywordTokens) {
        if (mmsLower.includes(token)) score += 2;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = entry;
      }
    }

    // Provider-only fuzzy hits are too weak; require at least one version/keyword match.
    if (bestScore <= 1) {
      return undefined;
    }

    return bestMatch;
  }

  private computeWeightedScore(
    modelId: string,
    model: StaticModelConfig,
    profile: ModelProfile | undefined,
    fingerprint: TaskFingerprint,
  ): RankedAssignment {
    const effectiveProfile = profile ?? {
      scores: Object.fromEntries(
        Object.keys(this.policy.base_weights).map((key) => [
          key,
          { value: this.policy.default_score, samples: 0, last_updated: null },
        ]),
      ) as ModelProfile['scores'],
      domain_tags: [],
      avoid_tags: [],
    };

    const weights = this.buildWeights(fingerprint);
    let weightedSum = 0;
    let totalWeight = 0;
    let totalSamples = 0;
    const roleKey = resolveRoleScoreKey(fingerprint.role);

    for (const key of Object.keys(weights) as ProfileScoreKey[]) {
      const observed = getEffectiveScore(effectiveProfile, key, this.policy);
      const weight = weights[key];
      weightedSum += observed.value * weight;
      totalWeight += weight;
      totalSamples += observed.samples * weight;
    }

    const weightedScore = totalWeight > 0
      ? weightedSum / totalWeight
      : this.policy.default_score;
    const averageSamples = totalWeight > 0 ? totalSamples / totalWeight : 0;
    const confidence = getConfidenceFactor(averageSamples, this.policy);
    const domainBonus = hasDomainOverlap(effectiveProfile.domain_tags, fingerprint.domains) * 0.05;
    const roleSamples = getEffectiveScore(effectiveProfile, roleKey, this.policy).samples;
    const totalRoleSamples = this.getTotalRoleSamples(roleKey);
    const explorationBonus = this.computeExplorationBonus(roleSamples, totalRoleSamples);
    const explorationConfidence = Math.max(confidence, 0.15);

    const reasons = [
      `role=${fingerprint.role}`,
      `domains=${fingerprint.domains.join(',') || 'general'}`,
      `weighted=${weightedScore.toFixed(2)}`,
      `confidence=${confidence.toFixed(2)}`,
      `domain_bonus=${domainBonus.toFixed(2)}`,
      `exploration_bonus=${explorationBonus.toFixed(2)}`,
    ];

    return {
      model: modelId,
      final_score: clamp(
        (weightedScore + domainBonus) * confidence + explorationBonus * explorationConfidence,
        0,
        1,
      ),
      confidence,
      domain_bonus: domainBonus,
      reasons,
    };
  }

  private getTotalRoleSamples(roleKey: ProfileScoreKey): number {
    let total = 0;
    for (const modelId of this.models.keys()) {
      const score = this.profiles.profiles[modelId]?.scores[roleKey];
      total += score?.effective_samples ?? score?.samples ?? 0;
    }
    return total;
  }

  private computeExplorationBonus(modelSamples: number, totalSamples: number): number {
    if (totalSamples <= 0) {
      return EXPLORATION_BONUS_SCALE;
    }
    return EXPLORATION_BONUS_SCALE
      * Math.sqrt(Math.log(totalSamples + 2) / (modelSamples + 1));
  }

  private buildWeights(fingerprint: TaskFingerprint): Record<ProfileScoreKey, number> {
    const weights = { ...this.policy.base_weights };
    const roleKey = resolveRoleScoreKey(fingerprint.role);
    weights[roleKey] += this.policy.role_boost;

    if (fingerprint.needs_strict_boundary) {
      weights.scope_discipline += this.policy.strict_boundary_boost;
    }

    if (fingerprint.needs_fast_turnaround) {
      weights.turnaround_speed += this.policy.fast_turnaround_boost;
    }

    return weights;
  }

  private getHardFilterFailures(
    modelId: string,
    model: StaticModelConfig,
    profile: ModelProfile | undefined,
    fingerprint: TaskFingerprint,
  ): string[] {
    const failures: string[] = [];
    const effectiveProfile = profile;
    const dynamicAvoid = effectiveProfile?.avoid_tags ?? [];
    const staticAvoid = model.avoid_tags ?? [];
    const mergedAvoid = mergeAvoidTags(staticAvoid, dynamicAvoid);
    const scopeScore = effectiveProfile
      ? getEffectiveScore(effectiveProfile, 'scope_discipline', this.policy).value
      : this.policy.default_score;
    const confidence = effectiveProfile
      ? getConfidenceFactor(
          Math.max(
            0,
            ...Object.values(effectiveProfile.scores).map(
              (score) => score.effective_samples ?? score.samples,
            ),
          ),
          this.policy,
        )
      : 0;

    if (fingerprint.needs_strict_boundary && scopeScore < this.policy.hard_filters.strict_boundary_min_scope_discipline) {
      failures.push('scope_discipline_below_threshold');
    }

    if (fingerprint.role === 'integration' && confidence < this.policy.hard_filters.integration_min_confidence) {
      failures.push('integration_confidence_too_low');
    }

    if (mergedAvoid.some((tag) => fingerprint.needs_strict_boundary && tag === 'strict-boundary')) {
      failures.push('avoid_tag_strict_boundary');
    }
    if (mergedAvoid.some((tag) => fingerprint.domains.includes(tag))) {
      failures.push('avoid_tag_domain_match');
    }

    const maxComplexity = inferMaxComplexity(model);
    const complexityRank: Record<Complexity, number> = {
      low: 0,
      medium: 1,
      'medium-high': 2,
      high: 3,
    };
    if (complexityRank[maxComplexity] < complexityRank[fingerprint.complexity]) {
      failures.push('insufficient_complexity_capacity');
    }

    const provider = model.provider;
    if (!provider) {
      failures.push('missing_provider');
    } else if (!this.canResolveProvider(provider)) {
      failures.push('provider_resolution_failed');
    }

    return failures;
  }

  private toLegacyModelView(id: string, model: StaticModelConfig): LegacyModelView {
    const profile = this.profiles.profiles[id];
    const implementation = profile
      ? getEffectiveScore(profile, 'implementation', this.policy).value
      : this.policy.default_score;
    const integration = profile
      ? getEffectiveScore(profile, 'integration', this.policy).value
      : this.policy.default_score;
    const review = profile
      ? getEffectiveScore(profile, 'review', this.policy).value
      : this.policy.default_score;

    return {
      id,
      provider: model.provider,
      display_name: titleCaseModelId(id),
      coding: model.scores.coding,
      tool_use_reliability: clamp((model.scores.general + implementation) / 2, 0, 1),
      reasoning: clamp((model.scores.planning + review + integration) / 3, 0, 1),
      chinese: model.scores.translation,
      pass_rate: implementation,
      avg_iterations: clamp(2 - integration, 0.5, 3),
      total_tasks_completed: profile
        ? Object.values(profile.scores).reduce((sum, score) => sum + score.samples, 0)
        : 0,
      last_updated: profile
        ? Object.values(profile.scores)
            .map((score) => score.last_updated)
            .filter((value): value is string => Boolean(value))
            .sort()
            .at(-1) || new Date(0).toISOString()
        : new Date(0).toISOString(),
      context_window: model.context_window,
      cost_per_mtok_input: model.cost_per_1k * 1000,
      cost_per_mtok_output: model.cost_per_1k * 1000,
      max_complexity: inferMaxComplexity(model),
      sweet_spot: model.strengths,
      avoid: mergeAvoidTags(model.avoid_tags ?? [], profile?.avoid_tags ?? []),
    };
  }

  private isSubTask(input: SubTask | TaskFingerprint): input is SubTask {
    return 'assigned_model' in input;
  }
}

let sharedRegistry: ModelRegistry | null = null;

export function getRegistry(): ModelRegistry {
  if (!sharedRegistry) {
    sharedRegistry = new ModelRegistry();
  }
  return sharedRegistry;
}

export function assignModel(task: SubTask): string {
  return getRegistry().assignModel(task);
}

export function rankModelsForTask(task: SubTask | TaskFingerprint): RankedAssignment[] {
  return getRegistry().rankModelsForTask(task);
}

export function selectCrossReviewer(workerModelId: string): string {
  return getRegistry().selectCrossReviewer(workerModelId);
}

export function selectDiscussPartner(workerModelId: string): string {
  return getRegistry().selectDiscussPartner(workerModelId);
}

export function selectA2aLensModels(workerModelId: string): string[] {
  return getRegistry().selectA2aLensModels(workerModelId);
}
