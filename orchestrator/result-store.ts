// orchestrator/result-store.ts — P1: execution result persistence + checkpoint
import fs from 'fs';
import path from 'path';
import type { WorkerResult, OrchestratorResult, PlanCheckpoint } from './types.js';

const MAX_OUTPUT_MESSAGES = 20;

function resultsDir(cwd: string, planId: string): string {
  return path.join(cwd, '.ai', 'results', planId);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Trim output messages to avoid multi-MB files */
function trimResult(result: WorkerResult): WorkerResult {
  if (result.output.length <= MAX_OUTPUT_MESSAGES) return result;
  return {
    ...result,
    output: result.output.slice(-MAX_OUTPUT_MESSAGES),
  };
}

export function saveWorkerResult(
  planId: string,
  cwd: string,
  result: WorkerResult,
): void {
  try {
    const dir = resultsDir(cwd, planId);
    ensureDir(dir);
    const filePath = path.join(dir, `${result.taskId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(trimResult(result), null, 2));
  } catch {
    // Non-critical: don't block execution
  }
}

export function saveCheckpoint(
  planId: string,
  cwd: string,
  checkpoint: PlanCheckpoint,
): void {
  try {
    const dir = resultsDir(cwd, planId);
    ensureDir(dir);
    const filePath = path.join(dir, 'checkpoint.json');
    fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2));
  } catch {
    // Non-critical
  }
}

export function loadCheckpoint(
  planId: string,
  cwd: string,
): PlanCheckpoint | null {
  try {
    const filePath = path.join(resultsDir(cwd, planId), 'checkpoint.json');
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PlanCheckpoint;
  } catch {
    return null;
  }
}

export function loadWorkerResult(
  planId: string,
  cwd: string,
  taskId: string,
): WorkerResult | null {
  try {
    const filePath = path.join(resultsDir(cwd, planId), `${taskId}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as WorkerResult;
  } catch {
    return null;
  }
}

export function saveFinalResult(
  planId: string,
  cwd: string,
  result: OrchestratorResult,
): void {
  try {
    const dir = resultsDir(cwd, planId);
    ensureDir(dir);
    // Trim worker outputs in the final dump too
    const trimmed = {
      ...result,
      worker_results: result.worker_results.map(trimResult),
    };
    const filePath = path.join(dir, 'final.json');
    fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2));
  } catch {
    // Non-critical
  }
}
