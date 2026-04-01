// ═══════════════════════════════════════════════════════════════════
// discuss-lib/discuss.ts — Cross-model structured discussion
// ═══════════════════════════════════════════════════════════════════
// Extracted from hive/orchestrator/discuss-bridge.ts
// Takes ModelCaller + config — no registry dependency.

import type { ModelCaller } from './model-caller.js';
import type { DiscussTrigger, DiscussResult, DiscussOptions, DiscussConfig } from './types.js';
import { parseDiscussionReply } from './json-utils.js';
import { resolveModelRoute } from './config.js';

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

function assessQuality(
  reply: { pushback?: string; one_paragraph_synthesis?: string; recommended_next_step?: string },
): 'pass' | 'warn' | 'fail' {
  if (!reply.pushback || reply.pushback.length < 20) return 'fail';
  if (!reply.one_paragraph_synthesis) return 'warn';
  if (!reply.recommended_next_step) return 'warn';
  return 'pass';
}

/**
 * Run a structured discussion with a domestic model.
 *
 * The caller provides the ModelCaller (how to call) and the model/provider config.
 * No registry, no escalation — pure discussion logic.
 */
export async function runDiscussion(
  trigger: DiscussTrigger,
  caller: ModelCaller,
  options: DiscussOptions,
  config?: Partial<DiscussConfig>,
): Promise<DiscussResult> {
  const { modelId, cwd = process.cwd() } = options;
  const { baseUrl, apiKey } = resolveModelRoute(modelId, config);

  const prompt = DISCUSS_PROMPT
    .replace('{understanding}', trigger.context || `Worker (${trigger.worker_model}) is implementing a task`)
    .replace('{direction}', `Leaning toward: ${trigger.leaning} because: ${trigger.why}`)
    .replace('{constraints}', `Options: ${trigger.options.join(', ')}`)
    .replace('{question}', `${trigger.uncertain_about}\nPressure-test this direction. Which option and why?`);

  const threadId = `discuss-${trigger.task_id}-${Date.now()}`;

  try {
    const rawOutput = await caller.queryText(prompt, {
      modelId,
      baseUrl,
      apiKey,
      cwd,
      maxTurns: 3,
      timeoutMs: 180_000,
    });

    const reply = parseDiscussionReply(rawOutput);

    if (!reply) {
      return {
        decision: trigger.leaning,
        reasoning: 'Could not parse discussion reply',
        escalated: false,
        thread_id: threadId,
        quality_gate: 'fail',
      };
    }

    const quality = assessQuality(reply);

    return {
      decision: reply.recommended_next_step || trigger.leaning,
      reasoning: reply.one_paragraph_synthesis || '',
      escalated: false,
      thread_id: threadId,
      quality_gate: quality,
      reply,
    };
  } catch (err: any) {
    return {
      decision: trigger.leaning,
      reasoning: `Discussion failed: ${err.message?.slice(0, 100)}`,
      escalated: false,
      thread_id: threadId,
      quality_gate: 'fail',
    };
  }
}
