// ═══════════════════════════════════════════════════════════════════
// orchestrator/user-profile-store.ts — User-Level Preference Store
// ═══════════════════════════════════════════════════════════════════
/**
 * Global user preference store persisted outside of any single repo.
 * Learns the user's style, stack preferences, recent focus, and habits
 * across all hive sessions.
 *
 * Modeled after project-memory-store.ts but scoped to the user, not the repo.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export type UserProfileDimension =
  | 'communication_style'
  | 'tech_stack'
  | 'focus_project'
  | 'recent_blocker'
  | 'special_habit';

export interface UserProfileEvidence {
  source_run_id: string;
  signal: string;
  weight: number;
  observed_at: string; // ISO
}

export interface UserProfileEntry {
  dimension: UserProfileDimension;
  summary: string; // short, e.g. "prefers terse responses"
  detail?: string; // optional elaboration
  confidence: number; // 0-1
  recency: number; // 0-1
  active: boolean;
  stale: boolean;
  evidence: UserProfileEvidence[];
  created_at: string;
  updated_at: string;
}

export interface UserProfileStore {
  user_id: string; // e.g. os.userInfo().username or env override
  entries: UserProfileEntry[];
  generated_at: string;
}

// ── Config ──

const DECAY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7-day half-life (slower than project memory)
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_CONFIDENCE = 0.35;
const PROFILE_DIR = path.join(os.homedir(), '.config', 'gbrain');
const PROFILE_PATH = path.join(PROFILE_DIR, 'user-profile.json');

// ── Persistence ──

export function loadUserProfile(): UserProfileStore | null {
  try {
    if (!fs.existsSync(PROFILE_PATH)) return null;
    return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8')) as UserProfileStore;
  } catch {
    return null;
  }
}

export function saveUserProfile(store: UserProfileStore): void {
  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
  }
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

// ── Decay & Freshness ──

function decayWeight(ts: number, now: number): number {
  const age = now - ts;
  if (age < 0) return 1.0;
  if (age > MAX_AGE_MS) return 0;
  return Math.pow(0.5, age / DECAY_HALF_LIFE_MS);
}

function computeRecency(evidence: UserProfileEvidence[], now: number): number {
  if (evidence.length === 0) return 0;
  const weights = evidence.map(e => decayWeight(new Date(e.observed_at).getTime(), now));
  const avg = weights.reduce((s, w) => s + w, 0) / weights.length;
  return Math.min(avg, 1.0);
}

export function refreshProfileFreshness(store: UserProfileStore): UserProfileStore {
  const now = Date.now();
  for (const entry of store.entries) {
    entry.recency = computeRecency(entry.evidence, now);
    const age = now - new Date(entry.updated_at).getTime();
    entry.stale = age > MAX_AGE_MS || entry.recency < 0.1;
    entry.active = !entry.stale && entry.confidence >= MIN_CONFIDENCE;
  }
  store.entries = store.entries.filter(e => e.active || !e.stale);
  store.generated_at = new Date(now).toISOString();
  return store;
}

// ── Upsert ──

export function upsertUserProfile(
  store: UserProfileStore,
  input: {
    dimension: UserProfileDimension;
    summary: string;
    detail?: string;
    evidence: UserProfileEvidence[];
  },
): UserProfileEntry | null {
  const now = Date.now();
  const existing = store.entries.find(
    e => e.active && e.dimension === input.dimension && similarityScore(e.summary, input.summary) > 0.7,
  );

  if (existing) {
    const newEvidence = input.evidence.filter(
      ne => !existing.evidence.some(ee => ee.source_run_id === ne.source_run_id && ee.signal === ne.signal),
    );
    if (newEvidence.length === 0) {
      // No new signal — just refresh timestamp
      existing.updated_at = new Date(now).toISOString();
      return existing;
    }
    existing.evidence.push(...newEvidence);
    existing.updated_at = new Date(now).toISOString();
    existing.confidence = computeConfidence(existing.evidence);
    existing.recency = computeRecency(existing.evidence, now);
    existing.stale = existing.recency < 0.1 || (now - new Date(existing.updated_at).getTime()) > MAX_AGE_MS;
    existing.active = !existing.stale && existing.confidence >= MIN_CONFIDENCE;
    return existing;
  }

  const confidence = computeConfidence(input.evidence);
  if (input.evidence.length < 1 || confidence < MIN_CONFIDENCE) {
    return null;
  }

  const entry: UserProfileEntry = {
    dimension: input.dimension,
    summary: input.summary,
    detail: input.detail,
    evidence: input.evidence,
    confidence,
    recency: computeRecency(input.evidence, now),
    active: true,
    stale: false,
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
  };
  store.entries.push(entry);
  return entry;
}

// ── Helpers ──

function computeConfidence(evidence: UserProfileEvidence[]): number {
  if (evidence.length === 0) return 0;
  const count = evidence.length;
  const uniqueRuns = new Set(evidence.map(e => e.source_run_id)).size;
  const avgWeight = evidence.reduce((s, e) => s + e.weight, 0) / count;
  const countScore = Math.min(count / 3, 1.0); // saturate at 3
  const diversityScore = Math.min(uniqueRuns / 2, 1.0); // saturate at 2
  return countScore * 0.4 + diversityScore * 0.3 + avgWeight * 0.3;
}

function similarityScore(a: string, b: string): number {
  const aWords = new Set(a.toLowerCase().split(/\s+/));
  const bWords = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...aWords].filter(w => bWords.has(w));
  const union = new Set([...aWords, ...bWords]);
  return union.size === 0 ? 0 : intersection.length / union.size;
}

export function initUserProfile(userId?: string): UserProfileStore {
  const existing = loadUserProfile();
  if (existing) {
    return refreshProfileFreshness(existing);
  }
  return {
    user_id: userId || os.userInfo().username || 'default',
    entries: [],
    generated_at: new Date().toISOString(),
  };
}
