// ═══════════════════════════════════════════════════════════════════
// orchestrator/task-context-pack.ts — Phase 1A: Fresh Session + Context Pack
// ═══════════════════════════════════════════════════════════════════
// 目标：
//   - 为每个 task dispatch 生成显式的 context pack artifact
//   - 避免模糊的"自己去找上下文"，注入内容可检查、可测试、可复现
//   - 强化 fresh session / worktree ownership，禁止静默复用被污染的旧 session
// ═══════════════════════════════════════════════════════════════════

import path from 'path';
import fs from 'fs';
import type {
  TaskContextPack,
  TaskContextSource,
  DispatchContextRecord,
  ContextPacket,
  SubTask,
  WorkerResult,
  PromptPolicyFragmentId,
  PromptPolicySelection,
  ReviewFinding,
  VerificationResult,
} from './types.js';

// ── Constants ──

const MAX_GOAL_SNIPPET_LENGTH = 400;
const MAX_UPSTREAM_CONTEXTS = 5;

// ── Context Pack Builder ──

export interface ContextPackBuilderOptions {
  runId: string;
  planId: string;
  round: number;
  selectedFiles?: string[];
  goalSnippets?: string[];
  promptPolicy?: PromptPolicySelection;
  assignedModel?: string;
  assignedProvider?: string;
}

export interface BuildRepairContextOptions {
  previousError?: string;
  previousChangedFiles?: string[];
  reviewFindings?: ReviewFinding[];
  verificationFailures?: VerificationResult[];
  repairGuidance?: string[];
}

/**
 * 为 repair round 构建 repair context
 */
export function buildRepairContext(options: BuildRepairContextOptions): TaskContextPack['repair_context'] {
  const repairContext: TaskContextPack['repair_context'] = {};

  if (options.previousError) {
    repairContext.previous_error = options.previousError.slice(0, 1000);
  }

  if (options.previousChangedFiles && options.previousChangedFiles.length > 0) {
    repairContext.previous_changed_files = options.previousChangedFiles;
  }

  if (options.reviewFindings && options.reviewFindings.length > 0) {
    repairContext.review_findings = options.reviewFindings.map((f) => ({
      severity: f.severity,
      file: f.file,
      line: f.line,
      issue: f.issue.slice(0, 300),
    }));
  }

  if (options.verificationFailures && options.verificationFailures.length > 0) {
    repairContext.verification_failures = options.verificationFailures.map((v) => ({
      type: v.failure_class || 'unknown',
      message: (v.stderr_tail || v.stdout_tail || 'verification failed').slice(0, 300),
      command: v.target.command,
    }));
  }

  if (options.repairGuidance && options.repairGuidance.length > 0) {
    repairContext.repair_guidance = options.repairGuidance.map((g) => g.slice(0, 200));
  }

  return repairContext;
}

/**
 * 从 upstream context packets 中选择相关的上下文
 * 限制数量避免上下文爆炸
 */
export function selectUpstreamContext(
  packets: ContextPacket[],
  maxCount: number = MAX_UPSTREAM_CONTEXTS,
): ContextPacket[] {
  // 已经有依赖关系的 packets 直接返回（由 caller 过滤）
  // 这里只做截断
  return packets.slice(0, maxCount);
}

/**
 * 为 task 构建 TaskContextPack
 * 这是 Phase 1A 的核心：每个 dispatch 都有显式的 context artifact
 */
export function buildTaskContextPack(
  task: SubTask,
  options: ContextPackBuilderOptions,
  upstreamContexts: ContextPacket[] = [],
  repairOptions?: BuildRepairContextOptions,
): TaskContextPack {
  const isRepair = options.round > 0 || Boolean(repairOptions);

  const pack: TaskContextPack = {
    generated_at: new Date().toISOString(),
    run_id: options.runId,
    plan_id: options.planId,
    task_id: task.id,
    task_objective: task.description.slice(0, 500),
    round: options.round,
    is_repair: isRepair,
    selected_files: options.selectedFiles || task.estimated_files || [],
    verification_profile: task.verification_profile,
    prompt_fragments: options.promptPolicy?.fragments,
    prompt_policy_version: options.promptPolicy?.version,
    goal_snippets: options.goalSnippets?.map((s) =>
      s.slice(0, MAX_GOAL_SNIPPET_LENGTH),
    ),
    upstream_context: selectUpstreamContext(upstreamContexts),
    assigned_model: options.assignedModel,
    assigned_provider: options.assignedProvider,
    execution_contract: task.execution_contract,
  };

  if (isRepair && repairOptions) {
    pack.repair_context = buildRepairContext(repairOptions);
  }

  return pack;
}

// ── Context Pack Serializer ──

/**
 * 将 TaskContextPack 序列化为可注入 worker 的 prompt 片段
 */
export function serializeContextPack(pack: TaskContextPack): string {
  const sections: string[] = [];

  // Section 1: Task Objective
  sections.push(`## Task Objective
Task ID: ${pack.task_id}
Round: ${pack.round}${pack.is_repair ? ' (REPAIR ROUND)' : ''}

${pack.task_objective}`);

  // Section 2: Selected Files
  if (pack.selected_files.length > 0) {
    sections.push(`
## Selected Files
${pack.selected_files.map((f) => `- ${f}`).join('\n')}`);
  }

  // Section 3: Verification Profile
  if (pack.verification_profile) {
    sections.push(`
## Verification Profile
${pack.verification_profile}`);
  }

  if (pack.execution_contract) {
    sections.push(`
## Execution Contract
${pack.execution_contract}`);
  }

  // Section 4: Prompt Policy
  if (pack.prompt_fragments && pack.prompt_fragments.length > 0) {
    sections.push(`
## Prompt Policy
Version: ${pack.prompt_policy_version || 'unspecified'}
Fragments: ${pack.prompt_fragments.join(', ')}`);
  }

  // Section 5: Upstream Context
  if (pack.upstream_context.length > 0) {
    sections.push(`
## Upstream Context
${pack.upstream_context
  .map(
    (ctx) => `### From Task: ${ctx.from_task}
Summary: ${ctx.summary}
Key Outputs: ${ctx.key_outputs.map((o) => `\`${o.file}\``).join(', ')}
Decisions: ${ctx.decisions_made.join('; ') || 'none'}`,
  )
  .join('\n\n')}`);
  }

  // Section 6: Repair Context (if applicable)
  if (pack.repair_context) {
    const rc = pack.repair_context;
    const rcSections: string[] = ['## Repair Context'];

    if (rc.previous_error) {
      rcSections.push(`Previous Error: ${rc.previous_error}`);
    }

    if (rc.previous_changed_files && rc.previous_changed_files.length > 0) {
      rcSections.push(`Previous Changed Files: ${rc.previous_changed_files.join(', ')}`);
    }

    if (rc.review_findings && rc.review_findings.length > 0) {
      rcSections.push(`Review Findings:\n${rc.review_findings.map((f) => `- [${f.severity}] ${f.file}: ${f.issue}`).join('\n')}`);
    }

    if (rc.verification_failures && rc.verification_failures.length > 0) {
      rcSections.push(`Verification Failures:\n${rc.verification_failures.map((v) => `- [${v.type}] ${v.message}`).join('\n')}`);
    }

    if (rc.repair_guidance && rc.repair_guidance.length > 0) {
      rcSections.push(`Repair Guidance:\n${rc.repair_guidance.map((g) => `- ${g}`).join('\n')}`);
    }

    sections.push(rcSections.join('\n'));
  }

  return sections.join('\n\n');
}

// ── Context Pack Artifact (Persistence) ──

/**
 * 生成 context pack artifact 文件名
 */
export function contextPackFileName(taskId: string, round: number): string {
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `context-pack-${safeTaskId}-r${round}.json`;
}

/**
 * 获取 context pack artifact 目录
 */
export function contextPackArtifactsDir(cwd: string, runId: string): string {
  return path.join(cwd, '.ai', 'runs', runId, 'context-packs');
}

/**
 * 持久化 TaskContextPack 到 artifact 文件
 */
export function persistContextPack(
  cwd: string,
  runId: string,
  pack: TaskContextPack,
): string {
  const artifactsDir = contextPackArtifactsDir(cwd, runId);

  // Ensure directory exists
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  const fileName = contextPackFileName(pack.task_id, pack.round);
  const filePath = path.join(artifactsDir, fileName);

  fs.writeFileSync(filePath, JSON.stringify(pack, null, 2), 'utf-8');
  return filePath;
}

/**
 * 加载已持久化的 TaskContextPack
 */
export function loadContextPack(
  cwd: string,
  runId: string,
  taskId: string,
  round: number,
): TaskContextPack | null {
  try {
    const artifactsDir = contextPackArtifactsDir(cwd, runId);
    const fileName = contextPackFileName(taskId, round);
    const filePath = path.join(artifactsDir, fileName);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TaskContextPack;
  } catch {
    return null;
  }
}

// ── Dispatch Context Recorder ──

/**
 * 记录 dispatch 时实际注入的上下文
 * 用于后续检查/测试/复现
 */
export interface DispatchContextRecorder {
  /** 记录一次 dispatch 的 context 注入 */
  record(record: DispatchContextRecord): void;
  /** 获取某 task 的所有 dispatch 记录 */
  getRecords(taskId: string): DispatchContextRecord[];
  /** 获取某 run 的所有 dispatch 记录 */
  getRunRecords(runId: string): DispatchContextRecord[];
}

/**
 * 创建 dispatch context recorder
 * 使用 in-memory 存储，可选持久化
 */
export function createDispatchContextRecorder(): DispatchContextRecorder {
  const records = new Map<string, DispatchContextRecord[]>(); // taskId -> records

  return {
    record(record: DispatchContextRecord) {
      const taskId = record.task_id;
      if (!records.has(taskId)) {
        records.set(taskId, []);
      }
      records.get(taskId)!.push(record);
    },

    getRecords(taskId: string): DispatchContextRecord[] {
      return records.get(taskId) || [];
    },

    getRunRecords(runId: string): DispatchContextRecord[] {
      const allRecords: DispatchContextRecord[] = [];
      for (const taskRecords of records.values()) {
        allRecords.push(...taskRecords.filter((r) => r.run_id === runId));
      }
      return allRecords;
    },
  };
}

// ── Global Recorder (singleton) ──

let globalRecorder: DispatchContextRecorder | null = null;

export function getGlobalDispatchRecorder(): DispatchContextRecorder {
  if (!globalRecorder) {
    globalRecorder = createDispatchContextRecorder();
  }
  return globalRecorder;
}

export function resetGlobalDispatchRecorder(): void {
  globalRecorder = null;
}

// ── Fresh Session Guard ──

/**
 * 检查是否应该使用 fresh session
 * Phase 1A 规则：
 * - 每个 task 默认 fresh session
 * - repair round 也使用 fresh session (不复用旧 session)
 * - 禁止静默复用被污染的旧 session 状态
 */
export function shouldUseFreshSession(options: {
  taskId: string;
  round: number;
  isRepair: boolean;
  existingSessionId?: string;
}): boolean {
  // Round > 0 (repair round) always uses fresh session
  if (options.round > 0 || options.isRepair) {
    return true;
  }

  // First round always uses fresh session
  return true;
}

/**
 * 生成 fresh session ID
 */
export function generateFreshSessionId(taskId: string, round: number): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `fresh-${taskId}-r${round}-${timestamp}-${random}`;
}

// ── Helper: Build context packets from upstream worker results ──

export interface UpstreamContextOptions {
  maxContexts?: number;
}

/**
 * 从已完成的 worker 结果中构建 upstream context packets
 */
export function buildUpstreamContextPackets(
  completedResults: WorkerResult[],
  dependentTaskIds: string[],
  options: UpstreamContextOptions = {},
): ContextPacket[] {
  const { maxContexts = MAX_UPSTREAM_CONTEXTS } = options;

  // Filter results for tasks that this task depends on
  const relevantResults = completedResults.filter((r) =>
    dependentTaskIds.includes(r.taskId) && r.success,
  );

  // Build context packets
  const packets: ContextPacket[] = relevantResults.map((result) => {
    const assistantMessages = result.output.filter(
      (m) => m.type === 'assistant' || m.type === 'system',
    );

    const summary =
      assistantMessages.length > 0
        ? assistantMessages
            .map((m) => m.content)
            .join('\n')
            .slice(0, 500)
        : 'No assistant output available.';

    const keyOutputs = result.changedFiles.map((file) => ({
      file,
      purpose: inferFilePurpose(file),
      key_exports: [],
    }));

    const decisionsMade = extractDecisionsFromMessages(assistantMessages);

    return {
      from_task: result.taskId,
      summary,
      key_outputs: keyOutputs,
      decisions_made: decisionsMade,
    };
  });

  return packets.slice(0, maxContexts);
}

/**
 * 推断文件用途
 */
function inferFilePurpose(filePath: string): string {
  const parts = filePath.split('/');
  const fileName = parts[parts.length - 1] || '';

  if (fileName.includes('.test.') || fileName.includes('.spec.')) {
    return '测试文件';
  }
  if (fileName.includes('.config.') || fileName.includes('.rc.')) {
    return '配置文件';
  }
  if (fileName.endsWith('.md')) {
    return '文档';
  }
  if (fileName.endsWith('.json')) {
    return '数据/配置';
  }
  if (fileName.endsWith('.ts') || fileName.endsWith('.js')) {
    if (fileName.includes('controller') || fileName.includes('handler')) {
      return '控制器/处理器';
    }
    if (fileName.includes('service')) {
      return '服务层';
    }
    if (fileName.includes('repository') || fileName.includes('dao')) {
      return '数据访问层';
    }
    if (fileName.includes('types') || fileName.endsWith('types.ts')) {
      return '类型定义';
    }
    if (fileName.includes('utils') || fileName.includes('helpers')) {
      return '工具函数';
    }
    return '源代码';
  }

  return '未知用途';
}

/**
 * 从消息中提取决策
 */
function extractDecisionsFromMessages(
  messages: Array<{ type: string; content: string }>,
): string[] {
  const decisions: string[] = [];
  const maxDecisions = 10;

  for (const msg of messages) {
    const content = msg.content;

    // Capture decision patterns
    const decisionMatches = content.matchAll(
      /(决定 | 选择 | 采用 | 使用 | decided|chose|adopted|using)[:：]\s*(.+?)(?:\n|$)/g,
    );

    for (const match of decisionMatches) {
      if (decisions.length >= maxDecisions) break;
      decisions.push(match[2].trim());
    }

    // Capture conclusion patterns
    const conclusionMatches = content.matchAll(
      /(结论 | 总结 | 综上 | conclusion|summary)[:：]\s*(.+?)(?:\n|$)/g,
    );

    for (const match of conclusionMatches) {
      if (decisions.length >= maxDecisions) break;
      decisions.push(match[2].trim());
    }
  }

  return decisions;
}
