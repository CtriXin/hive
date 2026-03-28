import fs from 'fs';
import path from 'path';
import { resolveProjectPath } from './project-paths.js';

const PROFILES_PATH = resolveProjectPath('config', 'model-profiles.json');
const POLICY_PATH = resolveProjectPath('config', 'benchmark-policy.json');

export type ProfileScoreKey =
  | 'implementation'
  | 'review'
  | 'repair'
  | 'integration'
  | 'spec_adherence'
  | 'scope_discipline'
  | 'turnaround_speed';

export interface ObservedScore {
  value: number;
  samples: number;
  effective_samples: number;
  last_updated: string | null;
}

export interface ModelProfile {
  scores: Record<ProfileScoreKey, ObservedScore>;
  domain_tags: string[];
  avoid_tags: string[];
}

export interface ModelProfilesStore {
  schema_version: string;
  profiles: Record<string, ModelProfile>;
}

export interface BenchmarkPolicy {
  schema_version: string;
  min_samples_for_confidence: number;
  half_life_days: number;
  default_score: number;
  hard_filters: {
    strict_boundary_min_scope_discipline: number;
    integration_min_confidence: number;
  };
  base_weights: Record<ProfileScoreKey, number>;
  role_boost: number;
  strict_boundary_boost: number;
  fast_turnaround_boost: number;
}

export const PROFILE_SCORE_KEYS: ProfileScoreKey[] = [
  'implementation',
  'review',
  'repair',
  'integration',
  'spec_adherence',
  'scope_discipline',
  'turnaround_speed',
];

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function createDefaultObservedScore(defaultScore: number): ObservedScore {
  return {
    value: defaultScore,
    samples: 0,
    effective_samples: 0,
    last_updated: null,
  };
}

function createDefaultProfile(defaultScore: number): ModelProfile {
  return {
    scores: Object.fromEntries(
      PROFILE_SCORE_KEYS.map((key) => [key, createDefaultObservedScore(defaultScore)]),
    ) as Record<ProfileScoreKey, ObservedScore>,
    domain_tags: [],
    avoid_tags: [],
  };
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function normalizeProfile(
  input: Partial<ModelProfile> | undefined,
  defaultScore: number,
): ModelProfile {
  const base = createDefaultProfile(defaultScore);
  if (!input) {
    return base;
  }

  const mergedScores = { ...base.scores };
  for (const key of PROFILE_SCORE_KEYS) {
    const score = input.scores?.[key];
    if (!score) {
      continue;
    }
    mergedScores[key] = {
      value: clamp(score.value ?? defaultScore),
      samples: Math.max(0, Math.round(score.samples ?? 0)),
      effective_samples: Math.max(0, score.effective_samples ?? score.samples ?? 0),
      last_updated: score.last_updated ?? null,
    };
  }

  return {
    scores: mergedScores,
    domain_tags: [...new Set(input.domain_tags ?? [])],
    avoid_tags: [...new Set(input.avoid_tags ?? [])],
  };
}

export function loadBenchmarkPolicy(
  policyPath: string = POLICY_PATH,
): BenchmarkPolicy {
  return readJsonFile<BenchmarkPolicy>(policyPath);
}

export function loadProfiles(
  profilesPath: string = PROFILES_PATH,
  policy: BenchmarkPolicy = loadBenchmarkPolicy(),
): ModelProfilesStore {
  if (!fs.existsSync(profilesPath)) {
    return { schema_version: '1.0', profiles: {} };
  }

  const raw = readJsonFile<ModelProfilesStore>(profilesPath);
  const profiles = Object.fromEntries(
    Object.entries(raw.profiles || {}).map(([modelId, profile]) => [
      modelId,
      normalizeProfile(profile, policy.default_score),
    ]),
  );

  return {
    schema_version: raw.schema_version || '1.0',
    profiles,
  };
}

export function saveProfiles(
  store: ModelProfilesStore,
  profilesPath: string = PROFILES_PATH,
): void {
  writeJsonFile(profilesPath, store);
}

export function getOrCreateProfile(
  store: ModelProfilesStore,
  modelId: string,
  policy: BenchmarkPolicy,
): ModelProfile {
  if (!store.profiles[modelId]) {
    store.profiles[modelId] = createDefaultProfile(policy.default_score);
  }
  return store.profiles[modelId];
}

export function getProfile(
  store: ModelProfilesStore,
  modelId: string,
  policy: BenchmarkPolicy,
): ModelProfile {
  return normalizeProfile(store.profiles[modelId], policy.default_score);
}

export function mergeAvoidTags(
  staticAvoid: string[] = [],
  dynamicAvoid: string[] = [],
): string[] {
  return [...new Set([...staticAvoid, ...dynamicAvoid])];
}

export function getConfidenceFactor(
  samples: number,
  policy: BenchmarkPolicy,
): number {
  if (samples <= 0) {
    return 0;
  }
  return Math.min(1, Math.sqrt(samples / policy.min_samples_for_confidence));
}

export function applyTimeDecay(
  rawValue: number,
  lastUpdated: string | null,
  policy: BenchmarkPolicy,
  now: Date = new Date(),
): number {
  if (!lastUpdated) {
    return rawValue;
  }

  const updatedAt = new Date(lastUpdated);
  if (Number.isNaN(updatedAt.getTime())) {
    return rawValue;
  }

  const days = Math.max(
    0,
    (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60 * 24),
  );
  const decayFactor = Math.pow(0.5, days / policy.half_life_days);
  return clamp(
    policy.default_score + (rawValue - policy.default_score) * decayFactor,
  );
}

export function getEffectiveScore(
  profile: ModelProfile,
  key: ProfileScoreKey,
  policy: BenchmarkPolicy,
): ObservedScore {
  const source = profile.scores[key] ?? createDefaultObservedScore(policy.default_score);
  return {
    value: applyTimeDecay(source.value, source.last_updated, policy),
    samples: source.effective_samples ?? source.samples,
    effective_samples: source.effective_samples ?? source.samples,
    last_updated: source.last_updated,
  };
}

export function updateObservedScore(
  store: ModelProfilesStore,
  modelId: string,
  key: ProfileScoreKey,
  nextValue: number,
  policy: BenchmarkPolicy,
  alpha: number = 0.2,
  sampleWeight: number = 1,
): void {
  const profile = getOrCreateProfile(store, modelId, policy);
  const current = profile.scores[key];
  const merged = current.samples === 0
    ? clamp(nextValue)
    : clamp(current.value * (1 - alpha) + nextValue * alpha);

  profile.scores[key] = {
    value: merged,
    samples: current.samples + 1,
    effective_samples: (current.effective_samples ?? current.samples) + sampleWeight,
    last_updated: new Date().toISOString(),
  };
}

interface ScorecardEntry {
  model_label: string;
  scores: Record<string, number>;
}

interface ScorecardPayload {
  results: ScorecardEntry[];
}

const SCORECARD_MODEL_ALIASES: Record<string, string> = {
  'glm5-turbo': 'glm-5-turbo',
  'glm-5-turbo': 'glm-5-turbo',
  'minimax-2.7': 'MiniMax-M2.7',
  'MiniMax-M2.7': 'MiniMax-M2.7',
  'kimi-coding': 'kimi-for-coding',
  'kimi-for-coding': 'kimi-for-coding',
  'kimi-k2.5': 'kimi-k2.5',
  'qwen-max': 'qwen-max',
  'qwen-3.5': 'qwen-3.5',
};

function normalizeModelLabel(label: string): string | null {
  const normalized = label.trim().toLowerCase().replace(/\s+/g, '-');
  return SCORECARD_MODEL_ALIASES[normalized] ?? null;
}

function mapScorecardToProfileScores(
  entry: ScorecardEntry,
): Partial<Record<ProfileScoreKey, number>> {
  const score = entry.scores;
  const specAdherence = (score.spec_comprehension ?? 0) / 20;
  const scopeDiscipline = (score.scope_discipline ?? 0) / 10;
  const integration = (score.integration_readiness ?? 0) / 15;

  return {
    implementation:
      ((score.code_control ?? 0) + (score.delivery_completeness ?? 0)) / 35,
    repair: (score.repair_ability ?? 0) / 10,
    review: (specAdherence + scopeDiscipline + integration) / 3,
    integration,
    spec_adherence: specAdherence,
    scope_discipline: scopeDiscipline,
    turnaround_speed: (score.turnaround_speed ?? 0) / 10,
  };
}

export function applyBenchmarkSession(
  scorecardPath: string,
  profilesPath: string = PROFILES_PATH,
): ModelProfilesStore {
  const policy = loadBenchmarkPolicy();
  const store = loadProfiles(profilesPath, policy);
  const payload = readJsonFile<ScorecardPayload>(scorecardPath);

  for (const entry of payload.results || []) {
    const modelId = normalizeModelLabel(entry.model_label);
    if (!modelId) {
      continue;
    }

    const mapped = mapScorecardToProfileScores(entry);
    for (const [key, value] of Object.entries(mapped)) {
      if (value === undefined) {
        continue;
      }
      updateObservedScore(store, modelId, key as ProfileScoreKey, value, policy);
    }
  }

  saveProfiles(store, profilesPath);
  return store;
}
