// ═══════════════════════════════════════════════════════════════════
// orchestrator/forensics-pack.ts — Phase 3A: Forensics Pack
// ═══════════════════════════════════════════════════════════════════
/**
 * Compact forensic pack for failed tasks.
 * Enables rapid diagnosis without replaying execution.
 *
 * Each forensic pack contains:
 * - task_id, run_id, final status
 * - failure_class (from Phase 2A classifier)
 * - transition tail (last 5 state changes)
 * - prompt/context pointers
 * - verification summary
 * - review finding summary
 * - retry_count / terminal_reason
 * - generated_at timestamp
 */

import fs from 'fs';
import path from 'path';
import type {
  FailureClass,
  TaskStateRecord,
  TaskRunStatus,
  RunTransitionRecord,
  ReviewResult,
  VerificationResult,
  WorkerResult,
} from './types.js';
import { loadTransitionLog, getTaskTransitions } from './run-transition-log.js';

export interface ForensicsPack {
  /** Task identifier */
  task_id: string;
  /** Run identifier */
  run_id: string;
  /** Final task status */
  final_status: TaskRunStatus;
  /** Phase 2A failure classification */
  failure_class: FailureClass | 'unknown';
  /** Why task entered terminal state */
  terminal_reason?: string;
  /** Number of repair attempts */
  retry_count: number;
  /** Last 5 state transitions for this task */
  transition_tail: RunTransitionRecord[];
  /** Pointer to context pack */
  context_pack_path?: string;
  /** Pointer to worker transcript */
  transcript_path?: string;
  /** Pointer to injected prompt */
  prompt_path?: string;
  /** Verification summary (if applicable) */
  verification_summary?: VerificationSummary;
  /** Review findings summary (if applicable) */
  review_summary?: ReviewSummary;
  /** Worker execution summary */
  worker_summary?: WorkerSummary;
  /** When this forensic pack was generated */
  generated_at: string;
}

export interface VerificationSummary {
  /** Did task-scoped smoke check pass? */
  smoke_passed?: boolean;
  /** Suite verification results count */
  total_checks: number;
  /** Failed checks count */
  failed_checks: number;
  /** Last failure message */
  last_failure?: string;
  /** Failure types encountered */
  failureTypes: string[];
}

export interface ReviewSummary {
  /** Did review pass? */
  passed: boolean;
  /** Highest review stage reached */
  final_stage: string;
  /** Number of findings */
  findings_count: number;
  /** Red/yellow/green counts */
  red_count: number;
  yellow_count: number;
  green_count: number;
  /** Top 3 issues */
  top_issues: string[];
}

export interface WorkerSummary {
  /** Did worker report success? */
  success: boolean;
  /** Number of changed files */
  changed_files_count: number;
  /** Files that were changed */
  changed_files: string[];
  /** Worker model used */
  model: string;
  /** Duration in ms */
  duration_ms: number;
  /** Token usage */
  token_usage?: { input: number; output: number };
  /** Last error message */
  last_error?: string;
}

/**
 * Get forensics directory path for a run
 */
export function getForensicsDir(cwd: string, runId: string): string {
  return path.join(cwd, '.ai', 'runs', runId, 'forensics');
}

/**
 * Get forensic pack path for a task
 */
export function getForensicPackPath(
  cwd: string,
  runId: string,
  taskId: string,
): string {
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return path.join(getForensicsDir(cwd, runId), `${safeTaskId}.json`);
}

/**
 * Ensure forensics directory exists
 */
function ensureForensicsDir(cwd: string, runId: string): void {
  const dir = getForensicsDir(cwd, runId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Build verification summary from results
 */
function buildVerificationSummary(
  results: VerificationResult[],
): VerificationSummary | undefined {
  if (!results || results.length === 0) return undefined;

  const failed = results.filter((r) => !r.passed);
  const failureTypes = [...new Set(failed.map((r) => r.failure_class || 'unknown'))];

  return {
    smoke_passed: undefined, // Will be set by caller from _smokeResults
    total_checks: results.length,
    failed_checks: failed.length,
    last_failure: failed[0]?.stderr_tail?.slice(0, 200),
    failureTypes,
  };
}

/**
 * Build review summary from review result
 */
function buildReviewSummary(review: ReviewResult): ReviewSummary {
  const redCount = review.findings.filter((f) => f.severity === 'red').length;
  const yellowCount = review.findings.filter((f) => f.severity === 'yellow').length;
  const greenCount = review.findings.filter((f) => f.severity === 'green').length;
  const topIssues = review.findings
    .filter((f) => f.severity === 'red' || f.severity === 'yellow')
    .slice(0, 3)
    .map((f) => `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.issue}`);

  return {
    passed: review.passed,
    final_stage: review.final_stage,
    findings_count: review.findings.length,
    red_count: redCount,
    yellow_count: yellowCount,
    green_count: greenCount,
    top_issues: topIssues,
  };
}

/**
 * Build worker summary from worker result
 */
function buildWorkerSummary(worker: WorkerResult): WorkerSummary {
  const error = worker.output.find((msg) => msg.type === 'error')?.content;

  return {
    success: worker.success,
    changed_files_count: worker.changedFiles.length,
    changed_files: worker.changedFiles,
    model: worker.model,
    duration_ms: worker.duration_ms,
    token_usage: worker.token_usage,
    last_error: error || worker.success ? undefined : 'Worker failed without specific error',
  };
}

/**
 * Get last N transitions for a task
 */
function getTransitionTail(
  transitions: RunTransitionRecord[],
  taskId: string,
  limit = 5,
): RunTransitionRecord[] {
  return getTaskTransitions(transitions, taskId)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit)
    .reverse();
}

/**
 * Build forensic pack for a failed task
 */
export function buildForensicsPack(
  cwd: string,
  runId: string,
  taskId: string,
  taskState: TaskStateRecord,
  worker?: WorkerResult,
  review?: ReviewResult,
  verificationResults?: VerificationResult[],
  smokePassed?: boolean,
): ForensicsPack {
  const transitions = loadTransitionLog(cwd, runId);
  const transitionTail = getTransitionTail(transitions, taskId);
  const verificationSummary = verificationResults
    ? buildVerificationSummary(verificationResults)
    : undefined;

  if (verificationSummary && smokePassed !== undefined) {
    verificationSummary.smoke_passed = smokePassed;
  }

  const reviewSummary = review ? buildReviewSummary(review) : undefined;
  const workerSummary = worker ? buildWorkerSummary(worker) : undefined;

  // Build context pack path pointer
  const contextPackPath = path.join(
    '.ai',
    'runs',
    runId,
    'context-packs',
    `context-pack-${taskId.replace(/[^a-zA-Z0-9._-]+/g, '-')}-r${taskState.round}.json`,
  );

  // Build transcript path pointer
  const transcriptPath = worker?.worktreePath
    ? path.join('.ai', 'runs', runId, 'workers', `${taskId.replace(/[^a-zA-Z0-9._-]+/g, '-')}.transcript.jsonl`)
    : undefined;

  return {
    task_id: taskId,
    run_id: runId,
    final_status: taskState.status,
    failure_class: taskState.failure_class || 'unknown',
    terminal_reason: taskState.terminal_reason,
    retry_count: taskState.retry_count,
    transition_tail: transitionTail,
    context_pack_path: contextPackPath,
    transcript_path: transcriptPath,
    verification_summary: verificationSummary,
    review_summary: reviewSummary,
    worker_summary: workerSummary,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Save forensic pack to disk
 */
export function saveForensicsPack(
  cwd: string,
  runId: string,
  pack: ForensicsPack,
): string {
  ensureForensicsDir(cwd, runId);
  const filePath = getForensicPackPath(cwd, runId, pack.task_id);
  fs.writeFileSync(filePath, JSON.stringify(pack, null, 2), 'utf-8');
  return filePath;
}

/**
 * Load forensic pack from disk
 */
export function loadForensicsPack(
  cwd: string,
  runId: string,
  taskId: string,
): ForensicsPack | null {
  const filePath = getForensicPackPath(cwd, runId, taskId);
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as ForensicsPack;
  } catch {
    return null;
  }
}

/**
 * List all forensic packs for a run
 */
export function listForensicsPacks(
  cwd: string,
  runId: string,
): ForensicsPack[] {
  const dir = getForensicsDir(cwd, runId);
  if (!fs.existsSync(dir)) return [];

  const packs: ForensicsPack[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(dir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      packs.push(JSON.parse(content) as ForensicsPack);
    } catch {
      // Skip corrupted files
    }
  }

  return packs.sort((a, b) => a.task_id.localeCompare(b.task_id));
}

/**
 * Summarize forensic packs for quick inspection
 */
export function summarizeForensics(packs: ForensicsPack[]): string {
  if (packs.length === 0) return 'No forensic packs available';

  const lines: string[] = [];
  lines.push(`Forensics Summary (${packs.length} failed tasks):\n`);

  for (const pack of packs) {
    lines.push(`## ${pack.task_id}`);
    lines.push(`- Status: ${pack.final_status}`);
    lines.push(`- Failure Class: ${pack.failure_class}`);
    lines.push(`- Retry Count: ${pack.retry_count}`);
    if (pack.terminal_reason) {
      lines.push(`- Terminal Reason: ${pack.terminal_reason}`);
    }
    if (pack.worker_summary) {
      lines.push(`- Worker: ${pack.worker_summary.success ? '✅' : '❌'} ${pack.worker_summary.changed_files_count} files`);
    }
    if (pack.review_summary) {
      lines.push(`- Review: ${pack.review_summary.passed ? '✅' : '❌'} ${pack.review_summary.red_count} red, ${pack.review_summary.yellow_count} yellow`);
      if (pack.review_summary.top_issues.length > 0) {
        lines.push(`- Top Issues: ${pack.review_summary.top_issues.slice(0, 2).join('; ')}`);
      }
    }
    if (pack.verification_summary) {
      lines.push(`- Verification: ${pack.verification_summary.failed_checks}/${pack.verification_summary.total_checks} failed`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate forensic packs for all failed tasks in a run
 */
export function generateForensicsForFailedTasks(
  cwd: string,
  runId: string,
  taskStates: Record<string, TaskStateRecord>,
  workerResults: WorkerResult[],
  reviewResults: ReviewResult[],
  taskVerificationResults: Record<string, VerificationResult[]>,
  smokeResults?: Record<string, boolean>,
): ForensicsPack[] {
  const packs: ForensicsPack[] = [];
  const workerByTaskId = new Map(workerResults.map((w) => [w.taskId, w]));
  const reviewByTaskId = new Map(reviewResults.map((r) => [r.taskId, r]));

  for (const [taskId, taskState] of Object.entries(taskStates)) {
    // Only generate forensics for failed terminal states
    const isFailed = [
      'worker_failed',
      'no_op',
      'review_failed',
      'verification_failed',
      'merge_blocked',
    ].includes(taskState.status);

    if (!isFailed) continue;

    const worker = workerByTaskId.get(taskId);
    const review = reviewByTaskId.get(taskId);
    const verificationResults = taskVerificationResults[taskId];
    const smokePassed = smokeResults?.[taskId];

    const pack = buildForensicsPack(
      cwd,
      runId,
      taskId,
      taskState,
      worker,
      review,
      verificationResults,
      smokePassed,
    );

    saveForensicsPack(cwd, runId, pack);
    packs.push(pack);
  }

  return packs;
}
