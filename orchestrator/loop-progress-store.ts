// orchestrator/loop-progress-store.ts — Persistent progress surface for run loops
// Single source of truth for all progress consumers (MCP, CLI, compact, restore).

import fs from 'fs';
import path from 'path';
import type { CollabStatusSnapshot } from './types.js';

export type LoopPhase =
  | 'planning'
  | 'discussing'
  | 'executing'
  | 'reviewing'
  | 'verifying'
  | 'repairing'
  | 'replanning'
  | 'done'
  | 'blocked'
  | 'paused';

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
  collab?: CollabStatusSnapshot;
  planner_discuss_conclusion?: {
    quality_gate: 'pass' | 'warn' | 'fail' | 'fallback';
    overall_assessment: string;
  };
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
  // Preserve existing planner_discuss_conclusion if not provided
  const existing = readLoopProgress(cwd, runId);
  const full: LoopProgress = {
    ...progress,
    updated_at: new Date().toISOString(),
    planner_discuss_conclusion: progress.planner_discuss_conclusion || existing?.planner_discuss_conclusion,
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
