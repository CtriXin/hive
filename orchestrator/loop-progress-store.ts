// orchestrator/loop-progress-store.ts — Persistent progress surface for run loops
// Single source of truth for all progress consumers (MCP, CLI, compact, restore).

import fs from 'fs';
import path from 'path';

export type LoopPhase =
  | 'planning'
  | 'discussing'
  | 'executing'
  | 'reviewing'
  | 'verifying'
  | 'repairing'
  | 'replanning'
  | 'done'
  | 'blocked';

export interface LoopProgress {
  run_id: string;
  round: number;
  phase: LoopPhase;
  reason: string;
  focus_task_id?: string;
  focus_agent_id?: string;
  focus_summary?: string;
  focus_model?: string;
  transcript_path?: string;
  planner_model?: string;
  updated_at: string;
}

function progressPath(cwd: string, runId: string): string {
  return path.join(cwd, '.ai', 'runs', runId, 'loop-progress.json');
}

export function writeLoopProgress(
  cwd: string,
  runId: string,
  progress: Omit<LoopProgress, 'updated_at'>,
): void {
  const filePath = progressPath(cwd, runId);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const full: LoopProgress = {
    ...progress,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(full, null, 2));
}

export function readLoopProgress(
  cwd: string,
  runId: string,
): LoopProgress | null {
  const filePath = progressPath(cwd, runId);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as LoopProgress;
  } catch {
    return null;
  }
}
