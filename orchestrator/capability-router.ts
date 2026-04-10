// orchestrator/capability-router.ts — Capability-aware routing with deterministic scoring
import type { Complexity } from './types.js';
import { resolveProjectPath } from './project-paths.js';
import fs from 'fs';

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export type TaskType =
  | 'implementation'
  | 'review'
  | 'repair'
  | 'integration'
  | 'spec_adherence'
  | 'scope_discipline'
  | 'turnaround_speed';

const TASK_TYPES: readonly TaskType[] = [
  'implementation', 'review', 'repair', 'integration',
  'spec_adherence', 'scope_discipline', 'turnaround_speed',
] as const;

export interface CapabilityRouterInput {
  taskType: TaskType;
  complexity: Complexity;
  contextSize: number;
  failureHistory: FailureRecord[];
  isRepair: boolean;
  budgetPressure: BudgetPressure;
  priority?: number;
  now?: number;
}

export interface FailureRecord {
  model: string;
  provider: string;
  timestamp: number;
  reason: string;
}

export type BudgetPressure = 'low' | 'medium' | 'high' | 'critical';

export interface RoutingDecision {
  selectedModel: string;
  selectedProvider: string;
  selectionMethod: SelectionMethod;
  candidates: ScoredCandidate[];
  reasons: string[];
  timestamp: number;
}

export type SelectionMethod = 'scored' | 'heuristic' | 'fallback';

export interface ScoredCandidate {
  model: string;
  provider: string;
  score: number;
  reasons: string[];
  deprioritized: boolean;
  deprioritizeReason?: string;
}

export interface ModelCapabilityProfile {
  scores: Record<TaskType, ScoreEntry>;
  domain_tags: string[];
  avoid_tags: string[];
}

export interface ScoreEntry {
  value: number;
  samples: number;
  effective_samples: number;
  last_updated: string | null;
}

export interface ProviderFailureState {
  failures: number;
  lastFailure: number;
  inCooldown: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════

const COOLDOWN_MS = 60_000;
const MAX_FAILURES_BEFORE_COOLDOWN = 2;
const CONTEXT_THRESHOLDS = { low: 10_000, medium: 50_000, high: 100_000 };
const SAMPLE_CONFIDENCE_CAP = 5;
const HEURISTIC_SCORE_THRESHOLD = 0.001;

// ═══════════════════════════════════════════════════════════════════
// Main Router Function
// ═══════════════════════════════════════════════════════════════════

export function routeWithCapabilities(
  input: CapabilityRouterInput,
  profiles: Record<string, ModelCapabilityProfile>,
  providerFailures: Map<string, ProviderFailureState>,
): RoutingDecision {
  const now = input.now ?? Date.now();
  const candidates = scoreAllCandidates(input, profiles, providerFailures, now);
  const valid = candidates.filter((c) => !c.deprioritized);

  if (valid.length === 0) {
    return selectFallback(candidates, now);
  }

  const sorted = sortCandidatesDeterministic(valid, input);
  const top = sorted[0];
  const hasNoSamples = sorted.every(
    (c) => getMaxSamples(profiles[c.model]) < 1,
  );
  const method = hasNoSamples ? 'heuristic' : 'scored';

  return {
    selectedModel: top.model,
    selectedProvider: top.provider,
    selectionMethod: method,
    candidates: sorted,
    reasons: top.reasons,
    timestamp: now,
  };
}

function getMaxSamples(profile: ModelCapabilityProfile | undefined): number {
  if (!profile) return 0;
  let max = 0;
  for (const s of Object.values(profile.scores)) {
    if (s.samples > max) max = s.samples;
  }
  return max;
}

// ═══════════════════════════════════════════════════════════════════
// Candidate Scoring
// ═══════════════════════════════════════════════════════════════════

function scoreAllCandidates(
  input: CapabilityRouterInput,
  profiles: Record<string, ModelCapabilityProfile>,
  providerFailures: Map<string, ProviderFailureState>,
  now: number,
): ScoredCandidate[] {
  const candidates: ScoredCandidate[] = [];

  for (const [model, profile] of Object.entries(profiles)) {
    const provider = extractProvider(model);
    const score = computeCapabilityScore(input, profile, now);
    const reasons = buildScoreReasons(input, profile, score);
    const deprioritized = isProviderInCooldown(provider, providerFailures, now);

    candidates.push({
      model,
      provider,
      score: deprioritized ? score * 0.5 : score,
      reasons,
      deprioritized,
      deprioritizeReason: deprioritized ? 'provider in cooldown' : undefined,
    });
  }

  return candidates;
}

function computeCapabilityScore(
  input: CapabilityRouterInput,
  profile: ModelCapabilityProfile,
  now: number,
): number {
  const baseScore = getTaskTypeScore(profile, input.taskType);
  const confidenceWeight = computeConfidenceWeight(profile);
  const complexityFactor = computeComplexityFactor(input.complexity, profile);
  const contextFactor = computeContextFactor(input.contextSize);
  const failurePenalty = computeFailurePenalty(input.failureHistory, profile, now);
  const repairBoost = input.isRepair ? computeRepairBoost(profile) : 0;
  const budgetFactor = computeBudgetFactor(input.budgetPressure);

  const rawScore = baseScore * confidenceWeight
    * complexityFactor * contextFactor
    * (1 - failurePenalty) + repairBoost;
  return clamp(rawScore * budgetFactor, 0, 1);
}

function computeConfidenceWeight(profile: ModelCapabilityProfile): number {
  const totalSamples = Object.values(profile.scores).reduce(
    (sum, s) => sum + s.effective_samples, 0,
  );
  return 0.7 + 0.3 * clamp(totalSamples / SAMPLE_CONFIDENCE_CAP, 0, 1);
}

function getTaskTypeScore(
  profile: ModelCapabilityProfile,
  taskType: TaskType,
): number {
  return profile.scores[taskType]?.value ?? 0.5;
}

function computeComplexityFactor(
  complexity: Complexity,
  profile: ModelCapabilityProfile,
): number {
  const weights: Record<Complexity, number> = {
    low: 1.0, medium: 1.05, 'medium-high': 1.1, high: 1.15,
  };
  const impl = profile.scores.implementation?.value ?? 0.5;
  return weights[complexity] * (0.8 + impl * 0.2);
}

function computeContextFactor(contextSize: number): number {
  if (contextSize < CONTEXT_THRESHOLDS.low) return 1.0;
  if (contextSize < CONTEXT_THRESHOLDS.medium) return 0.95;
  if (contextSize < CONTEXT_THRESHOLDS.high) return 0.9;
  return 0.85;
}

function computeFailurePenalty(
  history: FailureRecord[],
  profile: ModelCapabilityProfile,
  now: number,
): number {
  const oneHourMs = 3_600_000;
  const recent = history.filter((h) => h.timestamp > now - oneHourMs);
  const count = recent.length;
  return Math.min(count * 0.1, 0.3);
}

function computeRepairBoost(profile: ModelCapabilityProfile): number {
  const repairScore = profile.scores.repair?.value ?? 0.5;
  return 0.1 + repairScore * 0.1;
}

function computeBudgetFactor(pressure: BudgetPressure): number {
  const factors: Record<BudgetPressure, number> = {
    low: 1.0, medium: 0.95, high: 0.9, critical: 0.85,
  };
  return factors[pressure];
}

// ═══════════════════════════════════════════════════════════════════
// Provider Failure Management
// ═══════════════════════════════════════════════════════════════════

export function updateProviderFailure(
  provider: string,
  providerFailures: Map<string, ProviderFailureState>,
): void {
  const state = providerFailures.get(provider) ?? {
    failures: 0, lastFailure: 0, inCooldown: false,
  };
  state.failures++;
  state.lastFailure = Date.now();
  state.inCooldown = state.failures >= MAX_FAILURES_BEFORE_COOLDOWN;
  providerFailures.set(provider, state);
}

export function clearProviderCooldown(
  provider: string,
  providerFailures: Map<string, ProviderFailureState>,
): void {
  const state = providerFailures.get(provider);
  if (!state) return;
  state.failures = 0;
  state.inCooldown = false;
  providerFailures.set(provider, state);
}

function isProviderInCooldown(
  provider: string,
  providerFailures: Map<string, ProviderFailureState>,
  now: number,
): boolean {
  const state = providerFailures.get(provider);
  if (!state) return false;
  if (state.inCooldown && now - state.lastFailure > COOLDOWN_MS) {
    clearProviderCooldown(provider, providerFailures);
    return false;
  }
  return state.inCooldown;
}

// ═══════════════════════════════════════════════════════════════════
// Score Reasons
// ═══════════════════════════════════════════════════════════════════

function buildScoreReasons(
  input: CapabilityRouterInput,
  profile: ModelCapabilityProfile,
  score: number,
): string[] {
  const reasons: string[] = [];
  const taskScore = getTaskTypeScore(profile, input.taskType);
  const totalSamples = Object.values(profile.scores).reduce(
    (sum, s) => sum + s.effective_samples, 0,
  );

  reasons.push(`base ${input.taskType}: ${fmt(taskScore)}`);
  reasons.push(`confidence: ${fmt(totalSamples / SAMPLE_CONFIDENCE_CAP)} (n=${totalSamples})`);

  if (input.isRepair) {
    const repairVal = profile.scores.repair?.value ?? 0.5;
    reasons.push(`repair boost: +${fmt(0.1 + repairVal * 0.1)} (repair=${fmt(repairVal)})`);
  }

  if (input.budgetPressure !== 'low') {
    reasons.push(`budget pressure: ${input.budgetPressure}`);
  }

  reasons.push(`final: ${fmt(score)}`);
  return reasons;
}

// ═══════════════════════════════════════════════════════════════════
// Deterministic Sorting
// ═══════════════════════════════════════════════════════════════════

function sortCandidatesDeterministic(
  candidates: ScoredCandidate[],
  input: CapabilityRouterInput,
): ScoredCandidate[] {
  return candidates.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > HEURISTIC_SCORE_THRESHOLD) return scoreDiff;

    const aSamples = sampleCountFor(a.model, input);
    const bSamples = sampleCountFor(b.model, input);
    if (aSamples !== bSamples) return bSamples - aSamples;

    return a.model.localeCompare(b.model);
  });
}

function sampleCountFor(model: string, input: CapabilityRouterInput): number {
  const history = input.failureHistory.filter((h) => h.model === model);
  return history.length;
}

// ═══════════════════════════════════════════════════════════════════
// Fallback Selection
// ═══════════════════════════════════════════════════════════════════

function selectFallback(
  allCandidates: ScoredCandidate[],
  now: number,
): RoutingDecision {
  const sorted = allCandidates.sort((a, b) => b.score - a.score);
  const selected = sorted[0] ?? createDefaultCandidate();

  return {
    selectedModel: selected.model,
    selectedProvider: selected.provider,
    selectionMethod: 'fallback',
    candidates: sorted,
    reasons: ['all candidates deprioritized, using best-scored fallback'],
    timestamp: now,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Profile Loading
// ═══════════════════════════════════════════════════════════════════

export function loadModelProfiles(): Record<string, ModelCapabilityProfile> {
  const filePath = resolveProjectPath('config', 'model-profiles.json');

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    if (data.schema_version && data.profiles) {
      return normalizeProfiles(data.profiles);
    }
    return normalizeProfiles(data);
  } catch {
    return {};
  }
}

function normalizeProfiles(
  raw: Record<string, unknown>,
): Record<string, ModelCapabilityProfile> {
  const result: Record<string, ModelCapabilityProfile> = {};

  for (const [model, profile] of Object.entries(raw)) {
    if (typeof profile !== 'object' || profile === null) continue;
    result[model] = normalizeProfile(profile as Record<string, unknown>);
  }

  return result;
}

function normalizeProfile(raw: Record<string, unknown>): ModelCapabilityProfile {
  const defaults: Record<TaskType, ScoreEntry> = {
    implementation: { value: 0.5, samples: 0, effective_samples: 0, last_updated: null },
    review: { value: 0.5, samples: 0, effective_samples: 0, last_updated: null },
    repair: { value: 0.5, samples: 0, effective_samples: 0, last_updated: null },
    integration: { value: 0.5, samples: 0, effective_samples: 0, last_updated: null },
    spec_adherence: { value: 0.5, samples: 0, effective_samples: 0, last_updated: null },
    scope_discipline: { value: 0.5, samples: 0, effective_samples: 0, last_updated: null },
    turnaround_speed: { value: 0.5, samples: 0, effective_samples: 0, last_updated: null },
  };

  const rawScores = raw.scores as Record<string, unknown> | undefined;
  if (rawScores) {
    for (const [key, val] of Object.entries(rawScores)) {
      if (!isValidTaskType(key) || !val || typeof val !== 'object') continue;
      const entry = val as Record<string, unknown>;
      defaults[key] = {
        value: typeof entry.value === 'number' ? entry.value : 0.5,
        samples: typeof entry.samples === 'number' ? entry.samples : 0,
        effective_samples: typeof entry.effective_samples === 'number'
          ? entry.effective_samples : 0,
        last_updated: typeof entry.last_updated === 'string'
          ? entry.last_updated : null,
      };
    }
  }

  return {
    scores: defaults,
    domain_tags: Array.isArray(raw.domain_tags) ? raw.domain_tags : [],
    avoid_tags: Array.isArray(raw.avoid_tags) ? raw.avoid_tags : [],
  };
}

// ═══════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════

function extractProvider(modelId: string): string {
  const base = modelId.split('-')[0].toLowerCase();
  const map: Record<string, string> = {
    claude: 'claude', gpt: 'openai', kimi: 'kimi',
    qwen: 'qwen', glm: 'glm-cn', minimax: 'minimax-cn',
    mimo: 'mimo',
  };
  return map[base] ?? base;
}

function isValidTaskType(key: string): key is TaskType {
  return (TASK_TYPES as readonly string[]).includes(key);
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function fmt(score: number): string {
  return score.toFixed(3);
}

function createDefaultCandidate(): ScoredCandidate {
  return {
    model: 'kimi-for-coding',
    provider: 'kimi',
    score: 0.5,
    reasons: ['default fallback candidate'],
    deprioritized: false,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Convenience Exports
// ═══════════════════════════════════════════════════════════════════

let globalProviderFailures = new Map<string, ProviderFailureState>();

export function recordProviderFailure(provider: string): void {
  updateProviderFailure(provider, globalProviderFailures);
}

export function resetProviderCooldown(provider: string): void {
  clearProviderCooldown(provider, globalProviderFailures);
}

export function isProviderCooledDown(provider: string): boolean {
  return isProviderInCooldown(provider, globalProviderFailures, Date.now());
}

export function routeTask(input: CapabilityRouterInput): RoutingDecision {
  const profiles = loadModelProfiles();
  return routeWithCapabilities(input, profiles, globalProviderFailures);
}

export function getGlobalProviderFailures(): Map<string, ProviderFailureState> {
  return globalProviderFailures;
}

export function setGlobalProviderFailures(
  failures: Map<string, ProviderFailureState>,
): void {
  globalProviderFailures = failures;
}
