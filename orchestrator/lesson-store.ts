// ═══════════════════════════════════════════════════════════════════
// orchestrator/lesson-store.ts — Phase 6A: Cross-Run Lesson Store
// ═══════════════════════════════════════════════════════════════════
/**
 * Lightweight, explainable cross-run learning.
 *
 * Extracts structured lessons from historical run artifacts:
 * - transition logs (failure_class frequency)
 * - forensics packs (repair outcomes, retry patterns)
 * - verification outcomes (which profiles succeeded/failed)
 *
 * Guardrails:
 * - lessons have recency decay (older evidence weights less)
 * - minimum sample threshold (need >= 2 observations)
 * - explicit config always overrides learning
 * - never silently changes user-specified profiles
 */

import fs from 'fs';
import path from 'path';
import type {
  FailureClass,
  Lesson,
  LessonConfidence,
  LessonEvidence,
  LessonStore,
  RunTransitionRecord,
  TaskRunRecord,
} from './types.js';
import type { TaskVerificationRule } from './project-policy.js';
import { loadTransitionLog } from './run-transition-log.js';

// ── Config ──

const MIN_OBSERVATIONS = 2;
const MAX_LESSON_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DECAY_HALF_LIFE_MS = 2 * 24 * 60 * 60 * 1000; // 2 day half-life

// ── Artifact Scanners ──

/**
 * Scan transition logs for recurring failure patterns per task category.
 * Groups by task ID prefix (e.g. "task-a" → extract common prefix) and failure class.
 */
function scanTransitionLogTransitions(
  transitions: RunTransitionRecord[],
  now: number,
): { pattern: string; failureClass: FailureClass; observations: { ts: number; runId: string }[] }[] {
  const bucket = new Map<string, Map<FailureClass, { ts: number; runId: string }[]>>();

  for (const t of transitions) {
    if (!t.task_id || !t.failure_class || t.to_state === t.from_state) continue;

    const taskPrefix = normalizeTaskId(t.task_id);
    const byClass = bucket.get(taskPrefix) || new Map();
    const obs = byClass.get(t.failure_class) || [];
    obs.push({ ts: new Date(t.timestamp).getTime(), runId: t.run_id });
    byClass.set(t.failure_class, obs);
    bucket.set(taskPrefix, byClass);
  }

  const results: typeof bucket extends Map<string, Map<infer C, any>>
    ? { pattern: string; failureClass: C; observations: { ts: number; runId: string }[] }[]
    : never = [];

  for (const [taskPrefix, byClass] of bucket.entries()) {
    for (const [fc, obs] of byClass.entries()) {
      if (obs.length < MIN_OBSERVATIONS) continue;
      results.push({ pattern: taskPrefix, failureClass: fc, observations: obs });
    }
  }

  return results;
}

/**
 * Scan verification outcomes to find which rules/profiles work best for which file patterns.
 */
function scanVerificationPatterns(
  taskStates: Record<string, TaskRunRecord>,
  now: number,
): { pattern: string; verificationIssue: string; count: number }[] {
  const bucket = new Map<string, { issue: string; count: number }>();

  for (const [taskId, state] of Object.entries(taskStates)) {
    if (!state.failure_class && state.status !== 'verification_failed' && state.status !== 'review_failed') continue;

    const taskPrefix = normalizeTaskId(taskId);
    const key = `${taskPrefix}::${state.failure_class || state.status}`;
    const existing = bucket.get(key);
    if (existing) {
      existing.count++;
    } else {
      bucket.set(key, { issue: state.last_error || state.failure_class || 'unknown', count: 1 });
    }
  }

  const results: { pattern: string; verificationIssue: string; count: number }[] = [];
  for (const [key, val] of bucket.entries()) {
    if (val.count < MIN_OBSERVATIONS) continue;
    const [pattern, _issue] = key.split('::');
    results.push({ pattern, verificationIssue: val.issue, count: val.count });
  }

  return results;
}

// ── Lesson Generation ──

/**
 * Extract lessons from transition logs across multiple runs.
 */
function extractTransitionLessons(
  transitionLogs: Record<string, RunTransitionRecord[]>, // runId → transitions
): Lesson[] {
  const lessons: Lesson[] = [];
  const now = Date.now();

  // Combine all transitions with their run IDs
  const allTransitions: RunTransitionRecord[] = [];
  for (const [runId, logs] of Object.entries(transitionLogs)) {
    allTransitions.push(...logs);
  }

  if (allTransitions.length === 0) return lessons;

  const failurePatterns = scanTransitionLogTransitions(allTransitions, now);

  for (const pattern of failurePatterns) {
    const uniqueRuns = new Set(pattern.observations.map(o => o.runId));
    const recencyWeight = computeRecencyWeight(pattern.observations.map(o => o.ts), now);

    if (pattern.observations.length < MIN_OBSERVATIONS) continue;

    const confidence = scoreConfidence(
      uniqueRuns.size,
      pattern.observations.length,
      recencyWeight,
    );

    if (confidence === 'low' && uniqueRuns.size < 3) continue;

    const evidence: LessonEvidence[] = pattern.observations.map(o => ({
      source_run_id: o.runId,
      source_artifact: 'transition_log' as const,
      signal: `Task ${o.runId} → failure: ${pattern.failureClass}`,
      weight: decayWeight(o.ts, now),
    }));

    lessons.push({
      id: `lesson-${pattern.pattern}-${pattern.failureClass}-${hashStr(pattern.pattern + pattern.failureClass)}`,
      kind: pattern.failureClass === 'build' || pattern.failureClass === 'test'
        ? 'verification_profile'
        : pattern.failureClass === 'provider' || pattern.failureClass === 'tool'
          ? 'repair_strategy'
          : 'failure_pattern',
      pattern: pattern.pattern,
      recommendation: `Tasks matching "${pattern.pattern}" frequently fail with class "${pattern.failureClass}". Consider stricter verification or different model.`,
      reason: `Observed ${pattern.observations.length} occurrences across ${uniqueRuns.size} runs.`,
      confidence,
      evidence,
      supporting_runs: uniqueRuns.size,
      observation_count: pattern.observations.length,
      created_at: new Date(Math.min(...pattern.observations.map(o => o.ts))).toISOString(),
      updated_at: new Date(Math.max(...pattern.observations.map(o => o.ts))).toISOString(),
      active: true,
    });
  }

  return lessons;
}

/**
 * Extract lessons from verification outcomes.
 */
function extractVerificationLessons(
  taskStates: Record<string, TaskRunRecord>,
  taskRules: Record<string, TaskVerificationRule>,
): Lesson[] {
  const lessons: Lesson[] = [];
  const now = Date.now();

  if (Object.keys(taskStates).length === 0) return lessons;

  const verificationPatterns = scanVerificationPatterns(taskStates, now);

  for (const vp of verificationPatterns) {
    // Check if there's a rule that could have helped
    const relevantRules = findMatchingRules(vp.pattern, taskRules);

    if (relevantRules.length > 0) {
      lessons.push({
        id: `lesson-vp-${hashStr(vp.pattern + vp.verificationIssue)}`,
        kind: 'rule_recommendation',
        pattern: vp.pattern,
        recommendation: `Tasks matching "${vp.pattern}" with verification issues benefit from rule "${relevantRules[0].rule_id}".`,
        reason: `${vp.count} observations of verification issue: ${vp.verificationIssue}`,
        confidence: vp.count >= 5 ? 'high' : vp.count >= 3 ? 'medium' : 'low',
        evidence: [{
          source_run_id: 'aggregated',
          source_artifact: 'verification_outcome',
          signal: `${vp.count} tasks matching "${vp.pattern}" had verification issue: ${vp.verificationIssue}`,
          weight: 1,
        }],
        supporting_runs: 1,
        observation_count: vp.count,
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
        active: true,
      });
    }
  }

  return lessons;
}

// ── Helpers ──

function normalizeTaskId(taskId: string): string {
  // Extract meaningful prefix: "task-build-verify" → "task-build"
  // "task-a" → "task-a", "repair-task-b" → "repair-task"
  const parts = taskId.split('-');
  if (parts.length >= 3) {
    return parts.slice(0, 2).join('-');
  }
  return taskId;
}

function decayWeight(ts: number, now: number): number {
  const age = now - ts;
  if (age > MAX_LESSON_AGE_MS) return 0;
  return Math.pow(0.5, age / DECAY_HALF_LIFE_MS);
}

function computeRecencyWeight(timestamps: number[], now: number): number {
  if (timestamps.length === 0) return 0;
  const weights = timestamps.map(ts => decayWeight(ts, now));
  return Math.min(weights.reduce((sum, w) => sum + w, 0) / timestamps.length, 1);
}

function scoreConfidence(
  uniqueRuns: number,
  totalObs: number,
  recencyWeight: number,
): LessonConfidence {
  const score = (uniqueRuns * 0.4) + (totalObs * 0.3) + (recencyWeight * 0.3);
  if (score >= 2.0 && uniqueRuns >= 3 && recencyWeight > 0.5) return 'high';
  if (score >= 1.0 && uniqueRuns >= 2) return 'medium';
  return 'low';
}

function findMatchingRules(
  pattern: string,
  rules: Record<string, TaskVerificationRule>,
): TaskVerificationRule[] {
  const matches: TaskVerificationRule[] = [];
  for (const rule of Object.values(rules)) {
    if (rule.file_patterns.length === 0) continue;
    for (const filePattern of rule.file_patterns) {
      if (pattern.startsWith(filePattern) || filePattern.startsWith(pattern)) {
        matches.push(rule);
        break;
      }
    }
  }
  return matches;
}

function hashStr(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

// ── Public API ──

/**
 * Load lesson store from disk.
 * Returns null if no lessons exist yet.
 */
export function loadLessonStore(cwd: string): LessonStore | null {
  const filePath = path.join(cwd, '.ai', 'lessons', 'store.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as LessonStore;
  } catch {
    return null;
  }
}

/**
 * Save lesson store to disk.
 */
export function saveLessonStore(cwd: string, store: LessonStore): void {
  const dir = path.join(cwd, '.ai', 'lessons');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Extract lessons from historical run artifacts.
 * This is the main lesson generation entry point.
 */
export function extractLessons(
  transitionLogs: Record<string, RunTransitionRecord[]>,
  taskStates: Record<string, TaskRunRecord> = {},
  taskRules: Record<string, TaskVerificationRule> = {},
): Lesson[] {
  const transitionLessons = extractTransitionLessons(transitionLogs);
  const verificationLessons = extractVerificationLessons(taskStates, taskRules);

  // Merge lessons, deduplicating by ID (keep the most recent)
  const lessonMap = new Map<string, Lesson>();
  for (const lesson of [...transitionLessons, ...verificationLessons]) {
    const existing = lessonMap.get(lesson.id);
    if (!existing || new Date(lesson.updated_at) > new Date(existing.updated_at)) {
      lessonMap.set(lesson.id, lesson);
    }
  }

  return [...lessonMap.values()].filter(lesson => {
    // Filter out stale lessons
    const age = Date.now() - new Date(lesson.updated_at).getTime();
    return lesson.active && age < MAX_LESSON_AGE_MS && lesson.observation_count >= MIN_OBSERVATIONS;
  });
}

/**
 * Load all transition logs from historical runs.
 */
export function loadAllTransitionLogs(cwd: string): Record<string, RunTransitionRecord[]> {
  const runsDir = path.join(cwd, '.ai', 'runs');
  if (!fs.existsSync(runsDir)) return {};

  const result: Record<string, RunTransitionRecord[]> = {};
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
    const transitions = loadTransitionLog(cwd, entry.name);
    if (transitions.length > 0) {
      result[entry.name] = transitions;
    }
  }

  return result;
}

/**
 * Load task states from a specific run's state file.
 */
export function loadTaskStates(cwd: string, runId: string): Record<string, TaskRunRecord> {
  const statePath = path.join(cwd, '.ai', 'runs', runId, 'state.json');
  try {
    if (!fs.existsSync(statePath)) return {};
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    return state.task_states || {};
  } catch {
    return {};
  }
}

/**
 * Refresh the lesson store by scanning all historical runs.
 * Returns the updated store.
 */
export function refreshLessonStore(cwd: string, taskRules: Record<string, TaskVerificationRule> = {}): LessonStore {
  const transitionLogs = loadAllTransitionLogs(cwd);

  // Also load latest task states if a run is active
  const runDirs = Object.keys(transitionLogs);
  const latestRun = runDirs.sort().pop();
  const taskStates = latestRun ? loadTaskStates(cwd, latestRun) : {};

  const lessons = extractLessons(transitionLogs, taskStates, taskRules);

  return {
    lessons,
    generated_at: new Date().toISOString(),
  };
}
