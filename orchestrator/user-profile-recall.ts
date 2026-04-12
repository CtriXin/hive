// ═══════════════════════════════════════════════════════════════════
// orchestrator/user-profile-recall.ts — Recall user preferences for planner
// ═══════════════════════════════════════════════════════════════════
/**
 * Recalls the most relevant user preferences for the current planning goal.
 *
 * Rules:
 * - only active, non-stale entries
 * - score by keyword overlap between goal and preference summary
 * - return top 1-2 compact bullets so the prompt never grows too heavy
 */

import { loadUserProfile, refreshProfileFreshness, type UserProfileEntry } from './user-profile-store.js';

export interface UserProfileRecallResult {
  entries: Array<{
    entry: UserProfileEntry;
    relevance_score: number;
    why: string;
  }>;
  selection_reason: string;
}

const DEFAULT_TOP_N = 2;
const MAX_CHARS = 600; // rough cap on injected text size

// Dimension priority for planner context (some dimensions are more useful to planner)
const DIMENSION_BOOST: Record<string, number> = {
  communication_style: 0.1,
  tech_stack: 0.15,
  focus_project: 0.1,
  recent_blocker: 0.05,
  special_habit: 0.05,
};

export function recallUserProfile(goal: string, options?: { topN?: number }): UserProfileRecallResult {
  const raw = loadUserProfile();
  if (!raw || raw.entries.length === 0) {
    return { entries: [], selection_reason: 'No user profile available.' };
  }

  const store = refreshProfileFreshness(raw);
  const candidates = store.entries.filter(e => e.active && !e.stale);
  if (candidates.length === 0) {
    return { entries: [], selection_reason: 'All profile entries are stale or inactive.' };
  }

  const topN = options?.topN ?? DEFAULT_TOP_N;
  const goalLower = goal.toLowerCase();

  const scored = candidates
    .map(entry => {
      const score = scoreRelevance(entry, goalLower);
      return { entry, ...score };
    })
    .filter(s => s.relevance_score > 0.15)
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, topN);

  return {
    entries: scored,
    selection_reason:
      scored.length > 0
        ? `Top ${scored.length} user preferences selected from ${candidates.length} active entries.`
        : `No user preferences matched the current goal (${candidates.length} active, all low relevance).`,
  };
}

export function formatUserProfileRecall(recall: UserProfileRecallResult): string {
  if (recall.entries.length === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push('\n## User Profile');
  for (const item of recall.entries) {
    const { entry } = item;
    lines.push(`- [${entry.dimension}] ${entry.summary}`);
    if (entry.detail) {
      lines.push(`  (${entry.detail})`);
    }
  }

  let result = lines.join('\n');
  if (result.length > MAX_CHARS) {
    result = result.slice(0, MAX_CHARS) + '\n...(truncated)';
  }
  return result;
}

function scoreRelevance(
  entry: UserProfileEntry,
  goalLower: string,
): { relevance_score: number; why: string } {
  const summaryWords = tokenize(entry.summary);
  const detailWords = entry.detail ? tokenize(entry.detail) : [];
  const allWords = [...new Set([...summaryWords, ...detailWords])];

  let hits = 0;
  for (const word of allWords) {
    if (goalLower.includes(word)) hits++;
  }
  const keywordScore = allWords.length === 0 ? 0 : hits / allWords.length;

  const dimBoost = DIMENSION_BOOST[entry.dimension] || 0;
  const recencyBoost = entry.recency * 0.1;
  const confidenceBoost = entry.confidence * 0.05;

  const score = Math.min(keywordScore + dimBoost + recencyBoost + confidenceBoost, 1.0);

  const reasons: string[] = [];
  if (keywordScore > 0) reasons.push('keyword match with goal');
  if (dimBoost > 0) reasons.push(`useful dimension: ${entry.dimension}`);
  if (entry.recency > 0.5) reasons.push('recent observation');

  return {
    relevance_score: score,
    why: reasons.length > 0 ? reasons.join('; ') : 'weak match',
  };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);
}
