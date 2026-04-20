import { execSync } from 'child_process';
import path from 'path';
import type {
  TaskPlan,
  TranslationResult,
  PlanDiscussResult,
  StageTokenUsage,
  PlannerDiscussRoomRef,
  CollabConfig,
  CollabLifecycleEvent,
  CollabStatusSnapshot,
  PlanningBrief,
  ProjectMemoryStore,
  MemoryRecallInput,
} from './types.js';
import { buildPlanFromClaudeOutput, PLAN_PROMPT_TEMPLATE } from './planner.js';
import { translateToEnglish } from './translator.js';
import { ModelRegistry } from './model-registry.js';
import { loadConfig, resolveTierModel, getBudgetWarning } from './hive-config.js';
import { resolveEffectiveRunModelPolicy } from './run-model-policy.js';
import { describeTaskVerificationRules } from './project-policy.js';
import type { DiscussPlanDiag } from './discuss-bridge.js';
import { resolveProviderForModel } from './provider-resolver.js';
import {
  openPlannerDiscussRoom,
  collectPlannerDiscussReplies,
  buildRoomRef,
  closePlannerDiscussRoom,
} from './agentbus-adapter.js';

const MAX_COLLAB_EVENTS = 8;

const PLANNER_CONTEXT_EXCLUDED_GLOBS = [
  'node_modules/**',
  'dist/**',
  '.git/**',
  '.ai/**',
  '.sessions/**',
] as const;

const PLANNER_FILE_TREE_MAX_LINES = 60;
const PLANNER_TYPE_SEARCH_MAX_LINES = 35;
const PLANNER_CONTEXT_SECTION_CHAR_LIMIT = 1200;
export const PLANNER_CONTEXT_TOTAL_CHAR_LIMIT = 4200;
const CLAUDE_PLANNER_TIMEOUT_MS = 120_000;
const DOMESTIC_PLANNER_TIMEOUT_MS = 45_000;
const DISCUSS_SYNTHESIS_TIMEOUT_MS = 20_000;

export function buildPlannerFileTreeCommand(maxLines = 80): string {
  const includeGlobs = ['*.ts', '*.js', '*.json']
    .map((glob) => `-g '${glob}'`)
    .join(' ');
  const excludeGlobs = PLANNER_CONTEXT_EXCLUDED_GLOBS
    .map((glob) => `-g '!${glob}' -g '!**/${glob}'`)
    .join(' ');
  return `rg --files ${includeGlobs} ${excludeGlobs} | sort | head -${maxLines}`;
}

export function buildPlannerTypeSearchCommand(maxLines = 50): string {
  const excludeGlobs = PLANNER_CONTEXT_EXCLUDED_GLOBS
    .map((glob) => `-g '!${glob}' -g '!**/${glob}'`)
    .join(' ');
  return `rg -n "^export (interface|type|enum)" -g '*.ts' ${excludeGlobs} . | head -${maxLines}`;
}

function collectFileTree(cwd: string, maxLines = 80): string {
  try {
    const raw = execSync(buildPlannerFileTreeCommand(maxLines), {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    });
    return raw.trim();
  } catch {
    return '(file tree unavailable)';
  }
}

function collectKeyTypes(cwd: string, maxLines = 50): string {
  try {
    const raw = execSync(buildPlannerTypeSearchCommand(maxLines), {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    });
    return raw.trim();
  } catch {
    return '(type signatures unavailable)';
  }
}

function truncatePlannerContextSection(text: string, limit: number, label: string): string {
  const normalized = text.trim() || `(${label} unavailable)`;
  if (normalized.length <= limit) {
    return normalized;
  }
  const suffix = `\n... [${label} truncated]`;
  const head = normalized.slice(0, Math.max(0, limit - suffix.length));
  return `${head}${suffix}`;
}

export function buildPlannerContext(cwd: string): string {
  const fileTree = truncatePlannerContextSection(
    collectFileTree(cwd, PLANNER_FILE_TREE_MAX_LINES),
    PLANNER_CONTEXT_SECTION_CHAR_LIMIT,
    'file tree',
  );
  const keyTypes = truncatePlannerContextSection(
    collectKeyTypes(cwd, PLANNER_TYPE_SEARCH_MAX_LINES),
    PLANNER_CONTEXT_SECTION_CHAR_LIMIT,
    'exported types',
  );
  const taskRules = truncatePlannerContextSection(
    describeTaskVerificationRules(cwd),
    PLANNER_CONTEXT_SECTION_CHAR_LIMIT,
    'task verification rules',
  );
  return truncatePlannerContextSection(
    `\n## Codebase Context (auto-collected)\n### File tree\n\`\`\`\n${fileTree}\n\`\`\`\n### Exported types\n\`\`\`\n${keyTypes}\n\`\`\`\n### Task verification rules\n${taskRules}\n`,
    PLANNER_CONTEXT_TOTAL_CHAR_LIMIT,
    'planner context',
  );
}

export function parseJsonBlock<T>(raw: string): T {
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1].trim()) as T;
    } catch {
      // fall through
    }
  }

  const braceStart = raw.indexOf('{');
  if (braceStart >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = braceStart; i < raw.length; i++) {
      const c = raw[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\') {
        esc = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === '{') depth++;
      if (c === '}') {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(braceStart, i + 1);
          try {
            return JSON.parse(candidate) as T;
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error('Planner did not return valid JSON');
}

export interface PlannerRunResult {
  text: string;
  tokenUsage: { input: number; output: number };
  diagnostics: PlannerRunDiagnostics;
}

export interface PlannerRunDiagnostics extends Record<string, unknown> {
  modelId: string;
  agentModel: string;
  resolvedBaseUrl: string | null;
  providerResolveFailed: string | null;
  maxTurns: number;
  messageCount: number;
  rawLength: number;
  messages: string[];
  exitError: string | null;
  toolUseDetected: boolean;
  toolUseNames: string[];
}

function normalizePlannerMessages(result: { messages?: unknown }): any[] {
  return Array.isArray(result?.messages) ? result.messages : [];
}

function buildPlannerPrompt(prompt: string, modelId: string): string {
  if (modelId.startsWith('claude-')) {
    return prompt;
  }
  return [
    prompt,
    '',
    '## Planner Output Contract',
    'Return exactly one JSON object in your first reply.',
    'Do not use tools, do not inspect files, do not emit markdown fences, and do not ask follow-up questions.',
    'If the context looks insufficient, still produce the best-effort task JSON using only the provided context.',
  ].join('\n');
}

function getPlannerTimeoutMs(modelId: string): number {
  return modelId.startsWith('claude-')
    ? CLAUDE_PLANNER_TIMEOUT_MS
    : DOMESTIC_PLANNER_TIMEOUT_MS;
}

class PlannerRunError extends Error {
  rawText: string;
  diagnostics: PlannerRunDiagnostics | null;

  constructor(message: string, rawText: string, diagnostics: PlannerRunDiagnostics | null) {
    super(message);
    this.name = 'PlannerRunError';
    this.rawText = rawText;
    this.diagnostics = diagnostics;
  }
}

function isPlannerRunError(error: unknown): error is PlannerRunError {
  return error instanceof PlannerRunError;
}

function collectPlannerToolUseNames(messages: any[]): string[] {
  const names = new Set<string>();

  for (const message of messages) {
    if (message?.type !== 'assistant') {
      continue;
    }
    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block.name === 'string' && block.name.trim()) {
          names.add(block.name.trim());
        }
      }
      continue;
    }
    if (typeof content === 'string') {
      const matches = content.matchAll(/"type"\s*:\s*"tool_use"[\s\S]*?"name"\s*:\s*"([^"]+)"/g);
      for (const match of matches) {
        if (match[1]) {
          names.add(match[1].trim());
        }
      }
    }
  }

  return [...names];
}

export function describePlannerJsonError(
  raw: string,
  diagnostics: PlannerRunDiagnostics | null = null,
): string {
  const toolSuffix = diagnostics?.toolUseNames?.length
    ? ` (${diagnostics.toolUseNames.join(', ')})`
    : '';
  if (diagnostics?.toolUseDetected) {
    return `Planner attempted tool use${toolSuffix} instead of returning JSON`;
  }
  if (!raw.trim() && diagnostics?.exitError) {
    return `Planner returned no JSON output before transport error: ${diagnostics.exitError}`;
  }
  if (!raw.trim()) {
    return 'Planner returned empty output instead of valid JSON';
  }
  return 'Planner did not return valid JSON';
}

export function parsePlannerJsonBlock<T>(
  raw: string,
  diagnostics: PlannerRunDiagnostics | null = null,
): T {
  try {
    return parseJsonBlock<T>(raw);
  } catch {
    throw new Error(describePlannerJsonError(raw, diagnostics));
  }
}

export interface PlanGoalResult {
  plan: TaskPlan | null;
  translation: TranslationResult | null;
  planner_model: string;
  planner_stage_usage: StageTokenUsage | null;
  extra_stage_usages: StageTokenUsage[];
  planner_raw_output: string;
  planner_error: string | null;
  planner_diagnostics: PlannerRunResult['diagnostics'] | null;
  plan_discuss: PlanDiscussResult | null;
  discuss_diag: DiscussPlanDiag | null;
  plan_discuss_room: PlannerDiscussRoomRef | null;
  plan_discuss_collab: CollabStatusSnapshot | null;
  budget_warning: string | null;
}

export interface PlannerDiscussExecutionResult {
  plan_discuss: PlanDiscussResult | null;
  discuss_diag: DiscussPlanDiag | null;
  plan_discuss_room: PlannerDiscussRoomRef | null;
  plan_discuss_collab: CollabStatusSnapshot | null;
}

export interface PlannerDiscussProgressHooks {
  onSnapshot?: (snapshot: CollabStatusSnapshot) => void | Promise<void>;
}

export interface PlanGoalHooks {
  onPlannerDiscussSnapshot?: (snapshot: CollabStatusSnapshot) => void | Promise<void>;
}

function collectReviewFocus(plan: TaskPlan): string {
  const focusAreas = new Set<string>();
  const categories = [...new Set(plan.tasks.map((task) => task.category))];
  const hasHighComplexity = plan.tasks.some((task) => task.complexity === 'high' || task.complexity === 'medium-high');
  const overlappingFiles = new Set<string>();
  const seenFiles = new Set<string>();

  for (const task of plan.tasks) {
    for (const estimatedFile of task.estimated_files) {
      if (seenFiles.has(estimatedFile)) {
        overlappingFiles.add(estimatedFile);
      } else {
        seenFiles.add(estimatedFile);
      }
    }
  }

  if (categories.length > 0) {
    focusAreas.add(`Check whether the ${categories.slice(0, 3).join(', ')} split matches the goal.`);
  }
  if (plan.execution_order.length > 1 || Object.keys(plan.context_flow).length > 0) {
    focusAreas.add('Check dependency ordering and context handoff between task groups.');
  }
  if (hasHighComplexity) {
    focusAreas.add('Check whether higher-complexity tasks are assigned to strong enough models.');
  }
  if (overlappingFiles.size > 0) {
    focusAreas.add(`Check merge risk around shared files like ${[...overlappingFiles].slice(0, 3).join(', ')}.`);
  }

  if (focusAreas.size === 0) {
    focusAreas.add('Check task completeness, execution order, and model fit.');
  }

  return [...focusAreas].join(' ');
}

function collectPlanningQuestions(plan: TaskPlan): string[] {
  const questions: string[] = [];
  const highComplexityTasks = plan.tasks
    .filter((task) => task.complexity === 'high' || task.complexity === 'medium-high')
    .map((task) => task.id);
  const overlappingFiles = new Set<string>();
  const seenFiles = new Set<string>();

  if (plan.execution_order.length > 2) {
    questions.push('Is the dependency ordering across execution groups correct?');
  }

  for (const task of plan.tasks) {
    for (const estimatedFile of task.estimated_files) {
      if (seenFiles.has(estimatedFile)) {
        overlappingFiles.add(estimatedFile);
      } else {
        seenFiles.add(estimatedFile);
      }
    }
  }

  if (highComplexityTasks.length > 0) {
    questions.push(`Are ${highComplexityTasks.slice(0, 2).join(', ')} assigned to strong enough models?`);
  }
  if (overlappingFiles.size > 0) {
    questions.push('Are there merge conflict risks from overlapping estimated files?');
  }
  if (questions.length === 0) {
    questions.push('Is the task split complete enough to deliver the goal?');
    questions.push('Are model assignments and execution order sensible for this plan?');
  }

  return questions.slice(0, 3);
}

export function buildPlanningBrief(
  plan: TaskPlan,
  plannerModel: string,
): PlanningBrief {
  return {
    type: 'planning-brief',
    version: 1,
    created_at: new Date().toISOString(),
    goal: plan.goal,
    planner_model: plannerModel,
    cwd_hint: path.basename(plan.cwd),
    task_count: plan.tasks.length,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      complexity: task.complexity,
      category: task.category,
      description: task.description.slice(0, 200),
      assigned_model: task.assigned_model,
      depends_on: [...task.depends_on],
      estimated_files: [...task.estimated_files],
    })),
    execution_order: plan.execution_order.map((group) => [...group]),
    context_flow: Object.fromEntries(
      Object.entries(plan.context_flow).map(([taskId, deps]) => [taskId, [...deps]]),
    ),
    review_focus: collectReviewFocus(plan),
    questions: collectPlanningQuestions(plan),
  };
}

export function renderPlanningBriefForSynthesis(brief: PlanningBrief): string {
  const sections: string[] = [];

  sections.push(`Goal: ${brief.goal}`);
  sections.push(`Planner Model: ${brief.planner_model}`);
  sections.push(`Working Directory: ${brief.cwd_hint}`);
  sections.push('');

  sections.push(`Tasks: ${brief.task_count} total`);
  sections.push(`Execution Groups: ${brief.execution_order.length}`);
  if (Object.keys(brief.context_flow).length > 0) {
    const deps = Object.entries(brief.context_flow)
      .map(([task, deps]) => `${task} depends on ${deps.join(', ')}`)
      .join('; ');
    sections.push(`Dependencies: ${deps}`);
  }
  sections.push('');

  sections.push(`Review Focus: ${brief.review_focus}`);
  sections.push('');

  sections.push('Key Questions:');
  for (const q of brief.questions) {
    sections.push(`  - ${q}`);
  }

  return sections.join('\n');
}

function cloneCollabSnapshot(
  snapshot: CollabStatusSnapshot,
): CollabStatusSnapshot {
  return {
    card: { ...snapshot.card },
    recent_events: snapshot.recent_events.map((event) => ({ ...event })),
  };
}

async function publishCollabSnapshot(
  snapshot: CollabStatusSnapshot | null,
  hooks?: PlannerDiscussProgressHooks,
): Promise<void> {
  if (!snapshot) {
    return;
  }
  await hooks?.onSnapshot?.(cloneCollabSnapshot(snapshot));
}

function buildInitialCollabSnapshot(
  roomId: string,
  joinHint?: string,
): CollabStatusSnapshot {
  return {
    card: {
      room_id: roomId,
      room_kind: 'plan',
      status: 'open',
      replies: 0,
      join_hint: joinHint,
      next: 'room opened; waiting to start collecting replies',
    },
    recent_events: [],
  };
}

async function updateCollabCard(
  snapshot: CollabStatusSnapshot | null,
  updates: Partial<CollabStatusSnapshot['card']>,
  hooks?: PlannerDiscussProgressHooks,
): Promise<void> {
  if (!snapshot) {
    return;
  }
  snapshot.card = {
    ...snapshot.card,
    ...updates,
  };
  await publishCollabSnapshot(snapshot, hooks);
}

async function recordCollabEvent(
  snapshot: CollabStatusSnapshot | null,
  event: CollabLifecycleEvent,
  hooks?: PlannerDiscussProgressHooks,
): Promise<void> {
  if (!snapshot) {
    return;
  }
  snapshot.recent_events = [
    ...snapshot.recent_events,
    event,
  ].slice(-MAX_COLLAB_EVENTS);
  await publishCollabSnapshot(snapshot, hooks);
}

async function safeClosePlannerDiscussRoom(
  roomId: string,
  orchestratorId: string,
  summary: Record<string, unknown>,
): Promise<void> {
  try {
    await closePlannerDiscussRoom({
      room_id: roomId,
      orchestrator_id: orchestratorId,
      summary,
    });
  } catch (err: any) {
    console.log(`  ⚠️ AgentBus close failed for ${roomId}: ${err.message?.slice(0, 80)}`);
  }
}

export async function runClaudePlanner(prompt: string, cwd: string, modelId: string): Promise<PlannerRunResult> {
  const { safeQuery, extractTextFromMessages, extractTokenUsage } = await import('./sdk-query-safe.js');
  const { buildSdkEnv } = await import('./project-paths.js');

  const agentModel = modelId;
  let env: Record<string, string>;
  let resolvedBaseUrl: string | null = null;
  let providerResolveFailed: string | null = null;

  try {
    const resolved = resolveProviderForModel(modelId);
    resolvedBaseUrl = resolved.baseUrl;
    env = buildSdkEnv(agentModel, resolved.baseUrl, resolved.apiKey);
  } catch (err: any) {
    providerResolveFailed = err.message;
    if (!agentModel.startsWith('claude-')) {
      throw new Error(
        `Planner model "${agentModel}" has no resolvable provider route. Refusing implicit Claude fallback. ${providerResolveFailed}`,
      );
    }
    env = buildSdkEnv(agentModel);
  }

  // Non-Claude models should return JSON directly without tool use.
  // Claude models may benefit from reading files before planning.
  const maxTurns = agentModel.startsWith('claude-') ? 8 : 1;
  const plannerPrompt = buildPlannerPrompt(prompt, agentModel);
  const timeoutMs = getPlannerTimeoutMs(agentModel);
  const result = await safeQuery({
    prompt: plannerPrompt,
    options: { cwd, maxTurns, env, model: agentModel },
    timeoutMs,
  });

  const normalizedMessages = normalizePlannerMessages(result);
  if (!Array.isArray(result?.messages)) {
    throw new PlannerRunError(
      'Planner transport returned malformed result: messages array missing',
      '',
      {
        modelId,
        agentModel,
        resolvedBaseUrl,
        providerResolveFailed,
        maxTurns,
        messageCount: 0,
        rawLength: 0,
        messages: [],
        exitError: result?.exitError?.message || null,
        toolUseDetected: false,
        toolUseNames: [],
      },
    );
  }

  const text = extractTextFromMessages(normalizedMessages);
  const tokenUsage = extractTokenUsage(normalizedMessages);
  const toolUseNames = collectPlannerToolUseNames(normalizedMessages);
  const messages = normalizedMessages.map((m: any, i: number) => {
    const type = m.type || '?';
    let preview = '';
    if (type === 'assistant') {
      const content = m.message?.content;
      if (Array.isArray(content)) {
        preview = content.map((b: any) => `${b.type}(${(b.text || b.name || '').slice(0, 40)})`).join('+');
      } else if (typeof content === 'string') {
        preview = content.slice(0, 60);
      }
    } else if (type === 'result') {
      preview = JSON.stringify(m).slice(0, 80);
    }
    return `[${i}] ${type}: ${preview || '(no text)'}`;
  });

  const plannerResult: PlannerRunResult = {
    text,
    tokenUsage,
    diagnostics: {
      modelId,
      agentModel,
      resolvedBaseUrl,
      providerResolveFailed,
      maxTurns,
      messageCount: normalizedMessages.length,
      rawLength: text.length,
      messages,
      exitError: result.exitError?.message || null,
      toolUseDetected: toolUseNames.length > 0,
      toolUseNames,
    },
  };

  if (!agentModel.startsWith('claude-')) {
    if (plannerResult.diagnostics.toolUseDetected || (!text.trim() && plannerResult.diagnostics.exitError)) {
      throw new PlannerRunError(
        describePlannerJsonError(text, plannerResult.diagnostics),
        text,
        plannerResult.diagnostics,
      );
    }
  }

  return plannerResult;
}

// ── AgentBus reply synthesis ──

export async function synthesizeAgentBusReplies(
  briefText: string,
  replies: Array<{ participant_id: string; content: string }>,
  plannerModel: string,
  config: any,
  registry: ModelRegistry,
): Promise<PlanDiscussResult> {
  // Use the discuss tier model for synthesis (cheap summarization pass).
  // config.tiers.discuss.model can be string | string[] — extract first element for resolveTierModel.
  const rawDiscussModel = config.tiers?.discuss?.model || 'auto';
  const singleModelSelector: string = Array.isArray(rawDiscussModel)
    ? (rawDiscussModel[0] || 'auto')
    : rawDiscussModel;
  const discussTierModel = resolveTierModel(
    singleModelSelector,
    () => registry.selectDiscussPartner(plannerModel),
    registry,
    'review',
  );

  const replyText = replies.map(r =>
    `[${r.participant_id}]: ${r.content}`,
  ).join('\n\n');

  const synthPrompt = [
    'You are a senior architect. Synthesize these code review replies into a structured plan review.',
    '',
    '## Planning Brief',
    briefText,
    '',
    '## Review Replies',
    replyText,
    '',
    'Respond with ONLY a JSON object with these fields:',
    '{',
    '  "partner_models": ["list of participant IDs from replies"],',
    '  "task_gaps": ["any missing tasks or steps"],',
    '  "task_redundancies": ["overlapping tasks"],',
    '  "model_suggestions": ["model assignment suggestions"],',
    '  "execution_order_issues": ["dependency or ordering problems"],',
    '  "overall_assessment": "One paragraph overall assessment",',
    '  "quality_gate": "pass" | "warn" | "fail"',
    '}',
  ].join('\n');

  try {
    const { safeQuery, extractTextFromMessages } = await import('./sdk-query-safe.js');
    const { buildSdkEnv } = await import('./project-paths.js');
    const { resolveProviderForModel } = await import('./provider-resolver.js');

    let env: Record<string, string>;
    try {
      const resolved = resolveProviderForModel(discussTierModel);
      env = buildSdkEnv(discussTierModel, resolved.baseUrl, resolved.apiKey);
    } catch {
      if (!discussTierModel.startsWith('claude-')) {
        throw new Error(
          `Discuss synthesis model "${discussTierModel}" has no direct Claude Code transport route.`,
        );
      }
      env = buildSdkEnv(discussTierModel);
    }

    const result = await safeQuery({
      prompt: synthPrompt,
      options: { cwd: process.cwd(), maxTurns: 1, env, model: discussTierModel },
      timeoutMs: DISCUSS_SYNTHESIS_TIMEOUT_MS,
    });
    const text = extractTextFromMessages(result.messages);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        partner_models: parsed.partner_models || replies.map(r => r.participant_id),
        task_gaps: parsed.task_gaps || [],
        task_redundancies: parsed.task_redundancies || [],
        model_suggestions: parsed.model_suggestions || [],
        execution_order_issues: parsed.execution_order_issues || [],
        overall_assessment: parsed.overall_assessment || 'Synthesis completed from AgentBus replies.',
        quality_gate: parsed.quality_gate || 'warn',
      };
    }
  } catch (err: any) {
    console.log(`  ⚠️ AgentBus synthesis model call failed: ${err.message?.slice(0, 80)}`);
  }

  // Fallback: lightweight merge without model call
  return {
    partner_models: replies.map(r => r.participant_id),
    task_gaps: [],
    task_redundancies: [],
    model_suggestions: [],
    execution_order_issues: [],
    overall_assessment: replies.map(r => `[${r.participant_id}] ${r.content.slice(0, 200)}`).join('\n'),
    quality_gate: 'warn',
  };
}

export async function executePlannerDiscuss(
  plan: TaskPlan,
  plannerModel: string,
  config: { tiers: { discuss?: { mode?: string; model?: string | string[]; fallback?: string } }; collab?: CollabConfig },
  registry: ModelRegistry,
  cwd: string,
  hooks?: PlannerDiscussProgressHooks,
): Promise<PlannerDiscussExecutionResult> {
  let planDiscussResult: PlanDiscussResult | null = null;
  let discussDiag: DiscussPlanDiag | null = null;
  let planDiscussRoom: PlannerDiscussRoomRef | null = null;
  let planDiscussCollab: CollabStatusSnapshot | null = null;
  const discussMode = config.tiers.discuss?.mode || 'auto';

  if (discussMode !== 'always') {
    return {
      plan_discuss: null,
      discuss_diag: null,
      plan_discuss_room: null,
      plan_discuss_collab: null,
    };
  }

  const collab = config.collab;
  const transport: string = collab?.plan_discuss_transport || 'local';

  if (transport === 'agentbus') {
    try {
      const brief = buildPlanningBrief(plan, plannerModel);
      const briefText = renderPlanningBriefForSynthesis(brief);

      const room = await openPlannerDiscussRoom({
        cwd,
        brief,
      });

      const timeoutMs = collab?.plan_discuss_timeout_ms ?? 15000;
      const minReplies = collab?.plan_discuss_min_replies ?? 0;
      planDiscussCollab = buildInitialCollabSnapshot(room.room_id, room.join_hint);
      await recordCollabEvent(planDiscussCollab, {
        type: 'room:opened',
        room_id: room.room_id,
        room_kind: 'plan',
        at: new Date().toISOString(),
        reply_count: 0,
        note: 'Planner discuss room opened on AgentBus.',
      }, hooks);
      await updateCollabCard(planDiscussCollab, {
        status: 'collecting',
        next: minReplies > 0
          ? `collecting replies until ${minReplies} arrive or timeout`
          : 'collecting quick replies before synthesis fallback',
      }, hooks);

      const replies = await collectPlannerDiscussReplies({
        cwd, room_id: room.room_id,
        timeout_ms: timeoutMs,
        min_replies: minReplies,
        on_reply: async (reply) => {
          if (!planDiscussCollab) {
            return;
          }
          planDiscussCollab.card.replies += 1;
          planDiscussCollab.card.last_reply_at = reply.received_at;
          planDiscussCollab.card.status = 'collecting';
          planDiscussCollab.card.next = 'reply received; waiting for more replies or timeout';
          await recordCollabEvent(planDiscussCollab, {
            type: 'reply:arrived',
            room_id: room.room_id,
            room_kind: 'plan',
            at: reply.received_at,
            reply_count: planDiscussCollab.card.replies,
            note: `Reply from ${reply.participant_id}`,
          }, hooks);
        },
      });

      planDiscussRoom = buildRoomRef(room, replies, timeoutMs);

      if (replies.length > 0) {
        await updateCollabCard(planDiscussCollab, {
          status: 'synthesizing',
          replies: replies.length,
          next: 'synthesizing collected planner discuss replies',
        }, hooks);
        await recordCollabEvent(planDiscussCollab, {
          type: 'synthesis:started',
          room_id: room.room_id,
          room_kind: 'plan',
          at: new Date().toISOString(),
          reply_count: replies.length,
          note: 'Planner discuss synthesis started.',
        }, hooks);
        const synthesized = await synthesizeAgentBusReplies(
          briefText, replies, plannerModel, config, registry,
        );
        planDiscussResult = synthesized;
        await updateCollabCard(planDiscussCollab, {
          status: 'closed',
          next: 'planner discuss complete',
        }, hooks);
        await recordCollabEvent(planDiscussCollab, {
          type: 'synthesis:done',
          room_id: room.room_id,
          room_kind: 'plan',
          at: new Date().toISOString(),
          reply_count: replies.length,
          note: synthesized.quality_gate === 'pass'
            ? 'Planner discuss synthesis completed.'
            : `Planner discuss synthesis completed with ${synthesized.quality_gate}.`,
        }, hooks);
        await safeClosePlannerDiscussRoom(room.room_id, room.orchestrator_id, {
          quality_gate: synthesized.quality_gate,
          reply_count: replies.length,
        });
        await recordCollabEvent(planDiscussCollab, {
          type: 'room:closed',
          room_id: room.room_id,
          room_kind: 'plan',
          at: new Date().toISOString(),
          reply_count: replies.length,
          note: 'Planner discuss room closed after synthesis.',
        }, hooks);
      } else {
        console.log('  ⚠️ AgentBus discuss: no replies collected, falling back to local');
        await updateCollabCard(planDiscussCollab, {
          status: 'fallback',
          next: 'no replies collected; continuing with local discuss fallback',
        }, hooks);
        await recordCollabEvent(planDiscussCollab, {
          type: 'fallback:local',
          room_id: room.room_id,
          room_kind: 'plan',
          at: new Date().toISOString(),
          reply_count: 0,
          note: 'No AgentBus replies arrived before timeout.',
        }, hooks);
        await safeClosePlannerDiscussRoom(room.room_id, room.orchestrator_id, {
          quality_gate: 'fallback',
          reply_count: 0,
          fallback: 'local-discuss',
        });
        await recordCollabEvent(planDiscussCollab, {
          type: 'room:closed',
          room_id: room.room_id,
          room_kind: 'plan',
          at: new Date().toISOString(),
          reply_count: 0,
          note: 'Planner discuss room closed after local fallback.',
        }, hooks);
        const { discussPlan } = await import('./discuss-bridge.js');
        const dr = await discussPlan(plan, plannerModel, config as any, registry);
        planDiscussResult = dr.result;
        discussDiag = dr.diag;
        planDiscussRoom = null;
      }
    } catch (err: any) {
      console.log(`  ❌ AgentBus discuss failed: ${err.message?.slice(0, 100)}, falling back to local`);
      const { discussPlan } = await import('./discuss-bridge.js');
      const dr = await discussPlan(plan, plannerModel, config as any, registry);
      planDiscussResult = dr.result;
      discussDiag = dr.diag;
      planDiscussRoom = null;
      planDiscussCollab = null;
    }
  } else {
    const { discussPlan } = await import('./discuss-bridge.js');
    const dr = await discussPlan(plan, plannerModel, config as any, registry);
    planDiscussResult = dr.result;
    discussDiag = dr.diag;
  }

  return {
    plan_discuss: planDiscussResult,
    discuss_diag: discussDiag,
    plan_discuss_room: planDiscussRoom,
    plan_discuss_collab: planDiscussCollab,
  };
}

export async function planGoal(
  goal: string,
  cwd: string,
  hooks: PlanGoalHooks = {},
  options?: { projectMemory?: ProjectMemoryStore | null; runId?: string },
): Promise<PlanGoalResult> {
  const registry = new ModelRegistry();
  const policy = options?.runId ? resolveEffectiveRunModelPolicy(cwd, options.runId) : null;
  const config = loadConfig(cwd);
  if (policy) {
    config.tiers = {
      ...config.tiers,
      translator: policy.effective_policy.translator,
      planner: policy.effective_policy.planner,
      executor: policy.effective_policy.executor,
      discuss: policy.effective_policy.discuss,
      reviewer: policy.effective_policy.reviewer,
    };
  }
  const plannerModel = resolveTierModel(
    config.tiers.planner.model,
    () => registry.selectForPlanning(),
    registry,
    'planning',
  );

  const asciiRatio = goal.split('').filter(c => c.charCodeAt(0) < 128).length / Math.max(goal.length, 1);
  let englishGoal = goal;
  let translationResult: TranslationResult | null = null;

  if (asciiRatio <= 0.7) {
    const translatorModel = resolveTierModel(
      config.tiers.translator.model,
      () => registry.selectTranslator(),
      registry,
      'translation',
    );
    const modelInfo = registry.get(translatorModel);
    if (!modelInfo) {
      throw new Error('No suitable translator model found');
    }
    translationResult = await translateToEnglish(goal, translatorModel, modelInfo.provider);
    englishGoal = translationResult.english;
  }

  const plannerContext = buildPlannerContext(cwd);
  let lessonContext = '';
  try {
    const { buildLessonContext } = await import('./lesson-extractor.js');
    lessonContext = buildLessonContext();
  } catch { /* lessons unavailable — proceed without */ }

  // Phase 7A: Recall project memory for current goal
  let memoryContext = '';
  try {
    const { recallProjectMemories, formatMemoryRecall } = await import('./memory-recall.js');
    const recallInput: MemoryRecallInput = { goal };
    const recall = recallProjectMemories(options?.projectMemory ?? null, recallInput, { topN: 3 });
    memoryContext = formatMemoryRecall(recall);
  } catch { /* memory unavailable — proceed without */ }

  // GBrain: Recall user profile for current goal (best-effort, top 2 only)
  let userProfileContext = '';
  try {
    const { recallUserProfile, formatUserProfileRecall } = await import('./user-profile-recall.js');
    const userRecall = recallUserProfile(goal, { topN: 2 });
    userProfileContext = formatUserProfileRecall(userRecall);
  } catch { /* user profile unavailable — proceed without */ }

  const claudePrompt = `${PLAN_PROMPT_TEMPLATE}${plannerContext}${lessonContext}${memoryContext}${userProfileContext}\nUser goal: ${englishGoal}`;

  let plan: TaskPlan | null = null;
  let plannerRawOutput = '';
  let plannerDiagnostics: PlannerRunResult['diagnostics'] | null = null;
  let plannerStageUsage: StageTokenUsage | null = null;
  let plannerError: string | null = null;

  // Planner fallback chain: primary → config fallback → domestic trio
  const plannerFallbacks = [
    plannerModel,
    config.tiers.planner.fallback,
    'kimi-for-coding',
    'glm-5-turbo',
    'qwen3-max',
  ].filter((m, i, arr) => m && arr.indexOf(m) === i) as string[];

  let usedPlannerModel = plannerModel;
  for (const tryModel of plannerFallbacks) {
    try {
      console.log(`  🧠 Trying planner: ${tryModel}`);
      const plannerResult = await runClaudePlanner(claudePrompt, cwd, tryModel);
      plannerRawOutput = plannerResult.text;
      plannerDiagnostics = plannerResult.diagnostics;
      usedPlannerModel = tryModel;
      plannerStageUsage = {
        stage: 'planner',
        model: tryModel,
        input_tokens: plannerResult.tokenUsage.input,
        output_tokens: plannerResult.tokenUsage.output,
      };
      const parsed = parsePlannerJsonBlock<{ goal: string; tasks: unknown[] }>(
        plannerRawOutput,
        plannerDiagnostics,
      );
      plan = buildPlanFromClaudeOutput(parsed, cwd);
      plan.cwd = cwd;
      for (const task of plan.tasks) {
        task.assigned_model = registry.assignModel(task);
        task.assignment_reason = `Assigned by registry for ${task.complexity} ${task.category} task`;
      }
      plannerError = null;
      break;
    } catch (err: any) {
      if (isPlannerRunError(err)) {
        plannerRawOutput = err.rawText;
        plannerDiagnostics = err.diagnostics;
      }
      plannerError = `${tryModel}: ${err.message}`;
      console.log(`  ⚠️ Planner ${tryModel} failed: ${err.message.slice(0, 100)}`);
    }
  }

  let planDiscussResult: PlanDiscussResult | null = null;
  let discussDiag: DiscussPlanDiag | null = null;
  let planDiscussRoom: PlannerDiscussRoomRef | null = null;
  let planDiscussCollab: CollabStatusSnapshot | null = null;
  if (plan) {
    // If planner fell back, widen discuss to cross-check with more models
    const effectiveConfig = { ...config };
    if (usedPlannerModel !== plannerModel) {
      console.log(`  🔄 Planner fell back ${plannerModel} → ${usedPlannerModel}, widening discuss`);
      effectiveConfig.tiers = {
        ...config.tiers,
        discuss: {
          ...config.tiers.discuss,
          model: ['qwen3-max', 'glm-5', 'kimi-k2.5'].filter(m => m !== usedPlannerModel),
          mode: 'always',
        },
      };
    }
    const discussExecution = await executePlannerDiscuss(
      plan,
      usedPlannerModel,
      effectiveConfig as any,
      registry,
      cwd,
      { onSnapshot: hooks.onPlannerDiscussSnapshot },
    );
    planDiscussResult = discussExecution.plan_discuss;
    discussDiag = discussExecution.discuss_diag;
    planDiscussRoom = discussExecution.plan_discuss_room;
    planDiscussCollab = discussExecution.plan_discuss_collab;
  }

  return {
    plan,
    translation: translationResult,
    planner_model: usedPlannerModel,
    planner_stage_usage: plannerStageUsage,
    extra_stage_usages: [
      ...(translationResult?.stage_usage ? [translationResult.stage_usage] : []),
      ...(plannerStageUsage ? [plannerStageUsage] : []),
    ],
    planner_raw_output: plannerRawOutput,
    planner_error: plannerError,
    planner_diagnostics: plannerDiagnostics,
    plan_discuss: planDiscussResult,
    plan_discuss_room: planDiscussRoom,
    plan_discuss_collab: planDiscussCollab,
    discuss_diag: discussDiag,
    budget_warning: getBudgetWarning(config),
  };
}
