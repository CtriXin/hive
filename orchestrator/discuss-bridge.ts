// ═══════════════════════════════════════════════════════════════════
// orchestrator/discuss-bridge.ts — Cross-model discussion using Claude Code SDK
// ═══════════════════════════════════════════════════════════════════
// Supports 1v1 and 1v2 discuss (single or multi-partner)
// Partner model(s) configurable via tiers.discuss.model

import type {
  DiscussTrigger, DiscussResult, DiscussionReply,
  WorkerConfig, TaskPlan, HiveConfig, PlanDiscussResult,
} from './types.js';
import type { ModelRegistry } from './model-registry.js';
import { getRegistry } from './model-registry.js';
import { ensureStageModelAllowed, loadConfig, resolveTierModel } from './hive-config.js';
import { isUnsupportedMmsTransportError, resolveProviderForModel } from './provider-resolver.js';
import { buildSdkEnv } from './project-paths.js';
import { safeQuery, extractTextFromMessages } from './sdk-query-safe.js';

// ── Shared utilities ──

function resolveProviderConfig(
  modelId: string,
): { baseUrl: string; apiKey: string } {
  try {
    const result = resolveProviderForModel(modelId);
    return { baseUrl: result.baseUrl, apiKey: result.apiKey };
  } catch (err) {
    if (!modelId.startsWith('claude-') || isUnsupportedMmsTransportError(err)) {
      throw err;
    }
    const envKey = modelId.toUpperCase().replace(/-/g, '_');
    return {
      baseUrl: process.env[`${envKey}_BASE_URL`] || '',
      apiKey: process.env[`${envKey}_API_KEY`] || '',
    };
  }
}

function ensureExplicitSdkRoute(
  modelId: string,
  baseUrl: string,
  apiKey: string,
): void {
  if (!baseUrl || !apiKey) {
    const detail = modelId.startsWith('claude-')
      ? 'Claude OAuth is manual-only here; ambient fallback is blocked.'
      : 'Refusing implicit Claude fallback.';
    throw new Error(
      `Model "${modelId}" has no explicit provider route/key. ${detail}`,
    );
  }
}

function extractJsonObject(rawOutput: string): string | null {
  const start = rawOutput.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < rawOutput.length; index += 1) {
    const char = rawOutput[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return rawOutput.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Resolve discuss partner model IDs from tier config.
 * Supports: 'auto', exact ID, provider shorthand, or array of these.
 */
function resolveDiscussPartners(
  excludeModel: string,
  registry: ModelRegistry,
): string[] {
  const config = loadConfig(process.cwd());
  const tierModel = config.tiers.discuss?.model || 'auto';
  const models = Array.isArray(tierModel) ? tierModel : [tierModel];

  const resolved: string[] = [];
  for (const m of models) {
    const id = resolveTierModel(
      m,
      () => registry.selectDiscussPartner(excludeModel),
      registry,
      'review',
      config,
    );
    ensureStageModelAllowed('discuss', id, config);
    if (!resolved.includes(id)) resolved.push(id);
  }
  return resolved;
}

// ── Worker Discussion (triggered by [DISCUSS_TRIGGER]) ──

const DISCUSS_PROMPT = `You are a senior engineer participating in a technical discussion.
A colleague is uncertain about a decision and needs your structured pushback.

## Context
{understanding}

## Direction under discussion
{direction}

## Constraints
{constraints}

## Specific question
{question}

## Your response MUST be valid JSON with this exact structure:
{
  "agreement": "What you agree with in their approach (1-2 sentences)",
  "pushback": "REQUIRED: At least one concrete objection or concern (2-3 sentences). You MUST push back on something.",
  "risks": ["risk 1", "risk 2"],
  "better_options": ["alternative 1 if any"],
  "recommended_next_step": "What they should do next (1 sentence)",
  "questions_back": ["clarifying question if needed"],
  "one_paragraph_synthesis": "Your overall assessment in one paragraph"
}

RULES:
- pushback is MANDATORY. Even if you mostly agree, find something to challenge.
- Be specific and actionable, not generic.
- Output ONLY the JSON, no explanatory text.`;

function assessQuality(reply: DiscussionReply): 'pass' | 'warn' | 'fail' {
  if (!reply.pushback || reply.pushback.length < 20) return 'fail';
  if (!reply.one_paragraph_synthesis) return 'warn';
  if (!reply.recommended_next_step) return 'warn';
  return 'pass';
}

function parseDiscussionReply(output: string): DiscussionReply | null {
  try {
    const jsonPayload = extractJsonObject(output);
    if (!jsonPayload) return null;
    const parsed = JSON.parse(jsonPayload);
    if (!parsed.pushback || parsed.pushback.trim().length < 10) return null;
    return parsed as DiscussionReply;
  } catch {
    return null;
  }
}

function escalateToSonnet(trigger: DiscussTrigger): DiscussResult {
  return {
    decision: trigger.leaning,
    reasoning: 'Discussion inconclusive, escalating to Sonnet.',
    escalated: true,
    escalated_to: 'sonnet',
    thread_id: '',
    quality_gate: 'fail',
  };
}

async function runSingleDiscuss(
  partnerId: string,
  prompt: string,
  workDir: string,
): Promise<DiscussionReply | null> {
  const { baseUrl, apiKey } = resolveProviderConfig(partnerId);
  ensureExplicitSdkRoute(partnerId, baseUrl, apiKey);
  const result = await safeQuery({
    prompt,
    options: {
      cwd: workDir,
      env: buildSdkEnv(partnerId, baseUrl, apiKey),
      model: partnerId,
      maxTurns: 3,
    },
  });
  return parseDiscussionReply(extractTextFromMessages(result.messages));
}

/**
 * Merge multiple discussion replies into a single DiscussResult.
 * Takes the most critical pushback and synthesizes reasoning.
 */
function mergeDiscussReplies(
  replies: Array<{ model: string; reply: DiscussionReply }>,
  trigger: DiscussTrigger,
): DiscussResult {
  const allRisks = replies.flatMap(r => r.reply.risks || []);
  const allOptions = replies.flatMap(r => r.reply.better_options || []);
  const pushbacks = replies.map(r => `[${r.model}] ${r.reply.pushback}`);
  const syntheses = replies.map(r => r.reply.one_paragraph_synthesis).filter(Boolean);

  // Use the recommendation from the highest-quality reply
  const bestReply = replies.find(r => assessQuality(r.reply) === 'pass')
    || replies[0];
  const worstQuality = replies.some(r => assessQuality(r.reply) === 'fail')
    ? 'fail' : replies.some(r => assessQuality(r.reply) === 'warn') ? 'warn' : 'pass';

  return {
    decision: bestReply.reply.recommended_next_step || trigger.leaning,
    reasoning: [
      ...pushbacks,
      `Risks: ${[...new Set(allRisks)].join('; ')}`,
      ...syntheses,
    ].join('\n'),
    escalated: false,
    thread_id: `discuss-${trigger.task_id}-${Date.now()}`,
    quality_gate: worstQuality,
  };
}

export async function triggerDiscussion(
  trigger: DiscussTrigger,
  workerConfig: WorkerConfig,
  workDir: string,
): Promise<DiscussResult> {
  const registry = getRegistry();
  const partnerIds = resolveDiscussPartners(workerConfig.model, registry);

  const prompt = DISCUSS_PROMPT
    .replace('{understanding}', `Worker (${workerConfig.model}) is implementing: ${workerConfig.prompt.slice(0, 300)}`)
    .replace('{direction}', `Leaning toward: ${trigger.leaning} because: ${trigger.why}`)
    .replace('{constraints}', `Options: ${trigger.options.join(', ')}`)
    .replace('{question}', `${trigger.uncertain_about}\nPressure-test this direction. Which option and why?`);

  console.log(`    💬 Discussion: ${trigger.uncertain_about}`);
  console.log(`    💬 Partners: ${partnerIds.join(', ')}`);

  try {
    // Run all partners in parallel
    const results = await Promise.all(
      partnerIds.map(async (id) => {
        const reply = await runSingleDiscuss(id, prompt, workDir);
        return { model: id, reply };
      }),
    );

    const validResults = results.filter(
      (r): r is { model: string; reply: DiscussionReply } => r.reply !== null,
    );

    if (validResults.length === 0) {
      console.log('    ⚠️ No valid discussion replies, escalating');
      return escalateToSonnet(trigger);
    }

    if (validResults.length === 1) {
      const { model, reply } = validResults[0];
      const quality = assessQuality(reply);
      if (quality === 'fail') return escalateToSonnet(trigger);
      console.log(`    ✅ Discussion resolved: ${reply.recommended_next_step.slice(0, 80)}`);
      return {
        decision: reply.recommended_next_step || trigger.leaning,
        reasoning: reply.one_paragraph_synthesis || '',
        escalated: false,
        thread_id: `discuss-${trigger.task_id}-${Date.now()}`,
        quality_gate: quality,
      };
    }

    // 1v2: merge results
    const merged = mergeDiscussReplies(validResults, trigger);
    console.log(`    ✅ Discussion merged (${validResults.length} partners, ${merged.quality_gate})`);
    return merged;

  } catch (err: any) {
    console.log(`    ❌ Discussion failed: ${err.message?.slice(0, 100)}`);
    return escalateToSonnet(trigger);
  }
}

// ── Plan Discuss ──

const PLAN_DISCUSS_PROMPT = `You are a senior architect reviewing a task plan before execution.
Your job is to find gaps, redundancies, and issues that the planner missed.

## Plan to review
{plan_summary}

## Your response MUST be valid JSON with this exact structure:
{
  "task_gaps": ["description of any missing tasks or steps"],
  "task_redundancies": ["tasks that overlap or should be merged"],
  "model_suggestions": ["suggestions for better model assignment"],
  "execution_order_issues": ["dependency or ordering problems"],
  "overall_assessment": "One paragraph: is this plan ready to execute? What's the biggest risk?"
}

RULES:
- Be specific and actionable. Reference task IDs when possible.
- If the plan looks solid, say so — but still look for at least one improvement.
- Focus on: missing error handling, wrong execution order, tasks too large to be atomic.
- Output ONLY the JSON, no explanatory text.`;

interface RawPlanReview {
  task_gaps?: string[];
  task_redundancies?: string[];
  model_suggestions?: string[];
  execution_order_issues?: string[];
  overall_assessment?: string;
}

async function runSinglePlanDiscuss(
  partnerId: string,
  prompt: string,
  cwd: string,
): Promise<RawPlanReview | null> {
  const { baseUrl, apiKey } = resolveProviderConfig(partnerId);
  ensureExplicitSdkRoute(partnerId, baseUrl, apiKey);
  const result = await safeQuery({
    prompt,
    options: {
      cwd,
      env: buildSdkEnv(partnerId, baseUrl, apiKey),
      model: partnerId,
      maxTurns: 1,
    },
  });

  const raw = extractTextFromMessages(result.messages);
  const json = extractJsonObject(raw);
  if (!json) return null;

  try {
    return JSON.parse(json) as RawPlanReview;
  } catch {
    return null;
  }
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}

export interface DiscussPlanDiag {
  partners: string[];
  partner_raw: Array<{ model: string; raw_len: number; json_found: boolean; raw_preview?: string; error?: string }>;
  error?: string;
}

export async function discussPlan(
  plan: TaskPlan,
  plannerModel: string,
  config: HiveConfig,
  registry: ModelRegistry,
): Promise<{ result: PlanDiscussResult | null; diag: DiscussPlanDiag }> {
  const tierModel = config.tiers.discuss?.model || 'auto';
  const models = Array.isArray(tierModel) ? tierModel : [tierModel];

  const partnerIds = models.map(m =>
    resolveTierModel(m, () => registry.selectDiscussPartner(plannerModel), registry, 'review', config),
  );
  const uniquePartners = dedup(partnerIds);

  const diag: DiscussPlanDiag = { partners: uniquePartners, partner_raw: [] };

  const taskSummary = plan.tasks.map(t =>
    `- ${t.id}: [${t.complexity}] ${t.description.slice(0, 120)} → ${t.assigned_model}`,
  ).join('\n');

  const planSummary = [
    `Goal: ${plan.goal}`,
    `Tasks (${plan.tasks.length}):`,
    taskSummary,
    `Execution order: ${plan.execution_order.map(g => `[${g.join(',')}]`).join(' → ')}`,
  ].join('\n');

  const prompt = PLAN_DISCUSS_PROMPT.replace('{plan_summary}', planSummary);

  console.log(`  💬 Plan discuss: ${uniquePartners.join(' + ')} reviewing plan...`);

  try {
    const results = await Promise.all(
      uniquePartners.map(async (id) => {
        try {
          const { baseUrl, apiKey } = resolveProviderConfig(id);
          ensureExplicitSdkRoute(id, baseUrl, apiKey);
          const r = await safeQuery({
            prompt,
            options: {
              cwd: plan.cwd || process.cwd(),
              env: buildSdkEnv(id, baseUrl, apiKey),
              model: id,
              maxTurns: 1,
            },
          });
          const raw = extractTextFromMessages(r.messages);
          const json = extractJsonObject(raw);
          const review = json ? JSON.parse(json) as RawPlanReview : null;
          diag.partner_raw.push({
            model: id,
            raw_len: raw.length,
            json_found: !!json,
            raw_preview: raw.slice(0, 200),
          });
          return { model: id, review };
        } catch (err: any) {
          diag.partner_raw.push({
            model: id,
            raw_len: 0,
            json_found: false,
            error: err.message?.slice(0, 150),
          });
          return { model: id, review: null };
        }
      }),
    );

    let valid = results.filter(
      (r): r is { model: string; review: RawPlanReview } => r.review !== null,
    );

    // Fallback: if all partners failed, try tier fallback model
    if (valid.length === 0) {
      const fallbackModel = config.tiers.discuss?.fallback;
      if (fallbackModel && !uniquePartners.includes(fallbackModel)) {
        console.log(`  🔄 Plan discuss: primary partners failed, trying fallback ${fallbackModel}`);
        try {
          const { baseUrl, apiKey } = resolveProviderConfig(fallbackModel);
          ensureExplicitSdkRoute(fallbackModel, baseUrl, apiKey);
          const r = await safeQuery({
            prompt,
            options: {
              cwd: plan.cwd || process.cwd(),
              env: buildSdkEnv(fallbackModel, baseUrl, apiKey),
              model: fallbackModel,
              maxTurns: 1,
            },
          });
          const raw = extractTextFromMessages(r.messages);
          const json = extractJsonObject(raw);
          const review = json ? JSON.parse(json) as RawPlanReview : null;
          diag.partner_raw.push({
            model: `${fallbackModel}(fallback)`,
            raw_len: raw.length,
            json_found: !!json,
            raw_preview: raw.slice(0, 200),
          });
          if (review) {
            valid = [{ model: fallbackModel, review }];
          }
        } catch (err: any) {
          diag.partner_raw.push({
            model: `${fallbackModel}(fallback)`,
            raw_len: 0,
            json_found: false,
            error: err.message?.slice(0, 150),
          });
        }
      }
    }

    if (valid.length === 0) {
      console.log('  ⚠️ Plan discuss: no valid replies (including fallback)');
      return { result: null, diag };
    }

    const merged: PlanDiscussResult = {
      partner_models: valid.map(v => v.model),
      task_gaps: dedup(valid.flatMap(v => v.review.task_gaps || [])),
      task_redundancies: dedup(valid.flatMap(v => v.review.task_redundancies || [])),
      model_suggestions: dedup(valid.flatMap(v => v.review.model_suggestions || [])),
      execution_order_issues: dedup(valid.flatMap(v => v.review.execution_order_issues || [])),
      overall_assessment: valid.map(v =>
        `[${v.model}] ${v.review.overall_assessment || 'No assessment'}`,
      ).join('\n'),
      quality_gate: 'pass',
    };

    const hasSubstance = merged.task_gaps.length > 0
      || merged.task_redundancies.length > 0
      || merged.execution_order_issues.length > 0;

    merged.quality_gate = !merged.overall_assessment ? 'fail'
      : hasSubstance ? 'pass' : 'warn';

    console.log(`  ✅ Plan discuss done (${valid.length} partner(s), ${merged.quality_gate})`);
    return { result: merged, diag };

  } catch (err: any) {
    diag.error = err.message?.slice(0, 200);
    console.log(`  ❌ Plan discuss failed: ${err.message?.slice(0, 100)}`);
    return { result: null, diag };
  }
}
