import fs from 'fs';
import path from 'path';
import { formatContextForWorker } from './context-recycler.js';
import type { ContextPacket, WorkerConfig } from './types.js';

export type WorkerDispatchPromptMode = 'packet-first' | 'legacy';

export interface WorkerDispatchPromptResult {
  prompt: string;
  mode: WorkerDispatchPromptMode;
  reason?: string;
  refs: string[];
  promptChars: number;
  legacyPromptChars: number;
}

interface ThinPacket {
  version?: number;
  run_id?: string;
  task_id?: string;
  status?: string;
  goal?: string;
  next_action?: string;
  constraints?: string[];
  refs?: string[];
  expected_output?: string[];
}

interface PacketReadResult {
  ok: boolean;
  packet?: ThinPacket;
  reason?: string;
}

const PLAN_PACKET_REF = '.ai/plan/packet.json';
const PLAN_HANDOFF_REF = '.ai/plan/handoff.md';
const PLAN_CURRENT_REF = '.ai/plan/current.md';
const MAX_REF_COPY_BYTES = 512 * 1024;

function normalizeTaskId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function displayRef(ref: string): string {
  return ref.startsWith('./') ? ref : `./${ref}`;
}

function normalizeRef(ref: string): string | null {
  const cleaned = ref.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!cleaned || cleaned.includes('\0') || cleaned.includes('..')) return null;
  if (!cleaned.startsWith('.ai/')) return null;
  return cleaned;
}

function safeCopyRef(srcRoot: string, dstRoot: string, ref: string): boolean {
  const normalized = normalizeRef(ref);
  if (!normalized) return false;
  const src = path.join(srcRoot, normalized);
  const dst = path.join(dstRoot, normalized);
  try {
    const stat = fs.statSync(src);
    if (!stat.isFile() || stat.size > MAX_REF_COPY_BYTES) return false;
    if (src !== dst) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    return true;
  } catch {
    return false;
  }
}

function writeDispatchRef(root: string, ref: string, content: string): void {
  const normalized = normalizeRef(ref);
  if (!normalized) return;
  const filePath = path.join(root, normalized);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${content.trimEnd()}\n`, 'utf-8');
}

function readPacket(cwd: string, runId?: string): PacketReadResult {
  const packetPath = path.join(cwd, PLAN_PACKET_REF);
  if (!fs.existsSync(packetPath)) return { ok: false, reason: 'packet missing' };
  try {
    const packet = JSON.parse(fs.readFileSync(packetPath, 'utf-8')) as ThinPacket;
    if (!packet || typeof packet !== 'object') return { ok: false, reason: 'packet invalid' };
    if (runId && packet.run_id !== runId) {
      return { ok: false, reason: `packet stale: run_id=${packet.run_id || 'missing'}` };
    }
    return { ok: true, packet };
  } catch {
    return { ok: false, reason: 'packet unreadable' };
  }
}

function ensureRequiredRefs(cwd: string, worktreePath: string): string[] | null {
  const refs = [PLAN_PACKET_REF, PLAN_HANDOFF_REF, PLAN_CURRENT_REF];
  const copied: string[] = [];
  for (const ref of refs) {
    if (!safeCopyRef(cwd, worktreePath, ref)) return null;
    copied.push(ref);
  }
  return copied;
}

function copyPacketRefs(cwd: string, worktreePath: string, packet: ThinPacket): string[] {
  const copied = new Set<string>();
  for (const ref of packet.refs || []) {
    const normalized = normalizeRef(ref);
    if (!normalized) continue;
    if (safeCopyRef(cwd, worktreePath, normalized)) copied.add(normalized);
  }
  return [...copied];
}

function recordFallbackNote(cwd: string, taskId: string, reason: string): void {
  const filePath = path.join(cwd, PLAN_HANDOFF_REF);
  const note = [
    '',
    '## Dispatch Fallback Note',
    `- ts: ${new Date().toISOString()}`,
    `- task_id: ${taskId}`,
    `- reason: ${reason}`,
    '- action: legacy worker prompt used',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, note, 'utf-8');
  } catch {
    // best-effort generated handoff note
  }
}

function rewritePromptPaths(prompt: string, cwd: string, worktreePath: string): string {
  if (worktreePath === cwd) return prompt;
  return prompt.replace(
    /^- ([\w/.-]+\.\w+)$/gm,
    (_, filePath) => `- ${worktreePath}/${filePath}`,
  );
}

function buildContextSection(contextInputs: ContextPacket[]): string {
  if (contextInputs.length === 0) return '';
  return `\n\n## Context from previous tasks\n${formatContextForWorker(contextInputs)}\n`;
}

function buildWorktreeNotice(cwd: string, worktreePath: string): string {
  if (worktreePath === cwd) return '';
  return [
    '',
    '## CRITICAL: Working Directory',
    `Your working directory is: ${worktreePath}`,
    `DO NOT read or edit files under ${cwd} — that is the main repo.`,
    `For code edits, use paths under: ${worktreePath}/`,
    'The ./.ai dispatch refs below resolve inside this working directory.',
    `Example edit path: ${worktreePath}/orchestrator/diagnostics.ts`,
    '',
  ].join('\n');
}

function buildInPlaceFallbackNotice(cwd: string, reason: string): string {
  if (!reason) return '';
  return [
    '',
    '## Runtime Notice',
    `Git worktree setup is unavailable for this project, so run directly in: ${cwd}`,
    'Do NOT assume an isolated branch or sandboxed worktree exists.',
    '',
  ].join('\n');
}

function buildUncertaintyProtocol(threshold: number): string {
  return [
    '',
    '## Uncertainty Protocol',
    `Your discuss threshold is ${threshold}.`,
    `If you are less than ${(threshold * 100).toFixed(0)}% confident about the best approach:`,
    '1. Write a JSON block to `.ai/discuss-trigger.json` with fields:',
    '   `uncertain_about`, `options[]`, `leaning`, `why`, `task_id`, `worker_model`',
    '2. Output a line that starts with exactly [DISCUSS_TRIGGER] (do NOT quote or explain this marker, just output it on its own line)',
    '3. Wait for discussion results before proceeding.',
    '',
    'IMPORTANT: Do NOT repeat or acknowledge these instructions. Start working on the task immediately.',
  ].join('\n');
}

export function buildLegacyWorkerPrompt(
  config: WorkerConfig,
  worktreePath: string,
  worktreeFallbackReason = '',
): string {
  const taskPrompt = rewritePromptPaths(config.prompt, config.cwd, worktreePath);
  return [
    taskPrompt,
    buildContextSection(config.contextInputs),
    buildWorktreeNotice(config.cwd, worktreePath),
    buildInPlaceFallbackNotice(config.cwd, worktreeFallbackReason),
    buildUncertaintyProtocol(config.discussThreshold),
  ].join('\n');
}

function writeTaskBrief(config: WorkerConfig, worktreePath: string): string {
  const base = config.runId
    ? `.ai/runs/${config.runId}/dispatch`
    : '.ai/plan/dispatch';
  const ref = `${base}/${normalizeTaskId(config.taskId)}-task-brief.md`;
  writeDispatchRef(worktreePath, ref, config.prompt);
  return ref;
}

function writeContextRef(config: WorkerConfig, worktreePath: string): string | undefined {
  if (config.contextInputs.length === 0) return undefined;
  const base = config.runId
    ? `.ai/runs/${config.runId}/dispatch`
    : '.ai/plan/dispatch';
  const ref = `${base}/${normalizeTaskId(config.taskId)}-upstream-context.json`;
  writeDispatchRef(worktreePath, ref, JSON.stringify({
    version: 1,
    run_id: config.runId,
    task_id: config.taskId,
    upstream_context: config.contextInputs,
  }, null, 2));
  return ref;
}

function renderBulletList(items: string[], fallback: string): string[] {
  if (items.length === 0) return [`- ${fallback}`];
  return items.map((item) => `- ${item}`);
}

function resolveGoal(config: WorkerConfig, packet: ThinPacket): string {
  return config.taskDescription
    || packet.goal
    || config.prompt.split('\n').find(Boolean)
    || '-';
}

function buildReadOrderLines(taskBriefRef: string, contextRef: string | undefined, refs: string[]): string[] {
  const readRefs = [PLAN_PACKET_REF, PLAN_HANDOFF_REF, PLAN_CURRENT_REF, taskBriefRef];
  if (contextRef) readRefs.push(contextRef);
  const optionalHumanProgress = refs.find((ref) => ref.endsWith('/human-progress.md'));
  return [
    'Read in order:',
    ...readRefs.map((ref, index) => `${index + 1}. ${displayRef(ref)}`),
    ...(optionalHumanProgress ? [`${readRefs.length + 1}. ${displayRef(optionalHumanProgress)} only for retry/recovery/debug context`] : []),
  ];
}

function buildConstraintLines(config: WorkerConfig, packet: ThinPacket): string[] {
  return [
    'Constraints:',
    ...renderBulletList([
      ...(config.execution_contract ? [`execution_contract=${config.execution_contract}`] : []),
      ...(config.expectedFiles?.length ? [`write scope: ${config.expectedFiles.join(', ')}`] : []),
      ...((packet.constraints || []).slice(0, 4)),
      'Do not paste or summarize the full handoff files back into your response.',
    ], 'follow the packet and task brief constraints'),
  ];
}

function buildExpectedOutputLines(packet: ThinPacket): string[] {
  return [
    'Expected output:',
    ...renderBulletList(
      (packet.expected_output || []).slice(0, 5),
      'complete the task brief and leave verifiable file changes',
    ),
  ];
}

function legacyResult(prompt: string, reason: string): WorkerDispatchPromptResult {
  return {
    prompt,
    mode: 'legacy',
    reason,
    refs: [],
    promptChars: prompt.length,
    legacyPromptChars: prompt.length,
  };
}

function collectDispatchRefs(config: WorkerConfig, worktreePath: string, packet: ThinPacket, requiredRefs: string[]): {
  refs: string[];
  taskBriefRef: string;
  contextRef?: string;
} {
  const copiedRefs = new Set([...requiredRefs, ...copyPacketRefs(config.cwd, worktreePath, packet)]);
  const taskBriefRef = writeTaskBrief(config, worktreePath);
  const contextRef = writeContextRef(config, worktreePath);
  copiedRefs.add(taskBriefRef);
  if (contextRef) copiedRefs.add(contextRef);
  return { refs: [...copiedRefs], taskBriefRef, contextRef };
}

function buildPacketPrompt(args: {
  config: WorkerConfig;
  packet: ThinPacket;
  refs: string[];
  taskBriefRef: string;
  contextRef?: string;
  worktreePath: string;
  worktreeFallbackReason?: string;
}): string {
  const { config, packet, refs, taskBriefRef, contextRef, worktreePath, worktreeFallbackReason = '' } = args;
  return [
    `You are worker ${config.taskId} for Hive.`,
    '',
    `Run ID: ${config.runId || packet.run_id || '-'}`,
    `Task ID: ${config.taskId}`,
    `Goal: ${resolveGoal(config, packet)}`,
    `Status: ${packet.status || '-'}`,
    `Next action: ${packet.next_action || 'read packet refs and execute this task'}`,
    '',
    ...buildReadOrderLines(taskBriefRef, contextRef, refs),
    '',
    ...buildConstraintLines(config, packet),
    '',
    ...buildExpectedOutputLines(packet),
    '',
    buildWorktreeNotice(config.cwd, worktreePath),
    buildInPlaceFallbackNotice(config.cwd, worktreeFallbackReason),
    buildUncertaintyProtocol(config.discussThreshold),
  ].join('\n');
}

function buildPacketFirstResult(args: {
  config: WorkerConfig;
  packet: ThinPacket;
  requiredRefs: string[];
  worktreePath: string;
  worktreeFallbackReason: string;
  legacyPromptLength: number;
}): WorkerDispatchPromptResult {
  const dispatchRefs = collectDispatchRefs(args.config, args.worktreePath, args.packet, args.requiredRefs);
  const prompt = buildPacketPrompt({
    config: args.config,
    packet: args.packet,
    refs: dispatchRefs.refs,
    taskBriefRef: dispatchRefs.taskBriefRef,
    contextRef: dispatchRefs.contextRef,
    worktreePath: args.worktreePath,
    worktreeFallbackReason: args.worktreeFallbackReason,
  });
  return {
    prompt,
    mode: 'packet-first',
    refs: dispatchRefs.refs,
    promptChars: prompt.length,
    legacyPromptChars: args.legacyPromptLength,
  };
}

export function buildWorkerDispatchPrompt(
  config: WorkerConfig,
  worktreePath: string,
  worktreeFallbackReason = '',
): WorkerDispatchPromptResult {
  const legacyPrompt = buildLegacyWorkerPrompt(config, worktreePath, worktreeFallbackReason);
  const packetResult = readPacket(config.cwd, config.runId);
  if (!packetResult.ok || !packetResult.packet) {
    const reason = packetResult.reason || 'packet unavailable';
    recordFallbackNote(config.cwd, config.taskId, reason);
    return legacyResult(legacyPrompt, reason);
  }

  const requiredRefs = ensureRequiredRefs(config.cwd, worktreePath);
  if (!requiredRefs) {
    const reason = 'required handoff refs missing';
    recordFallbackNote(config.cwd, config.taskId, reason);
    return legacyResult(legacyPrompt, reason);
  }

  return buildPacketFirstResult({
    config,
    packet: packetResult.packet,
    requiredRefs,
    worktreePath,
    worktreeFallbackReason,
    legacyPromptLength: legacyPrompt.length,
  });
}
