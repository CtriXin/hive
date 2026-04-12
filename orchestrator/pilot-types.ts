/**
 * pilot-types.ts — OpenSpace-style pilot data contracts.
 *
 * Slice 1: types only, no prompt injection.
 * Fail-open: lesson store missing/corrupt must never block main flow.
 */

// ── Schema versioning ──

/** Bump only when persisting a layout change that old code can't read. */
export const PILOT_SCHEMA_VERSION = '1.0';

// ── Enums / unions ──

/** Where the lesson came from. */
export type SourceKind =
  | 'discuss'
  | 'cross_review'
  | 'a2a'
  | 'handoff';

/** Observed outcome after a lesson was injected into a run. */
export type LessonOutcome =
  | 'helped'
  | 'failed'
  | 'unknown';

// ── Core records ──

/**
 * A single lesson captured from discuss / review / handoff.
 *
 * Design notes:
 * - `task_fingerprint` is stored as a JSON string of the simplified
 *   fingerprint (role + sorted domains + complexity).  This keeps matching
 *   deterministic without needing embedding search.
 * - `evidence` is a short human-readable summary (≤ 200 chars suggested).
 * - `adoption_count` and `helped_count` are monotonically-increasing
 *   counters updated by the adoption receipt flow.
 */
export interface LessonRecord {
  lesson_id: string;
  created_at: string;           // ISO-8601
  source_kind: SourceKind;
  task_category: string;
  task_fingerprint: string;     // JSON: {role, domains[], complexity}
  worker_model: string;
  reviewer_model: string;
  symptom: string;              // ≤ 120 chars
  rule: string;                 // ≤ 200 chars
  evidence: string;             // ≤ 200 chars
  outcome: LessonOutcome;
  adoption_count: number;
  helped_count: number;
}

// ── Recall ──

/** What we're looking for.  All fields optional — empty query = no recall. */
export interface RecallQuery {
  task_category?: string;
  task_fingerprint?: string;    // JSON string to compare
  source_kind?: SourceKind;
}

export interface RecallResult {
  lessons: LessonRecord[];
  /** How many were considered before truncation. */
  total_matched: number;
}

// ── Adoption receipt ──

/**
 * Appended once per run to `.ai/pilot-lessons/adoption-log.jsonl`.
 * Records which lessons were offered and the observed outcome.
 */
export interface AdoptionReceipt {
  run_id: string;
  task_id: string;
  used_lessons: string[];       // lesson_ids injected into prompt
  adopted_lessons: string[];    // lesson_ids the worker clearly followed
  ignored_lessons: string[];    // lesson_ids that had no visible effect
  still_failed_patterns: string[];
  final_outcome: 'pass' | 'fail' | 'unknown';
  created_at: string;           // ISO-8601
}

// ── Store shape ──

export interface PilotLessonsStore {
  schema_version: string;
  lessons: LessonRecord[];
}

// ── Limits ──

export const MAX_LESSONS = 200;
export const RECALL_TOP_N = 3;
