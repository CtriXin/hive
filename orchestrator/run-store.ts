import fs from 'fs';
import path from 'path';
import type { RunSpec, RunState, TaskPlan, OrchestratorResult } from './types.js';
import { trackRunSpec, trackRunState } from './global-run-registry.js';

function runsDir(cwd: string): string {
  return path.join(cwd, '.ai', 'runs');
}

function runDir(cwd: string, runId: string): string {
  return path.join(runsDir(cwd), runId);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function saveRunSpec(cwd: string, spec: RunSpec): void {
  writeJson(path.join(runDir(cwd, spec.id), 'spec.json'), spec);
  trackRunSpec(cwd, spec);
}

export function loadRunSpec(cwd: string, runId: string): RunSpec | null {
  return readJson<RunSpec>(path.join(runDir(cwd, runId), 'spec.json'));
}

export function saveRunState(cwd: string, state: RunState): void {
  const payload: RunState = {
    ...state,
    updated_at: new Date().toISOString(),
  };
  writeJson(path.join(runDir(cwd, state.run_id), 'state.json'), payload);
  trackRunState(cwd, payload);
}

export function loadRunState(cwd: string, runId: string): RunState | null {
  return readJson<RunState>(path.join(runDir(cwd, runId), 'state.json'));
}

export function saveRunPlan(cwd: string, runId: string, plan: TaskPlan): void {
  writeJson(path.join(runDir(cwd, runId), 'plan.json'), plan);
}

export function loadRunPlan(cwd: string, runId: string): TaskPlan | null {
  return readJson<TaskPlan>(path.join(runDir(cwd, runId), 'plan.json'));
}

export function saveRunResult(cwd: string, runId: string, result: OrchestratorResult): void {
  writeJson(path.join(runDir(cwd, runId), 'result.json'), result);
}

export function loadRunResult(cwd: string, runId: string): OrchestratorResult | null {
  return readJson<OrchestratorResult>(path.join(runDir(cwd, runId), 'result.json'));
}

export function listRuns(cwd: string): Array<{ id: string; spec: RunSpec | null; state: RunState | null }> {
  const dir = runsDir(cwd);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .map((id) => ({
      id,
      spec: loadRunSpec(cwd, id),
      state: loadRunState(cwd, id),
    }))
    .filter((item) => item.spec || item.state)
    .sort((a, b) => {
      const aTime = a.state?.updated_at || a.spec?.created_at || '';
      const bTime = b.state?.updated_at || b.spec?.created_at || '';
      return bTime.localeCompare(aTime);
    });
}
