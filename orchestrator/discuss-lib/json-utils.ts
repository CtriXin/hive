// ═══════════════════════════════════════════════════════════════════
// discuss-lib/json-utils.ts — Shared JSON extraction utilities
// ═══════════════════════════════════════════════════════════════════
// Brace-counting parser — replaces 3 duplicated copies in hive orchestrator.

import type { FindingSeverity, A2aLens, ReviewFinding, DiscussionReply } from './types.js';

/**
 * Extract the first complete JSON object from raw model output.
 * Uses brace-counting with proper string/escape handling.
 */
export function extractJsonObject(rawOutput: string): string | null {
  const start = rawOutput.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < rawOutput.length; i += 1) {
    const char = rawOutput[i];

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
    if (inString) continue;

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return rawOutput.slice(start, i + 1);
      }
    }
  }

  return null;
}

/**
 * Normalize a severity string to a valid FindingSeverity.
 */
export function normalizeSeverity(input: unknown): FindingSeverity {
  return input === 'red' || input === 'green' || input === 'yellow'
    ? input
    : 'yellow';
}

/**
 * Parse a2a lens output into ReviewFindings.
 */
export function parseLensOutput(
  output: string,
  lens: A2aLens,
  idOffset = 0,
): ReviewFinding[] {
  try {
    const jsonPayload = extractJsonObject(output);
    if (!jsonPayload) return [];

    const parsed = JSON.parse(jsonPayload);
    if (!Array.isArray(parsed.findings)) return [];

    return parsed.findings.slice(0, 10).map((f: any, i: number) => ({
      id: idOffset + i + 1,
      severity: normalizeSeverity(f.severity),
      lens,
      file: f.file || 'unknown',
      line: parseInt(f.file?.split(':')[1]) || undefined,
      issue: String(f.issue || '').slice(0, 300),
      decision: 'flag',
    }));
  } catch {
    return [];
  }
}

/**
 * Parse a structured discussion reply from model output.
 * Returns null if the output is invalid or pushback is too short.
 */
export function parseDiscussionReply(output: string): DiscussionReply | null {
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
