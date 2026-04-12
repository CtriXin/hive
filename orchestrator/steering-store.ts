// ═══════════════════════════════════════════════════════════════════
// orchestrator/steering-store.ts — Phase 8B: Human Steering Store
// ═══════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import type { SteeringAction, SteeringActionStatus } from './types.js';

const STORE_FILE = 'steering.json';

function storePath(cwd: string, runId: string): string {
  return path.join(cwd, '.ai', 'runs', runId, STORE_FILE);
}

function ensureDir(cwd: string, runId: string): void {
  const dir = path.join(cwd, '.ai', 'runs', runId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export interface SteeringStore {
  run_id: string;
  actions: SteeringAction[];
  updated_at: string;
}

function generateActionId(): string {
  return `steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function loadSteeringStore(cwd: string, runId: string): SteeringStore | null {
  const p = storePath(cwd, runId);
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as SteeringStore;
  } catch {
    return null;
  }
}

export function saveSteeringStore(cwd: string, runId: string, store: SteeringStore): void {
  ensureDir(cwd, runId);
  store.updated_at = new Date().toISOString();
  fs.writeFileSync(storePath(cwd, runId), JSON.stringify(store, null, 2), 'utf-8');
}

export function initSteeringStore(cwd: string, runId: string): SteeringStore {
  const existing = loadSteeringStore(cwd, runId);
  if (existing) return existing;
  return { run_id: runId, actions: [], updated_at: new Date().toISOString() };
}

/**
 * Submit a new steering action. Returns the action with generated ID.
 * Does NOT validate — validation happens at apply time.
 */
export function submitSteeringAction(
  cwd: string,
  runId: string,
  action: Omit<SteeringAction, 'action_id' | 'status' | 'requested_at'>,
): SteeringAction {
  const store = initSteeringStore(cwd, runId);
  const newAction: SteeringAction = {
    ...action,
    action_id: generateActionId(),
    status: 'pending',
    requested_at: new Date().toISOString(),
  };
  store.actions.push(newAction);
  saveSteeringStore(cwd, runId, store);
  return newAction;
}

/** Get all actions for a run */
export function getSteeringActions(cwd: string, runId: string): SteeringAction[] {
  return loadSteeringStore(cwd, runId)?.actions ?? [];
}

/** Get pending actions only */
export function getPendingSteeringActions(cwd: string, runId: string): SteeringAction[] {
  return getSteeringActions(cwd, runId).filter((a) => a.status === 'pending');
}

/** Mark an action as applied/rejected/suppressed/expired */
export function updateSteeringStatus(
  cwd: string,
  runId: string,
  actionId: string,
  status: SteeringActionStatus,
  outcome?: string,
): boolean {
  const store = loadSteeringStore(cwd, runId);
  if (!store) return false;
  const action = store.actions.find((a) => a.action_id === actionId);
  if (!action) return false;
  action.status = status;
  action.applied_at = Date.now();
  if (outcome) action.outcome = outcome;
  saveSteeringStore(cwd, runId, store);
  return true;
}

/** Check for duplicate actions (same type + same task_id within recent window) */
export function isDuplicateAction(
  cwd: string,
  runId: string,
  actionType: string,
  taskId?: string,
  windowMs = 30_000,
  excludeActionId?: string,
): boolean {
  const store = loadSteeringStore(cwd, runId);
  if (!store) return false;
  const now = Date.now();
  return store.actions.some((a) => {
    if (excludeActionId && a.action_id === excludeActionId) return false;
    if (a.action_type !== actionType) return false;
    if (taskId && a.task_id !== taskId) return false;
    if (!taskId && a.task_id) return false;
    const age = now - new Date(a.requested_at).getTime();
    return age < windowMs;
  });
}
