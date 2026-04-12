// ═══════════════════════════════════════════════════════════════════
// orchestrator/memory-extractor.ts — Phase 7A: Memory Extraction
// ═══════════════════════════════════════════════════════════════════
/**
 * Extracts project-level memories from historical run artifacts.
 *
 * Sources:
 * - transition logs (recurring failure patterns)
 * - forensics packs (repair outcomes, failure classes)
 * - verification outcomes (which checks consistently fail/pass)
 * - lessons (already-extracted signals from lesson-store)
 *
 * Strategy:
 * - recurring signal first (single-event noise is ignored)
 * - repeated failures / repeated fixes prioritized
 * - explicit成功经验 also captured when evidence is sufficient
 */

import fs from 'fs';
import path from 'path';
import type {
  FailureClass,
  MemoryEvidence,
  ProjectMemoryStore,
  RunTransitionRecord,
  TaskRunRecord,
} from './types.js';
import { upsertMemory, saveProjectMemory } from './project-memory-store.js';
import { loadAllTransitionLogs, loadTaskStates } from './lesson-store.js';

// ── Config ──

const MIN_RECURRING_COUNT = 2; // need ≥2 occurrences to form a memory

// ── Public API ──

/**
 * Extract memories from all historical runs and merge into project memory.
 * Returns the updated store.
 */
export function extractProjectMemories(
  cwd: string,
  existingStore: ProjectMemoryStore,
): ProjectMemoryStore {
  const transitionLogs = loadAllTransitionLogs(cwd);
  const allTransitions = flattenTransitions(transitionLogs);

  extractFailurePatternMemories(allTransitions, existingStore);
  extractRepairPatternMemories(allTransitions, cwd, existingStore);
  extractRiskyAreaMemories(allTransitions, existingStore);

  saveProjectMemory(cwd, existingStore);
  return existingStore;
}

// ── Failure Pattern Memories ──

function extractFailurePatternMemories(
  transitions: RunTransitionRecord[],
  store: ProjectMemoryStore,
): void {
  const buckets = bucketFailuresByClass(transitions);

  for (const [failureClass, entries] of Object.entries(buckets)) {
    if (entries.length < MIN_RECURRING_COUNT) continue;

    const uniqueRuns = new Set(entries.map(e => e.run_id));
    if (uniqueRuns.size < 2) continue; // need diversity across runs

    const fc = failureClass as FailureClass;
    const topTaskPatterns = findTopTaskPatterns(entries, 3);

    for (const pattern of topTaskPatterns) {
      if (pattern.count < MIN_RECURRING_COUNT) continue;

      const evidence: MemoryEvidence[] = pattern.entries.slice(0, 5).map(e => ({
        source_run_id: e.run_id,
        source_artifact: 'transition_log' as const,
        signal: `Task ${e.task_id} → ${fc} in round ${e.round}`,
        weight: 1.0, // will be decayed by store
      }));

      upsertMemory(store, {
        category: 'recurring_failure',
        summary: `${fc} failures recur in tasks matching "${pattern.prefix}"`,
        detail: `Failure class "${fc}" observed ${pattern.count} times across ${uniqueRuns.size} runs. Most affected task patterns: ${pattern.prefix}.`,
        evidence,
        source_run_ids: [...uniqueRuns].slice(0, 5),
        source_artifacts: ['transition_log'],
      });
    }
  }
}

// ── Repair Pattern Memories ──

function extractRepairPatternMemories(
  transitions: RunTransitionRecord[],
  cwd: string,
  store: ProjectMemoryStore,
): void {
  // Look for tasks that went from worker_failed → verified/merged
  const taskTransitions = groupByTaskId(transitions);

  for (const [taskId, records] of Object.entries(taskTransitions)) {
    const hadFailure = records.some(r => r.failure_class && r.from_state !== r.to_state);
    const eventualSuccess = records.some(r => r.to_state === 'done' || r.to_state === 'verified');

    if (hadFailure && eventualSuccess && records.length >= 3) {
      const failureClasses = [...new Set(records.map(r => r.failure_class).filter(Boolean))];
      const runIds = [...new Set(records.map(r => r.run_id))];

      // This task recovered — capture the failure class as a recoverable pattern
      for (const fc of failureClasses.slice(0, 2)) {
        const evidence: MemoryEvidence[] = records
          .filter(r => r.failure_class === fc)
          .slice(0, 3)
          .map(r => ({
            source_run_id: r.run_id,
            source_artifact: 'transition_log' as const,
            signal: `Task ${taskId}: ${r.from_state} → ${r.to_state} (failure: ${fc})`,
            weight: 1.0,
          }));

        if (evidence.length < MIN_RECURRING_COUNT) continue;

        upsertMemory(store, {
          category: 'effective_repair',
          summary: `Tasks with ${fc} failure can recover via repair/retry`,
          detail: `Task pattern "${taskId.slice(0, 30)}" experienced ${fc} but recovered. Retry/repair is effective for this failure class.`,
          evidence,
          source_run_ids: runIds.slice(0, 5),
          source_artifacts: ['transition_log'],
        });
      }
    }
  }

  // Also scan task states from latest run for verification patterns
  const runDirs = listRunDirs(cwd);
  const latestRun = runDirs.sort().pop();
  if (latestRun) {
    const taskStates = loadTaskStates(cwd, latestRun);
    extractVerificationPatternMemories(taskStates, latestRun, store);
  }
}

function extractVerificationPatternMemories(
  taskStates: Record<string, TaskRunRecord>,
  runId: string,
  store: ProjectMemoryStore,
): void {
  const failedByClass = new Map<string, TaskRunRecord[]>();
  for (const state of Object.values(taskStates)) {
    if (state.failure_class) {
      const bucket = failedByClass.get(state.failure_class) || [];
      bucket.push(state);
      failedByClass.set(state.failure_class, bucket);
    }
  }

  for (const [fc, tasks] of failedByClass.entries()) {
    if (tasks.length < MIN_RECURRING_COUNT) continue;

    const evidence: MemoryEvidence[] = tasks.slice(0, 5).map(t => ({
      source_run_id: runId,
      source_artifact: 'verification_outcome' as const,
      signal: `Task ${t.task_id}: ${t.status} (failure: ${fc})`,
      weight: 1.0,
    }));

    upsertMemory(store, {
      category: fc === 'build' || fc === 'test' ? 'risky_area' : 'recurring_failure',
      summary: `${fc} failures cluster in this run (${tasks.length} tasks)`,
      detail: `${tasks.length} tasks in run ${runId} failed with class "${fc}". This area may need extra verification or different approach.`,
      evidence,
      source_run_ids: [runId],
      source_artifacts: ['verification_outcome'],
    });
  }
}

// ── Risky Area Memories ──

function extractRiskyAreaMemories(
  transitions: RunTransitionRecord[],
  store: ProjectMemoryStore,
): void {
  // Tasks with multiple retries → potentially risky area
  const retryCounts = new Map<string, number>();
  for (const t of transitions) {
    if (t.retry_count && t.retry_count > 0 && t.task_id) {
      retryCounts.set(t.task_id, Math.max(retryCounts.get(t.task_id) || 0, t.retry_count));
    }
  }

  const highRetryTasks = [...retryCounts.entries()].filter(([, count]) => count >= 2);
  if (highRetryTasks.length >= 2) {
    // Multiple tasks needed retries — there's a systemic risk
    const evidence: MemoryEvidence[] = highRetryTasks.slice(0, 5).map(([taskId, count]) => ({
      source_run_id: transitions.find(t => t.task_id === taskId)?.run_id || 'unknown',
      source_artifact: 'transition_log' as const,
      signal: `Task ${taskId} required ${count} retries`,
      weight: 1.0,
    }));

    upsertMemory(store, {
      category: 'risky_area',
      summary: 'Multiple tasks required ≥2 retries — execution area is fragile',
      detail: `${highRetryTasks.length} tasks needed multiple retries: ${highRetryTasks.slice(0, 3).map(([id]) => id).join(', ')}. This suggests the task design or verification may be too aggressive.`,
      evidence,
      source_run_ids: [...new Set(highRetryTasks.map(([id]) =>
        transitions.find(t => t.task_id === id)?.run_id || 'unknown',
      ))],
      source_artifacts: ['transition_log'],
    });
  }
}

// ── Helpers ──

function flattenTransitions(
  logs: Record<string, RunTransitionRecord[]>,
): RunTransitionRecord[] {
  const result: RunTransitionRecord[] = [];
  for (const entries of Object.values(logs)) {
    result.push(...entries);
  }
  return result;
}

function bucketFailuresByClass(
  transitions: RunTransitionRecord[],
): Record<string, RunTransitionRecord[]> {
  const buckets: Record<string, RunTransitionRecord[]> = {};
  for (const t of transitions) {
    if (!t.failure_class) continue;
    const bucket = buckets[t.failure_class] || [];
    bucket.push(t);
    buckets[t.failure_class] = bucket;
  }
  return buckets;
}

function findTopTaskPatterns(
  entries: RunTransitionRecord[],
  limit: number,
): Array<{ prefix: string; count: number; entries: RunTransitionRecord[] }> {
  const prefixMap = new Map<string, RunTransitionRecord[]>();
  for (const entry of entries) {
    if (!entry.task_id) continue;
    const prefix = normalizeTaskPrefix(entry.task_id);
    const bucket = prefixMap.get(prefix) || [];
    bucket.push(entry);
    prefixMap.set(prefix, bucket);
  }

  return [...prefixMap.entries()]
    .map(([prefix, ents]) => ({ prefix, count: ents.length, entries: ents }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function normalizeTaskPrefix(taskId: string): string {
  const parts = taskId.split('-');
  if (parts.length >= 3) return parts.slice(0, 2).join('-');
  return parts[0] || taskId;
}

function groupByTaskId(
  transitions: RunTransitionRecord[],
): Record<string, RunTransitionRecord[]> {
  const groups: Record<string, RunTransitionRecord[]> = {};
  for (const t of transitions) {
    if (!t.task_id) continue;
    const bucket = groups[t.task_id] || [];
    bucket.push(t);
    groups[t.task_id] = bucket;
  }
  return groups;
}

function listRunDirs(cwd: string): string[] {
  const runsDir = path.join(cwd, '.ai', 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('run-'))
    .map(d => d.name);
}
