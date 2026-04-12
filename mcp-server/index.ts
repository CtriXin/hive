import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { execSync } from 'child_process';
import type { TaskPlan, TranslationResult, OrchestratorResult, PlanDiscussResult, StageTokenUsage, PlannerDiscussRoomRef, CollabStatusSnapshot, ExecutionMode } from '../orchestrator/types.js';
import type { DiscussPlanDiag } from '../orchestrator/discuss-bridge.js';
import { buildPlanFromClaudeOutput, PLAN_PROMPT_TEMPLATE } from '../orchestrator/planner.js';
import { translateToEnglish } from '../orchestrator/translator.js';
import { reportResults } from '../orchestrator/reporter.js';
import { spawnWorker, dispatchBatch } from '../orchestrator/dispatcher.js';
import { resolveEffectiveMode } from '../orchestrator/mode-policy.js';
import { reviewCascade } from '../orchestrator/reviewer.js';
import { ModelRegistry } from '../orchestrator/model-registry.js';
import { checkProviderHealth, getAllProviders, resolveProviderForModel, quickPing } from '../orchestrator/provider-resolver.js';
import { isMmsAvailable, loadMmsRoutes } from '../orchestrator/mms-routes-loader.js';
import { getBudgetStatus, getBudgetWarning, loadConfig, recordSpending, resolveTierModel, resolveFallback } from '../orchestrator/hive-config.js';
import { saveRoundScore } from '../orchestrator/score-history.js';
import { saveRunPlan, saveRunResult, saveRunSpec, saveRunState } from '../orchestrator/run-store.js';
import { selectPromptPolicy } from '../orchestrator/prompt-policy.js';
import { loadCompactPacket, loadLatestCompactRestore, loadWorkspaceCompactPacket } from '../orchestrator/compact-packet.js';
import { executePlannerDiscuss } from '../orchestrator/planner-runner.js';
import { loadWorkerStatusSnapshot, summarizeWorkerSnapshot } from '../orchestrator/worker-status-store.js';
import {
  extractRunnableTaskPlan,
  LATEST_PLAN_ARTIFACT,
  relPath,
  resolvePreferredLatestPlanArtifact,
  saveLatestPlanPointer,
  summarizeDispatchCard,
  summarizeExecutionCard,
  summarizePlanCard,
  writeMcpJsonArtifact,
  writeMcpTextArtifact,
  writeStableMcpJsonArtifact,
} from '../orchestrator/mcp-surface.js';
import fs from 'fs';
import path from 'path';

const server = new McpServer({
  name: 'hive-mcp',
  version: '1.0.0',
});

// ── Planner context collection ──

const DEFAULT_GOAL_ARTIFACT = path.join('.ai', 'mcp', 'latest-goal.md');
const DEFAULT_FILE_TREE_LINES = 24;
const DEFAULT_KEY_TYPES_LINES = 16;
const LIGHT_FILE_TREE_LINES = 12;
const LIGHT_KEY_TYPES_LINES = 8;
const MAX_CONTEXT_BLOCK_CHARS = 1200;
const LARGE_GOAL_THRESHOLD = 4000;

function trimBlock(raw: string, maxChars: number = MAX_CONTEXT_BLOCK_CHARS): string {
  const text = raw.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

function collectFileTree(cwd: string, maxLines = DEFAULT_FILE_TREE_LINES): string {
  try {
    const raw = execSync(
      `rg --files -g '*.ts' -g '*.js' -g '*.json' -g '!node_modules' -g '!dist' -g '!.git' . | head -n ${maxLines}`,
      { cwd, encoding: 'utf-8', timeout: 5000 },
    );
    return trimBlock(raw);
  } catch {
    return '(file tree unavailable)';
  }
}

function collectKeyTypes(cwd: string, maxLines = DEFAULT_KEY_TYPES_LINES): string {
  try {
    const raw = execSync(
      `rg -n "^export (interface|type|enum)" --glob '*.ts' -g '!node_modules' -g '!dist' -g '!.git' . | head -n ${maxLines}`,
      { cwd, encoding: 'utf-8', timeout: 5000 },
    );
    return trimBlock(raw);
  } catch {
    return '(type signatures unavailable)';
  }
}

function buildPlannerContext(cwd: string, goalLength: number): string {
  const lightMode = goalLength >= LARGE_GOAL_THRESHOLD;
  const fileTree = collectFileTree(cwd, lightMode ? LIGHT_FILE_TREE_LINES : DEFAULT_FILE_TREE_LINES);
  const keyTypes = collectKeyTypes(cwd, lightMode ? LIGHT_KEY_TYPES_LINES : DEFAULT_KEY_TYPES_LINES);
  return `\n## Codebase Context (auto-collected, ${lightMode ? 'light' : 'standard'})\n### File tree\n\`\`\`\n${fileTree}\n\`\`\`\n### Exported types\n\`\`\`\n${keyTypes}\n\`\`\`\n`;
}

interface ResolvedGoalInput {
  goal: string;
  source: 'inline' | 'goal_path' | 'latest-goal';
  sourcePath?: string;
}

function validateGoalInputForExecution(goalInput: ResolvedGoalInput): void {
  if (goalInput.source === 'inline' && goalInput.goal.length >= LARGE_GOAL_THRESHOLD) {
    throw new Error(
      `Large inline goal detected (${goalInput.goal.length} chars). Run capture_goal first, then call plan_tasks/run_goal without inline goal.`,
    );
  }
}

function resolveGoalInput(
  effectiveCwd: string,
  goalArg?: string,
  goalPathArg?: string,
): ResolvedGoalInput {
  if (goalArg) {
    return { goal: goalArg, source: 'inline' };
  }
  if (goalPathArg) {
    const absPath = path.isAbsolute(goalPathArg) ? goalPathArg : path.join(effectiveCwd, goalPathArg);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Goal file not found: ${goalPathArg}`);
    }
    return {
      goal: fs.readFileSync(absPath, 'utf-8').trim(),
      source: 'goal_path',
      sourcePath: absPath,
    };
  }
  const defaultPath = path.join(effectiveCwd, DEFAULT_GOAL_ARTIFACT);
  if (!fs.existsSync(defaultPath)) {
    throw new Error(`No goal provided. Pass goal, goal_path, or run capture_goal first (${DEFAULT_GOAL_ARTIFACT}).`);
  }
  return {
    goal: fs.readFileSync(defaultPath, 'utf-8').trim(),
    source: 'latest-goal',
    sourcePath: defaultPath,
  };
}

function persistInlineGoalArtifact(effectiveCwd: string, goal: string): string {
  const goalDir = path.join(effectiveCwd, '.ai', 'mcp');
  if (!fs.existsSync(goalDir)) fs.mkdirSync(goalDir, { recursive: true });
  const goalPath = path.join(goalDir, 'latest-goal.md');
  fs.writeFileSync(goalPath, goal, 'utf-8');
  return goalPath;
}

function parseJsonBlock<T>(raw: string): T {
  // Try fenced code block first
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    try { return JSON.parse(fencedMatch[1].trim()) as T; } catch { /* fall through */ }
  }

  // Try to find the outermost { ... } containing "goal" and "tasks"
  const braceStart = raw.indexOf('{');
  if (braceStart >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = braceStart; i < raw.length; i++) {
      const c = raw[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(braceStart, i + 1);
          try { return JSON.parse(candidate) as T; } catch { /* fall through */ }
          break;
        }
      }
    }
  }

  throw new Error('Planner did not return valid JSON');
}

function startExecutePlanHeartbeat(
  cwd: string,
  runId: string,
): () => void {
  let lastLine = '';
  const emit = () => {
    const snapshot = loadWorkerStatusSnapshot(cwd, runId);
    if (!snapshot) return;
    const counts = summarizeWorkerSnapshot(snapshot);
    const activeWorkers = snapshot.workers
      .filter((worker) => ['starting', 'running', 'discussing'].includes(worker.status))
      .map((worker) => `${worker.task_id}:${worker.status}`)
      .slice(0, 3);
    const line = `[execute_plan] run=${runId} workers active=${counts.active} completed=${counts.completed}/${counts.total} failed=${counts.failed}${activeWorkers.length ? ` focus=${activeWorkers.join(',')}` : ''}`;
    if (line === lastLine) return;
    lastLine = line;
    server.sendLoggingMessage({ level: 'info', logger: 'hive', data: line });
  };

  const timer = setInterval(emit, 5000);
  emit();
  return () => clearInterval(timer);
}

// ── MCP execution snapshot (from hiveshell) ──

function persistMcpExecutionSnapshot(
  plan: TaskPlan,
  orchestratorResult: OrchestratorResult,
): void {
  const now = new Date().toISOString();
  const allReviewsPassed = orchestratorResult.review_results.every((review) => review.passed);
  const status = allReviewsPassed ? 'done' : 'partial';
  const nextAction = allReviewsPassed
    ? {
        kind: 'finalize' as const,
        reason: 'All review gates passed for MCP execution.',
        task_ids: [],
      }
    : {
        kind: 'repair_task' as const,
        reason: 'Some tasks failed review during MCP execution.',
        task_ids: orchestratorResult.review_results
          .filter((review) => !review.passed)
          .map((review) => review.taskId),
      };

  saveRunSpec(plan.cwd, {
    id: plan.id,
    goal: plan.goal,
    cwd: plan.cwd,
    origin_cwd: process.cwd(),
    task_cwd: plan.cwd,
    mode: 'safe',
    done_conditions: [],
    max_rounds: 1,
    max_worker_retries: 0,
    max_replans: 0,
    allow_auto_merge: true,
    stop_on_high_risk: false,
    created_at: now,
  });
  saveRunPlan(plan.cwd, plan.id, plan);
  saveRunResult(plan.cwd, plan.id, orchestratorResult);
  saveRunState(plan.cwd, {
    run_id: plan.id,
    status,
    round: 1,
    current_plan_id: plan.id,
    completed_task_ids: orchestratorResult.worker_results
      .filter((worker) => worker.success)
      .map((worker) => worker.taskId),
    failed_task_ids: orchestratorResult.worker_results
      .filter((worker) => !worker.success)
      .map((worker) => worker.taskId),
    review_failed_task_ids: orchestratorResult.review_results
      .filter((review) => !review.passed)
      .map((review) => review.taskId),
    merged_task_ids: [],
    retry_counts: {},
    replan_count: 0,
    task_states: {},
    task_verification_results: {},
    repair_history: [],
    round_cost_history: [],
    policy_hook_results: [],
    verification_results: [],
    next_action: nextAction,
    final_summary: allReviewsPassed
      ? 'MCP execution finished with all reviews passing.'
      : 'MCP execution finished with review failures.',
    updated_at: now,
  });
  saveRoundScore({
    cwd: plan.cwd,
    runId: plan.id,
    goal: plan.goal,
    round: 1,
    action: 'execute',
    status,
    workerResults: orchestratorResult.worker_results,
    reviewResults: orchestratorResult.review_results,
    verificationResults: [],
  });
}

interface PlannerRunResult {
  text: string;
  diagnostics: {
    modelId: string;
    agentModel: string;
    resolvedBaseUrl: string | null;
    providerResolveFailed: string | null;
    maxTurns: number;
    messageCount: number;
    rawLength: number;
    messages: string[];
  };
}

async function runClaudePlanner(prompt: string, cwd: string, modelId: string): Promise<PlannerRunResult> {
  const { safeQuery, extractTextFromMessages } = await import('../orchestrator/sdk-query-safe.js');
  const { buildSdkEnv } = await import('../orchestrator/project-paths.js');

  // Use original model ID — MMS gateway requires exact model name
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
    // INVARIANT: non-claude models must NOT fallback to Claude
    if (!agentModel.startsWith('claude-')) {
      throw new Error(
        `Planner model "${agentModel}" has no resolvable provider route. Refusing implicit Claude fallback. ${providerResolveFailed}`,
      );
    }
    env = buildSdkEnv(agentModel);
  }

  const maxTurns = 3;
  // INVARIANT: explicit model in safeQuery options
  const result = await safeQuery({
    prompt,
    options: { cwd, maxTurns, env, model: agentModel },
  });

  const text = extractTextFromMessages(result.messages);

  // Diagnostics: summarize message types and content preview
  const msgSummary = result.messages.map((m: any, i: number) => {
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

  return {
    text,
    diagnostics: {
      modelId,
      agentModel,
      resolvedBaseUrl,
      providerResolveFailed,
      maxTurns,
      messageCount: result.messages.length,
      rawLength: text.length,
      messages: msgSummary,
    },
  };
}

// 工具 0: capture_goal — 写长需求到 stable artifact，plan_tasks 可无参读取
server.tool(
  'capture_goal',
  'Save a goal/brief to .ai/mcp/latest-goal.md so plan_tasks can read it without long inline text.',
  {
    goal: z.string().describe('Goal text (Chinese or English)'),
    cwd: z.string().describe('Working directory').optional(),
  },
  async ({ goal, cwd }) => {
    const effectiveCwd = cwd || process.cwd();
    const goalPath = persistInlineGoalArtifact(effectiveCwd, goal);
    return {
      content: [{
        type: 'text',
        text: `Goal saved to ${relPath(effectiveCwd, goalPath)} (${goal.length} chars). Prefer plan_tasks/run_goal without inline goal to keep the host prompt thin.`,
      }],
    };
  },
);

// 工具 1: plan_tasks - 接受中文或英文输入
server.tool(
  'plan_tasks',
  'Plan tasks from a goal.',
  {
    goal: z.string().describe('Goal in Chinese or English. Omit to read from .ai/mcp/latest-goal.md').optional(),
    goal_path: z.string().describe('Path to a goal/brief file (alternative to inline goal)').optional(),
    cwd: z.string().describe('Working directory').optional(),
  },
  async ({ goal: goalArg, goal_path, cwd }) => {
    const registry = new ModelRegistry();
    const effectiveCwd = cwd || process.cwd();

    let goalInput: ResolvedGoalInput;
    try {
      goalInput = resolveGoalInput(effectiveCwd, goalArg, goal_path);
      validateGoalInputForExecution(goalInput);
    } catch (err: any) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    const goal = goalInput.goal;
    const capturedGoalPath = goalInput.source === 'inline' && goal.length >= LARGE_GOAL_THRESHOLD
      ? persistInlineGoalArtifact(effectiveCwd, goal)
      : null;
    const config = loadConfig(effectiveCwd);
    const plannerModel = resolveTierModel(
      config.tiers.planner.model,
      () => registry.selectForPlanning(),
      registry,
      'planning',
    );

    // 检测语言（ASCII > 70% → 英文，否则中文）
    const asciiRatio = goal.split('').filter(c => c.charCodeAt(0) < 128).length / goal.length;
    let englishGoal = goal;
    let translationResult: TranslationResult | null = null;

    if (asciiRatio <= 0.7) {
      // 中文输入，需要翻译
      const translatorModel = resolveTierModel(
        config.tiers.translator.model,
        () => registry.selectTranslator(),
        registry,
        'translation',
      );
      const modelInfo = registry.get(translatorModel);
      if (!modelInfo) {
        return { content: [{ type: 'text', text: `No suitable translator model found` }] };
      }

      translationResult = await translateToEnglish(goal, translatorModel, modelInfo.provider);
      englishGoal = translationResult.english;
    }

    // 构建 Claude prompt（注入代码库上下文）
    const plannerContext = buildPlannerContext(effectiveCwd, goal.length);
    const claudePrompt = `${PLAN_PROMPT_TEMPLATE}${plannerContext}\nUser goal: ${englishGoal}`;
    let plannerOutput = '';
    let plan: TaskPlan | null = null;
    let plannerFallbackPrompt: string | null = null;

    let plannerDiagnostics: PlannerRunResult['diagnostics'] | null = null;
    let plannerError: string | null = null;
    try {
      const plannerResult = await runClaudePlanner(claudePrompt, effectiveCwd, plannerModel);
      plannerOutput = plannerResult.text;
      plannerDiagnostics = plannerResult.diagnostics;
      const parsedPlannerOutput = parseJsonBlock<{ goal: string; tasks: unknown[] }>(plannerOutput);
      plan = buildPlanFromClaudeOutput(parsedPlannerOutput);
      plan.cwd = effectiveCwd;
    } catch (err: any) {
      plannerError = err.message;
      plannerFallbackPrompt = claudePrompt;
    }

    if (plan) {
      for (const task of plan.tasks) {
        task.assigned_model = registry.assignModel(task);
        task.assignment_reason = `Assigned by registry for ${task.complexity} ${task.category} task`;
        task.prompt_policy = task.prompt_policy || selectPromptPolicy(task);
      }
    }

    // Plan discuss (when configured)
    let planDiscussResult: PlanDiscussResult | null = null;
    let discussDiag: DiscussPlanDiag | null = null;
    let planDiscussRoom: PlannerDiscussRoomRef | null = null;
    let planDiscussCollab: CollabStatusSnapshot | null = null;
    const discussMode = config.tiers.discuss?.mode || 'auto';
    let discussSkipReason: string | null = null;
    if (!plan) {
      discussSkipReason = 'no plan generated';
    } else if (discussMode !== 'always') {
      discussSkipReason = `discuss.mode="${discussMode}" (need "always")`;
    } else {
      const discussExecution = await executePlannerDiscuss(
        plan,
        plannerModel,
        config as any,
        registry,
        effectiveCwd,
      );
      planDiscussResult = discussExecution.plan_discuss;
      discussDiag = discussExecution.discuss_diag;
      planDiscussRoom = discussExecution.plan_discuss_room;
      planDiscussCollab = discussExecution.plan_discuss_collab;
    }

    const budgetWarning = getBudgetWarning(config);
    const artifactPayload = {
      plan,
      plan_discuss: planDiscussResult,
      plan_discuss_room: planDiscussRoom || undefined,
      plan_discuss_collab: planDiscussCollab || undefined,
      discuss_debug: planDiscussResult ? undefined : {
        mode: discussMode,
        skip_reason: discussSkipReason,
        config_tiers_discuss: config.tiers.discuss,
        discuss_diag: discussDiag,
      },
      translation: translationResult,
      goal_source: goalInput.source,
      goal_source_path: goalInput.sourcePath || capturedGoalPath || undefined,
      goal_chars: goal.length,
      planner_context_chars: plannerContext.length,
      planner_prompt_chars: claudePrompt.length,
      planner_model: plannerModel,
      planner_prompt: plannerFallbackPrompt,
      planner_diagnostics: plannerDiagnostics,
      planner_error: plannerError,
      planner_raw_output: plan ? undefined : plannerOutput?.slice(0, 500),
      budget_warning: budgetWarning,
    };
    const artifactPath = writeMcpJsonArtifact(
      effectiveCwd,
      'plan-tasks',
      artifactPayload,
    );
    const stablePlanPath = writeStableMcpJsonArtifact(
      effectiveCwd,
      LATEST_PLAN_ARTIFACT,
      artifactPayload,
    );
    if (plan) {
      saveLatestPlanPointer(effectiveCwd, stablePlanPath);
    }
    const summaryText = plan
      ? summarizePlanCard(plan, {
          artifactPath,
          plannerModel,
          stablePlanPath,
          translationModel: translationResult?.translator_model,
          discussQualityGate: planDiscussResult?.quality_gate,
          discussRoom: planDiscussRoom,
          collabCard: planDiscussCollab?.card,
          budgetWarning,
        })
      : [
          `Planning failed with ${plannerModel}.`,
          plannerError ? `- error: ${plannerError}` : '',
          `- diagnostics: ${relPath(effectiveCwd, artifactPath)}`,
        ].filter(Boolean).join('\n');
    const sourceLine = `- goal source: ${goalInput.source}${goalInput.sourcePath ? ` (${relPath(effectiveCwd, goalInput.sourcePath)})` : capturedGoalPath ? ` (${relPath(effectiveCwd, capturedGoalPath)})` : ''}`;
    const sizeLine = `- prompt budget: goal=${goal.length} chars | context=${plannerContext.length} chars | planner_prompt=${claudePrompt.length} chars`;
    const inlineHint = capturedGoalPath
      ? `- note: large inline goal was captured to ${relPath(effectiveCwd, capturedGoalPath)}; prefer capture_goal/goal_path next time`
      : '';

    return {
      content: [{
        type: 'text',
        text: [summaryText, sourceLine, sizeLine, inlineHint].filter(Boolean).join('\n'),
      }],
    };
  }
);

// 工具 2: execute_plan
server.tool(
  'execute_plan',
  'Execute a task plan.',
  {
    plan_json: z.string().describe('TaskPlan JSON').optional(),
    plan_path: z.string().describe('Path to saved planning artifact or raw plan JSON file').optional(),
    report_language: z.enum(['zh', 'en']).default('zh'),
    resume_plan_id: z.string().describe('Plan ID to resume from checkpoint').optional(),
  },
  async ({ plan_json, plan_path, report_language, resume_plan_id }) => {
    const effectiveCwd = process.cwd();
    let plan: TaskPlan;
    if (plan_json) {
      const parsed = JSON.parse(plan_json);
      const runnablePlan = extractRunnableTaskPlan(parsed);
      if (!runnablePlan) {
        return {
          content: [{
            type: 'text',
            text: 'execute_plan received plan_json, but it does not contain a runnable plan.',
          }],
          isError: true,
        };
      }
      plan = runnablePlan;
    } else if (plan_path) {
      if (plan_path.endsWith('.md')) {
        return {
          content: [{
            type: 'text',
            text: `execute_plan expects runnable JSON, not markdown plan notes (${plan_path}). Use .ai/mcp/${LATEST_PLAN_ARTIFACT} or run execute_plan with no args after plan_tasks.`,
          }],
          isError: true,
        };
      }
      const raw = fs.readFileSync(path.resolve(effectiveCwd, plan_path), 'utf-8');
      const parsed = JSON.parse(raw);
      const runnablePlan = extractRunnableTaskPlan(parsed);
      if (!runnablePlan) {
        return {
          content: [{
            type: 'text',
            text: `execute_plan found ${plan_path}, but it does not contain a runnable plan. Re-run plan_tasks first.`,
          }],
          isError: true,
        };
      }
      plan = runnablePlan;
    } else {
      const latestPlanPath = resolvePreferredLatestPlanArtifact(effectiveCwd);
      if (!latestPlanPath) {
        return {
          content: [{
            type: 'text',
            text: `execute_plan needs a plan. Run plan_tasks first, or pass plan_path. Expected stable plan: .ai/mcp/${LATEST_PLAN_ARTIFACT}`,
          }],
          isError: true,
        };
      }
      const raw = fs.readFileSync(latestPlanPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const runnablePlan = extractRunnableTaskPlan(parsed);
      if (!runnablePlan) {
        return {
          content: [{
            type: 'text',
            text: `execute_plan found .ai/mcp/${LATEST_PLAN_ARTIFACT}, but it does not contain a runnable plan. Re-run plan_tasks first.`,
          }],
          isError: true,
        };
      }
      plan = runnablePlan;
    }
    const registry = new ModelRegistry();
    const config = loadConfig(plan.cwd);
    server.sendLoggingMessage({
      level: 'info',
      logger: 'hive',
      data: `[execute_plan] run=${plan.id} start tasks=${plan.tasks.length} cwd=${plan.cwd}`,
    });
    const stopHeartbeat = startExecutePlanHeartbeat(plan.cwd, plan.id);
    let dispatchResult;
    try {
      dispatchResult = await dispatchBatch(plan, registry, resume_plan_id, { recordBudget: false });
    } finally {
      stopHeartbeat();
    }
    server.sendLoggingMessage({
      level: 'info',
      logger: 'hive',
      data: `[execute_plan] run=${plan.id} dispatch complete workers=${dispatchResult.worker_results.length}`,
    });

    // 执行 review cascade
    server.sendLoggingMessage({
      level: 'info',
      logger: 'hive',
      data: `[execute_plan] run=${plan.id} review start count=${dispatchResult.worker_results.length}`,
    });
    const reviewResults = await Promise.all(
      dispatchResult.worker_results.map((workerResult) => {
        const task = plan.tasks.find((item) => item.id === workerResult.taskId);
        if (!task) {
          throw new Error(`Task not found for worker result: ${workerResult.taskId}`);
        }
        return reviewCascade(workerResult, task, plan, registry);
      }),
    );
    server.sendLoggingMessage({
      level: 'info',
      logger: 'hive',
      data: `[execute_plan] run=${plan.id} review done passed=${reviewResults.filter((review) => review.passed).length}/${reviewResults.length}`,
    });

    // Auto-merge: commit and merge passed worktrees
    const { commitAndMergeWorktree } = await import('../orchestrator/worktree-manager.js');
    const mergeResults: Array<{ taskId: string; merged: boolean; error?: string }> = [];
    for (const review of reviewResults) {
      const wr = dispatchResult.worker_results.find(w => w.taskId === review.taskId);
      if (!wr?.branch) continue; // no worktree used
      if (review.passed) {
        const task = plan.tasks.find(t => t.id === wr.taskId);
        const msg = `task ${wr.taskId}: ${task?.description.slice(0, 80) || wr.taskId}`;
        const mr = commitAndMergeWorktree(wr.worktreePath, wr.branch, msg, plan.cwd);
        mergeResults.push({ taskId: wr.taskId, ...mr });
      } else {
        mergeResults.push({ taskId: wr.taskId, merged: false, error: 'review not passed — worktree kept for inspection' });
      }
    }
    server.sendLoggingMessage({
      level: 'info',
      logger: 'hive',
      data: `[execute_plan] run=${plan.id} merge done merged=${mergeResults.filter((item) => item.merged).length}/${mergeResults.length}`,
    });

    const orchestratorResult: OrchestratorResult = {
      plan,
      worker_results: dispatchResult.worker_results,
      review_results: reviewResults,
      score_updates: [],
      total_duration_ms: dispatchResult.worker_results.reduce((sum, worker) => sum + worker.duration_ms, 0),
      cost_estimate: (() => {
        let opusTok = 0, sonnetTok = 0, haikuTok = 0, domesticTok = 0, costUsd = 0;
        for (const wr of dispatchResult.worker_results) {
          const total = wr.token_usage.input + wr.token_usage.output;
          const cap = registry.get(wr.model);
          if (wr.model.includes('opus')) opusTok += total;
          else if (wr.model.includes('sonnet')) sonnetTok += total;
          else if (wr.model.includes('haiku')) haikuTok += total;
          else domesticTok += total;
          if (cap) {
            costUsd += (wr.token_usage.input * (cap.cost_per_mtok_input || 0)
                      + wr.token_usage.output * (cap.cost_per_mtok_output || 0)) / 1_000_000;
          }
        }
        return { opus_tokens: opusTok, sonnet_tokens: sonnetTok, haiku_tokens: haikuTok, domestic_tokens: domesticTok, estimated_cost_usd: costUsd };
      })()
    };

    // Build token breakdown
    const stages: StageTokenUsage[] = [];

    // Worker stages
    for (const wr of dispatchResult.worker_results) {
      stages.push({
        stage: `worker:${wr.taskId}`,
        model: wr.model,
        input_tokens: wr.token_usage.input,
        output_tokens: wr.token_usage.output,
      });
    }

    // Review stages (collected by reviewCascade)
    for (const rr of reviewResults) {
      if (rr.token_stages) stages.push(...rr.token_stages);
    }

    // Calculate totals and claude savings
    const totalInput = stages.reduce((s, t) => s + t.input_tokens, 0);
    const totalOutput = stages.reduce((s, t) => s + t.output_tokens, 0);

    // Actual cost from domestic models
    let actualCost = 0;
    for (const st of stages) {
      const cap = registry.get(st.model);
      if (cap) {
        actualCost += (st.input_tokens * (cap.cost_per_mtok_input || 0)
                     + st.output_tokens * (cap.cost_per_mtok_output || 0)) / 1_000_000;
      }
    }

    // Claude equivalent: what it would cost using Sonnet for everything
    const sonnetTier = registry.getClaudeTier('sonnet');
    const sonnetCostPer1k = sonnetTier?.cost_per_1k || 0.003;
    const claudeEquivalent = (totalInput + totalOutput) * sonnetCostPer1k / 1000;

    orchestratorResult.token_breakdown = {
      stages,
      total_input: totalInput,
      total_output: totalOutput,
      actual_cost_usd: actualCost,
      claude_equivalent_usd: claudeEquivalent,
      savings_usd: claudeEquivalent - actualCost,
    };
    const budgetStatus = recordSpending(plan.cwd, actualCost);
    orchestratorResult.budget_status = budgetStatus ?? undefined;
    orchestratorResult.budget_warning = budgetStatus?.warning ?? null;

    // Persist final result to disk
    const { saveFinalResult } = await import('../orchestrator/result-store.js');
    saveFinalResult(plan.id, plan.cwd, orchestratorResult);

    // Resolve reporter model from tiers config
    const reporterModel = resolveTierModel(
      config.tiers.reporter.model,
      () => registry.selectForReporter(),
      registry,
      'general',
    );
    const reporterInfo = registry.get(reporterModel);
    const reporterProvider = reporterInfo?.provider || reporterModel;

    const report = await reportResults(
      orchestratorResult,
      reporterModel,
      reporterProvider,
      { language: report_language, format: 'summary', target: 'stdout' }
    );

    // Persist execution snapshot for run_status
    persistMcpExecutionSnapshot(plan, orchestratorResult);
    const reportPath = writeMcpTextArtifact(plan.cwd, 'execute-plan-report', report);
    server.sendLoggingMessage({
      level: 'info',
      logger: 'hive',
      data: `[execute_plan] run=${plan.id} done report=${relPath(plan.cwd, reportPath)}`,
    });
    const compactPacket = loadCompactPacket(plan.cwd, plan.id);
    return {
      content: [{
        type: 'text',
        text: summarizeExecutionCard(plan, orchestratorResult, {
          mergeResults,
          reportPath: relPath(plan.cwd, reportPath),
          compactPacket,
        }),
      }],
    };
  }
);

// 工具 3: dispatch_single
server.tool(
  'dispatch_single',
  'Dispatch one task.',
  {
    task_id: z.string().describe('Task ID'),
    prompt: z.string().describe('Full task prompt with context'),
    model: z.string().describe('Model ID'),
    provider: z.string().describe('Provider ID').optional(),
    cwd: z.string().describe('Working directory').optional(),
    worktree: z.boolean().describe('Run in isolated git worktree').default(false),
    discuss_threshold: z.number().describe('Confidence threshold for discussion trigger').default(0.7),
    benchmark_no_fallback: z.boolean().describe('Disable channel/model fallback and pin benchmark providers').default(false),
  },
  async ({ task_id, prompt, model, provider, cwd, worktree, discuss_threshold, benchmark_no_fallback }) => {
    if (!prompt || prompt.trim().length < 5) {
      return {
        content: [{ type: 'text', text: '## dispatch_single error\n\n**error**: prompt is empty or too short. Provide a full task description with context.' }],
        isError: true,
      };
    }

    try {
      const runId = `dispatch-${task_id}-${Date.now()}`;
      const benchmarkRoutingPolicy = benchmark_no_fallback
        ? {
            mode: 'fixed-provider' as const,
            providerByFamily: {
              gpt: 'openai',
              non_gpt: 'anthropic',
            },
            disable_channel_fallback: true,
            disable_model_fallback: true,
          }
        : undefined;

      // Preflight: quickPing before spawning
      let actualModel = model;
      let preflightFallback: string | null = null;
      const ping = await quickPing(model);
      if (!ping.ok && !benchmark_no_fallback) {
        const registry = new ModelRegistry();
        const config = loadConfig(cwd || process.cwd());
        const fb = resolveFallback(model, 'server_error', {
          id: task_id, description: prompt.slice(0, 200), complexity: 'medium',
          category: 'general', assigned_model: model, assignment_reason: '',
          estimated_files: [], acceptance_criteria: [],
          discuss_threshold: discuss_threshold, depends_on: [], review_scale: 'auto',
        }, config, registry);
        console.log(`  🔄 Preflight: ${model} unhealthy (${ping.error}), using ${fb}`);
        preflightFallback = `${model} → ${fb} (${ping.error})`;
        actualModel = fb;
      } else if (!ping.ok && benchmark_no_fallback) {
        console.log(`  ⛔ Preflight failed in benchmark no-fallback mode: ${model} (${ping.error})`);
      }

      const result = await spawnWorker({
        taskId: task_id,
        model: actualModel,
        provider: provider || '',
        benchmarkRoutingPolicy,
        assignedModel: model,
        prompt,
        cwd: cwd || process.cwd(),
        worktree: worktree ?? false,
        contextInputs: [],
        discussThreshold: discuss_threshold,
        maxTurns: 25,
        runId,
        planId: `dispatch-${task_id}`,
        round: 1,
        taskDescription: prompt.slice(0, 120),
      });

      // Record spending for single dispatch
      const spendRegistry = new ModelRegistry();
      const cap = spendRegistry.get(result.model);
      if (cap) {
        const cost = (result.token_usage.input * (cap.cost_per_mtok_input || 0)
                    + result.token_usage.output * (cap.cost_per_mtok_output || 0)) / 1_000_000;
        if (cost > 0) {
          const { recordSpending } = await import('../orchestrator/hive-config.js');
          recordSpending(cwd || process.cwd(), cost);
        }
      }

      const output = {
        ...result,
        requested_model: model,
        executed_model: result.model,
        benchmark_no_fallback,
        preflight_ping_ok: ping.ok,
        runId,
        preflight_fallback: preflightFallback,
      };
      const artifactPath = writeMcpJsonArtifact(
        cwd || process.cwd(),
        `dispatch-${task_id}`,
        output,
      );
      const compactPacket = loadCompactPacket(cwd || process.cwd(), runId);
      return {
        content: [{
          type: 'text',
          text: summarizeDispatchCard(output, {
            cwd: cwd || process.cwd(),
            artifactPath: relPath(cwd || process.cwd(), artifactPath),
            compactPacket,
          }),
        }],
      };
    } catch (err: any) {
      return {
        content: [{
          type: 'text',
          text: `## dispatch_single error\n\n**model**: ${model}\n**task_id**: ${task_id}\n**error**: ${err.message}\n**stack**: ${err.stack?.split('\n').slice(0, 5).join('\n')}`,
        }],
        isError: true,
      };
    }
  }
);

// 工具 4: diagnostics — 合并 health_check / debug_env / model_scores / translate / ping_model
import { buildSdkEnv } from '../orchestrator/project-paths.js';
import { resolveModelRoute } from '../orchestrator/mms-routes-loader.js';
import Anthropic from '@anthropic-ai/sdk';

// ── Shared URL helpers ──
function stripTrailingV1(url: string): string {
  return url.replace(/\/v1\/?$/, '');
}

server.tool(
  'diagnostics',
  'Run diagnostic actions.',
  {
    action: z.enum(['health', 'env', 'scores', 'translate', 'ping']).describe('Action'),
    input: z.string().optional().describe('For translate: text; for ping: model ID'),
  },
  async ({ action, input }) => {
    if (action === 'health') {
      let healthText = '## Provider Health Check\n\n';

      // MMS routes check
      const mmsAvailable = isMmsAvailable();
      healthText += `**MMS routes**: ${mmsAvailable ? 'loaded' : 'not found'}\n`;
      healthText += `**Resolution**: MMS routes → providers.json fallback\n\n`;

      if (mmsAvailable) {
        const table = loadMmsRoutes()!;
        const modelIds = Object.keys(table.routes);
        healthText += `### MMS Models (${modelIds.length})\n`;
        for (const modelId of modelIds) {
          const route = table.routes[modelId];
          const urlPreview = route.anthropic_base_url.replace(/https?:\/\//, '').slice(0, 40);
          const hasKey = route.api_key ? 'key-set' : 'NO-KEY';
          healthText += `- ${modelId}: ${urlPreview} (${hasKey}, p${route.priority})\n`;
        }
        healthText += '\n';

        // Live ping: 1 representative per provider_id + all tier-critical models
        const config = loadConfig(process.cwd());
        const tierModels = new Set<string>();
        // Collect models referenced in tiers config
        const tm = config.tiers;
        for (const m of [tm.planner?.model, tm.translator?.model, tm.reporter?.model,
          tm.executor?.model, tm.reviewer?.cross_review?.model,
          tm.reviewer?.arbitration?.model, tm.reviewer?.final_review?.model]) {
          if (m && m !== 'auto') tierModels.add(m);
        }
        const dm = tm.discuss?.model;
        if (dm) { for (const m of (Array.isArray(dm) ? dm : [dm])) { if (m !== 'auto') tierModels.add(m); } }
        // Also add default_worker and fallback
        if (config.default_worker) tierModels.add(config.default_worker);

        const seenProviders = new Set<string>();
        const pingTargets: Array<{ modelId: string; route: typeof table.routes[string]; reason: string }> = [];
        // First: add tier-critical models (always ping these)
        for (const id of tierModels) {
          const route = table.routes[id];
          if (!route) continue;
          pingTargets.push({ modelId: id, route, reason: 'tier' });
          const pKey = route.provider_id || route.anthropic_base_url;
          seenProviders.add(pKey);
        }
        // Then: add 1 representative per remaining provider_id
        for (const [id, route] of Object.entries(table.routes)) {
          if (id.startsWith('claude-')) continue;
          const pKey = route.provider_id || route.anthropic_base_url;
          if (seenProviders.has(pKey)) continue;
          seenProviders.add(pKey);
          pingTargets.push({ modelId: id, route, reason: 'provider-rep' });
        }

        healthText += `### Live Ping (${pingTargets.length} providers, 15s timeout)\n`;
        const PING_TIMEOUT = 15_000;
        const pingResults = await Promise.all(
          pingTargets.map(async ({ modelId, route }) => {
            const urlShort = route.anthropic_base_url.replace(/https?:\/\//, '').slice(0, 50);
            const start = Date.now();
            try {
              const resp = await fetch(stripTrailingV1(route.anthropic_base_url) + '/v1/messages', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-api-key': route.api_key,
                  'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                  model: modelId,
                  max_tokens: 5,
                  stream: true,
                  messages: [{ role: 'user', content: 'ping' }],
                }),
                signal: AbortSignal.timeout(PING_TIMEOUT),
              });
              const elapsed = Date.now() - start;
              // 200/201 = healthy, 4xx = endpoint exists but model/auth issue
              const ok = resp.status >= 200 && resp.status < 300;
              const icon = ok ? '✅' : resp.status < 500 ? '⚠️' : '❌';
              return { modelId, url: urlShort, status: `${icon} ${resp.status} (${elapsed}ms)`, provider: route.provider_id || '?' };
            } catch (err: any) {
              const elapsed = Date.now() - start;
              const reason = elapsed >= PING_TIMEOUT ? 'TIMEOUT' : err.message?.slice(0, 50);
              return { modelId, url: urlShort, status: `❌ ${reason} (${elapsed}ms)`, provider: route.provider_id || '?' };
            }
          }),
        );

        for (const r of pingResults) {
          healthText += `- **${r.modelId}** → ${r.url} [${r.provider}] ${r.status}\n`;
        }
        healthText += '\n';
      }

      // Static providers check
      const providers = Object.keys(getAllProviders());
      if (providers.length > 0) {
        healthText += `### Static Providers (${providers.length})\n`;
        for (const provider of providers) {
          const healthy = await checkProviderHealth(provider);
          healthText += `- ${provider}: ${healthy ? 'OK' : 'UNAVAILABLE'}\n`;
        }
      }

      return { content: [{ type: 'text', text: healthText }] };
    }

    if (action === 'env') {
      const keys = [
        'HOME', 'USER', 'PATH',
        'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
        'MMS_ROUTES_PATH',
      ];
      let text = '## MCP Server Environment\n\n';
      text += `**pid**: ${process.pid}\n`;
      text += `**cwd**: ${process.cwd()}\n`;
      text += `**node**: ${process.version}\n\n`;

      text += '### Key Env Vars\n';
      for (const key of keys) {
        const val = process.env[key];
        if (!val) {
          text += `- ${key}: (not set)\n`;
        } else if (key.includes('TOKEN') || key.includes('KEY')) {
          text += `- ${key}: ${val.slice(0, 6)}...${val.slice(-4)} (${val.length} chars)\n`;
        } else if (key === 'PATH') {
          text += `- ${key}: ${val.slice(0, 80)}...\n`;
        } else {
          text += `- ${key}: ${val}\n`;
        }
      }

      text += '\n### MMS Routes File\n';
      const mmsTable = loadMmsRoutes();
      if (mmsTable) {
        text += `- Loaded: ${Object.keys(mmsTable.routes).length} models\n`;
        text += `- Models: ${Object.keys(mmsTable.routes).join(', ')}\n`;
      } else {
        text += '- NOT FOUND\n';
      }

      return { content: [{ type: 'text', text }] };
    }

    if (action === 'scores') {
      const registry = new ModelRegistry();
      const models = registry.getResolvable() as any[];

      let scoresText = "## Model Capability Scores\n";
      scoresText += "| Model | Coding | Reasoning | Chinese | Pass Rate |\n";
      scoresText += "|-------|--------|-----------|---------|-----------|\n";
      for (const model of models) {
        scoresText += `| ${model.id} | ${model.coding.toFixed(2)} | ${model.reasoning.toFixed(2)} | ${model.chinese.toFixed(2)} | ${model.pass_rate.toFixed(2)} |\n`;
      }

      return { content: [{ type: 'text', text: scoresText }] };
    }

    if (action === 'translate') {
      const registry = new ModelRegistry();
      const translatorModel = registry.selectTranslator();
      const modelInfo = registry.get(translatorModel);
      if (!modelInfo) {
        return { content: [{ type: 'text', text: `Unknown model: ${translatorModel}` }] };
      }
      const result = await translateToEnglish(input || '', translatorModel, modelInfo.provider);
      return {
        content: [{
          type: 'text',
          text: `## Translation (${result.translator_model}, confidence: ${result.confidence.toFixed(2)})\n\n${result.english}\n\n_Duration: ${result.duration_ms}ms_`,
        }],
      };
    }

    // action === 'ping'
    const pingModel = input || '';
    const pingPrompt = 'Reply with exactly: PONG';
    const startTime = Date.now();
    try {
      const mmsRoute = resolveModelRoute(pingModel);
      const baseUrl = mmsRoute?.anthropic_base_url
        || process.env.ANTHROPIC_BASE_URL || '';
      const apiKey = mmsRoute?.api_key
        || process.env.ANTHROPIC_AUTH_TOKEN || '';

      const client = new Anthropic({
        apiKey: apiKey || 'dummy',
        baseURL: stripTrailingV1(baseUrl) || undefined,
      });

      const response = await client.messages.create({
        model: pingModel,
        max_tokens: 256,
        messages: [{ role: 'user', content: pingPrompt }],
        stream: true,
      });

      let output = '';
      for await (const event of response) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          output += event.delta.text;
        }
      }

      const duration = Date.now() - startTime;
      const debug = {
        baseUrl: baseUrl?.slice(0, 50),
        tokenPrefix: apiKey?.slice(0, 8),
        source: mmsRoute ? 'mms-route' : 'process-env',
      };

      return {
        content: [{
          type: 'text',
          text: `## ping_model OK\n\n**model**: ${pingModel}\n**duration**: ${duration}ms\n**response**: ${output.slice(0, 500)}\n\n**routing debug**: ${JSON.stringify(debug, null, 2)}`,
        }],
      };
    } catch (err: any) {
      const duration = Date.now() - startTime;
      return {
        content: [{
          type: 'text',
          text: `## ping_model FAILED\n\n**model**: ${pingModel}\n**duration**: ${duration}ms\n**error**: ${err.message}`,
        }],
        isError: true,
      };
    }
  }
);

// 工具 5: compact_run
server.tool(
  'compact_run',
  'Build a minimal compact/restore card for the latest or specified Hive run.',
  {
    cwd: z.string().describe('Working directory').optional(),
    run_id: z.string().describe('Run ID').optional(),
  },
  async ({ cwd, run_id }) => {
    const effectiveCwd = cwd || process.cwd();
    const compactPacket = loadCompactPacket(effectiveCwd, run_id);
    const workspaceCompact = compactPacket ? null : loadWorkspaceCompactPacket(effectiveCwd);
    if (!compactPacket) {
      if (workspaceCompact) {
        return {
          content: [{
            type: 'text',
            text: [
              'Hive workspace restore card ready.',
              `- restore prompt: ${relPath(effectiveCwd, workspaceCompact.restorePromptPath)}`,
              `- latest restore prompt: ${relPath(effectiveCwd, workspaceCompact.latestRestorePromptPath)}`,
              `- packet: ${relPath(effectiveCwd, workspaceCompact.jsonPath)}`,
              '',
              workspaceCompact.packet.restore_prompt,
            ].join('\n'),
          }],
        };
      }
      const latestRestore = loadLatestCompactRestore(effectiveCwd);
      if (latestRestore) {
        return {
          content: [{
            type: 'text',
            text: [
              `Hive latest restore card ready${latestRestore.runId ? ` for ${latestRestore.runId}` : ''}.`,
              `- restore prompt: ${relPath(effectiveCwd, latestRestore.restorePromptPath)}`,
              latestRestore.packetPath ? `- packet: ${relPath(effectiveCwd, latestRestore.packetPath)}` : '',
              '',
              latestRestore.restorePrompt,
            ].filter(Boolean).join('\n'),
          }],
        };
      }
      return {
        content: [{
          type: 'text',
          text: 'No Hive restore surface is available in this repository yet.',
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: [
          `Hive compact card ready for ${compactPacket.runId}.`,
          `- restore prompt: ${relPath(effectiveCwd, compactPacket.restorePromptPath)}`,
          `- latest restore prompt: ${relPath(effectiveCwd, compactPacket.latestRestorePromptPath)}`,
          `- packet: ${relPath(effectiveCwd, compactPacket.jsonPath)}`,
          '',
          compactPacket.packet.restore_prompt,
        ].join('\n'),
      }],
    };
  },
);

// 工具 6: report
server.tool(
  'report',
  'Generate report.',
  {
    result_json: z.string().describe('OrchestratorResult JSON'),
    format: z.enum(['summary', 'detailed']).default('summary'),
  },
  async ({ result_json, format }) => {
    const result = JSON.parse(result_json);
    const config = loadConfig(process.cwd());
    const registry = new ModelRegistry();
    const reporterModel = resolveTierModel(
      config.tiers.reporter.model,
      () => registry.selectForReporter(),
      registry,
      'general',
    );
    const reporterInfo = registry.get(reporterModel);
    const reporterProvider = reporterInfo?.provider || reporterModel;

    const report = await reportResults(result, reporterModel, reporterProvider, {
      language: 'zh', format, target: 'stdout',
    });
    const reportPath = writeMcpTextArtifact(process.cwd(), 'report', report);
    return {
      content: [{
        type: 'text',
        text: [
          `Generated ${format} report with ${reporterModel}.`,
          `- saved to: ${relPath(process.cwd(), reportPath)}`,
        ].join('\n'),
      }],
    };
  }
);

// ── Autoloop tools ──

server.tool(
  'run_goal',
  'Run a full autonomous loop: plan → dispatch → review → verify → repair/replan → done.',
  {
    goal: z.string().describe('Goal in Chinese or English. Omit to read from .ai/mcp/latest-goal.md').optional(),
    goal_path: z.string().describe('Path to a goal/brief file (alternative to inline goal)').optional(),
    cwd: z.string().describe('Working directory').optional(),
    mode: z.enum(['safe', 'balanced', 'aggressive']).default('safe'),
    execution_mode: z.enum([
      'quick', 'think', 'auto',
      'record-only', 'clarify-first',
      'auto-execute-small', 'execute-standard', 'execute-parallel',
    ]).describe('Execution depth mode (auto-classified if not provided)').optional(),
    lane: z.enum([
      'record-only', 'clarify-first',
      'auto-execute-small', 'execute-standard', 'execute-parallel',
    ]).describe('Operator-facing lane name').optional(),
    agent_count: z.number().describe('Agent count hint (never overrides dispatch_style)').optional(),
    max_rounds: z.number().describe('Max loop rounds').default(6),
    auto_merge: z.boolean().describe('Auto-merge passed worktrees').default(false),
  },
  async ({ goal: goalArg, goal_path, cwd, mode, execution_mode, lane, agent_count, max_rounds, auto_merge }) => {
    const { runGoal } = await import('../orchestrator/driver.js');
    const effectiveCwd = cwd || process.cwd();
    let goalInput: ResolvedGoalInput;
    try {
      goalInput = resolveGoalInput(effectiveCwd, goalArg, goal_path);
      validateGoalInputForExecution(goalInput);
    } catch (err: any) {
      return { content: [{ type: 'text', text: `## run_goal error\n\n**error**: ${err.message}` }], isError: true };
    }
    const capturedGoalPath = goalInput.source === 'inline' && goalInput.goal.length >= LARGE_GOAL_THRESHOLD
      ? persistInlineGoalArtifact(effectiveCwd, goalInput.goal)
      : null;
    server.sendLoggingMessage({
      level: 'info',
      logger: 'hive',
      data: `[bootstrap] goal_source=${goalInput.source} goal_chars=${goalInput.goal.length}${capturedGoalPath ? ` captured=${relPath(effectiveCwd, capturedGoalPath)}` : ''}`,
    });
    try {
      const execution = await runGoal({
        goal: goalInput.goal, cwd: effectiveCwd, mode,
        execution_mode, lane, agent_count,
        maxRounds: max_rounds, allowAutoMerge: auto_merge,
        onProgress: (stage, detail) => {
          server.sendLoggingMessage({ level: 'info', logger: 'hive', data: `[${stage}] ${detail}` });
        },
      });
      const { spec, state, plan, planner_model, plan_discuss, plan_discuss_collab } = execution;
      const taskSummary = plan
        ? plan.tasks.map(t => `- ${t.id}: ${t.description.slice(0, 80)} [${t.assigned_model}]${t.verification_profile ? ` {rule:${t.verification_profile}}` : ''}`).join('\n')
        : '(no plan)';
      const verificationSummary = state.verification_results
        .map(v => `- [${v.passed ? '✅' : '❌'}] ${v.target.label}${v.failure_class ? ` (${v.failure_class})` : ''}`)
        .join('\n');
      const taskVerificationSummary = Object.entries(state.task_verification_results || {})
        .filter(([, results]) => results.length > 0)
        .map(([taskId, results]) => {
          const failed = results.filter((result) => result.target.must_pass && !result.passed).length;
          return `- ${taskId}: ${results.length} checks${failed > 0 ? `, ${failed} failed` : ''}`;
        })
        .join('\n');
      let text = `## Run Complete: ${spec.id}\n\n`;
      text += `**Status**: ${state.status}\n`;
      text += `**Rounds**: ${state.round}/${spec.max_rounds}\n`;
      text += `**Mode**: ${spec.mode}\n`;
      text += `**Goal Source**: ${goalInput.source}${goalInput.sourcePath ? ` (${relPath(effectiveCwd, goalInput.sourcePath)})` : capturedGoalPath ? ` (${relPath(effectiveCwd, capturedGoalPath)})` : ''}\n`;
      text += `**Goal Chars**: ${goalInput.goal.length}\n`;
      if (planner_model) text += `**Planner**: ${planner_model}\n`;
      if (plan_discuss) text += `**Discuss**: ${plan_discuss.quality_gate} — ${plan_discuss.overall_assessment?.slice(0, 150)}\n`;
      if (plan_discuss_collab?.card) {
        text += `**Collab**: ${plan_discuss_collab.card.room_id} [${plan_discuss_collab.card.status}] replies=${plan_discuss_collab.card.replies}\n`;
        text += `**Collab Next**: ${plan_discuss_collab.card.next}\n`;
      }
      text += '\n';
      text += `### Tasks\n${taskSummary}\n\n`;
      if (verificationSummary) text += `### Verification\n${verificationSummary}\n\n`;
      if (taskVerificationSummary) text += `### Task Verification\n${taskVerificationSummary}\n\n`;
      if (execution.result?.token_breakdown) {
        text += `### Cost\n`;
        text += `- Actual: $${execution.result.token_breakdown.actual_cost_usd.toFixed(4)}\n`;
        text += `- Claude equivalent: $${execution.result.token_breakdown.claude_equivalent_usd.toFixed(4)}\n`;
        text += `- Savings: $${execution.result.token_breakdown.savings_usd.toFixed(4)}\n\n`;
      }
      if (state.budget_status) {
        text += `### Budget\n`;
        text += `- Spent: $${state.budget_status.current_spent_usd.toFixed(4)} / $${state.budget_status.monthly_limit_usd.toFixed(2)}\n`;
        text += `- Remaining: $${state.budget_status.remaining_usd.toFixed(4)}\n`;
        if (state.budget_warning) {
          text += `- Warning: ${state.budget_warning}\n`;
        }
        text += `\n`;
      }
      text += `### Next Action\n**${state.next_action?.kind}**: ${state.next_action?.reason}\n\n`;
      if (state.final_summary) text += `### Summary\n${state.final_summary}\n`;
      if (capturedGoalPath) {
        text += `\n### Host Prompt Note\nLarge inline goal was captured to \`${relPath(effectiveCwd, capturedGoalPath)}\`; prefer capture_goal/goal_path next time to keep the host prompt thin.\n`;
      }
      return { content: [{ type: 'text', text }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `## run_goal error\n\n**error**: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'resume_run',
  'Resume a saved run. Default: read-only restore. Set execute=true to re-enter the loop.',
  {
    run_id: z.string().describe('Run ID (e.g. run-1775011220354)'),
    cwd: z.string().describe('Working directory').optional(),
    execute: z.boolean().describe('Re-enter execution loop').default(false),
  },
  async ({ run_id, cwd, execute }) => {
    const { resumeRun } = await import('../orchestrator/driver.js');
    const execution = await resumeRun(cwd || process.cwd(), run_id, { execute });
    if (!execution) {
      return { content: [{ type: 'text', text: `## resume_run error\n\nRun not found: ${run_id}` }], isError: true };
    }
    const { spec, state } = execution;
    let text = `## Run ${execute ? 'Resumed' : 'Restored'}: ${spec.id}\n\n`;
    text += `**Status**: ${state.status}\n**Rounds**: ${state.round}/${spec.max_rounds}\n**Goal**: ${spec.goal}\n\n`;
    const taskVerificationSummary = Object.entries(state.task_verification_results || {})
      .filter(([, results]) => results.length > 0)
      .map(([taskId, results]) => {
        const failed = results.filter((result) => result.target.must_pass && !result.passed).length;
        return `- ${taskId}: ${results.length} checks${failed > 0 ? `, ${failed} failed` : ''}`;
      })
      .join('\n');
    if (taskVerificationSummary) {
      text += `### Task Verification\n${taskVerificationSummary}\n\n`;
    }
    text += `### Next Action\n**${state.next_action?.kind}**: ${state.next_action?.reason}\n`;
    if (state.final_summary) text += `\n### Summary\n${state.final_summary}\n`;
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'run_status',
  'List all runs or get details of a specific run, including task verification summaries.',
  {
    run_id: z.string().describe('Specific run ID to inspect').optional(),
    cwd: z.string().describe('Working directory').optional(),
  },
  async ({ run_id, cwd }) => {
    const { listRuns, loadRunPlan, loadRunResult, loadRunSpec, loadRunState } = await import('../orchestrator/run-store.js');
    const effectiveCwd = cwd || process.cwd();
    if (run_id) {
      const spec = loadRunSpec(effectiveCwd, run_id);
      const state = loadRunState(effectiveCwd, run_id);
      if (!spec || !state) {
        return { content: [{ type: 'text', text: `## run_status error\n\nRun not found: ${run_id}` }], isError: true };
      }
      const plan = loadRunPlan(effectiveCwd, run_id);
      const result = loadRunResult(effectiveCwd, run_id);
      const { readLoopProgress } = await import('../orchestrator/loop-progress-store.js');
      const progress = readLoopProgress(effectiveCwd, run_id);
      let text = `## Run: ${run_id}\n\n`;
      const effectiveMode = resolveEffectiveMode(spec, state);
      const modeLabel = effectiveMode.overridden
        ? `${effectiveMode.mode} (steered from ${spec.execution_mode ?? 'auto'})`
        : effectiveMode.mode;
      text += `**Status**: ${state.status}\n**Goal**: ${spec.goal}\n**Mode**: ${modeLabel}\n`;
      text += `**Rounds**: ${state.round}/${spec.max_rounds}\n`;
      if (progress) {
        text += `**Phase**: ${progress.phase} — ${progress.reason}\n`;
        if (progress.planner_model) text += `**Planner**: ${progress.planner_model}\n`;
        if (progress.focus_task_id) text += `**Focus**: ${progress.focus_task_id}${progress.focus_model ? ` (${progress.focus_model})` : ''}\n`;
        if (progress.collab?.card) {
          text += `**Collab**: ${progress.collab.card.room_id} [${progress.collab.card.status}] replies=${progress.collab.card.replies}\n`;
          text += `**Collab Next**: ${progress.collab.card.next}\n`;
          if (progress.collab.card.last_reply_at) {
            text += `**Collab Last Reply**: ${progress.collab.card.last_reply_at}\n`;
          }
          if (progress.collab.card.join_hint) {
            text += `**Collab Join**: ${progress.collab.card.join_hint}\n`;
          }
        }
      }
      text += `**Plan tasks**: ${plan?.tasks.length || 0}\n`;
      text += `**Completed**: ${state.completed_task_ids.join(', ') || 'none'}\n`;
      text += `**Failed**: ${state.failed_task_ids.join(', ') || 'none'}\n`;
      text += `**Merged**: ${state.merged_task_ids?.join(', ') || 'none'}\n`;
      text += `**Result saved**: ${result ? 'yes' : 'no'}\n`;
      const profiledTasks = plan?.tasks.filter((task) => task.verification_profile) || [];
      if (profiledTasks.length > 0) {
        text += `**Task rules**: ${profiledTasks.map((task) => `${task.id}:${task.verification_profile}`).join(', ')}\n`;
      }
      if (result?.token_breakdown) {
        text += `**Actual cost**: $${result.token_breakdown.actual_cost_usd.toFixed(4)}\n`;
        text += `**Savings vs Claude**: $${result.token_breakdown.savings_usd.toFixed(4)}\n`;
      }
      if (state.budget_status) {
        text += `**Budget spent**: $${state.budget_status.current_spent_usd.toFixed(4)} / $${state.budget_status.monthly_limit_usd.toFixed(2)}\n`;
        text += `**Budget remaining**: $${state.budget_status.remaining_usd.toFixed(4)}\n`;
      } else {
        const budgetStatus = getBudgetStatus(loadConfig(effectiveCwd));
        if (budgetStatus) {
          text += `**Budget spent**: $${budgetStatus.current_spent_usd.toFixed(4)} / $${budgetStatus.monthly_limit_usd.toFixed(2)}\n`;
          text += `**Budget remaining**: $${budgetStatus.remaining_usd.toFixed(4)}\n`;
        }
      }
      if (state.budget_warning) {
        text += `**Budget warning**: ${state.budget_warning}\n`;
      }
      if (state.final_summary) text += `\n**Summary**: ${state.final_summary}\n`;
      const taskVerificationSummary = Object.entries(state.task_verification_results || {})
        .filter(([, results]) => results.length > 0)
        .map(([taskId, results]) => {
          const failed = results.filter((result) => result.target.must_pass && !result.passed).length;
          return `- ${taskId}: ${results.length} checks${failed > 0 ? `, ${failed} failed` : ''}`;
        })
        .join('\n');
      if (taskVerificationSummary) {
        text += `\n### Task Verification\n${taskVerificationSummary}\n`;
      }
      // Phase 8B: Steering visibility
      if (state.steering) {
        const s = state.steering;
        if (s.paused) text += `\n**Steering**: PAUSED ⏸️\n`;
        if (s.last_applied) {
          text += `\n**Last Steering**: ${s.last_applied.action_type} → ${s.last_applied.outcome}\n`;
        }
        if (s.last_rejected) {
          text += `\n**Last Rejected**: ${s.last_rejected.action_type} — ${s.last_rejected.reason}\n`;
        }
        const pendingActions = (await import('../orchestrator/steering-store.js')).getPendingSteeringActions(effectiveCwd, run_id);
        if (pendingActions.length > 0) {
          text += `\n**Pending Steering** (${pendingActions.length}):\n`;
          for (const a of pendingActions) {
            text += `- \`${a.action_type}\`${a.task_id ? ` → ${a.task_id}` : ''} (requested ${a.requested_at})\n`;
          }
        }
      }
      // Phase 9A: Operator summary — same surface as CLI hive status
      const runIdLocal = run_id;
      const { loadProviderHealth } = await import('../orchestrator/watch-loader.js');
      const providerHealth = loadProviderHealth(effectiveCwd, run_id);
      const { generateRunSummary } = await import('../orchestrator/operator-summary.js');
      const summary = generateRunSummary({
        runId: runIdLocal, spec, state, progress, plan, providerHealth,
      });
      text += `\n### Operator Summary\n`;
      text += `**Overall**: ${summary.overall_state} | round ${summary.round}${summary.max_rounds ? `/${summary.max_rounds}` : ''}\n`;
      if (summary.top_successes.length > 0) {
        text += `**Completed**: ${summary.top_successes.map((s: any) => s.task_id).join(', ')}\n`;
      }
      if (summary.top_failures.length > 0) {
        text += `**Failed**: ${summary.top_failures.map((f: any) => `${f.task_id} (${f.failure_class})`).join(', ')}\n`;
      }
      if (summary.primary_blocker) {
        text += `**Blocker**: ${summary.primary_blocker.description}\n`;
      }

      // Phase 9B: Quick commands
      const { generateOperatorHints } = await import('../orchestrator/operator-hints.js');
      const hints = generateOperatorHints({ spec, state, providerHealth });
      if (hints.hints.length > 0) {
        text += `\n### Next Actions\n`;
        for (const hint of hints.hints.slice(0, 3)) {
          const icon = hint.priority === 'high' ? '‼️' : hint.priority === 'medium' ? '▶️' : '💡';
          text += `- ${icon} [${hint.priority}] ${hint.description}\n`;
        }
        const { suggestNextCommands } = await import('../orchestrator/operator-commands.js');
        const topHint = hints.hints[0];
        const cmdCtx = {
          run_id: runIdLocal,
          topHintAction: topHint?.action,
          taskId: topHint?.task_id,
          hasSteering: ((state.steering?.pending_actions || []).length) > 0,
          hasFailures: summary.top_failures.length > 0,
        };
        const cmds = suggestNextCommands(summary.overall_state, cmdCtx);
        if (cmds.length > 0) {
          text += `\n### Quick Commands\n`;
          for (const cmd of cmds.slice(0, 4)) {
            text += `- \`${cmd.command}\` — ${cmd.label}\n`;
          }
        }
      }

      // Phase 10A: Collaboration summary
      const { loadSteeringStore } = await import('../orchestrator/steering-store.js');
      const steeringStore = loadSteeringStore(effectiveCwd, run_id);
      const { generateCollaborationSummary } = await import('../orchestrator/collab-summary.js');
      const collabSummary = generateCollaborationSummary({
        runId: runIdLocal, state, spec,
        steeringActions: steeringStore?.actions || [],
        reviewResults: result?.review_results,
        providerHealth,
      });
      if (collabSummary.active_cues > 0 || collabSummary.blocker_categories.length > 0) {
        text += `\n### Collaboration\n`;
        const dist = collabSummary.cue_distribution;
        const parts: string[] = [];
        if (dist.needs_human > 0) parts.push(`human:${dist.needs_human}`);
        if (dist.blocked > 0) parts.push(`blocked:${dist.blocked}`);
        if (dist.needs_review > 0) parts.push(`review:${dist.needs_review}`);
        if (dist.watch > 0) parts.push(`watch:${dist.watch}`);
        if (dist.ready > 0) parts.push(`ready:${dist.ready}`);
        text += `- Cues: ${parts.join(' | ')}\n`;
        for (const item of collabSummary.top_attention_items.slice(0, 3)) {
          text += `- ${item.task_id}: ${item.reason}\n`;
        }
        text += `- Handoff: ${collabSummary.handoff_ready ? 'ready' : 'not_ready'}\n`;
      }

      text += `\n### Next Action\n**${state.next_action?.kind}**: ${state.next_action?.reason}\n`;
      return { content: [{ type: 'text', text }] };
    }
    const runs = listRuns(effectiveCwd);
    if (runs.length === 0) {
      return { content: [{ type: 'text', text: '## Runs\n\nNo runs found.' }] };
    }
    let text = `## Runs (${runs.length})\n\n| ID | Status | Goal |\n|-----|--------|------|\n`;
    for (const run of runs) {
      text += `| ${run.id} | ${run.state?.status || '?'} | ${run.spec?.goal?.slice(0, 60) || '(no goal)'} |\n`;
    }
    return { content: [{ type: 'text', text }] };
  },
);

// ── Phase 8B: Steering submission tool ──

server.tool(
  'submit_steering',
  'Submit a human steering action to an active run. Actions are applied at the next safe point in the driver loop.',
  {
    run_id: z.string().describe('Run ID to steer'),
    action_type: z.enum([
      'pause_run', 'resume_run', 'retry_task', 'skip_task',
      'escalate_mode', 'downgrade_mode', 'request_replan',
      'force_discuss', 'mark_requires_human', 'inject_steering_note',
    ]).describe('Type of steering action'),
    task_id: z.string().describe('Target task ID (for task-level actions)').optional(),
    target_mode: z.string().describe('Target execution mode (for escalate/downgrade)').optional(),
    reason: z.string().describe('Why this steering is needed').optional(),
    note: z.string().describe('Free-text instruction (for inject_steering_note)').optional(),
    cwd: z.string().describe('Working directory').optional(),
  },
  async ({ run_id, action_type, task_id, target_mode, reason, note, cwd }) => {
    const { submitSteeringAction, isDuplicateAction } = await import('../orchestrator/steering-store.js');
    const { loadRunSpec, loadRunState } = await import('../orchestrator/run-store.js');
    const { validateSteeringAction } = await import('../orchestrator/steering-actions.js');
    const effectiveCwd = cwd || process.cwd();

    const spec = loadRunSpec(effectiveCwd, run_id);
    const state = loadRunState(effectiveCwd, run_id);
    if (!spec || !state) {
      return { content: [{ type: 'text', text: `## submit_steering error\n\nRun not found: ${run_id}` }], isError: true };
    }

    // Check for duplicates
    if (isDuplicateAction(effectiveCwd, run_id, action_type, task_id)) {
      return { content: [{ type: 'text', text: `## submit_steering\n\n⚠️ Duplicate action suppressed: ${action_type}${task_id ? ` for ${task_id}` : ''}. A similar action was submitted within the last 30s.` }] };
    }

    const action = submitSteeringAction(effectiveCwd, run_id, {
      run_id,
      task_id,
      action_type: action_type as any,
      scope: task_id ? 'task' : 'run',
      payload: { target_mode: target_mode as ExecutionMode | undefined, note, reason },
      requested_by: 'mcp',
    });

    // Pre-validate and report
    const validation = validateSteeringAction(action, spec, state);
    const statusLine = validation.allowed
      ? `✅ Accepted — will be applied at next safe point`
      : `⚠️ Submitted but may be rejected: ${validation.reason}`;

    return {
      content: [{
        type: 'text',
        text: `## Steering Submitted\n\n- **Action**: \`${action.action_type}\`\n- **ID**: \`${action.action_id}\`\n- **Scope**: ${action.scope}${task_id ? ` → ${task_id}` : ''}\n- **Status**: ${statusLine}\n- **Requested**: ${action.requested_at}`,
      }],
    };
  },
);

export default server;

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isMainModule = process.argv[1]?.includes('mcp-server/index');
if (isMainModule) {
  main().catch((error) => {
    console.error('Hive MCP server failed:', error);
    process.exit(1);
  });
}
