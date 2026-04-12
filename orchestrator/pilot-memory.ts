/**
 * pilot-memory.ts — Lesson persistence + deterministic recall.
 *
 * All I/O is wrapped in try/catch that returns safe defaults.
 * Corrupt or missing store never throws — main flow always continues.
 */

import fs from 'fs';
import path from 'path';
import {
  type LessonRecord,
  type RecallQuery,
  type RecallResult,
  type AdoptionReceipt,
  type PilotLessonsStore,
  PILOT_SCHEMA_VERSION,
  MAX_LESSONS,
  RECALL_TOP_N,
} from './pilot-types.js';
import type { DiscussResult, DiscussTrigger } from './types.js';

// ── Path helpers ──

/** Resolve store directory, defaulting to CWD/.ai/pilot-lessons/. */
export function resolveLessonsDir(cwd?: string): string {
  return path.resolve(cwd ?? process.cwd(), '.ai', 'pilot-lessons');
}

function lessonsPath(dir: string): string {
  return path.join(dir, 'lessons.json');
}

function adoptionLogPath(dir: string): string {
  return path.join(dir, 'adoption-log.jsonl');
}

// ── Load / Save ──

const EMPTY_STORE: PilotLessonsStore = {
  schema_version: PILOT_SCHEMA_VERSION,
  lessons: [],
};

export function loadStore(lessonsDir?: string): PilotLessonsStore {
  const dir = resolveLessonsDir(lessonsDir);
  const fp = lessonsPath(dir);
  try {
    if (!fs.existsSync(fp)) return { ...EMPTY_STORE, lessons: [] };
    const raw = fs.readFileSync(fp, 'utf-8');
    const parsed = JSON.parse(raw) as PilotLessonsStore;
    if (!parsed || !Array.isArray(parsed.lessons)) {
      return { ...EMPTY_STORE, lessons: [] };
    }
    return parsed;
  } catch {
    // Corruption or unreadable → return empty, don't throw.
    return { ...EMPTY_STORE, lessons: [] };
  }
}

/** Dedupe by lesson_id; keep the newer one on collision. */
function dedupe(lessons: LessonRecord[]): LessonRecord[] {
  const map = new Map<string, LessonRecord>();
  for (const l of lessons) {
    const existing = map.get(l.lesson_id);
    if (!existing || l.created_at > existing.created_at) {
      map.set(l.lesson_id, l);
    }
  }
  return [...map.values()];
}

/** Sort newest-first, then cap to MAX_LESSONS. */
function capLessons(lessons: LessonRecord[]): LessonRecord[] {
  const sorted = [...lessons].sort(
    (a: LessonRecord, b: LessonRecord) => b.created_at.localeCompare(a.created_at),
  );
  return sorted.slice(0, MAX_LESSONS);
}

export function saveStore(
  store: PilotLessonsStore,
  lessonsDir?: string,
): void {
  const dir = resolveLessonsDir(lessonsDir);
  const fp = lessonsPath(dir);
  try {
    const merged = dedupe(store.lessons);
    const capped = capLessons(merged);
    const out: PilotLessonsStore = {
      schema_version: PILOT_SCHEMA_VERSION,
      lessons: capped,
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(out, null, 2));
  } catch {
    // Fail open: swallow write errors.
  }
}

/** Append a single lesson to the store, dedupe + cap, persist. */
export function appendLesson(
  lesson: LessonRecord,
  lessonsDir?: string,
): void {
  const store = loadStore(lessonsDir);
  store.lessons.push(lesson);
  saveStore(store, lessonsDir);
}

// ── Adoption log ──

export function appendAdoptionReceipt(
  receipt: AdoptionReceipt,
  lessonsDir?: string,
): void {
  const dir = resolveLessonsDir(lessonsDir);
  const fp = adoptionLogPath(dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(receipt) + '\n';
    fs.appendFileSync(fp, line);
  } catch {
    // Fail open.
  }
}

/** Read all adoption receipts (newest last). */
export function readAdoptionLog(lessonsDir?: string): AdoptionReceipt[] {
  const dir = resolveLessonsDir(lessonsDir);
  const fp = adoptionLogPath(dir);
  try {
    if (!fs.existsSync(fp)) return [];
    const raw = fs.readFileSync(fp, 'utf-8').trim();
    if (!raw) return [];
    return raw.split('\n').map((line) => JSON.parse(line) as AdoptionReceipt);
  } catch {
    return [];
  }
}

// ── Deterministic recall ──

/**
 * Recall matching strategy (deterministic, no embeddings):
 *
 * 1. Filter by task_category (exact match) if provided.
 * 2. Filter by source_kind (exact match) if provided.
 * 3. Filter by task_fingerprint if provided:
 *    - Parse both query and record as JSON.
 *    - Match if `role` matches AND any domain overlaps.
 * 4. Rank by composite score (descending):
 *    a. outcome === 'helped' → +3
 *    b. outcome === 'failed' → -1
 *    c. adoption_count × 1  (capped at +5)
 *    d. helped_count × 2    (capped at +5)
 *    e. recency: days since created_at × -0.1
 * 5. Truncate to RECALL_TOP_N.
 */
export function recall(
  query: RecallQuery,
  lessonsDir?: string,
): RecallResult {
  const store = loadStore(lessonsDir);
  if (store.lessons.length === 0) {
    return { lessons: [], total_matched: 0 };
  }

  // Category filter
  let pool = store.lessons;
  if (query.task_category) {
    pool = pool.filter((l) => l.task_category === query.task_category);
  }

  // Source kind filter
  if (query.source_kind) {
    pool = pool.filter((l) => l.source_kind === query.source_kind);
  }

  // Fingerprint filter
  if (query.task_fingerprint) {
    let qFp: Record<string, unknown>;
    try {
      qFp = JSON.parse(query.task_fingerprint) as Record<string, unknown>;
    } catch {
      // Bad fingerprint → skip this filter
      qFp = {};
    }
    if (Object.keys(qFp).length > 0) {
      pool = pool.filter((l) => fingerprintMatches(qFp, l.task_fingerprint));
    }
  }

  const totalMatched = pool.length;
  const ranked = [...pool].sort((a: LessonRecord, b: LessonRecord) => lessonScore(b) - lessonScore(a));
  const top = ranked.slice(0, RECALL_TOP_N);

  return { lessons: top, total_matched: totalMatched };
}

// ── Recall internals ──

function fingerprintMatches(
  query: Record<string, unknown>,
  candidate: string,
): boolean {
  let cFp: Record<string, unknown>;
  try {
    cFp = JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    return false;
  }

  // Role must match if both present
  if (query.role && cFp.role && query.role !== cFp.role) return false;

  // Domain overlap
  const qDomains = asStringArray(query.domains);
  const cDomains = asStringArray(cFp.domains);
  if (qDomains.length > 0 && cDomains.length > 0) {
    const overlap = qDomains.some((d) => cDomains.includes(d));
    if (!overlap) return false;
  }

  return true;
}

function asStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val as string[];
  return [];
}

function lessonScore(l: LessonRecord): number {
  let score = 0;

  // Outcome bonus
  if (l.outcome === 'helped') score += 3;
  if (l.outcome === 'failed') score -= 1;

  // Adoption / helped caps
  score += Math.min(l.adoption_count, 5);
  score += Math.min(l.helped_count * 2, 5);

  // Recency decay: newer is better
  const daysSince = (Date.now() - new Date(l.created_at).getTime())
    / (86_400_000);
  score -= daysSince * 0.1;

  return score;
}

// ── Capture helpers ──

/**
 * Extract a LessonRecord from a completed discuss result.
 * Captures pushback/risk patterns as symptom + rule.
 * Fail-open: never throws.
 */
export function captureDiscussLesson(
  trigger: DiscussTrigger,
  result: DiscussResult,
  workerModel: string,
  reviewerModel: string,
  lessonsDir?: string,
): void {
  try {
    const symptom = result.reasoning.length > 120
      ? result.reasoning.slice(0, 117) + '...'
      : result.reasoning;

    const rule = result.quality_gate === 'fail'
      ? `Discuss escalated; verify escalated decision independently.`
      : `Consider discuss pushback before committing to direction.`;

    const evidence = [
      `decision=${result.decision.slice(0, 60)}`,
      `gate=${result.quality_gate}`,
      trigger.uncertain_about.length > 80
        ? `q=${trigger.uncertain_about.slice(0, 77)}...`
        : `q=${trigger.uncertain_about}`,
    ].join('; ');

    const lesson: LessonRecord = {
      lesson_id: `les-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      created_at: new Date().toISOString(),
      source_kind: 'discuss',
      task_category: 'unknown',
      task_fingerprint: '{}',
      worker_model: workerModel,
      reviewer_model: reviewerModel,
      symptom,
      rule,
      evidence,
      outcome: 'unknown',
      adoption_count: 0,
      helped_count: 0,
    };

    appendLesson(lesson, lessonsDir);
  } catch {
    // Fail open: capture failure must not affect main flow.
  }
}
