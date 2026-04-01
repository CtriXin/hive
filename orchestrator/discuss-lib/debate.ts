// ═══════════════════════════════════════════════════════════════════
// discuss-lib/debate.ts — Multi-model debate (对碰)
// ═══════════════════════════════════════════════════════════════════
// Flow: Round 1 models discuss in parallel → synthesizer confronts all pushbacks → final report

import type { ModelCaller } from './model-caller.js';
import type {
  DiscussTrigger, DiscussConfig, DiscussionReply, DebateRoundResult, DebateResult, GroupDebateResult,
} from './types.js';
import { parseDiscussionReply } from './json-utils.js';
import { resolveModelRoute } from './config.js';

const ROUND1_PROMPT = `You are a senior engineer participating in a technical discussion.
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

const SYNTHESIS_PROMPT = `You are a senior architect synthesizing a multi-model technical debate.

## Original question
{question}

## Context
{understanding}

## Direction under discussion
{direction}

## Model responses from Round 1
{round1_results}

## Your task
Analyze ALL perspectives above. Find where they agree, where they clash, and what the blind spots are.
Then produce YOUR OWN independent assessment — don't just summarize, CONFRONT the arguments.

## Your response MUST be valid JSON with this exact structure:
{
  "agreement": "Points where all models converge — these are likely correct (2-3 sentences)",
  "pushback": "REQUIRED: Where you disagree with the consensus, or critical gaps ALL models missed (2-3 sentences)",
  "risks": ["consolidated risk 1", "consolidated risk 2"],
  "better_options": ["synthesis of best alternatives from all models"],
  "recommended_next_step": "Your final recommendation considering all perspectives (1-2 sentences)",
  "questions_back": ["unresolved questions that need human input"],
  "one_paragraph_synthesis": "Final verdict: synthesize all perspectives into a clear recommendation with reasoning"
}

RULES:
- You are the FINAL arbiter. Your pushback should address weaknesses in the other models' arguments.
- If models disagree, take a clear stance rather than hedging.
- Output ONLY the JSON, no explanatory text.`;

function buildRound1Prompt(trigger: DiscussTrigger): string {
  return ROUND1_PROMPT
    .replace('{understanding}', trigger.context || `Worker (${trigger.worker_model}) is implementing a task`)
    .replace('{direction}', `Leaning toward: ${trigger.leaning} because: ${trigger.why}`)
    .replace('{constraints}', `Options: ${trigger.options.join(', ')}`)
    .replace('{question}', `${trigger.uncertain_about}\nPressure-test this direction. Which option and why?`);
}

function formatRound1Results(results: DebateRoundResult[]): string {
  return results.map((r, i) => {
    if (!r.reply) return `### Model ${i + 1} (${r.model}): [failed to respond]`;
    return `### Model ${i + 1} (${r.model})
**Agreement**: ${r.reply.agreement}
**Pushback**: ${r.reply.pushback}
**Risks**: ${r.reply.risks?.join('; ') || 'none'}
**Better options**: ${r.reply.better_options?.join('; ') || 'none'}
**Recommendation**: ${r.reply.recommended_next_step}`;
  }).join('\n\n');
}

function assessQuality(
  reply: { pushback?: string; one_paragraph_synthesis?: string; recommended_next_step?: string } | null,
): 'pass' | 'warn' | 'fail' {
  if (!reply) return 'fail';
  if (!reply.pushback || reply.pushback.length < 20) return 'fail';
  if (!reply.one_paragraph_synthesis) return 'warn';
  if (!reply.recommended_next_step) return 'warn';
  return 'pass';
}

async function callModel(
  prompt: string,
  modelId: string,
  caller: ModelCaller,
  cwd: string,
  config?: Partial<DiscussConfig>,
): Promise<DebateRoundResult> {
  const { baseUrl, apiKey } = resolveModelRoute(modelId, config);
  try {
    const raw = await caller.queryText(prompt, {
      modelId, baseUrl, apiKey, cwd, maxTurns: 3, timeoutMs: 180_000,
    });
    const reply = parseDiscussionReply(raw);
    return { model: modelId, reply, raw_output: raw, quality_gate: assessQuality(reply) };
  } catch (err: any) {
    return { model: modelId, reply: null, raw_output: `ERROR: ${err.message}`, quality_gate: 'fail' };
  }
}

/**
 * Run a multi-model debate.
 *
 * @param trigger - Discussion trigger (topic, options, leaning, etc.)
 * @param caller - ModelCaller implementation
 * @param models - Array of model IDs. Last model is the synthesizer.
 *                 e.g. ['gpt-5', 'kimi-k2.5', 'glm-5-turbo']
 *                 → Round 1: gpt-5 + kimi-k2.5 discuss in parallel
 *                 → Round 2: glm-5-turbo synthesizes
 *                 If only 1 model, runs single discussion (no synthesis round).
 *                 If only 2 models, both discuss then second also synthesizes.
 */
export async function runDebate(
  trigger: DiscussTrigger,
  caller: ModelCaller,
  models: string[],
  options?: { cwd?: string },
  config?: Partial<DiscussConfig>,
): Promise<DebateResult> {
  const cwd = options?.cwd || process.cwd();
  const threadId = `debate-${trigger.task_id}-${Date.now()}`;

  if (models.length === 0) {
    return { rounds: [], synthesis: null, thread_id: threadId, models_used: [] };
  }

  // Split: discussers (round 1) vs synthesizer (last model)
  const discussers = models.length <= 1 ? models : models.slice(0, -1);
  const synthesizer = models.length <= 1 ? null : models[models.length - 1];

  // Round 1: all discussers in parallel
  const round1Prompt = buildRound1Prompt(trigger);
  const round1Results = await Promise.all(
    discussers.map(m => callModel(round1Prompt, m, caller, cwd, config)),
  );

  // If no synthesizer, return round 1 results directly
  if (!synthesizer) {
    return {
      rounds: [round1Results],
      synthesis: round1Results[0] || null,
      thread_id: threadId,
      models_used: models,
    };
  }

  // Round 2: synthesizer confronts all round 1 results
  const synthPrompt = SYNTHESIS_PROMPT
    .replace('{question}', trigger.uncertain_about)
    .replace('{understanding}', trigger.context || `Worker (${trigger.worker_model}) is implementing a task`)
    .replace('{direction}', `Leaning toward: ${trigger.leaning} because: ${trigger.why}`)
    .replace('{round1_results}', formatRound1Results(round1Results));

  const synthResult = await callModel(synthPrompt, synthesizer, caller, cwd, config);

  return {
    rounds: [round1Results, [synthResult]],
    synthesis: synthResult,
    thread_id: threadId,
    models_used: models,
  };
}

// ── Group Debate (A vs B vs ...) ──

const GROUP_SYNTHESIS_PROMPT = `You are a senior architect making the FINAL call after multiple independent teams have debated a question.

## Original question
{question}

## Context
{understanding}

## Direction under discussion
{direction}

## Group conclusions
{group_conclusions}

## Your task
Each group above debated independently and reached their own conclusion. Now you must:
1. Compare the group conclusions — where do they agree? Where do they clash?
2. Identify blind spots that ALL groups missed
3. Make a FINAL recommendation, choosing sides when groups disagree

## Your response MUST be valid JSON with this exact structure:
{
  "agreement": "Points where all groups converge — high confidence these are correct (2-3 sentences)",
  "pushback": "REQUIRED: Critical gaps, contradictions between groups, or issues all groups missed (2-3 sentences)",
  "risks": ["consolidated risk 1", "consolidated risk 2"],
  "better_options": ["alternatives that emerge from comparing group perspectives"],
  "recommended_next_step": "Your final recommendation — be decisive, pick a side (1-2 sentences)",
  "questions_back": ["unresolved questions if any"],
  "one_paragraph_synthesis": "Final verdict synthesizing all group perspectives into one clear recommendation"
}

RULES:
- You are the FINAL judge. When groups disagree, take a clear stance.
- Your pushback should highlight where groups contradicted each other.
- Output ONLY the JSON, no explanatory text.`;

function formatGroupConclusions(groups: DebateResult[]): string {
  return groups.map((g, i) => {
    const synth = g.synthesis;
    if (!synth?.reply) return `### Group ${i + 1} (${g.models_used.join(' + ')}): [no conclusion reached]`;
    return `### Group ${i + 1} (${g.models_used.join(' + ')})
**Conclusion**: ${synth.reply.one_paragraph_synthesis}
**Pushback**: ${synth.reply.pushback}
**Risks**: ${synth.reply.risks?.join('; ') || 'none'}
**Better options**: ${synth.reply.better_options?.join('; ') || 'none'}
**Recommendation**: ${synth.reply.recommended_next_step}`;
  }).join('\n\n');
}

/**
 * Run a group debate: multiple independent groups debate internally,
 * optionally followed by a model judge round.
 *
 * @param trigger - Discussion trigger
 * @param caller - ModelCaller implementation
 * @param groups - Array of model groups, e.g. [['kimi','minimax'], ['glm','qwen']]
 *                 Each group runs runDebate internally.
 * @param judgeModel - Model for final cross-confrontation. If null/undefined,
 *                     skip judge round (Claude is the natural judge).
 */
export async function runGroupDebate(
  trigger: DiscussTrigger,
  caller: ModelCaller,
  groups: string[][],
  judgeModel?: string | null,
  options?: { cwd?: string },
  config?: Partial<DiscussConfig>,
): Promise<GroupDebateResult> {
  const cwd = options?.cwd || process.cwd();
  const threadId = `group-debate-${trigger.task_id}-${Date.now()}`;
  const allModels = groups.flat().concat(judgeModel ? [judgeModel] : []);

  // Run all groups in parallel
  const groupResults = await Promise.all(
    groups.map(g => runDebate(trigger, caller, g, options, config)),
  );

  // If no judge model, return group results for Claude to compare
  if (!judgeModel) {
    return {
      group_results: groupResults,
      final_synthesis: null,
      judge_model: 'claude',
      thread_id: threadId,
      models_used: allModels,
    };
  }

  // Final synthesis: judge confronts all group conclusions
  const synthPrompt = GROUP_SYNTHESIS_PROMPT
    .replace('{question}', trigger.uncertain_about)
    .replace('{understanding}', trigger.context || `Worker (${trigger.worker_model}) is implementing a task`)
    .replace('{direction}', `Leaning toward: ${trigger.leaning} because: ${trigger.why}`)
    .replace('{group_conclusions}', formatGroupConclusions(groupResults));

  const finalSynthesis = await callModel(synthPrompt, judgeModel, caller, cwd, config);

  return {
    group_results: groupResults,
    final_synthesis: finalSynthesis,
    judge_model: judgeModel,
    thread_id: threadId,
    models_used: allModels,
  };
}
