import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  buildRoundScoreSignals,
  computeRoundScore,
  loadRunScoreHistory,
  saveRoundScore,
} from '../orchestrator/score-history.js';
import type { ReviewResult, VerificationResult, WorkerResult } from '../orchestrator/types.js';

const TMP_DIR = '/tmp/hive-score-history-test';
const RUN_ID = 'run-score-123';

function resetDir(): void {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true });
  }
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function makeWorkerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    taskId: overrides.taskId || 'task-a',
    model: overrides.model || 'qwen3-max',
    worktreePath: overrides.worktreePath || '/tmp/wt-a',
    branch: overrides.branch || 'worker-task-a',
    sessionId: overrides.sessionId || 'worker-task-a',
    output: overrides.output || [],
    changedFiles: overrides.changedFiles || ['src/a.ts'],
    success: overrides.success ?? true,
    duration_ms: overrides.duration_ms ?? 1200,
    token_usage: overrides.token_usage || { input: 100, output: 50 },
    discuss_triggered: overrides.discuss_triggered ?? false,
    discuss_results: overrides.discuss_results || [],
  };
}

function makeReviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    taskId: overrides.taskId || 'task-a',
    final_stage: overrides.final_stage || 'cross-review',
    passed: overrides.passed ?? true,
    findings: overrides.findings || [],
    iterations: overrides.iterations ?? 1,
    duration_ms: overrides.duration_ms ?? 100,
    verdict: overrides.verdict,
    token_stages: overrides.token_stages,
  };
}

function makeVerificationResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    target: overrides.target || {
      type: 'build',
      label: 'npm run build',
      command: 'npm run build',
      must_pass: true,
      timeout_ms: 1000,
    },
    passed: overrides.passed ?? true,
    exit_code: overrides.exit_code ?? 0,
    stdout_tail: overrides.stdout_tail || '',
    stderr_tail: overrides.stderr_tail || '',
    duration_ms: overrides.duration_ms ?? 400,
    failure_class: overrides.failure_class,
  };
}

describe('score-history', () => {
  beforeEach(() => {
    resetDir();
  });

  afterEach(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true });
    }
  });

  it('computes score signals from round artifacts', () => {
    const signals = buildRoundScoreSignals(
      [
        makeWorkerResult(),
        makeWorkerResult({
          taskId: 'task-b',
          changedFiles: ['src/b.ts', 'src/c.ts'],
          discuss_triggered: true,
        }),
      ],
      [
        makeReviewResult(),
        makeReviewResult({ taskId: 'task-b', passed: false }),
      ],
      [
        makeVerificationResult(),
        makeVerificationResult({
          target: {
            type: 'test',
            label: 'npm test',
            command: 'npm test',
            must_pass: true,
            timeout_ms: 1000,
          },
          passed: false,
          exit_code: 1,
          failure_class: 'test_fail',
        }),
      ],
    );

    expect(signals.worker_count).toBe(2);
    expect(signals.worker_success_count).toBe(2);
    expect(signals.review_pass_count).toBe(1);
    expect(signals.verification_fail_count).toBe(1);
    expect(signals.discuss_triggered_count).toBe(1);
    expect(signals.changed_files_count).toBe(3);
    expect(signals.total_input_tokens).toBe(200);
  });

  it('persists score history and round deltas', () => {
    const round1 = saveRoundScore({
      cwd: TMP_DIR,
      runId: RUN_ID,
      goal: 'Ship score history',
      round: 1,
      action: 'execute',
      status: 'partial',
      workerResults: [makeWorkerResult()],
      reviewResults: [makeReviewResult({ passed: false })],
      verificationResults: [makeVerificationResult({ passed: false, exit_code: 1 })],
    });

    const round2 = saveRoundScore({
      cwd: TMP_DIR,
      runId: RUN_ID,
      goal: 'Ship score history',
      round: 2,
      action: 'repair_task',
      status: 'done',
      workerResults: [makeWorkerResult({ taskId: 'task-b' })],
      reviewResults: [makeReviewResult({ taskId: 'task-b', passed: true })],
      verificationResults: [makeVerificationResult({ passed: true })],
    });

    expect(round1.entry.delta_from_previous).toBeUndefined();
    expect(round2.entry.delta_from_previous).toBeGreaterThan(0);
    expect(round2.history.latest_score).toBe(round2.entry.score);
    expect(round2.history.best_score).toBe(round2.entry.score);

    const history = loadRunScoreHistory(TMP_DIR, RUN_ID);
    expect(history).not.toBeNull();
    expect(history!.rounds).toHaveLength(2);
    expect(history!.rounds[1].round).toBe(2);

    const roundFile = path.join(
      TMP_DIR,
      '.ai',
      'runs',
      RUN_ID,
      'round-02-score.json',
    );
    expect(fs.existsSync(roundFile)).toBe(true);
  });

  it('scores a perfect round at 100', () => {
    const score = computeRoundScore({
      worker_count: 2,
      worker_success_count: 2,
      review_count: 2,
      review_pass_count: 2,
      verification_count: 2,
      verification_pass_count: 2,
      verification_fail_count: 0,
      discuss_triggered_count: 0,
      changed_files_count: 4,
      total_duration_ms: 1000,
      total_input_tokens: 100,
      total_output_tokens: 100,
    });

    expect(score).toBe(100);
  });
});
