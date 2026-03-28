// ═══════════════════════════════════════════════════════════════════
// orchestrator/discuss-bridge.ts — Cross-model discussion using Claude Code SDK
// ═══════════════════════════════════════════════════════════════════
// Rewritten from discuss-trigger.ts — no longer shells out to discuss.sh
// Uses TypeScript + Claude Code SDK for self-contained operation

import type {
  DiscussTrigger, DiscussResult, DiscussionReply,
  WorkerConfig,
} from './types.js';
import { getRegistry } from './model-registry.js';
import { resolveProvider } from './provider-resolver.js';
import { buildSdkEnv } from './project-paths.js';
import { safeQuery, extractTextFromMessages } from './sdk-query-safe.js';

const MAX_DISCUSS_ROUNDS = 2;

// Discussion prompt template (internalized from agent-discuss reply contract)
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

// Resolve provider from config or environment
async function resolveProviderConfig(providerId: string): Promise<{ baseUrl: string; apiKey: string }> {
  try {
    const result = resolveProvider(providerId);
    return { baseUrl: result.baseUrl, apiKey: result.apiKey };
  } catch {
    // Fallback to environment variables
    const envKey = providerId.toUpperCase().replace(/-/g, '_');
    return {
      baseUrl: process.env[`${envKey}_BASE_URL`] || '',
      apiKey: process.env[`${envKey}_API_KEY`] || '',
    };
  }
}

// Select discussion partner
async function selectDiscussPartner(workerModel: string): Promise<{ id: string; provider: string; reasoning: number }> {
  try {
    const registry = getRegistry();
    const partnerId = registry.selectDiscussPartner(workerModel);
    return registry.get(partnerId) || { id: partnerId, provider: 'kimi', reasoning: 0.85 };
  } catch {
    // Fallback: return a default partner
    return { id: 'kimi-for-coding', provider: 'kimi', reasoning: 0.85 };
  }
}

export async function triggerDiscussion(
  trigger: DiscussTrigger,
  workerConfig: WorkerConfig,
  workDir: string,
): Promise<DiscussResult> {
  // 1. Select discussion partner (different model, high reasoning)
  const partner = await selectDiscussPartner(workerConfig.model);
  const { baseUrl, apiKey } = await resolveProviderConfig(partner.provider);

  // 2. Build discussion prompt
  const prompt = DISCUSS_PROMPT
    .replace('{understanding}', `Worker (${workerConfig.model}) is implementing: ${workerConfig.prompt.slice(0, 300)}`)
    .replace('{direction}', `Leaning toward: ${trigger.leaning} because: ${trigger.why}`)
    .replace('{constraints}', `Options: ${trigger.options.join(', ')}`)
    .replace('{question}', `${trigger.uncertain_about}\nPressure-test this direction. Which option and why?`);

  const threadId = `discuss-${trigger.task_id}-${Date.now()}`;

  console.log(`    💬 Discussion: ${trigger.uncertain_about}`);
  console.log(`    💬 Partner: ${partner.id} (reasoning: ${partner.reasoning})`);

  try {
    // 3. Use SDK to call discussion partner
    const result = await safeQuery({
      prompt,
      options: {
        cwd: workDir,
        env: buildSdkEnv(partner.id, baseUrl, apiKey),
        maxTurns: 3,
      }
    });

    const rawOutput = extractTextFromMessages(result.messages);

    // 4. Parse structured reply
    const reply = parseDiscussionReply(rawOutput);

    if (!reply) {
      console.log('    ⚠️ Could not parse discussion reply, escalating');
      return escalateToSonnet(trigger);
    }

    // 5. Quality gate
    const quality = assessQuality(reply);

    if (quality === 'fail') {
      console.log('    ⚠️ Discussion quality: fail, escalating');
      return escalateToSonnet(trigger);
    }

    console.log(`    ✅ Discussion resolved: ${reply.recommended_next_step.slice(0, 80)}`);

    return {
      decision: reply.recommended_next_step || trigger.leaning,
      reasoning: reply.one_paragraph_synthesis || '',
      escalated: false,
      thread_id: threadId,
      quality_gate: quality,
    };

  } catch (err: any) {
    console.log(`    ❌ Discussion failed: ${err.message?.slice(0, 100)}`);
    return escalateToSonnet(trigger);
  }
}

function parseDiscussionReply(output: string): DiscussionReply | null {
  try {
    const jsonPayload = extractJsonObject(output);
    if (!jsonPayload) return null;
    const parsed = JSON.parse(jsonPayload);
    // Must have pushback
    if (!parsed.pushback || parsed.pushback.trim().length < 10) return null;
    return parsed as DiscussionReply;
  } catch {
    return null;
  }
}

function extractJsonObject(rawOutput: string): string | null {
  const start = rawOutput.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < rawOutput.length; index += 1) {
    const char = rawOutput[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return rawOutput.slice(start, index + 1);
      }
    }
  }

  return null;
}

function assessQuality(reply: DiscussionReply): 'pass' | 'warn' | 'fail' {
  // Pushback too short = fail
  if (!reply.pushback || reply.pushback.length < 20) return 'fail';
  // No synthesis = warn
  if (!reply.one_paragraph_synthesis) return 'warn';
  // No recommended_next_step = warn
  if (!reply.recommended_next_step) return 'warn';
  return 'pass';
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
