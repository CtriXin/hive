import fs from 'fs';
import path from 'path';
import type {
  MindkeeperRoomRef,
  OrchestratorResult,
  RunScoreHistory,
  RunSpec,
  RunState,
  TaskPlan,
  WorkerStatusSnapshot,
} from './types.js';
import type { LoopProgress } from './loop-progress-store.js';
import { collectMindkeeperRoomRefs, formatMindkeeperRoomRef } from './memory-linkage.js';
import { loadRunPlan, loadRunResult, loadRunSpec, loadRunState, listRuns } from './run-store.js';
import { loadRunScoreHistory } from './score-history.js';
import { readLoopProgress } from './loop-progress-store.js';
import { listWorkerStatusSnapshots, loadWorkerStatusSnapshot, summarizeWorkerSnapshot } from './worker-status-store.js';

interface MindkeeperCheckpointPayload {
  repo: string;
  task: string;
  branch?: string;
  parent?: string;
  cli: string;
  model: string;
  decisions: string[];
  changes: string[];
  findings: string[];
  next: string[];
  status: string;
  room_refs?: MindkeeperRoomRef[];
}

interface MindkeeperBootstrapArtifact {
  activeThread?: {
    id: string;
    task: string;
    status: string;
    nextSteps?: string[];
    decisions?: string[];
  };
  otherThreads?: Array<{
    id: string;
    task: string;
    status: string;
  }>;
}

interface MindkeeperCheckpointResult {
  success: boolean;
  threadId?: string;
  path?: string;
  parent?: string;
  room_refs?: MindkeeperRoomRef[];
}

export interface HiveShellDashboardData {
  runId: string;
  cwd: string;
  spec: RunSpec | null;
  state: RunState | null;
  loopProgress: LoopProgress | null;
  plan: TaskPlan | null;
  result: OrchestratorResult | null;
  workerSnapshot: WorkerStatusSnapshot | null;
  scoreHistory: RunScoreHistory | null;
  mindkeeperBootstrap: MindkeeperBootstrapArtifact | null;
  mindkeeperCheckpointInput: MindkeeperCheckpointPayload | null;
  mindkeeperCheckpointResult: MindkeeperCheckpointResult | null;
}

function runDir(cwd: string, runId: string): string {
  return path.join(cwd, '.ai', 'runs', runId);
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readLines(filePath: string, limit: number): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function truncate(text: string | undefined, limit: number): string {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '-';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function repeat(char: string, count: number): string {
  return Array.from({ length: Math.max(0, count) }, () => char).join('');
}

function section(title: string, lines: string[]): string {
  return [
    `== ${title} ==`,
    ...lines,
  ].join('\n');
}

function renderScoreTrend(history: RunScoreHistory | null): string[] {
  if (!history || history.rounds.length === 0) {
    return ['- no score history yet'];
  }

  return history.rounds.map((round) => {
    const filled = Math.max(1, Math.round(round.score / 5));
    const bar = `${repeat('#', filled)}${repeat('.', 20 - filled)}`;
    const delta = typeof round.delta_from_previous === 'number'
      ? `${round.delta_from_previous > 0 ? '+' : ''}${round.delta_from_previous}`
      : 'new';
    return `- r${round.round} ${bar} ${String(round.score).padStart(3, ' ')} (${delta}) ${round.status}`;
  });
}

function renderWorkers(snapshot: WorkerStatusSnapshot | null, limit = 8): string[] {
  if (!snapshot || snapshot.workers.length === 0) {
    return ['- no worker snapshot yet'];
  }

  return snapshot.workers.slice(0, limit).map((worker) => {
    const model = worker.assigned_model === worker.active_model
      ? worker.active_model
      : `${worker.assigned_model} -> ${worker.active_model}`;
    const changeText = typeof worker.changed_files_count === 'number'
      ? ` changed=${worker.changed_files_count}`
      : '';
    const discussText = worker.discuss_triggered ? ' discuss=yes' : '';
    return `- ${worker.task_id} [${worker.status}] ${model}${changeText}${discussText} | ${truncate(worker.last_message, 90)}`;
  });
}

function renderMindkeeper(data: HiveShellDashboardData): string[] {
  const lines: string[] = [];
  const roomRefs = collectMindkeeperRoomRefs({
    loopProgress: data.loopProgress,
    workerSnapshot: data.workerSnapshot,
    checkpointInputRoomRefs: data.mindkeeperCheckpointInput?.room_refs,
    checkpointResultRoomRefs: data.mindkeeperCheckpointResult?.room_refs,
  });
  const activeThread = data.mindkeeperBootstrap?.activeThread;
  if (activeThread) {
    lines.push(`- thread: ${activeThread.id}`);
    lines.push(`- previous: ${truncate(activeThread.task, 96)}`);
    lines.push(`- status: ${truncate(activeThread.status, 96)}`);
    for (const step of activeThread.nextSteps?.slice(0, 3) || []) {
      lines.push(`- next: ${truncate(step, 96)}`);
    }
  }

  if (data.mindkeeperCheckpointResult?.threadId) {
    lines.push(`- checkpoint: ${data.mindkeeperCheckpointResult.threadId}`);
  }

  if (data.mindkeeperCheckpointInput?.next?.length) {
    for (const next of data.mindkeeperCheckpointInput.next.slice(0, 2)) {
      lines.push(`- carry: ${truncate(next, 96)}`);
    }
  }

  if (roomRefs.length > 0) {
    lines.push(`- linked rooms: ${roomRefs.length}`);
    for (const ref of roomRefs.slice(0, 4)) {
      lines.push(`- room link: ${truncate(formatMindkeeperRoomRef(ref), 96)}`);
    }
  }

  return lines.length > 0 ? lines : ['- mindkeeper artifacts not found'];
}

function renderOverview(data: HiveShellDashboardData): string[] {
  const spec = data.spec;
  const state = data.state;
  const progress = data.loopProgress;
  const score = data.scoreHistory?.rounds.at(-1);
  const workers = data.workerSnapshot ? summarizeWorkerSnapshot(data.workerSnapshot) : null;

  return [
    `- run: ${data.runId}`,
    `- goal: ${truncate(spec?.goal, 110)}`,
    `- status: ${state?.status || 'unknown'}`,
    `- round: ${state?.round ?? 0}${spec ? ` / ${spec.max_rounds}` : ''}`,
    `- phase: ${progress ? `${progress.phase} | ${truncate(progress.reason, 96)}` : 'n/a'}`,
    `- next: ${state?.next_action ? `${state.next_action.kind} - ${truncate(state.next_action.reason, 90)}` : '-'}`,
    `- summary: ${truncate(state?.final_summary, 110)}`,
    `- score: ${score ? `${score.score} (best ${data.scoreHistory?.best_score ?? score.score})` : 'n/a'}`,
    `- workers: ${workers ? `${workers.total} total / ${workers.active} active / ${workers.completed} completed / ${workers.failed} failed` : 'n/a'}`,
  ];
}

function renderCollab(data: HiveShellDashboardData): string[] {
  const card = data.loopProgress?.collab?.card;
  const events = data.loopProgress?.collab?.recent_events || [];
  const workerCards = (data.workerSnapshot?.workers || [])
    .filter((worker) => worker.collab?.card)
    .filter((worker) => worker.collab!.card.room_id !== card?.room_id)
    .slice(0, 3);
  if (!card && workerCards.length === 0) {
    return ['- no collaboration snapshot yet'];
  }

  const lines: string[] = [];

  if (card) {
    lines.push(
      `- room: ${card.room_id} [${card.status}]`,
      `- replies: ${card.replies}`,
      `- next: ${truncate(card.next, 96)}`,
    );
  }

  if (card?.last_reply_at) {
    lines.push(`- last reply: ${card.last_reply_at}`);
  }
  if (card?.join_hint) {
    lines.push(`- join: ${truncate(card.join_hint, 96)}`);
  }
  for (const event of events.slice(-4)) {
    lines.push(`- event: ${event.at} ${event.type}${typeof event.reply_count === 'number' ? ` (#${event.reply_count})` : ''}${event.note ? ` | ${truncate(event.note, 72)}` : ''}`);
  }
  for (const worker of workerCards) {
    const workerCard = worker.collab!.card;
    lines.push(`- task collab: ${worker.task_id} -> ${workerCard.room_id} [${workerCard.status}] replies=${workerCard.replies}`);
    lines.push(`- task next: ${truncate(workerCard.next, 96)}`);
  }

  return lines;
}

function renderArtifacts(cwd: string, runId: string): string[] {
  const dir = runDir(cwd, runId);
  const files = [
    'worker-status.json',
    'worker-events.jsonl',
    'score-history.json',
    'mindkeeper-bootstrap.json',
    'mindkeeper-checkpoint-input.json',
    'mindkeeper-checkpoint-result.json',
  ];

  return files
    .filter((file) => fs.existsSync(path.join(dir, file)))
    .map((file) => `- ${path.join(dir, file)}`);
}

function renderRecentEvents(cwd: string, runId: string, limit = 5): string[] {
  const eventsFile = path.join(runDir(cwd, runId), 'worker-events.jsonl');
  const rawLines = readLines(eventsFile, 200);
  if (rawLines.length === 0) {
    return ['- no worker events yet'];
  }

  return rawLines
    .slice(-limit)
    .map((line) => {
      const parsed = JSON.parse(line) as {
        timestamp?: string;
        task_id?: string;
        status?: string;
        message?: string;
      };
      return `- ${parsed.timestamp || '-'} ${parsed.task_id || '-'} [${parsed.status || '-'}] ${truncate(parsed.message, 88)}`;
    });
}

export function resolveHiveShellRunId(cwd: string, runId?: string): string | null {
  if (runId) return runId;
  const workerRun = listWorkerStatusSnapshots(cwd)[0]?.run_id;
  if (workerRun) return workerRun;
  return listRuns(cwd)[0]?.id || null;
}

export function loadHiveShellDashboard(
  cwd: string,
  runId?: string,
): HiveShellDashboardData | null {
  const resolvedRunId = resolveHiveShellRunId(cwd, runId);
  if (!resolvedRunId) return null;

  const dir = runDir(cwd, resolvedRunId);
  return {
    runId: resolvedRunId,
    cwd,
    spec: loadRunSpec(cwd, resolvedRunId),
    state: loadRunState(cwd, resolvedRunId),
    loopProgress: readLoopProgress(cwd, resolvedRunId),
    plan: loadRunPlan(cwd, resolvedRunId),
    result: loadRunResult(cwd, resolvedRunId),
    workerSnapshot: loadWorkerStatusSnapshot(cwd, resolvedRunId),
    scoreHistory: loadRunScoreHistory(cwd, resolvedRunId),
    mindkeeperBootstrap: readJson<MindkeeperBootstrapArtifact>(path.join(dir, 'mindkeeper-bootstrap.json')),
    mindkeeperCheckpointInput: readJson<MindkeeperCheckpointPayload>(path.join(dir, 'mindkeeper-checkpoint-input.json')),
    mindkeeperCheckpointResult: readJson<MindkeeperCheckpointResult>(path.join(dir, 'mindkeeper-checkpoint-result.json')),
  };
}

export function renderHiveShellDashboard(
  data: HiveShellDashboardData,
): string {
  const sections = [
    section('HiveShell', [
      `cwd: ${data.cwd}`,
      `updated: ${new Date().toISOString()}`,
    ]),
    section('Run Overview', renderOverview(data)),
    section('Collab', renderCollab(data)),
    section('Score Trend', renderScoreTrend(data.scoreHistory)),
    section('Workers', renderWorkers(data.workerSnapshot)),
    section('Mindkeeper', renderMindkeeper(data)),
    section('Recent Events', renderRecentEvents(data.cwd, data.runId)),
    section('Artifacts', renderArtifacts(data.cwd, data.runId)),
  ];

  return sections.join('\n\n');
}
