import fs from 'fs';
import path from 'path';
import { trackWorkerSnapshot } from './global-run-registry.js';
import { syncHandoffSurfaces } from './handoff-surfaces.js';
import type {
  CollabStatusSnapshot,
  WorkerTranscriptEntry,
  WorkerStatusEntry,
  WorkerStatusEvent,
  WorkerStatusSnapshot,
  WorkerLifecycleStatus,
} from './types.js';

const MAX_LAST_MESSAGE = 240;
const MAX_TRANSCRIPT_CONTENT = 1200;
const TERMINAL_STATUSES = new Set<WorkerLifecycleStatus>(['completed', 'failed']);

export interface WorkerStatusUpdate {
  task_id: string;
  status: WorkerLifecycleStatus;
  plan_id?: string;
  goal?: string;
  round?: number;
  assigned_model?: string;
  active_model?: string;
  provider?: string;
  task_description?: string;
  session_id?: string;
  branch?: string;
  worktree_path?: string;
  discuss_triggered?: boolean;
  started_at?: string;
  finished_at?: string;
  task_summary?: string;
  last_message?: string;
  changed_files_count?: number;
  success?: boolean;
  error?: string;
  event_message?: string;
  prompt_policy_version?: string;
  prompt_fragments?: WorkerStatusEntry['prompt_fragments'];
  execution_contract?: WorkerStatusEntry['execution_contract'];
  provider_failure_subtype?: WorkerStatusEntry['provider_failure_subtype'];
  provider_fallback_used?: WorkerStatusEntry['provider_fallback_used'];
  collab?: CollabStatusSnapshot;
  discuss_conclusion?: {
    quality_gate: 'pass' | 'warn' | 'fail' | 'fallback';
    conclusion: string;
  };
}

function runsDir(cwd: string): string {
  return path.join(cwd, '.ai', 'runs');
}

function runDir(cwd: string, runId: string): string {
  return path.join(runsDir(cwd), runId);
}

function snapshotPath(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'worker-status.json');
}

function eventsPath(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'worker-events.jsonl');
}

function transcriptsDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'workers');
}

function safeTaskId(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function transcriptFileName(taskId: string): string {
  return `${safeTaskId(taskId)}.transcript.jsonl`;
}

function transcriptPath(cwd: string, runId: string, taskId: string): string {
  return path.join(transcriptsDir(cwd, runId), transcriptFileName(taskId));
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimMessage(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (!singleLine) return undefined;
  if (singleLine.length <= MAX_LAST_MESSAGE) return singleLine;
  return `${singleLine.slice(0, MAX_LAST_MESSAGE - 3)}...`;
}

function trimTranscriptContent(text: string): string {
  const normalized = text.trim();
  if (!normalized) return '';
  if (normalized.length <= MAX_TRANSCRIPT_CONTENT) return normalized;
  return `${normalized.slice(0, MAX_TRANSCRIPT_CONTENT - 3)}...`;
}

function cloneCollabSnapshot(
  snapshot: CollabStatusSnapshot | undefined,
): CollabStatusSnapshot | undefined {
  if (!snapshot) return undefined;
  return {
    card: { ...snapshot.card },
    recent_events: snapshot.recent_events.map((event) => ({ ...event })),
  };
}

export function buildWorkerAgentId(runId: string, taskId: string): string {
  return `${taskId}@${runId}`;
}

export function buildWorkerTranscriptPath(runId: string, taskId: string): string {
  return path.join('.ai', 'runs', runId, 'workers', transcriptFileName(taskId));
}

function workerMatchesSelector(
  worker: WorkerStatusEntry,
  selector: string,
): boolean {
  return worker.task_id === selector
    || worker.agent_id === selector
    || worker.session_id === selector;
}

function defaultSnapshot(runId: string, planId: string): WorkerStatusSnapshot {
  return {
    run_id: runId,
    plan_id: planId,
    round: 0,
    updated_at: nowIso(),
    workers: [],
  };
}

function writeSnapshot(cwd: string, runId: string, snapshot: WorkerStatusSnapshot): void {
  const filePath = snapshotPath(cwd, runId);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
}

function appendEvent(cwd: string, runId: string, event: WorkerStatusEvent): void {
  const filePath = eventsPath(cwd, runId);
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`);
}

export function loadWorkerStatusSnapshot(
  cwd: string,
  runId: string,
): WorkerStatusSnapshot | null {
  try {
    const filePath = snapshotPath(cwd, runId);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as WorkerStatusSnapshot;
  } catch {
    return null;
  }
}

export function findWorkerStatusEntry(
  snapshot: WorkerStatusSnapshot | null,
  selector: string,
): WorkerStatusEntry | null {
  if (!snapshot) return null;
  return snapshot.workers.find((worker) => workerMatchesSelector(worker, selector)) || null;
}

export function listWorkerStatusSnapshots(
  cwd: string,
): WorkerStatusSnapshot[] {
  const dir = runsDir(cwd);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .map((runId) => {
      const snapshot = loadWorkerStatusSnapshot(cwd, runId);
      const filePath = snapshotPath(cwd, runId);
      const mtimeMs = fs.existsSync(filePath)
        ? fs.statSync(filePath).mtimeMs
        : 0;
      return snapshot ? { snapshot, mtimeMs } : null;
    })
    .filter((entry): entry is { snapshot: WorkerStatusSnapshot; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.snapshot.updated_at.localeCompare(a.snapshot.updated_at))
    .map((entry) => entry.snapshot);
}

export function loadWorkerEvents(
  cwd: string,
  runId: string,
): WorkerStatusEvent[] {
  try {
    const filePath = eventsPath(cwd, runId);
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WorkerStatusEvent);
  } catch {
    return [];
  }
}

export function appendWorkerTranscriptEntry(
  cwd: string,
  runId: string,
  entry: {
    task_id: string;
    plan_id?: string;
    session_id?: string;
    type: WorkerTranscriptEntry['type'];
    content: string;
  },
): void {
  try {
    const content = trimTranscriptContent(entry.content);
    if (!content) return;

    const filePath = transcriptPath(cwd, runId, entry.task_id);
    ensureDir(path.dirname(filePath));
    const payload: WorkerTranscriptEntry = {
      run_id: runId,
      plan_id: entry.plan_id || runId,
      task_id: entry.task_id,
      agent_id: buildWorkerAgentId(runId, entry.task_id),
      session_id: entry.session_id,
      type: entry.type,
      timestamp: nowIso(),
      content,
    };
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
  } catch {
    // Non-critical artifact
  }
}

export function loadWorkerTranscript(
  cwd: string,
  runId: string,
  selector: string,
): WorkerTranscriptEntry[] {
  try {
    const snapshot = loadWorkerStatusSnapshot(cwd, runId);
    const worker = findWorkerStatusEntry(snapshot, selector);
    const taskId = worker?.task_id || selector;
    const filePath = transcriptPath(cwd, runId, taskId);
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WorkerTranscriptEntry);
  } catch {
    return [];
  }
}

export function updateWorkerStatus(
  cwd: string,
  runId: string,
  update: WorkerStatusUpdate,
): WorkerStatusSnapshot {
  const timestamp = nowIso();
  const planId = update.plan_id || runId;
  const snapshot = loadWorkerStatusSnapshot(cwd, runId) || defaultSnapshot(runId, planId);
  const workers = [...snapshot.workers];
  const index = workers.findIndex((worker) => worker.task_id === update.task_id);
  const previous = index >= 0 ? workers[index] : null;

  const startedAt = update.started_at
    || previous?.started_at
    || (update.status === 'starting' || update.status === 'running' || update.status === 'discussing'
      ? timestamp
      : undefined);
  const shouldClearError = update.success === true || update.status === 'completed';

  const nextEntry: WorkerStatusEntry = {
    task_id: update.task_id,
    status: update.status,
    assigned_model: update.assigned_model || previous?.assigned_model || update.active_model || 'unknown',
    active_model: update.active_model || previous?.active_model || update.assigned_model || 'unknown',
    provider: update.provider || previous?.provider || 'unknown',
    agent_id: previous?.agent_id || buildWorkerAgentId(runId, update.task_id),
    task_description: update.task_description || previous?.task_description,
    session_id: update.session_id || previous?.session_id,
    branch: update.branch || previous?.branch,
    worktree_path: update.worktree_path || previous?.worktree_path,
    discuss_triggered: update.discuss_triggered ?? previous?.discuss_triggered ?? false,
    started_at: startedAt,
    finished_at: update.finished_at
      || previous?.finished_at
      || (TERMINAL_STATUSES.has(update.status) ? timestamp : undefined),
    updated_at: timestamp,
    task_summary: trimMessage(update.task_summary)
      || previous?.task_summary
      || trimMessage(update.last_message || update.event_message)
      || trimMessage(update.task_description),
    last_message: trimMessage(update.last_message) || previous?.last_message,
    changed_files_count: update.changed_files_count ?? previous?.changed_files_count,
    success: update.success ?? previous?.success,
    error: update.error !== undefined
      ? update.error
      : shouldClearError
        ? undefined
        : previous?.error,
    prompt_policy_version: update.prompt_policy_version || previous?.prompt_policy_version,
    prompt_fragments: update.prompt_fragments || previous?.prompt_fragments,
    execution_contract: update.execution_contract || previous?.execution_contract,
    provider_failure_subtype: update.provider_failure_subtype || previous?.provider_failure_subtype,
    provider_fallback_used: update.provider_fallback_used ?? previous?.provider_fallback_used,
    transcript_path: previous?.transcript_path || buildWorkerTranscriptPath(runId, update.task_id),
    collab: cloneCollabSnapshot(update.collab) || cloneCollabSnapshot(previous?.collab),
    discuss_conclusion: update.discuss_conclusion || previous?.discuss_conclusion,
  };

  if (index >= 0) {
    workers[index] = nextEntry;
  } else {
    workers.push(nextEntry);
  }

  const nextSnapshot: WorkerStatusSnapshot = {
    ...snapshot,
    plan_id: update.plan_id || snapshot.plan_id || planId,
    goal: update.goal || snapshot.goal,
    round: update.round ?? snapshot.round,
    updated_at: timestamp,
    workers: workers.sort((a, b) => a.task_id.localeCompare(b.task_id)),
  };

  writeSnapshot(cwd, runId, nextSnapshot);
  trackWorkerSnapshot(cwd, nextSnapshot);

  const shouldLogEvent = previous?.status !== update.status
    || Boolean(update.event_message)
    || Boolean(update.error);

  if (shouldLogEvent) {
    appendEvent(cwd, runId, {
      run_id: runId,
      plan_id: nextSnapshot.plan_id,
      round: nextSnapshot.round,
      task_id: update.task_id,
      agent_id: nextEntry.agent_id,
      status: update.status,
      timestamp,
      message: update.event_message || update.error,
      active_model: nextEntry.active_model,
      provider: nextEntry.provider,
      transcript_path: nextEntry.transcript_path,
    });
  }

  syncHandoffSurfaces(cwd, runId);

  return nextSnapshot;
}

export function summarizeWorkerSnapshot(snapshot: WorkerStatusSnapshot): {
  total: number;
  queued: number;
  active: number;
  completed: number;
  failed: number;
} {
  const counts = {
    total: snapshot.workers.length,
    queued: 0,
    active: 0,
    completed: 0,
    failed: 0,
  };

  for (const worker of snapshot.workers) {
    if (worker.status === 'queued') counts.queued += 1;
    if (worker.status === 'starting' || worker.status === 'running' || worker.status === 'discussing') {
      counts.active += 1;
    }
    if (worker.status === 'completed') counts.completed += 1;
    if (worker.status === 'failed') counts.failed += 1;
  }

  return counts;
}
