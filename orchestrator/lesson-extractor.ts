/**
 * lesson-extractor.ts — Post-run lesson extraction and discipline score updates.
 *
 * After each review, extracts structured lessons from findings and worker results.
 * Lessons feed into model-profiles (spec_adherence, scope_discipline) and persist
 * to model-lessons.json for the planner to read on future runs.
 */

import fs from 'fs';
import path from 'path';
import { resolveProjectPath } from './project-paths.js';
import { updateObservedScore, loadProfiles, saveProfiles, loadBenchmarkPolicy } from './profiler.js';
import type { SubTask, WorkerResult, ReviewResult, ReviewFinding } from './types.js';

const LESSONS_PATH = resolveProjectPath('config', 'model-lessons.json');
const MAX_LESSONS_PER_MODEL = 20;

// ── Types ──

export type FailureType =
  | 'scope_violation'
  | 'api_mismatch'
  | 'no_output'
  | 'constraint_ignored'
  | 'wrong_enum'
  | 'partial_implementation'
  | 'worker_timeout';

export interface Lesson {
  id: string;
  run_id: string;
  task_id: string;
  category: string;
  failure_type: FailureType;
  description: string;
  rule: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  created_at: string;
}

interface LessonsStore {
  schema_version: string;
  lessons: Record<string, Lesson[]>;
  rules: Record<string, string[]>;
}

// ── Failure classification ──

const SCOPE_PATTERNS = [
  /modified files? not in scope/i,
  /changed \d+ files?.*expected \d/i,
  /outside.*task scope/i,
  /unrelated.*files? changed/i,
];

const API_PATTERNS = [
  /import.*not found/i,
  /does not exist/i,
  /no module named/i,
  /wrong.*signature/i,
  /wrong.*import/i,
  /api.*mismatch/i,
  /undefined.*function/i,
];

const NO_OUTPUT_PATTERNS = [
  /no files? changed/i,
  /zero output/i,
  /no diff/i,
  /produced no.*change/i,
];

function matchPatterns(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export function classifyFailure(
  findings: ReviewFinding[],
  workerResult: WorkerResult,
  task: SubTask,
): FailureType[] {
  const types: Set<FailureType> = new Set();
  const allText = findings.map((f) => `${f.issue} ${f.decision_reason || ''}`).join(' ');

  // Worker timeout / crash detection
  if (!workerResult.success) {
    const outputText = workerResult.output?.map((o) => o.content || '').join(' ') || '';
    if (/timeout|timed out|max_turns/i.test(outputText)) {
      types.add('worker_timeout');
    }
  }

  // No output detection
  if (workerResult.success && workerResult.changedFiles.length === 0) {
    types.add('no_output');
  }
  if (matchPatterns(allText, NO_OUTPUT_PATTERNS)) {
    types.add('no_output');
  }

  // Scope violation: changed files outside estimated_files
  if (task.estimated_files.length > 0 && workerResult.changedFiles.length > 0) {
    const expected = new Set(task.estimated_files.map((f) => path.basename(f)));
    const extra = workerResult.changedFiles.filter((f) => !expected.has(path.basename(f)));
    if (extra.length > 0) {
      types.add('scope_violation');
      // If many extra files, escalate to constraint_ignored
      if (extra.length >= 3) {
        types.add('constraint_ignored');
      }
    }
  }
  if (matchPatterns(allText, SCOPE_PATTERNS)) {
    types.add('scope_violation');
  }

  // API mismatch
  if (matchPatterns(allText, API_PATTERNS)) {
    types.add('api_mismatch');
  }

  // If review failed but none of the above matched, generic partial implementation
  if (types.size === 0 && !findings.every((f) => f.severity === 'green')) {
    const hasRed = findings.some((f) => f.severity === 'red');
    if (hasRed) {
      types.add('partial_implementation');
    }
  }

  return [...types];
}

// ── Lesson extraction ──

export function extractLessons(
  taskId: string,
  runId: string,
  modelId: string,
  task: SubTask,
  workerResult: WorkerResult,
  reviewResult: ReviewResult,
): Lesson[] {
  if (reviewResult.passed && workerResult.success && workerResult.changedFiles.length > 0) {
    return []; // No lessons from fully successful tasks
  }

  const failureTypes = classifyFailure(reviewResult.findings, workerResult, task);
  if (failureTypes.length === 0) return [];

  const redFindings = reviewResult.findings.filter((f) => f.severity === 'red');
  const description = redFindings.length > 0
    ? redFindings.map((f) => f.issue).join('; ')
    : `Task ${taskId} failed with ${failureTypes.join(', ')}`;

  return failureTypes.map((ft) => ({
    id: `les-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    run_id: runId,
    task_id: taskId,
    category: task.category || 'unknown',
    failure_type: ft,
    description,
    rule: generateRule(ft, modelId),
    severity: ft === 'constraint_ignored' ? 'critical' as const
      : ft === 'no_output' ? 'high' as const
      : 'medium' as const,
    created_at: new Date().toISOString(),
  }));
}

function generateRule(ft: FailureType, _modelId: string): string {
  switch (ft) {
    case 'scope_violation':
      return 'Add explicit "ONLY modify these files: [list]" constraint to task prompt';
    case 'api_mismatch':
      return 'Include exact import statements and function signatures in task description';
    case 'no_output':
      return 'Split into smaller tasks; verify acceptance criteria are achievable';
    case 'constraint_ignored':
      return 'Add hard file-list constraint AND repeat it in acceptance criteria';
    case 'wrong_enum':
      return 'Include enum/constant values in task prompt, not just field names';
    case 'partial_implementation':
      return 'Reduce task scope or increase complexity rating';
    case 'worker_timeout':
      return 'Avoid assigning large-file edits; split into smaller targeted changes';
  }
}

// ── Score updates ──

const SCORE_PENALTIES: Record<FailureType, { key: 'spec_adherence' | 'scope_discipline'; signal: number }[]> = {
  scope_violation:        [{ key: 'scope_discipline', signal: 0.2 }],
  constraint_ignored:     [{ key: 'scope_discipline', signal: 0.0 }],
  api_mismatch:           [{ key: 'spec_adherence', signal: 0.2 }],
  no_output:              [{ key: 'spec_adherence', signal: 0.1 }],
  wrong_enum:             [{ key: 'spec_adherence', signal: 0.3 }],
  partial_implementation: [{ key: 'spec_adherence', signal: 0.4 }],
  worker_timeout:         [{ key: 'spec_adherence', signal: 0.1 }],
};

export function updateDisciplineScores(
  modelId: string,
  lessons: Lesson[],
): void {
  const policy = loadBenchmarkPolicy();
  const profiles = loadProfiles(undefined, policy);

  for (const lesson of lessons) {
    const penalties = SCORE_PENALTIES[lesson.failure_type];
    if (!penalties) continue;
    for (const { key, signal } of penalties) {
      updateObservedScore(profiles, modelId, key, signal, policy, 0.25, 1.0);
    }
  }

  saveProfiles(profiles);
}

// ── Persistence ──

function loadLessonsStore(): LessonsStore {
  if (!fs.existsSync(LESSONS_PATH)) {
    return { schema_version: '1.0', lessons: {}, rules: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(LESSONS_PATH, 'utf-8')) as LessonsStore;
  } catch {
    return { schema_version: '1.0', lessons: {}, rules: {} };
  }
}

export function persistLessons(modelId: string, newLessons: Lesson[]): void {
  if (newLessons.length === 0) return;

  const store = loadLessonsStore();
  const existing = store.lessons[modelId] || [];
  const merged = [...existing, ...newLessons];

  // Keep only the most recent N lessons per model
  store.lessons[modelId] = merged.slice(-MAX_LESSONS_PER_MODEL);

  // Auto-distill rules from recent lessons (last 10)
  const recent = store.lessons[modelId].slice(-10);
  const ruleSet = new Set(store.rules[modelId] || []);
  for (const lesson of recent) {
    if (lesson.severity === 'high' || lesson.severity === 'critical') {
      ruleSet.add(lesson.rule);
    }
  }
  store.rules[modelId] = [...ruleSet].slice(-8); // Max 8 rules per model

  const dir = path.dirname(LESSONS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(LESSONS_PATH, JSON.stringify(store, null, 2));
}

// ── Planner context builder ──

export function buildLessonContext(): string {
  const store = loadLessonsStore();
  const rules = store.rules || {};
  const lines: string[] = [];

  let hasContent = false;
  for (const [model, modelRules] of Object.entries(rules)) {
    if (Array.isArray(modelRules) && modelRules.length > 0) {
      if (!hasContent) {
        lines.push('\n## Model Constraints (learned from past runs)\n');
        hasContent = true;
      }
      lines.push(`### ${model}`);
      for (const r of modelRules) {
        lines.push(`- ${r}`);
      }
    }
  }

  return lines.join('\n');
}
