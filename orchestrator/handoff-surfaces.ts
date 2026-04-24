import fs from 'fs';
import path from 'path';
import { readLoopProgress, type LoopProgress } from './loop-progress-store.js';
import { loadWorkerStatusSnapshot } from './worker-status-store.js';
import {
  generateHandoffSummary,
  formatHandoffSummary,
  type HandoffSummary,
} from './handoff-summary.js';
import { formatProviderDecision, latestProviderDecision } from './provider-surface.js';
import type {
  NextAction,
  OrchestratorResult,
  ProviderHealthStoreData,
  RunSpec,
  RunState,
  TaskPlan,
  TaskRunRecord,
  WorkerStatusEntry,
  WorkerStatusSnapshot,
} from './types.js';

export type HumanProgressStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'queued_retry'
  | 'fallback'
  | 'blocked'
  | 'request_human'
  | 'failed'
  | 'done';

export interface ThinHandoffPacket {
  version: 1;
  ts: string;
  agent: 'hive';
  cli: 'hive';
  run_id: string;
  task_id?: string;
  status: HumanProgressStatus;
  owner?: string;
  model?: string;
  goal: string;
  next_action: string;
  constraints: string[];
  refs: string[];
  changed_files: string[];
  expected_output: string[];
}

export interface HumanProgressSurface {
  run_id: string;
  goal: string;
  started: string;
  updated: string;
  status: HumanProgressStatus;
  next_action: string;
  why_not_moving?: string;
  counters: ProgressCounters;
  rows: ProgressRow[];
}

export interface HandoffSurfaceBundle {
  packet: ThinHandoffPacket;
  handoff: HandoffSummary;
  handoff_markdown: string;
  human_progress: HumanProgressSurface;
  human_progress_markdown: string;
}

interface SurfaceInputs {
  cwd: string;
  runId: string;
  spec: RunSpec | null;
  state: RunState | null;
  plan: TaskPlan | null;
  result: OrchestratorResult | null;
  loopProgress: LoopProgress | null;
  workerSnapshot: WorkerStatusSnapshot | null;
  providerHealth: ProviderHealthStoreData | null;
}

export interface ProgressRow {
  unit: string;
  provider: string;
  status: HumanProgressStatus;
  elapsed: string;
  output: string;
  note: string;
}

export interface ProgressCounters {
  done: number;
  failed: number;
  running: number;
  pending: number;
  queued_retry: number;
  blocked: number;
  fallback: number;
  request_human: number;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${content}\n`, 'utf-8');
}

function runDir(cwd: string, runId: string): string {
  return path.join(cwd, '.ai', 'runs', runId);
}

function relRunPath(runId: string, file: string): string {
  return path.posix.join('.ai', 'runs', runId, file);
}

function relPlanPath(file: string): string {
  return path.posix.join('.ai', 'plan', file);
}

function relRestorePath(file: string): string {
  return path.posix.join('.ai', 'restore', file);
}

function truncate(text: string | undefined, limit: number): string {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '-';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function escapeTable(text: string): string {
  return truncate(text, 120).replace(/\|/g, '/');
}

function parseTime(value?: string): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : ts;
}

function formatElapsed(start?: string, end?: string): string {
  const startTs = parseTime(start);
  if (!startTs) return '-';
  const endTs = parseTime(end) || Date.now();
  const diffMs = Math.max(0, endTs - startTs);
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds % 60}s`;
  return `${seconds}s`;
}

function collectChangedFiles(state: RunState | null): string[] {
  if (!state?.task_states) return [];
  const files = Object.values(state.task_states)
    .flatMap((task) => task.changed_files || [])
    .filter(Boolean);
  return [...new Set(files)].sort().slice(0, 20);
}

function findActiveWorker(snapshot: WorkerStatusSnapshot | null): WorkerStatusEntry | undefined {
  const workers = snapshot?.workers || [];
  return workers.find((worker) => ['running', 'starting', 'discussing'].includes(worker.status))
    || workers.at(0);
}

function findFocusTask(plan: TaskPlan | null, taskId?: string) {
  if (!plan || !taskId) return undefined;
  return plan.tasks.find((task) => task.id === taskId);
}

function buildOverallStatus(inputs: SurfaceInputs): HumanProgressStatus {
  const nextAction = inputs.state?.next_action;
  if (nextAction?.kind === 'request_human') return 'request_human';
  if (inputs.state?.steering?.paused) return 'waiting';
  if (inputs.state?.status === 'done') return 'done';
  if (inputs.state?.status === 'blocked') return 'blocked';

  const latestDecision = latestProviderDecision(inputs.providerHealth);
  if (latestDecision?.action === 'fallback') return 'fallback';
  if (latestDecision && ['cooldown', 'backoff_retry', 'bounded_retry', 'immediate_retry'].includes(latestDecision.action)) {
    return 'queued_retry';
  }

  const fallbackWorker = (inputs.workerSnapshot?.workers || []).find((worker) => worker.provider_fallback_used);
  if (fallbackWorker) return 'fallback';

  const activeWorker = findActiveWorker(inputs.workerSnapshot);
  if (activeWorker && ['running', 'starting', 'discussing'].includes(activeWorker.status)) {
    return 'running';
  }

  if (inputs.loopProgress && ['planning', 'discussing', 'executing', 'reviewing', 'verifying', 'repairing', 'replanning'].includes(inputs.loopProgress.phase)) {
    return 'running';
  }

  if (inputs.state?.failed_task_ids?.length) return 'failed';
  if (inputs.state?.status === 'partial') return 'blocked';
  if (inputs.state?.status) return 'pending';
  return 'pending';
}

function buildNextActionText(state: RunState | null, loopProgress: LoopProgress | null): string {
  if (state?.next_action) {
    return truncate(`${state.next_action.kind}: ${state.next_action.reason}`, 160);
  }
  if (loopProgress?.reason) {
    return truncate(`${loopProgress.phase}: ${loopProgress.reason}`, 160);
  }
  return '-';
}

function buildConstraints(inputs: SurfaceInputs, focusTaskId?: string): string[] {
  const constraints: string[] = [];
  if (inputs.spec) {
    constraints.push(`max_rounds=${inputs.spec.max_rounds}`);
    constraints.push(`max_worker_retries=${inputs.spec.max_worker_retries}`);
    constraints.push(`max_replans=${inputs.spec.max_replans}`);
    constraints.push(inputs.spec.allow_auto_merge ? 'allow_auto_merge=yes' : 'allow_auto_merge=no');
    if (inputs.spec.stop_on_high_risk) {
      constraints.push('stop_on_high_risk=yes');
    }
  }
  const focusTask = findFocusTask(inputs.plan, focusTaskId);
  if (focusTask?.execution_contract) {
    constraints.push(`execution_contract=${focusTask.execution_contract}`);
  }
  for (const criterion of focusTask?.acceptance_criteria || []) {
    constraints.push(`acceptance: ${truncate(criterion, 100)}`);
  }
  return [...new Set(constraints)].slice(0, 8);
}

function buildExpectedOutput(inputs: SurfaceInputs, focusTaskId?: string): string[] {
  const lines: string[] = [];
  const focusTask = findFocusTask(inputs.plan, focusTaskId);
  for (const criterion of focusTask?.acceptance_criteria || []) {
    lines.push(truncate(criterion, 120));
  }
  if (inputs.state?.next_action?.instructions) {
    lines.push(truncate(inputs.state.next_action.instructions, 120));
  }
  if (focusTask?.description) {
    lines.push(truncate(focusTask.description, 120));
  }
  if (lines.length === 0 && inputs.state?.final_summary) {
    lines.push(truncate(inputs.state.final_summary, 120));
  }
  return [...new Set(lines)].slice(0, 6);
}

function buildRefs(inputs: SurfaceInputs): string[] {
  const refs = [
    relPlanPath('current.md'),
    relPlanPath('handoff.md'),
    relPlanPath('packet.json'),
    relRunPath(inputs.runId, 'human-progress.md'),
    relRunPath(inputs.runId, 'state.json'),
    relRunPath(inputs.runId, 'worker-status.json'),
    relRunPath(inputs.runId, 'loop-progress.json'),
  ];
  const optional = [
    'plan.json',
    'result.json',
    'compact-packet.json',
    'provider-health.json',
  ].map((file) => relRunPath(inputs.runId, file));
  return [...refs, ...optional].slice(0, 12);
}

function buildThinHandoffPacket(inputs: SurfaceInputs): ThinHandoffPacket {
  const focusTaskId = inputs.loopProgress?.focus_task_id
    || inputs.state?.next_action?.task_ids?.[0]
    || findActiveWorker(inputs.workerSnapshot)?.task_id;
  const owner = inputs.loopProgress?.focus_agent_id || findActiveWorker(inputs.workerSnapshot)?.agent_id;
  const model = inputs.loopProgress?.focus_model || findActiveWorker(inputs.workerSnapshot)?.active_model;

  return {
    version: 1,
    ts: new Date().toISOString(),
    agent: 'hive',
    cli: 'hive',
    run_id: inputs.runId,
    task_id: focusTaskId,
    status: buildOverallStatus(inputs),
    owner,
    model,
    goal: truncate(inputs.spec?.goal || inputs.plan?.goal || inputs.workerSnapshot?.goal || '-', 200),
    next_action: buildNextActionText(inputs.state, inputs.loopProgress),
    constraints: buildConstraints(inputs, focusTaskId),
    refs: buildRefs(inputs),
    changed_files: collectChangedFiles(inputs.state),
    expected_output: buildExpectedOutput(inputs, focusTaskId),
  };
}

function mapTaskRowStatus(args: {
  taskId: string;
  taskRecord?: TaskRunRecord;
  worker?: WorkerStatusEntry;
  nextAction?: NextAction;
}): HumanProgressStatus {
  const { taskId, taskRecord, worker, nextAction } = args;
  if (nextAction?.kind === 'request_human' && nextAction.task_ids?.includes(taskId)) return 'request_human';
  if (nextAction && ['retry_task', 'repair_task'].includes(nextAction.kind) && nextAction.task_ids?.includes(taskId)) {
    return 'queued_retry';
  }
  if (taskRecord?.status === 'merge_blocked') return 'blocked';
  if (worker && ['running', 'starting', 'discussing'].includes(worker.status)) return 'running';
  if (worker?.provider_fallback_used) return 'fallback';
  if (taskRecord && ['merged', 'verified', 'superseded'].includes(taskRecord.status)) return 'done';
  if (worker?.status === 'completed') return 'done';
  if (taskRecord && ['worker_failed', 'review_failed', 'verification_failed'].includes(taskRecord.status)) return 'failed';
  if (worker?.status === 'failed') return 'failed';
  return 'pending';
}

function buildRowNote(args: {
  taskRecord?: TaskRunRecord;
  worker?: WorkerStatusEntry;
  nextAction?: NextAction;
  latestDecisionText?: string;
  taskId: string;
}): string {
  const { taskRecord, worker, nextAction, latestDecisionText, taskId } = args;
  if (nextAction?.kind === 'request_human' && nextAction.task_ids?.includes(taskId)) {
    return truncate(nextAction.instructions || nextAction.reason, 120);
  }
  if (taskRecord?.status === 'merge_blocked') {
    return truncate(taskRecord.last_error || 'merge blocked', 120);
  }
  if (worker?.provider_fallback_used) {
    return truncate(`fallback to ${worker.active_model}@${worker.provider}`, 120);
  }
  if (worker?.provider_failure_subtype) {
    return truncate(worker.provider_failure_subtype, 120);
  }
  if (taskRecord?.retry_count) {
    return truncate(`retry_count=${taskRecord.retry_count}`, 120);
  }
  if (taskRecord?.last_error) {
    return truncate(taskRecord.last_error, 120);
  }
  return latestDecisionText || '-';
}

function buildProgressRows(inputs: SurfaceInputs): ProgressRow[] {
  const taskIds = new Set<string>();
  for (const taskId of Object.keys(inputs.state?.task_states || {})) taskIds.add(taskId);
  for (const worker of inputs.workerSnapshot?.workers || []) taskIds.add(worker.task_id);
  if (taskIds.size === 0 && inputs.state?.next_action?.task_ids?.length) {
    for (const taskId of inputs.state.next_action.task_ids) taskIds.add(taskId);
  }

  const workerMap = new Map((inputs.workerSnapshot?.workers || []).map((worker) => [worker.task_id, worker]));
  const latestDecisionText = truncate(formatProviderDecision(latestProviderDecision(inputs.providerHealth)) || '', 120);

  return [...taskIds].sort().map((taskId) => {
    const taskRecord = inputs.state?.task_states?.[taskId];
    const worker = workerMap.get(taskId);
    const status = mapTaskRowStatus({
      taskId,
      taskRecord,
      worker,
      nextAction: inputs.state?.next_action,
    });
    const provider = worker
      ? `${worker.active_model}@${worker.provider}`
      : '-';
    const output = worker
      ? truncate(worker.task_summary || worker.last_message || worker.error || '-', 80)
      : truncate(taskRecord?.last_error || '-', 80);
    return {
      unit: taskId,
      provider,
      status,
      elapsed: formatElapsed(worker?.started_at, worker?.finished_at || worker?.updated_at),
      output,
      note: buildRowNote({
        taskRecord,
        worker,
        nextAction: inputs.state?.next_action,
        latestDecisionText,
        taskId,
      }),
    };
  });
}

function countProgress(rows: ProgressRow[], overall: HumanProgressStatus): ProgressCounters {
  const counters: ProgressCounters = {
    done: 0,
    failed: 0,
    running: 0,
    pending: 0,
    queued_retry: 0,
    blocked: 0,
    fallback: 0,
    request_human: 0,
  };
  for (const row of rows) {
    if (row.status in counters) {
      counters[row.status as keyof ProgressCounters] += 1;
    }
  }
  if (overall === 'request_human' && counters.request_human === 0) counters.request_human = 1;
  return counters;
}

function buildHumanProgressSurface(inputs: SurfaceInputs, handoff: HandoffSummary): HumanProgressSurface {
  const overall = buildOverallStatus(inputs);
  const rows = buildProgressRows(inputs);
  const counters = countProgress(rows, overall);
  const started = inputs.spec?.created_at
    || inputs.workerSnapshot?.workers
      ?.map((worker) => worker.started_at)
      .filter((value): value is string => Boolean(value))
      .sort()[0]
    || '-';
  const updated = inputs.state?.updated_at
    || inputs.loopProgress?.updated_at
    || inputs.workerSnapshot?.updated_at
    || inputs.providerHealth?.updated_at
    || new Date().toISOString();

  const humanProgress: HumanProgressSurface = {
    run_id: inputs.runId,
    goal: truncate(inputs.spec?.goal || inputs.plan?.goal || inputs.workerSnapshot?.goal || '-', 160),
    started,
    updated,
    status: overall,
    next_action: buildNextActionText(inputs.state, inputs.loopProgress),
    why_not_moving: buildProgressReason(inputs, overall),
    counters: {
      ...counters,
      fallback: rows.filter((row) => row.status === 'fallback').length,
    },
    rows,
  };

  if (overall === 'request_human' && humanProgress.counters.request_human === 0) {
    humanProgress.counters.request_human = 1;
  }
  if (!humanProgress.why_not_moving && handoff.top_blockers.length > 0) {
    humanProgress.why_not_moving = truncate(handoff.top_blockers[0].reason, 160);
  }
  return humanProgress;
}

function buildProgressReason(inputs: SurfaceInputs, overall: HumanProgressStatus): string | undefined {
  const nextAction = inputs.state?.next_action;
  const latestDecision = latestProviderDecision(inputs.providerHealth);
  if (overall === 'request_human') {
    return truncate(nextAction?.instructions || nextAction?.reason || 'human input required', 160);
  }
  if (overall === 'queued_retry') {
    return truncate(latestDecision?.action_reason || 'retry queued after provider backoff/cooldown', 160);
  }
  if (overall === 'fallback') {
    return truncate(latestDecision?.action_reason || 'provider/model fallback in progress', 160);
  }
  if (overall === 'blocked') {
    return truncate(nextAction?.reason || 'run is blocked and cannot continue automatically', 160);
  }
  if (overall === 'waiting') {
    if (inputs.state?.steering?.paused) return 'run paused by steering';
    return truncate(nextAction?.reason || 'waiting on external condition', 160);
  }
  if (overall === 'failed') {
    return truncate(nextAction?.reason || inputs.state?.final_summary || 'one or more tasks failed', 160);
  }
  return undefined;
}

function buildHumanProgressMarkdown(
  humanProgress: HumanProgressSurface,
  handoff: HandoffSummary,
): string {
  const lines = [
    '# Hive Human Progress',
    '',
    `- run id: ${humanProgress.run_id}`,
    `- goal: ${humanProgress.goal}`,
    `- started: ${humanProgress.started}`,
    `- updated: ${humanProgress.updated}`,
    `- overall status: ${humanProgress.status}`,
    `- next action: ${humanProgress.next_action}`,
    '',
    '## Counters',
    '',
    `- done: ${humanProgress.counters.done}`,
    `- failed: ${humanProgress.counters.failed}`,
    `- running: ${humanProgress.counters.running}`,
    `- pending: ${humanProgress.counters.pending}`,
    `- queued_retry: ${humanProgress.counters.queued_retry}`,
    `- blocked: ${humanProgress.counters.blocked}`,
    `- fallback: ${humanProgress.counters.fallback}`,
    `- request_human: ${humanProgress.counters.request_human}`,
  ];

  if (humanProgress.why_not_moving) {
    lines.push('', '## Why This Is Not Moving', '', `- ${humanProgress.why_not_moving}`);
  }

  lines.push(
    '',
    '## Units',
    '',
    '| Unit | Provider | Status | Elapsed | Output | Note |',
    '|------|----------|--------|---------|--------|------|',
  );

  if (humanProgress.rows.length === 0) {
    lines.push('| run | - | pending | - | - | no worker/task artifact yet |');
  } else {
    for (const row of humanProgress.rows) {
      lines.push(
        `| ${escapeTable(row.unit)} | ${escapeTable(row.provider)} | ${row.status} | ${escapeTable(row.elapsed)} | ${escapeTable(row.output)} | ${escapeTable(row.note)} |`,
      );
    }
  }

  if (handoff.top_blockers.length > 0) {
    lines.push('', '## Top Blockers', '');
    for (const blocker of handoff.top_blockers.slice(0, 5)) {
      lines.push(`- ${blocker.task_id || 'run'}: ${truncate(blocker.reason, 120)}`);
    }
  }

  if (handoff.suggested_commands.length > 0) {
    lines.push('', '## Suggested Commands', '');
    for (const item of handoff.suggested_commands) {
      lines.push(`- ${item.command}`);
    }
  }

  return lines.join('\n');
}

function buildHandoffMarkdown(packet: ThinHandoffPacket, handoff: HandoffSummary): string {
  const lines = [
    '# Hive Thin Handoff',
    '',
    `- ts: ${packet.ts}`,
    `- agent: ${packet.agent}`,
    `- cli: ${packet.cli}`,
    `- run_id: ${packet.run_id}`,
    `- task_id: ${packet.task_id || '-'}`,
    `- status: ${packet.status}`,
    `- owner: ${packet.owner || '-'}`,
    `- model: ${packet.model || '-'}`,
    `- next_action: ${packet.next_action}`,
    '',
    '## Goal',
    '',
    `- ${packet.goal}`,
    '',
    '## Constraints',
    '',
  ];

  if (packet.constraints.length === 0) {
    lines.push('- none');
  } else {
    for (const item of packet.constraints) lines.push(`- ${item}`);
  }

  lines.push('', '## Expected Output', '');
  if (packet.expected_output.length === 0) {
    lines.push('- continue the current run without re-reading full history');
  } else {
    for (const item of packet.expected_output) lines.push(`- ${item}`);
  }

  lines.push('', '## Refs', '');
  for (const ref of packet.refs) lines.push(`- ${ref}`);

  if (packet.changed_files.length > 0) {
    lines.push('', '## Changed Files', '');
    for (const file of packet.changed_files) lines.push(`- ${file}`);
  }

  lines.push('', '## Current Truth', '', `- ${handoff.current_truth}`);
  if (handoff.top_blockers.length > 0) {
    lines.push('', '## Top Blockers', '');
    for (const blocker of handoff.top_blockers.slice(0, 5)) {
      lines.push(`- ${blocker.task_id || 'run'}: ${truncate(blocker.reason, 120)}`);
    }
  }

  if (handoff.suggested_commands.length > 0) {
    lines.push('', '## Suggested Commands', '');
    for (const item of handoff.suggested_commands) {
      lines.push(`- ${item.command}  # ${item.label}`);
    }
  }

  lines.push('', '## Handoff Summary', '', '```text', formatHandoffSummary(handoff), '```');
  return lines.join('\n');
}

function loadInputs(cwd: string, runId: string): SurfaceInputs {
  const dir = runDir(cwd, runId);
  return {
    cwd,
    runId,
    spec: readJson<RunSpec>(path.join(dir, 'spec.json')),
    state: readJson<RunState>(path.join(dir, 'state.json')),
    plan: readJson<TaskPlan>(path.join(dir, 'plan.json')),
    result: readJson<OrchestratorResult>(path.join(dir, 'result.json')),
    loopProgress: readLoopProgress(cwd, runId),
    workerSnapshot: loadWorkerStatusSnapshot(cwd, runId),
    providerHealth: readJson<ProviderHealthStoreData>(path.join(dir, 'provider-health.json')),
  };
}

function hasAnyInput(inputs: SurfaceInputs): boolean {
  return Boolean(
    inputs.spec
      || inputs.state
      || inputs.plan
      || inputs.result
      || inputs.loopProgress
      || inputs.workerSnapshot
      || inputs.providerHealth,
  );
}

export function loadHandoffSurfaceBundle(cwd: string, runId: string): HandoffSurfaceBundle | null {
  const inputs = loadInputs(cwd, runId);
  if (!hasAnyInput(inputs)) return null;

  const packet = buildThinHandoffPacket(inputs);
  const handoff = generateHandoffSummary({
    runId,
    state: inputs.state,
    spec: inputs.spec,
    reviewResults: inputs.result?.review_results,
    providerHealth: inputs.providerHealth,
  });
  const humanProgress = buildHumanProgressSurface(inputs, handoff);

  return {
    packet,
    handoff,
    handoff_markdown: buildHandoffMarkdown(packet, handoff),
    human_progress: humanProgress,
    human_progress_markdown: buildHumanProgressMarkdown(humanProgress, handoff),
  };
}

export function syncHandoffSurfaces(cwd: string, runId: string): void {
  try {
    const bundle = loadHandoffSurfaceBundle(cwd, runId);
    if (!bundle) return;
    const planDir = path.join(cwd, '.ai', 'plan');
    const restoreDir = path.join(cwd, '.ai', 'restore');

    ensureDir(planDir);
    ensureDir(restoreDir);
    writeText(path.join(planDir, 'packet.json'), JSON.stringify(bundle.packet, null, 2));
    writeText(path.join(planDir, 'handoff.md'), bundle.handoff_markdown);
    writeText(path.join(runDir(cwd, runId), 'human-progress.md'), bundle.human_progress_markdown);
    writeText(path.join(restoreDir, 'latest-human-progress.md'), bundle.human_progress_markdown);
  } catch {
    // Non-critical derived surface
  }
}
