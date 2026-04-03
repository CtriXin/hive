import { execSync } from 'child_process';
import path from 'path';
import type {
  TaskPlan,
  TranslationResult,
  PlanDiscussResult,
  StageTokenUsage,
  PlannerDiscussRoomRef,
  CollabConfig,
  PlanningBrief,
} from './types.js';
import { buildPlanFromClaudeOutput, PLAN_PROMPT_TEMPLATE } from './planner.js';
import { translateToEnglish } from './translator.js';
import { ModelRegistry } from './model-registry.js';
import { loadConfig, resolveTierModel, getBudgetWarning } from './hive-config.js';
import { describeTaskVerificationRules } from './project-policy.js';
import type { DiscussPlanDiag } from './discuss-bridge.js';
import { resolveProviderForModel } from './provider-resolver.js';
import {
  openPlannerDiscussRoom,
  collectPlannerDiscussReplies,
  buildRoomRef,
} from './agentbus-adapter.js';

function collectFileTree(cwd: string, maxLines = 80): string {
  try {
    const raw = execSync(
      `find . -type f \\( -name "*.ts" -o -name "*.js" -o -name "*.json" \\) | grep -v node_modules | grep -v dist | grep -v .git | sort | head -${maxLines}`,
      { cwd, encoding: 'utf-8', timeout: 5000 },
    );
    return raw.trim();
  } catch {
    return '(file tree unavailable)';
  }
}

function collectKeyTypes(cwd: string, maxLines = 50): string {
  try {
    const raw = execSync(
      `grep -rn "^export \\(interface\\|type\\|enum\\)" --include="*.ts" . | grep -v node_modules | grep -v dist | head -${maxLines}`,
      { cwd, encoding: 'utf-8', timeout: 5000 },
    );
    return raw.trim();
  } catch {
    return '(type signatures unavailable)';
  }
}

export function buildPlannerContext(cwd: string): string {
  const fileTree = collectFileTree(cwd);
  const keyTypes = collectKeyTypes(cwd);
  const taskRules = describeTaskVerificationRules(cwd);
  return `\n## Codebase Context (auto-collected)\n### File tree\n\`\`\`\n${fileTree}\n\`\`\`\n### Exported types\n\`\`\`\n${keyTypes}\n\`\`\`\n### Task verification rules\n${taskRules}\n`;
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
  budget_warning: string | null;
}

export interface PlannerDiscussExecutionResult {
  plan_discuss: PlanDiscussResult | null;
  discuss_diag: DiscussPlanDiag | null;
  plan_discuss_room: PlannerDiscussRoomRef | null;
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
  const maxTurns = agentModel.startsWith('claude-') ? 8 : 2;
  const result = await safeQuery({
    prompt,
    options: { cwd, maxTurns, env, model: agentModel },
  });

  const text = extractTextFromMessages(result.messages);
  const tokenUsage = extractTokenUsage(result.messages);
  const messages = result.messages.map((m: any, i: number) => {
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
    tokenUsage,
    diagnostics: {
      modelId,
      agentModel,
      resolvedBaseUrl,
      providerResolveFailed,
      maxTurns,
      messageCount: result.messages.length,
      rawLength: text.length,
      messages,
    },
  };
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
      env = buildSdkEnv(discussTierModel);
    }

    const result = await safeQuery({
      prompt: synthPrompt,
      options: { cwd: process.cwd(), maxTurns: 1, env, model: discussTierModel },
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
): Promise<PlannerDiscussExecutionResult> {
  let planDiscussResult: PlanDiscussResult | null = null;
  let discussDiag: DiscussPlanDiag | null = null;
  let planDiscussRoom: PlannerDiscussRoomRef | null = null;
  const discussMode = config.tiers.discuss?.mode || 'auto';

  if (discussMode !== 'always') {
    return {
      plan_discuss: null,
      discuss_diag: null,
      plan_discuss_room: null,
    };
  }

  const collab = config.collab;
  const transport: string = collab?.plan_discuss_transport || 'local';

  if (transport === 'agentbus') {
    try {
      const brief = buildPlanningBrief(plan, plannerModel);
      const briefText = JSON.stringify(brief, null, 2);

      const room = await openPlannerDiscussRoom({
        cwd,
        brief,
      });

      const timeoutMs = collab?.plan_discuss_timeout_ms ?? 15000;
      const minReplies = collab?.plan_discuss_min_replies ?? 0;
      const replies = await collectPlannerDiscussReplies({
        cwd, room_id: room.room_id,
        timeout_ms: timeoutMs,
        min_replies: minReplies,
      });

      planDiscussRoom = buildRoomRef(room, replies, timeoutMs);

      if (replies.length > 0) {
        planDiscussResult = await synthesizeAgentBusReplies(
          briefText, replies, plannerModel, config, registry,
        );
      } else {
        console.log('  ⚠️ AgentBus discuss: no replies collected, falling back to local');
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
  };
}

export async function planGoal(goal: string, cwd: string): Promise<PlanGoalResult> {
  const registry = new ModelRegistry();
  const config = loadConfig(cwd);
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
  const claudePrompt = `${PLAN_PROMPT_TEMPLATE}${plannerContext}\nUser goal: ${englishGoal}`;

  let plan: TaskPlan | null = null;
  let plannerRawOutput = '';
  let plannerDiagnostics: PlannerRunResult['diagnostics'] | null = null;
  let plannerStageUsage: StageTokenUsage | null = null;
  let plannerError: string | null = null;

  try {
    const plannerResult = await runClaudePlanner(claudePrompt, cwd, plannerModel);
    plannerRawOutput = plannerResult.text;
    plannerDiagnostics = plannerResult.diagnostics;
    plannerStageUsage = {
      stage: 'planner',
      model: plannerModel,
      input_tokens: plannerResult.tokenUsage.input,
      output_tokens: plannerResult.tokenUsage.output,
    };
    const parsed = parseJsonBlock<{ goal: string; tasks: unknown[] }>(plannerRawOutput);
    plan = buildPlanFromClaudeOutput(parsed, cwd);
    plan.cwd = cwd;
    for (const task of plan.tasks) {
      task.assigned_model = registry.assignModel(task);
      task.assignment_reason = `Assigned by registry for ${task.complexity} ${task.category} task`;
    }
  } catch (err: any) {
    plannerError = err.message;
  }

  let planDiscussResult: PlanDiscussResult | null = null;
  let discussDiag: DiscussPlanDiag | null = null;
  let planDiscussRoom: PlannerDiscussRoomRef | null = null;
  if (plan) {
    const discussExecution = await executePlannerDiscuss(plan, plannerModel, config as any, registry, cwd);
    planDiscussResult = discussExecution.plan_discuss;
    discussDiag = discussExecution.discuss_diag;
    planDiscussRoom = discussExecution.plan_discuss_room;
  }

  return {
    plan,
    translation: translationResult,
    planner_model: plannerModel,
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
    discuss_diag: discussDiag,
    budget_warning: getBudgetWarning(config),
  };
}
