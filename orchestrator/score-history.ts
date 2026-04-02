import fs from 'fs';
import path from 'path';
import type {
  NextActionKind,
  ReviewResult,
  RoundScoreEntry,
  RunScoreHistory,
  RunScoreSignals,
  RunStatus,
  VerificationResult,
  WorkerResult,
} from './types.js';

export interface SaveRoundScoreInput {
  cwd: string;
  runId: string;
  goal?: string;
  round: number;
  action: NextActionKind;
  status: RunStatus;
  workerResults: WorkerResult[];
  reviewResults: ReviewResult[];
  verificationResults: VerificationResult[];
}

function runDir(cwd: string, runId: string): string {
  return path.join(cwd, '.ai', 'runs', runId);
}

function scoreHistoryPath(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'score-history.json');
}

function roundScorePath(cwd: string, runId: string, round: number): string {
  const fileName = `round-${String(round).padStart(2, '0')}-score.json`;
  return path.join(runDir(cwd, runId), fileName);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function ratio(passed: number, total: number): number {
  if (total <= 0) return 1;
  return passed / total;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function summarizeSignals(score: number, signals: RunScoreSignals): string {
  return [
    `score ${score}`,
    `workers ${signals.worker_success_count}/${signals.worker_count}`,
    `reviews ${signals.review_pass_count}/${signals.review_count}`,
    `verification ${signals.verification_pass_count}/${signals.verification_count}`,
    `discuss ${signals.discuss_triggered_count}`,
    `changed ${signals.changed_files_count}`,
  ].join(' | ');
}

export function buildRoundScoreSignals(
  workerResults: WorkerResult[],
  reviewResults: ReviewResult[],
  verificationResults: VerificationResult[],
): RunScoreSignals {
  const changedFiles = new Set<string>();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalDurationMs = 0;
  let discussTriggeredCount = 0;

  for (const worker of workerResults) {
    totalInputTokens += worker.token_usage.input;
    totalOutputTokens += worker.token_usage.output;
    totalDurationMs += worker.duration_ms;
    if (worker.discuss_triggered) {
      discussTriggeredCount += 1;
    }
    for (const file of worker.changedFiles) {
      changedFiles.add(file);
    }
  }

  const workerSuccessCount = workerResults.filter((worker) => worker.success).length;
  const reviewPassCount = reviewResults.filter((review) => review.passed).length;
  const verificationPassCount = verificationResults.filter((result) => result.passed).length;

  return {
    worker_count: workerResults.length,
    worker_success_count: workerSuccessCount,
    review_count: reviewResults.length,
    review_pass_count: reviewPassCount,
    verification_count: verificationResults.length,
    verification_pass_count: verificationPassCount,
    verification_fail_count: Math.max(0, verificationResults.length - verificationPassCount),
    discuss_triggered_count: discussTriggeredCount,
    changed_files_count: changedFiles.size,
    total_duration_ms: totalDurationMs,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
  };
}

export function computeRoundScore(signals: RunScoreSignals): number {
  const workerRatio = ratio(signals.worker_success_count, signals.worker_count);
  const reviewRatio = ratio(signals.review_pass_count, signals.review_count);
  const verificationRatio = ratio(signals.verification_pass_count, signals.verification_count);
  return clampScore(
    workerRatio * 25
      + reviewRatio * 45
      + verificationRatio * 30,
  );
}

export function buildRoundScoreEntry(input: SaveRoundScoreInput): RoundScoreEntry {
  const signals = buildRoundScoreSignals(
    input.workerResults,
    input.reviewResults,
    input.verificationResults,
  );
  const score = computeRoundScore(signals);

  return {
    run_id: input.runId,
    round: input.round,
    action: input.action,
    status: input.status,
    created_at: new Date().toISOString(),
    score,
    summary: summarizeSignals(score, signals),
    signals,
  };
}

export function loadRunScoreHistory(
  cwd: string,
  runId: string,
): RunScoreHistory | null {
  return readJson<RunScoreHistory>(scoreHistoryPath(cwd, runId));
}

export function saveRoundScore(
  input: SaveRoundScoreInput,
): { history: RunScoreHistory; entry: RoundScoreEntry } {
  const nextEntry = buildRoundScoreEntry(input);
  const existingHistory = loadRunScoreHistory(input.cwd, input.runId);
  const previousRounds = (existingHistory?.rounds || [])
    .filter((entry) => entry.round !== input.round)
    .sort((a, b) => a.round - b.round);
  const previousEntry = previousRounds.at(-1);

  const finalEntry: RoundScoreEntry = {
    ...nextEntry,
    delta_from_previous: previousEntry
      ? nextEntry.score - previousEntry.score
      : undefined,
  };

  const rounds = [...previousRounds, finalEntry].sort((a, b) => a.round - b.round);
  const bestScore = rounds.reduce(
    (best, round) => Math.max(best, round.score),
    0,
  );
  const history: RunScoreHistory = {
    run_id: input.runId,
    goal: input.goal || existingHistory?.goal,
    updated_at: new Date().toISOString(),
    latest_score: rounds.at(-1)?.score,
    best_score: bestScore,
    rounds,
  };

  writeJson(scoreHistoryPath(input.cwd, input.runId), history);
  writeJson(roundScorePath(input.cwd, input.runId, input.round), finalEntry);

  return { history, entry: finalEntry };
}
