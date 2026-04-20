// ═══════════════════════════════════════════════════════════════════
// orchestrator/user-profile-extractor.ts — Extract user preferences
// ═══════════════════════════════════════════════════════════════════
/**
 * Extracts user-level preferences from a completed run summary.
 *
 * Strategy:
 * - Feed the goal + final_summary into a cheap model (discuss tier)
 * - Ask it to emit structured preference updates with dimensions
 * - Merge updates into the global user profile store
 */

import type { UserProfileEvidence, UserProfileDimension } from './user-profile-store.js';
import { initUserProfile, upsertUserProfile, saveUserProfile } from './user-profile-store.js';

export interface ExtractorInput {
  runId: string;
  goal: string;
  finalSummary: string;
  changedFiles?: string[];
  executionMode?: string;
}

export interface ExtractorOutput {
  updates: Array<{
    dimension: UserProfileDimension;
    summary: string;
    detail?: string;
    confidence: number; // 0-1
    signal: string;
  }>;
}

const EXTRACTION_PROMPT_TEMPLATE = `
You are analyzing a completed AI agent session to extract the user's preferences and habits.

Input:
- Goal: {{{GOAL}}}
- Final Summary: {{{SUMMARY}}}
- Files changed: {{{FILES}}}
- Execution mode: {{{MODE}}}

Instructions:
1. Only emit preferences that are clearly demonstrated in this session. Do not guess.
2. Each preference must map to one of these dimensions:
   - communication_style (e.g., terse, detailed, step-by-step)
   - tech_stack (e.g., TypeScript, Python, React)
   - focus_project (e.g., agent-im, api-gateway)
   - recent_blocker (e.g., struggles with tests, avoids docs)
   - special_habit (e.g., uses rtk prefix, prefers named exports)
3. If no clear preference is demonstrated, return an empty updates array.

Output ONLY valid JSON in this exact shape:
{
  "updates": [
    {
      "dimension": "communication_style",
      "summary": "prefers terse responses",
      "detail": "user repeatedly asked to keep explanations short",
      "confidence": 0.8,
      "signal": "terse preference observed"
    }
  ]
}
`;

function buildPrompt(input: ExtractorInput): string {
  return EXTRACTION_PROMPT_TEMPLATE
    .replace('{{{GOAL}}}', input.goal || '(none)')
    .replace('{{{SUMMARY}}}', input.finalSummary || '(none)')
    .replace('{{{FILES}}}', (input.changedFiles || []).join(', ') || '(none)')
    .replace('{{{MODE}}}', input.executionMode || 'safe');
}

const VALID_DIMENSIONS: UserProfileDimension[] = [
  'communication_style',
  'tech_stack',
  'focus_project',
  'recent_blocker',
  'special_habit',
];

const EXTRACTOR_MODEL = 'glm-5-turbo';
const EXTRACTOR_TIMEOUT_MS = 30_000;

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim()) {
    return fenced[1].trim();
  }

  const braceStart = text.indexOf('{');
  if (braceStart < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = braceStart; i < text.length; i += 1) {
    const char = text[i];
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
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(braceStart, i + 1);
      }
    }
  }

  return null;
}

function normalizeUpdate(raw: unknown): ExtractorOutput['updates'][number] | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const dimension = typeof candidate.dimension === 'string'
    ? candidate.dimension.trim()
    : '';
  if (!VALID_DIMENSIONS.includes(dimension as UserProfileDimension)) {
    return null;
  }

  const summary = typeof candidate.summary === 'string'
    ? candidate.summary.trim()
    : '';
  const signal = typeof candidate.signal === 'string'
    ? candidate.signal.trim()
    : '';
  if (!summary || !signal) {
    return null;
  }

  const confidence = Number(candidate.confidence);
  if (!Number.isFinite(confidence)) {
    return null;
  }

  const detail = typeof candidate.detail === 'string' && candidate.detail.trim()
    ? candidate.detail.trim()
    : undefined;

  return {
    dimension: dimension as UserProfileDimension,
    summary,
    detail,
    confidence: clampConfidence(confidence),
    signal,
  };
}

async function callExtractorModel(prompt: string): Promise<ExtractorOutput> {
  try {
    const { safeQuery, extractTextFromMessages } = await import('./sdk-query-safe.js');
    const { buildSdkEnv } = await import('./project-paths.js');
    const { resolveProviderForModel } = await import('./provider-resolver.js');

    let env: Record<string, string>;
    try {
      const resolved = resolveProviderForModel(EXTRACTOR_MODEL);
      env = buildSdkEnv(EXTRACTOR_MODEL, resolved.baseUrl, resolved.apiKey);
    } catch {
      env = buildSdkEnv(EXTRACTOR_MODEL);
    }

    const result = await safeQuery({
      prompt,
      options: { cwd: process.cwd(), maxTurns: 1, env, model: EXTRACTOR_MODEL },
      timeoutMs: EXTRACTOR_TIMEOUT_MS,
    });
    const text = extractTextFromMessages(result.messages);
    return parseExtractorText(text);
  } catch {
    return { updates: [] };
  }
}

export function parseExtractorText(text: string): ExtractorOutput {
  try {
    const candidate = extractJsonObject(text);
    if (!candidate) {
      return { updates: [] };
    }

    const parsed = JSON.parse(candidate) as { updates?: unknown };
    if (!Array.isArray(parsed?.updates)) {
      return { updates: [] };
    }

    return {
      updates: parsed.updates
        .map((item) => normalizeUpdate(item))
        .filter((item): item is ExtractorOutput['updates'][number] => !!item),
    };
  } catch {
    return { updates: [] };
  }
}

/**
 * Extract user preferences from a run and merge them into the global profile store.
 * This function is safe to call asynchronously — it mutates the on-disk profile store.
 */
export async function extractAndSaveUserProfile(
  input: ExtractorInput,
): Promise<void> {
  const prompt = buildPrompt(input);
  const extracted = await callExtractorModel(prompt);
  if (extracted.updates.length === 0) {
    return;
  }

  const store = initUserProfile();
  for (const update of extracted.updates) {
    const evidence: UserProfileEvidence = {
      source_run_id: input.runId,
      signal: update.signal,
      weight: update.confidence,
      observed_at: new Date().toISOString(),
    };
    upsertUserProfile(store, {
      dimension: update.dimension,
      summary: update.summary,
      detail: update.detail,
      evidence: [evidence],
    });
  }
  saveUserProfile(store);
}

/**
 * Synchronous variant for callers that already have pre-computed updates.
 * Useful for testing or for manual curation.
 */
export function applyUserProfileUpdates(
  runId: string,
  updates: ExtractorOutput['updates'],
): void {
  if (updates.length === 0) return;
  const store = initUserProfile();
  for (const update of updates) {
    const evidence: UserProfileEvidence = {
      source_run_id: runId,
      signal: update.signal,
      weight: update.confidence,
      observed_at: new Date().toISOString(),
    };
    upsertUserProfile(store, {
      dimension: update.dimension,
      summary: update.summary,
      detail: update.detail,
      evidence: [evidence],
    });
  }
  saveUserProfile(store);
}
