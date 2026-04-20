import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CollabCard, OrchestratorResult, TaskPlan, SubTask, PlannerDiscussRoomRef } from './types.js';
import type { CompactPacketWorker, RunCompactPacketResult } from './compact-packet.js';
import { pickWorkerSurfaceSummary } from './worker-surface-summary.js';

const MCP_DIR_SEGMENTS = ['.ai', 'mcp'];
const MAX_FOCUS_DESCRIPTION = 96;

export const LATEST_PLAN_ARTIFACT = 'latest-plan.json';

interface LatestPlanPointer {
  version: 1;
  cwd: string;
  plan_path: string;
  updated_at: string;
}

function getMcpDir(cwd: string): string {
  return path.join(cwd, ...MCP_DIR_SEGMENTS);
}

function latestPlanPointerPath(): string {
  return path.join(os.homedir(), '.hive', 'latest-plan-pointer.json');
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function writeMcpJsonArtifact(
  cwd: string,
  prefix: string,
  payload: unknown,
): string {
  const dir = getMcpDir(cwd);
  ensureDir(dir);
  const filePath = path.join(dir, `${prefix}-${Date.now()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

export function writeMcpTextArtifact(
  cwd: string,
  prefix: string,
  content: string,
): string {
  const dir = getMcpDir(cwd);
  ensureDir(dir);
  const filePath = path.join(dir, `${prefix}-${Date.now()}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

export function writeStableMcpJsonArtifact(
  cwd: string,
  fileName: string,
  payload: unknown,
): string {
  const dir = getMcpDir(cwd);
  ensureDir(dir);
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

export function resolveLatestPlanArtifact(cwd: string): string | null {
  const filePath = path.join(getMcpDir(cwd), LATEST_PLAN_ARTIFACT);
  return fs.existsSync(filePath) ? filePath : null;
}

export function saveLatestPlanPointer(cwd: string, planPath: string): string {
  const filePath = latestPlanPointerPath();
  ensureDir(path.dirname(filePath));
  const payload: LatestPlanPointer = {
    version: 1,
    cwd,
    plan_path: planPath,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  return filePath;
}

export function loadLatestPlanPointer(): LatestPlanPointer | null {
  try {
    const filePath = latestPlanPointerPath();
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as LatestPlanPointer;
  } catch {
    return null;
  }
}

export function resolvePreferredLatestPlanArtifact(cwd: string): string | null {
  const pointer = loadLatestPlanPointer();
  if (pointer?.plan_path && fs.existsSync(pointer.plan_path)) {
    return pointer.plan_path;
  }
  return resolveLatestPlanArtifact(cwd);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTaskPlanLike(value: unknown): value is TaskPlan {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.goal)
    && isNonEmptyString(value.cwd)
    && Array.isArray(value.tasks)
    && Array.isArray(value.execution_order)
    && isRecord(value.context_flow)
    && isNonEmptyString(value.created_at);
}

export function extractRunnableTaskPlan(payload: unknown): TaskPlan | null {
  if (isTaskPlanLike(payload)) {
    return payload;
  }
  if (!isRecord(payload)) {
    return null;
  }
  return isTaskPlanLike(payload.plan) ? payload.plan : null;
}

export function relPath(cwd: string, target: string): string {
  if (!isNonEmptyString(cwd) || !isNonEmptyString(target)) {
    return target;
  }
  const rel = target.startsWith(cwd)
    ? target.slice(cwd.length).replace(/^\/+/, '')
    : target;
  return rel || target;
}

function compressTaskDescription(description: string): string {
  const singleLine = description.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= MAX_FOCUS_DESCRIPTION) {
    return singleLine;
  }
  return `${singleLine.slice(0, MAX_FOCUS_DESCRIPTION - 3)}...`;
}

function formatFocusTask(task: SubTask): string {
  return `${task.id} | ${task.assigned_model} | ${compressTaskDescription(task.description)}`;
}

interface PlanCardOptions {
  artifactPath: string;
  plannerModel: string;
  stablePlanPath: string;
  translationModel?: string;
  discussQualityGate?: string | null;
  discussRoom?: PlannerDiscussRoomRef | null;
  collabCard?: CollabCard | null;
  budgetWarning?: string | null;
}

export function summarizePlanCard(
  plan: TaskPlan,
  options: PlanCardOptions,
): string {
  const focusTask = plan.tasks[0];
  const extraCount = Math.max(0, plan.tasks.length - 1);

  return [
    `Hive plan ${plan.id} ready.`,
    `- result: ${plan.tasks.length} task(s) via ${options.plannerModel}`,
    options.translationModel ? `- translated: ${options.translationModel}` : '',
    options.discussQualityGate ? `- discuss: ${options.discussQualityGate}` : '',
    options.discussRoom ? `- room: ${options.discussRoom.room_id} (${options.discussRoom.reply_count} reply(s)${options.discussRoom.join_hint ? `, join: ${options.discussRoom.join_hint}` : ''})` : '',
    options.collabCard ? `- collab: ${options.collabCard.room_id} [${options.collabCard.status}] replies=${options.collabCard.replies}${options.collabCard.join_hint ? `, join: ${options.collabCard.join_hint}` : ''}` : '',
    options.collabCard ? `- collab next: ${options.collabCard.next}` : '',
    options.budgetWarning ? `- budget: ${options.budgetWarning}` : '',
    focusTask
      ? `- focus: ${formatFocusTask(focusTask)}${extraCount > 0 ? ` +${extraCount} more` : ''}`
      : '',
    '- next: execute_plan',
    `- plan: ${relPath(plan.cwd, options.stablePlanPath)}`,
    `- artifact: ${relPath(plan.cwd, options.artifactPath)}`,
  ].filter(Boolean).join('\n');
}

function formatFocusWorker(worker: CompactPacketWorker): string {
  return `${worker.agent_id} | ${worker.status} | ${pickWorkerSurfaceSummary(worker.task_summary) || '-'}`;
}

function buildAgentLines(cwd: string, worker?: CompactPacketWorker): string[] {
  if (!worker) return [];
  return [
    `- agent: ${worker.agent_id}`,
    worker.transcript_path ? `- transcript: ${relPath(cwd, worker.transcript_path)}` : '',
  ].filter(Boolean);
}

function buildWorkerCollabLines(worker?: CompactPacketWorker): string[] {
  if (!worker?.collab) return [];
  return [
    `- collab: ${worker.task_id} -> ${worker.collab.room_id} [${worker.collab.status}] replies=${worker.collab.replies}${worker.collab.join_hint ? `, join: ${worker.collab.join_hint}` : ''}`,
    `- collab next: ${worker.collab.next}`,
  ];
}

function buildInspectLine(commands: string[]): string {
  return `- next: ${commands.join(' | ')}`;
}

interface ExecutionCardOptions {
  reportPath: string;
  compactPacket?: RunCompactPacketResult | null;
  mergeResults: Array<{ taskId: string; merged: boolean; error?: string }>;
}

export function summarizeExecutionCard(
  plan: TaskPlan,
  orchestratorResult: OrchestratorResult,
  options: ExecutionCardOptions,
): string {
  const passedWorkers = orchestratorResult.worker_results.filter((worker) => worker.success).length;
  const passedReviews = orchestratorResult.review_results.filter((review) => review.passed).length;
  const totalWorkers = orchestratorResult.worker_results.length;
  const totalReviews = orchestratorResult.review_results.length;
  const blockedCount = options.mergeResults.filter((item) => !item.merged).length;
  const focusWorker = options.compactPacket?.packet.worker_focus[0];
  const restorePath = options.compactPacket
    ? relPath(plan.cwd, options.compactPacket.latestRestorePromptPath)
    : undefined;
  const inspectCommands = focusWorker
    ? [`hive workers ${focusWorker.task_id}`, 'hive status', 'hive compact']
    : ['hive status', 'hive workers', 'hive compact'];

  return [
    `Hive run ${plan.id} ready.`,
    `- result: ${blockedCount > 0 ? 'partial' : 'ok'} | workers ${passedWorkers}/${totalWorkers} | reviews ${passedReviews}/${totalReviews}`,
    focusWorker ? `- focus: ${formatFocusWorker(focusWorker)}` : '',
    ...buildAgentLines(plan.cwd, focusWorker),
    ...buildWorkerCollabLines(focusWorker),
    blockedCount > 0 ? `- note: ${blockedCount} task(s) stayed in worktree for inspection` : '',
    buildInspectLine(inspectCommands),
    restorePath ? `- restore: ${restorePath}` : '',
    `- artifact: ${options.reportPath}`,
  ].filter(Boolean).join('\n');
}

interface DispatchCardOutput {
  taskId: string;
  model: string;
  success: boolean;
  discuss_triggered: boolean;
  preflight_fallback: string | null;
}

interface DispatchCardOptions {
  cwd: string;
  artifactPath: string;
  compactPacket?: RunCompactPacketResult | null;
}

export function summarizeDispatchCard(
  output: DispatchCardOutput,
  options: DispatchCardOptions,
): string {
  const focusWorker = options.compactPacket?.packet.worker_focus[0];
  const restorePath = options.compactPacket
    ? relPath(options.cwd, options.compactPacket.latestRestorePromptPath)
    : undefined;
  const resultParts = [
    output.success ? 'ok' : 'failed',
    `via ${output.model}`,
    output.preflight_fallback ? `fallback ${output.preflight_fallback}` : '',
    output.discuss_triggered ? 'discuss triggered' : '',
  ].filter(Boolean);

  return [
    `Hive worker ${output.taskId} ready.`,
    `- result: ${resultParts.join(' | ')}`,
    focusWorker ? `- focus: ${formatFocusWorker(focusWorker)}` : '',
    ...buildAgentLines(options.cwd, focusWorker),
    ...buildWorkerCollabLines(focusWorker),
    buildInspectLine([`hive workers ${output.taskId}`, 'hive compact']),
    restorePath ? `- restore: ${restorePath}` : '',
    `- artifact: ${options.artifactPath}`,
  ].filter(Boolean).join('\n');
}
