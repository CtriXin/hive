// orchestrator/model-scorer.ts — Scoring engine for model ranking
import type { Complexity } from './types.js';
import type {
  BenchmarkPolicy,
  ModelProfile,
  ProfileScoreKey,
} from './profiler.js';
import {
  getConfidenceFactor,
  getEffectiveScore,
  mergeAvoidTags,
} from './profiler.js';
import type { TaskFingerprint } from './task-fingerprint.js';
import type { StaticModelConfig } from './model-defaults.js';
import { inferMaxComplexity } from './model-defaults.js';

export interface RankedAssignment {
  model: string;
  final_score: number;
  confidence: number;
  domain_bonus: number;
  reasons: string[];
  blocked_by?: string[];
}

// ── Constants ──

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

const EXPLORATION_BONUS_SCALE = 0.03;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function resolveRoleScoreKey(role: string): ProfileScoreKey {
  return ROLE_TO_SCORE_KEY[role as keyof RoleScoreKeyMap] || 'implementation';
}

function hasDomainOverlap(tags: string[], domains: string[]): number {
  const tagSet = new Set(tags);
  return domains.filter((domain) => tagSet.has(domain)).length;
}

// ── Score update constants ──

export const EXPECTED_ITERATIONS: Record<Complexity, number> = {
  low: 1.0,
  medium: 1.25,
  'medium-high': 1.75,
  high: 2.4,
};

export const COMPLEXITY_INFO_WEIGHT: Record<Complexity, number> = {
  low: 0.85,
  medium: 1.0,
  'medium-high': 1.15,
  high: 1.3,
};

export const FAILURE_WEIGHT: Record<Complexity, number> = {
  low: 1.25,
  medium: 1.0,
  'medium-high': 0.9,
  high: 0.8,
};

// ── Scoring engine ──

/** Context needed by the scorer (avoids coupling to ModelRegistry) */
export interface ScorerContext {
  policy: BenchmarkPolicy;
  profiles: { profiles: Record<string, ModelProfile> };
  models: Map<string, StaticModelConfig>;
  canResolveForModel: (modelId: string) => boolean;
}

export function computeWeightedScore(
  ctx: ScorerContext,
  modelId: string,
  model: StaticModelConfig,
  profile: ModelProfile | undefined,
  fingerprint: TaskFingerprint,
): RankedAssignment {
  const effectiveProfile = profile ?? {
    scores: Object.fromEntries(
      Object.keys(ctx.policy.base_weights).map((key) => [
        key,
        { value: ctx.policy.default_score, samples: 0, last_updated: null },
      ]),
    ) as ModelProfile['scores'],
    domain_tags: [],
    avoid_tags: [],
  };

  const weights = buildWeights(ctx.policy, fingerprint);
  let weightedSum = 0;
  let totalWeight = 0;
  let totalSamples = 0;
  const roleKey = resolveRoleScoreKey(fingerprint.role);

  for (const key of Object.keys(weights) as ProfileScoreKey[]) {
    const observed = getEffectiveScore(effectiveProfile, key, ctx.policy);
    const weight = weights[key];
    weightedSum += observed.value * weight;
    totalWeight += weight;
    totalSamples += observed.samples * weight;
  }

  const weightedScore = totalWeight > 0
    ? weightedSum / totalWeight
    : ctx.policy.default_score;
  const averageSamples = totalWeight > 0 ? totalSamples / totalWeight : 0;
  const confidence = getConfidenceFactor(averageSamples, ctx.policy);
  const domainBonus = hasDomainOverlap(effectiveProfile.domain_tags, fingerprint.domains) * 0.05;
  const roleSamples = getEffectiveScore(effectiveProfile, roleKey, ctx.policy).samples;
  const totalRoleSamples = getTotalRoleSamples(ctx, roleKey);
  const explorationBonus = computeExplorationBonus(roleSamples, totalRoleSamples);
  const explorationConfidence = Math.max(confidence, 0.15);

  return {
    model: modelId,
    final_score: clamp(
      (weightedScore + domainBonus) * confidence + explorationBonus * explorationConfidence,
      0, 1,
    ),
    confidence,
    domain_bonus: domainBonus,
    reasons: [
      `role=${fingerprint.role}`,
      `domains=${fingerprint.domains.join(',') || 'general'}`,
      `weighted=${weightedScore.toFixed(2)}`,
      `confidence=${confidence.toFixed(2)}`,
      `domain_bonus=${domainBonus.toFixed(2)}`,
      `exploration_bonus=${explorationBonus.toFixed(2)}`,
    ],
  };
}

function buildWeights(
  policy: BenchmarkPolicy,
  fingerprint: TaskFingerprint,
): Record<ProfileScoreKey, number> {
  const weights = { ...policy.base_weights };
  const roleKey = resolveRoleScoreKey(fingerprint.role);
  weights[roleKey] += policy.role_boost;

  if (fingerprint.needs_strict_boundary) {
    weights.scope_discipline += policy.strict_boundary_boost;
  }
  if (fingerprint.needs_fast_turnaround) {
    weights.turnaround_speed += policy.fast_turnaround_boost;
  }
  return weights;
}

function getTotalRoleSamples(ctx: ScorerContext, roleKey: ProfileScoreKey): number {
  let total = 0;
  for (const modelId of ctx.models.keys()) {
    const score = ctx.profiles.profiles[modelId]?.scores[roleKey];
    total += score?.effective_samples ?? score?.samples ?? 0;
  }
  return total;
}

function computeExplorationBonus(modelSamples: number, totalSamples: number): number {
  if (totalSamples <= 0) return EXPLORATION_BONUS_SCALE;
  return EXPLORATION_BONUS_SCALE * Math.sqrt(Math.log(totalSamples + 2) / (modelSamples + 1));
}

// ── Hard filters ──

export function getHardFilterFailures(
  ctx: ScorerContext,
  modelId: string,
  model: StaticModelConfig,
  profile: ModelProfile | undefined,
  fingerprint: TaskFingerprint,
): string[] {
  const failures: string[] = [];
  const dynamicAvoid = profile?.avoid_tags ?? [];
  const staticAvoid = model.avoid_tags ?? [];
  const mergedAvoid = mergeAvoidTags(staticAvoid, dynamicAvoid);

  const scopeScore = profile
    ? getEffectiveScore(profile, 'scope_discipline', ctx.policy).value
    : ctx.policy.default_score;
  const confidence = profile
    ? getConfidenceFactor(
        Math.max(0, ...Object.values(profile.scores).map(
          (score) => score.effective_samples ?? score.samples,
        )),
        ctx.policy,
      )
    : 0;

  if (fingerprint.needs_strict_boundary && scopeScore < ctx.policy.hard_filters.strict_boundary_min_scope_discipline) {
    failures.push('scope_discipline_below_threshold');
  }
  if (fingerprint.role === 'integration' && confidence < ctx.policy.hard_filters.integration_min_confidence) {
    failures.push('integration_confidence_too_low');
  }
  if (mergedAvoid.some((tag) => fingerprint.needs_strict_boundary && tag === 'strict-boundary')) {
    failures.push('avoid_tag_strict_boundary');
  }
  if (mergedAvoid.some((tag) => fingerprint.domains.includes(tag))) {
    failures.push('avoid_tag_domain_match');
  }

  const maxComplexity = inferMaxComplexity(model);
  const complexityRank: Record<Complexity, number> = { low: 0, medium: 1, 'medium-high': 2, high: 3 };
  if (complexityRank[maxComplexity] < complexityRank[fingerprint.complexity]) {
    failures.push('insufficient_complexity_capacity');
  }

  if (!model.provider) {
    failures.push('missing_provider');
  } else if (!ctx.canResolveForModel(modelId)) {
    failures.push('provider_resolution_failed');
  }

  return failures;
}
