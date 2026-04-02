import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { CompactConversationContext } from './claude-session-context.js';
import { loadConversationContext } from './claude-session-context.js';
import type { HiveShellDashboardData } from './hiveshell-dashboard.js';
import { loadHiveShellDashboard, resolveHiveShellRunId } from './hiveshell-dashboard.js';
import { loadLatestRunLocator, saveLatestRunLocator } from './run-locator.js';

export interface CompactPacketWorker {
  task_id: string;
  agent_id: string;
  status: string;
  task_summary: string;
  transcript_path?: string;
}

export interface CompactPacket {
  version: 1;
  run_id: string;
  cwd: string;
  origin_cwd?: string;
  task_cwd?: string;
  goal: string;
  status: string;
  round: number;
  summary: string;
  next_action: string;
  score?: number;
  thread_id?: string;
  conversation_context?: CompactConversationContext;
  worker_focus: CompactPacketWorker[];
  suggested_commands: string[];
  detail_sources: string[];
  restore_prompt: string;
}

export interface WorkspaceCompactPacket {
  version: 1;
  cwd: string;
  repo_name: string;
  branch?: string;
  goal: string;
  summary: string;
  next_action: string;
  conversation_context?: CompactConversationContext;
  changed_files: string[];
  suggested_commands: string[];
  detail_sources: string[];
  restore_prompt: string;
}

export interface LatestCompactRestore {
  runId?: string;
  packetPath?: string;
  packetMarkdownPath?: string;
  restorePromptPath: string;
  restorePrompt: string;
}

export interface CompactPacketResult {
  markdown: string;
  jsonPath: string;
  markdownPath: string;
  restorePromptPath: string;
  latestJsonPath: string;
  latestMarkdownPath: string;
  latestRestorePromptPath: string;
  latestRunPath?: string;
}

export interface RunCompactPacketResult extends CompactPacketResult {
  packet: CompactPacket;
  runId: string;
}

export interface WorkspaceCompactPacketResult extends CompactPacketResult {
  packet: WorkspaceCompactPacket;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function truncate(text: string | undefined, limit: number): string {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '-';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function runDir(cwd: string, runId: string): string {
  return path.join(cwd, '.ai', 'runs', runId);
}

function restoreDir(cwd: string): string {
  return path.join(cwd, '.ai', 'restore');
}

function compactPacketJsonPath(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'compact-packet.json');
}

function compactPacketMarkdownPath(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'compact-packet.md');
}

function compactRestorePromptPath(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'compact-restore-prompt.md');
}

function workspaceCompactPacketJsonPath(cwd: string): string {
  return path.join(restoreDir(cwd), 'workspace-compact-packet.json');
}

function workspaceCompactPacketMarkdownPath(cwd: string): string {
  return path.join(restoreDir(cwd), 'workspace-compact-packet.md');
}

function workspaceCompactRestorePromptPath(cwd: string): string {
  return path.join(restoreDir(cwd), 'workspace-compact-restore-prompt.md');
}

function latestCompactPacketJsonPath(cwd: string): string {
  return path.join(restoreDir(cwd), 'latest-compact-packet.json');
}

function latestCompactPacketMarkdownPath(cwd: string): string {
  return path.join(restoreDir(cwd), 'latest-compact-packet.md');
}

function latestCompactRestorePromptPath(cwd: string): string {
  return path.join(restoreDir(cwd), 'latest-compact-restore-prompt.md');
}

function latestCompactRunPath(cwd: string): string {
  return path.join(restoreDir(cwd), 'latest-run.txt');
}

function readText(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function readMarkdownSection(content: string | null, heading: string): string[] {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim() === heading);
  if (startIndex < 0) return [];
  const section: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s+/.test(line.trim())) break;
    const normalized = line.trim();
    if (!normalized) continue;
    section.push(normalized.replace(/^[-*]\s+/, ''));
  }
  return section;
}

function readPlanFile(cwd: string): string | null {
  return readText(path.join(cwd, '.ai', 'plan', 'current.md'));
}

function getRepoName(cwd: string): string {
  return path.basename(cwd) || cwd;
}

function getGitStatusLines(cwd: string): string[] {
  try {
    const output = execSync('git status --short --branch', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    if (!output) return [];
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function getBranchName(statusLines: string[]): string | undefined {
  const branchLine = statusLines[0];
  if (!branchLine?.startsWith('## ')) return undefined;
  return branchLine.slice(3).trim();
}

function buildNextActionText(data: HiveShellDashboardData): string {
  const action = data.state?.next_action;
  if (!action) return '-';
  return truncate(`${action.kind}: ${action.reason}`, 140);
}

function buildWorkerFocus(data: HiveShellDashboardData): CompactPacketWorker[] {
  const workers = data.workerSnapshot?.workers || [];
  const prioritized = [...workers].sort((a, b) => {
    const aActive = a.status === 'running' || a.status === 'starting' || a.status === 'discussing' ? 0 : 1;
    const bActive = b.status === 'running' || b.status === 'starting' || b.status === 'discussing' ? 0 : 1;
    return aActive - bActive || a.task_id.localeCompare(b.task_id);
  });

  return prioritized.slice(0, 3).map((worker) => ({
    task_id: worker.task_id,
    agent_id: worker.agent_id,
    status: worker.status,
    task_summary: truncate(worker.task_summary || worker.last_message || worker.task_description, 120),
    transcript_path: worker.transcript_path,
  }));
}

function buildSuggestedCommands(packet: CompactPacket): string[] {
  const commands = ['hive status', 'hive score'];
  const firstWorker = packet.worker_focus[0]?.task_id;
  if (firstWorker) {
    commands.splice(1, 0, `hive workers ${firstWorker}`);
  } else {
    commands.splice(1, 0, 'hive workers');
  }
  return commands;
}

function buildDetailSources(data: HiveShellDashboardData): string[] {
  const sources: string[] = [];
  const runBase = path.join('.ai', 'runs', data.runId);

  sources.push(path.join(runBase, 'state.json'));
  if (data.workerSnapshot?.workers[0]?.transcript_path) {
    sources.push(data.workerSnapshot.workers[0].transcript_path);
  }
  if (data.mindkeeperCheckpointResult?.threadId) {
    sources.push(`mindkeeper thread ${data.mindkeeperCheckpointResult.threadId}`);
  }
  if (loadConversationContext(data.cwd)) {
    sources.push('.ai/restore/latest-compact-conversation.md');
  }
  sources.push('.ai/plan/current.md');

  return sources;
}

function buildRestorePrompt(packet: CompactPacket): string {
  const worker = packet.worker_focus[0];
  const lines = [
    'You are resuming a Hive run after compact/clear/new.',
    'Use this packet as the primary context. Do not ask for a broad recap first.',
    '',
    `Run: ${packet.run_id}`,
    `Goal: ${packet.goal}`,
    `Status: ${packet.status}`,
    `Round: ${packet.round}`,
    `Summary: ${packet.summary}`,
    `Next action: ${packet.next_action}`,
    `Score: ${typeof packet.score === 'number' ? packet.score : 'n/a'}`,
    `Mindkeeper thread: ${packet.thread_id || '-'}`,
  ];

  if (packet.conversation_context) {
    lines.push('');
    lines.push('Conversation carry-over:');
    if (packet.conversation_context.volatile_facts.length > 0) {
      packet.conversation_context.volatile_facts.forEach((fact, index) => {
        lines.push(`${index + 1}. ${fact}`);
      });
    } else {
      lines.push(packet.conversation_context.summary);
    }
  }

  if (worker) {
    lines.push(
      `Primary worker: ${worker.task_id} | ${worker.agent_id} | ${worker.status}`,
      `Primary worker summary: ${worker.task_summary}`,
      `Primary transcript: ${worker.transcript_path || '-'}`,
    );
  } else {
    lines.push('Primary worker: none');
  }

  lines.push(
    '',
    'Recovery order:',
    ...packet.suggested_commands.map((command, index) => `${index + 1}. ${command}`),
    '',
    'Only if deeper context is needed, inspect these sources in order:',
    ...packet.detail_sources.map((source, index) => `${index + 1}. ${source}`),
    '',
    'When continuing work, stay on the current Hive mainline and keep output concise.',
  );

  return lines.join('\n');
}

function buildWorkspaceGoal(planContent: string | null, cwd: string): string {
  const goalLines = readMarkdownSection(planContent, '## Current Goal');
  if (goalLines.length > 0) {
    return truncate(goalLines.join(' '), 160);
  }
  return `Resume work in ${getRepoName(cwd)}`;
}

function buildWorkspaceSummary(planContent: string | null, statusLines: string[]): string {
  const stageLines = readMarkdownSection(planContent, '## Current Stage');
  if (stageLines.length > 0) {
    return truncate(stageLines.slice(0, 2).join(' '), 180);
  }
  const dirtyCount = statusLines.filter((line) => !line.startsWith('## ')).length;
  if (dirtyCount > 0) {
    return truncate(`${dirtyCount} changed files are still in flight.`, 180);
  }
  return 'No Hive run snapshot is available yet; use the plan and git diff as the restore surface.';
}

function buildWorkspaceNextAction(planContent: string | null): string {
  const nextCandidates = [
    ...readMarkdownSection(planContent, '## Highest Priority Next'),
    ...readMarkdownSection(planContent, '## Next Step After Restore'),
  ];
  if (nextCandidates.length > 0) {
    return truncate(nextCandidates[0], 140);
  }
  return 'Open .ai/plan/current.md, inspect git status, then continue the most recent in-flight slice.';
}

function buildWorkspaceChangedFiles(statusLines: string[]): string[] {
  return statusLines
    .filter((line) => !line.startsWith('## '))
    .slice(0, 8)
    .map((line) => truncate(line, 120));
}

function buildWorkspaceSuggestedCommands(): string[] {
  return ['hive restore', 'git status --short', 'git diff --stat'];
}

function buildWorkspaceDetailSources(cwd: string): string[] {
  const sources = ['.ai/plan/current.md', 'CLAUDE.md'];
  if (loadConversationContext(cwd)) {
    sources.push('.ai/restore/latest-compact-conversation.md');
  }
  if (fs.existsSync(path.join(cwd, '.ai', 'manifest.json'))) {
    sources.push('.ai/manifest.json');
  }
  if (fs.existsSync(path.join(cwd, '.ai', 'agent-release-notes.md'))) {
    sources.push('.ai/agent-release-notes.md');
  }
  return sources;
}

function buildWorkspaceRestorePrompt(packet: WorkspaceCompactPacket): string {
  const lines = [
    'You are resuming work after compact/clear/new, but there is no active Hive run snapshot.',
    'Use this workspace restore card as the smallest resume surface. Do not ask for a broad recap first.',
    '',
    `Workspace: ${packet.repo_name}`,
    `Path: ${packet.cwd}`,
    `Branch: ${packet.branch || '-'}`,
    `Goal: ${packet.goal}`,
    `Summary: ${packet.summary}`,
    `Next action: ${packet.next_action}`,
  ];

  if (packet.conversation_context) {
    lines.push('', 'Conversation carry-over:');
    if (packet.conversation_context.volatile_facts.length > 0) {
      packet.conversation_context.volatile_facts.forEach((fact, index) => {
        lines.push(`${index + 1}. ${fact}`);
      });
    } else {
      lines.push(packet.conversation_context.summary);
    }
  }

  if (packet.changed_files.length > 0) {
    lines.push('Changed files preview:');
    packet.changed_files.forEach((line, index) => {
      lines.push(`${index + 1}. ${line}`);
    });
  } else {
    lines.push('Changed files preview: clean or unavailable');
  }

  lines.push(
    '',
    'Recovery order:',
    ...packet.suggested_commands.map((command, index) => `${index + 1}. ${command}`),
    '',
    'Only if deeper context is needed, inspect these sources in order:',
    ...packet.detail_sources.map((source, index) => `${index + 1}. ${source}`),
    '',
    'If you need a true Hive run artifact later, start or resume through Hive and regenerate compact.',
  );

  return lines.join('\n');
}

export function buildCompactPacket(data: HiveShellDashboardData): CompactPacket {
  const workerFocus = buildWorkerFocus(data);
  const score = data.scoreHistory?.rounds.at(-1)?.score;
  const conversationContext = loadConversationContext(data.cwd);
  const packet: CompactPacket = {
    version: 1,
    run_id: data.runId,
    cwd: data.cwd,
    origin_cwd: data.spec?.origin_cwd || data.cwd,
    task_cwd: data.spec?.task_cwd || data.cwd,
    goal: truncate(data.spec?.goal || data.workerSnapshot?.goal || '-', 160),
    status: data.state?.status || 'unknown',
    round: data.state?.round ?? data.workerSnapshot?.round ?? 0,
    summary: truncate(data.state?.final_summary || 'artifact-backed run', 180),
    next_action: buildNextActionText(data),
    score,
    thread_id: data.mindkeeperCheckpointResult?.threadId || data.mindkeeperBootstrap?.activeThread?.id,
    conversation_context: conversationContext || undefined,
    worker_focus: workerFocus,
    suggested_commands: [],
    detail_sources: [],
    restore_prompt: '',
  };
  packet.suggested_commands = buildSuggestedCommands(packet);
  packet.detail_sources = buildDetailSources(data);
  packet.restore_prompt = buildRestorePrompt(packet);
  return packet;
}

export function buildWorkspaceCompactPacket(cwd: string): WorkspaceCompactPacket {
  const planContent = readPlanFile(cwd);
  const statusLines = getGitStatusLines(cwd);
  const conversationContext = loadConversationContext(cwd);
  const packet: WorkspaceCompactPacket = {
    version: 1,
    cwd,
    repo_name: getRepoName(cwd),
    branch: getBranchName(statusLines),
    goal: buildWorkspaceGoal(planContent, cwd),
    summary: buildWorkspaceSummary(planContent, statusLines),
    next_action: buildWorkspaceNextAction(planContent),
    conversation_context: conversationContext || undefined,
    changed_files: buildWorkspaceChangedFiles(statusLines),
    suggested_commands: buildWorkspaceSuggestedCommands(),
    detail_sources: buildWorkspaceDetailSources(cwd),
    restore_prompt: '',
  };
  packet.restore_prompt = buildWorkspaceRestorePrompt(packet);
  return packet;
}

export function renderCompactPacket(packet: CompactPacket): string {
  const lines = [
    '# Hive Compact Packet',
    '',
    'Keep this packet after compact. It is the smallest restore surface for the current Hive run.',
    '',
    `- run: ${packet.run_id}`,
    `- goal: ${packet.goal}`,
    `- status: ${packet.status}`,
    `- round: ${packet.round}`,
    `- summary: ${packet.summary}`,
    `- next: ${packet.next_action}`,
    `- score: ${typeof packet.score === 'number' ? packet.score : 'n/a'}`,
    `- thread: ${packet.thread_id || '-'}`,
  ];

  if (packet.conversation_context) {
    lines.push('- conversation carry-over:');
    if (packet.conversation_context.volatile_facts.length > 0) {
      packet.conversation_context.volatile_facts.forEach((fact) => {
        lines.push(`  - ${fact}`);
      });
    } else {
      lines.push(`  - ${packet.conversation_context.summary}`);
    }
  }

  if (packet.worker_focus.length > 0) {
    lines.push('- worker focus:');
    for (const worker of packet.worker_focus) {
      lines.push(`  - ${worker.task_id} | ${worker.agent_id} | ${worker.status} | ${worker.task_summary}`);
      if (worker.transcript_path) {
        lines.push(`    transcript: ${worker.transcript_path}`);
      }
    }
  } else {
    lines.push('- worker focus: none');
  }

  lines.push('- recover with:');
  for (const command of packet.suggested_commands) {
    lines.push(`  - ${command}`);
  }

  lines.push('- deep sources:');
  for (const source of packet.detail_sources) {
    lines.push(`  - ${source}`);
  }

  lines.push('', '## Restore Prompt', '', '```text', packet.restore_prompt, '```');

  return lines.join('\n');
}

export function renderWorkspaceCompactPacket(packet: WorkspaceCompactPacket): string {
  const lines = [
    '# Hive Workspace Restore Card',
    '',
    'Keep this card after compact when you do not have a live Hive run. It is the smallest workspace-level restore surface.',
    '',
    `- repo: ${packet.repo_name}`,
    `- path: ${packet.cwd}`,
    `- branch: ${packet.branch || '-'}`,
    `- goal: ${packet.goal}`,
    `- summary: ${packet.summary}`,
    `- next: ${packet.next_action}`,
  ];

  if (packet.conversation_context) {
    lines.push('- conversation carry-over:');
    if (packet.conversation_context.volatile_facts.length > 0) {
      packet.conversation_context.volatile_facts.forEach((fact) => {
        lines.push(`  - ${fact}`);
      });
    } else {
      lines.push(`  - ${packet.conversation_context.summary}`);
    }
  }

  if (packet.changed_files.length > 0) {
    lines.push('- changed files:');
    for (const line of packet.changed_files) {
      lines.push(`  - ${line}`);
    }
  } else {
    lines.push('- changed files: clean or unavailable');
  }

  lines.push('- recover with:');
  for (const command of packet.suggested_commands) {
    lines.push(`  - ${command}`);
  }

  lines.push('- deep sources:');
  for (const source of packet.detail_sources) {
    lines.push(`  - ${source}`);
  }

  lines.push('', '## Restore Prompt', '', '```text', packet.restore_prompt, '```');

  return lines.join('\n');
}

function writeLatestAliases(
  cwd: string,
  jsonPayload: unknown,
  markdown: string,
  restorePrompt: string,
): {
  latestJsonPath: string;
  latestMarkdownPath: string;
  latestRestorePromptPath: string;
} {
  ensureDir(restoreDir(cwd));
  const latestJsonPath = latestCompactPacketJsonPath(cwd);
  const latestMarkdownPath = latestCompactPacketMarkdownPath(cwd);
  const latestRestorePromptPath = latestCompactRestorePromptPath(cwd);
  fs.writeFileSync(latestJsonPath, JSON.stringify(jsonPayload, null, 2));
  fs.writeFileSync(latestMarkdownPath, `${markdown}\n`, 'utf-8');
  fs.writeFileSync(latestRestorePromptPath, `${restorePrompt}\n`, 'utf-8');
  return {
    latestJsonPath,
    latestMarkdownPath,
    latestRestorePromptPath,
  };
}

export function saveCompactPacket(cwd: string, runId: string, packet: CompactPacket): {
  jsonPath: string;
  markdownPath: string;
  restorePromptPath: string;
  latestJsonPath: string;
  latestMarkdownPath: string;
  latestRestorePromptPath: string;
  latestRunPath: string;
} {
  const dir = runDir(cwd, runId);
  ensureDir(dir);
  const jsonPath = compactPacketJsonPath(cwd, runId);
  const markdownPath = compactPacketMarkdownPath(cwd, runId);
  const restorePromptPath = compactRestorePromptPath(cwd, runId);
  const latestRunPath = latestCompactRunPath(cwd);
  const markdown = renderCompactPacket(packet);
  fs.writeFileSync(jsonPath, JSON.stringify(packet, null, 2));
  fs.writeFileSync(markdownPath, `${markdown}\n`, 'utf-8');
  fs.writeFileSync(restorePromptPath, `${packet.restore_prompt}\n`, 'utf-8');
  const latestPaths = writeLatestAliases(cwd, packet, markdown, packet.restore_prompt);
  fs.writeFileSync(latestRunPath, `${runId}\n`, 'utf-8');
  if (packet.origin_cwd && packet.origin_cwd !== cwd) {
    saveLatestRunLocator({
      version: 1,
      run_id: runId,
      origin_cwd: packet.origin_cwd,
      task_cwd: cwd,
      latest_restore_prompt_path: latestPaths.latestRestorePromptPath,
      latest_packet_path: latestPaths.latestJsonPath,
      updated_at: new Date().toISOString(),
    });
  }
  return {
    jsonPath,
    markdownPath,
    restorePromptPath,
    latestJsonPath: latestPaths.latestJsonPath,
    latestMarkdownPath: latestPaths.latestMarkdownPath,
    latestRestorePromptPath: latestPaths.latestRestorePromptPath,
    latestRunPath,
  };
}

export function saveWorkspaceCompactPacket(cwd: string, packet: WorkspaceCompactPacket): CompactPacketResult {
  ensureDir(restoreDir(cwd));
  const jsonPath = workspaceCompactPacketJsonPath(cwd);
  const markdownPath = workspaceCompactPacketMarkdownPath(cwd);
  const restorePromptPath = workspaceCompactRestorePromptPath(cwd);
  const latestRunPath = latestCompactRunPath(cwd);
  const markdown = renderWorkspaceCompactPacket(packet);
  fs.writeFileSync(jsonPath, JSON.stringify(packet, null, 2));
  fs.writeFileSync(markdownPath, `${markdown}\n`, 'utf-8');
  fs.writeFileSync(restorePromptPath, `${packet.restore_prompt}\n`, 'utf-8');
  const latestPaths = writeLatestAliases(cwd, packet, markdown, packet.restore_prompt);
  if (fs.existsSync(latestRunPath)) {
    fs.rmSync(latestRunPath, { force: true });
  }
  return {
    markdown,
    jsonPath,
    markdownPath,
    restorePromptPath,
    latestJsonPath: latestPaths.latestJsonPath,
    latestMarkdownPath: latestPaths.latestMarkdownPath,
    latestRestorePromptPath: latestPaths.latestRestorePromptPath,
  };
}

export function loadCompactPacket(
  cwd: string,
  runId?: string,
): RunCompactPacketResult | null {
  const resolvedRunId = resolveHiveShellRunId(cwd, runId);
  if (!resolvedRunId) return null;
  const data = loadHiveShellDashboard(cwd, resolvedRunId);
  if (!data) return null;
  const packet = buildCompactPacket(data);
  const markdown = renderCompactPacket(packet);
  const paths = saveCompactPacket(cwd, resolvedRunId, packet);
  return {
    packet,
    markdown,
    runId: resolvedRunId,
    jsonPath: paths.jsonPath,
    markdownPath: paths.markdownPath,
    restorePromptPath: paths.restorePromptPath,
    latestJsonPath: paths.latestJsonPath,
    latestMarkdownPath: paths.latestMarkdownPath,
    latestRestorePromptPath: paths.latestRestorePromptPath,
    latestRunPath: paths.latestRunPath,
  };
}

export function loadWorkspaceCompactPacket(cwd: string): WorkspaceCompactPacketResult {
  const packet = buildWorkspaceCompactPacket(cwd);
  const saved = saveWorkspaceCompactPacket(cwd, packet);
  return {
    packet,
    ...saved,
  };
}

export function loadLatestCompactRestore(
  cwd: string,
): LatestCompactRestore | null {
  const restorePromptPath = latestCompactRestorePromptPath(cwd);
  const restorePrompt = readText(restorePromptPath);
  if (!restorePrompt?.trim()) {
    const locator = loadLatestRunLocator(cwd);
    if (!locator?.latest_restore_prompt_path) return null;
    const pointedPrompt = readText(locator.latest_restore_prompt_path);
    if (!pointedPrompt?.trim()) return null;
    return {
      runId: locator.run_id,
      packetPath: locator.latest_packet_path,
      packetMarkdownPath: locator.latest_packet_path?.replace(/\.json$/, '.md'),
      restorePromptPath: locator.latest_restore_prompt_path,
      restorePrompt: pointedPrompt.trim(),
    };
  }

  const runId = readText(latestCompactRunPath(cwd))?.trim() || undefined;
  const packetPath = fs.existsSync(latestCompactPacketJsonPath(cwd))
    ? latestCompactPacketJsonPath(cwd)
    : undefined;
  const packetMarkdownPath = fs.existsSync(latestCompactPacketMarkdownPath(cwd))
    ? latestCompactPacketMarkdownPath(cwd)
    : undefined;

  return {
    runId,
    packetPath,
    packetMarkdownPath,
    restorePromptPath,
    restorePrompt: restorePrompt.trim(),
  };
}
