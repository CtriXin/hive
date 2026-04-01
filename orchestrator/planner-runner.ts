import { execSync } from 'child_process';
import type { TaskPlan, TranslationResult, PlanDiscussResult } from './types.js';
import { buildPlanFromClaudeOutput, PLAN_PROMPT_TEMPLATE } from './planner.js';
import { translateToEnglish } from './translator.js';
import { ModelRegistry } from './model-registry.js';
import { loadConfig, resolveTierModel, getBudgetWarning } from './hive-config.js';
import type { DiscussPlanDiag } from './discuss-bridge.js';
import { resolveProviderForModel } from './provider-resolver.js';

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
  return `\n## Codebase Context (auto-collected)\n### File tree\n\`\`\`\n${fileTree}\n\`\`\`\n### Exported types\n\`\`\`\n${keyTypes}\n\`\`\`\n`;
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
  planner_raw_output: string;
  planner_error: string | null;
  planner_diagnostics: PlannerRunResult['diagnostics'] | null;
  plan_discuss: PlanDiscussResult | null;
  discuss_diag: DiscussPlanDiag | null;
  budget_warning: string | null;
}

export async function runClaudePlanner(prompt: string, cwd: string, modelId: string): Promise<PlannerRunResult> {
  const { safeQuery, extractTextFromMessages } = await import('./sdk-query-safe.js');
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
    env = buildSdkEnv(agentModel);
  }

  const maxTurns = 3;
  const result = await safeQuery({
    prompt,
    options: { cwd, maxTurns, env },
  });

  const text = extractTextFromMessages(result.messages);
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
  let plannerError: string | null = null;

  try {
    const plannerResult = await runClaudePlanner(claudePrompt, cwd, plannerModel);
    plannerRawOutput = plannerResult.text;
    plannerDiagnostics = plannerResult.diagnostics;
    const parsed = parseJsonBlock<{ goal: string; tasks: unknown[] }>(plannerRawOutput);
    plan = buildPlanFromClaudeOutput(parsed);
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
  const discussMode = config.tiers.discuss?.mode || 'auto';
  if (plan && discussMode === 'always') {
    const { discussPlan } = await import('./discuss-bridge.js');
    const dr = await discussPlan(plan, plannerModel, config, registry);
    planDiscussResult = dr.result;
    discussDiag = dr.diag;
  }

  return {
    plan,
    translation: translationResult,
    planner_model: plannerModel,
    planner_raw_output: plannerRawOutput,
    planner_error: plannerError,
    planner_diagnostics: plannerDiagnostics,
    plan_discuss: planDiscussResult,
    discuss_diag: discussDiag,
    budget_warning: getBudgetWarning(config),
  };
}
