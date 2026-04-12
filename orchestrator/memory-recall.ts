// ═══════════════════════════════════════════════════════════════════
// orchestrator/memory-recall.ts — Phase 7A: Cross-Session Recall
// ═══════════════════════════════════════════════════════════════════
/**
 * Recall relevant project memories for the current task context.
 *
 * Recall policy:
 * - filter by active, non-stale memories
 * - score by relevance to current goal/task/files/failure_class
 * - rank by composite: relevance (50%) + confidence (30%) + recency (20%)
 * - return top-N compact results with evidence summary
 *
 * Guardrails:
 * - recall output is short (top 3-5 by default)
 * - explicit config / current context always wins
 * - recall never dominates the prompt
 */

import type {
  FailureClass,
  ExecutionMode,
  MemoryRecallInput,
  MemoryRecallResult,
  ProjectMemoryEntry,
  ProjectMemoryStore,
} from './types.js';

// ── Config ──

const DEFAULT_TOP_N = 3;
const MAX_RECALL_TOKENS = 500; // rough cap on recall output size

// Relevance keyword mapping: category → keywords that boost relevance
const CATEGORY_KEYWORDS: Record<ProjectMemoryEntry['category'], string[]> = {
  recurring_failure: ['fail', 'error', 'broken', 'crash', 'timeout', 'limit', 'rate'],
  effective_repair: ['repair', 'recover', 'retry', 'fix', 'resolved', 'worked'],
  stable_preference: ['prefer', 'stable', 'works', 'reliable', 'best', 'recommend'],
  risky_area: ['risk', 'fragile', 'regression', 'flaky', 'careful', 'caution'],
  routing_tendency: ['model', 'provider', 'route', 'mode', 'quick', 'think', 'auto'],
};

// ── Public API ──

/**
 * Recall relevant project memories for the current context.
 * Returns a compact, ranked list with explainability.
 */
export function recallProjectMemories(
  store: ProjectMemoryStore | null,
  input: MemoryRecallInput,
  options?: { topN?: number },
): MemoryRecallResult {
  if (!store || store.memories.length === 0) {
    return {
      memories: [],
      total_candidates: 0,
      selection_reason: 'No project memory available.',
    };
  }

  const topN = options?.topN ?? DEFAULT_TOP_N;

  // Step 1: Filter active, non-stale memories
  const candidates = store.memories.filter(m => m.active && !m.stale);

  if (candidates.length === 0) {
    return {
      memories: [],
      total_candidates: store.memories.length,
      selection_reason: 'All project memories are stale or inactive.',
    };
  }

  // Step 2: Score each candidate by relevance
  const scored = candidates
    .map(entry => scoreRelevance(entry, input))
    .filter(s => s.relevance_score > 0.03) // low threshold: let ranking decide, not hard filter
    .sort((a, b) => compositeScore(b) - compositeScore(a))
    .slice(0, topN);

  // Step 3: Build output with explainability
  const memories = scored.map(s => ({
    entry: s.entry,
    relevance_score: s.relevance_score,
    why_relevant: s.why,
  }));

  const selectionReason = memories.length > 0
    ? `Top ${memories.length} memories selected from ${candidates.length} active candidates.`
    : `No memories matched the current context (${candidates.length} active, all low relevance).`;

  return {
    memories,
    total_candidates: store.memories.length,
    selection_reason: selectionReason,
  };
}

/**
 * Format recall output as a compact text block for prompt injection.
 * Keeps output short — never dominates the prompt.
 */
export function formatMemoryRecall(recall: MemoryRecallResult, maxChars = MAX_RECALL_TOKENS * 4): string {
  if (recall.memories.length === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push('\n## Project Memory (cross-session recall)');

  for (const m of recall.memories) {
    const confidenceLabel = m.entry.confidence >= 0.7 ? 'high'
      : m.entry.confidence >= 0.4 ? 'medium' : 'low';
    const staleTag = m.entry.stale ? ' [STALE]' : '';

    lines.push(`\n### [${m.entry.category}] ${m.entry.summary}${staleTag}`);
    lines.push(`- Confidence: ${confidenceLabel} (${m.entry.confidence.toFixed(2)}), Recency: ${m.entry.recency.toFixed(2)}`);
    lines.push(`- Source: ${m.entry.source_run_ids.slice(0, 3).join(', ')}`);
    lines.push(`- Relevance: ${m.relevance_score.toFixed(2)} — ${m.why_relevant}`);
  }

  let result = lines.join('\n');
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + '\n...(truncated)';
  }

  return result;
}

// ── Scoring ──

interface ScoredMemory {
  entry: ProjectMemoryEntry;
  relevance_score: number;
  why: string;
}

function scoreRelevance(
  entry: ProjectMemoryEntry,
  input: MemoryRecallInput,
): ScoredMemory {
  let score = 0;
  const reasons: string[] = [];

  // 1. Goal keyword match (strongest signal)
  const goalScore = keywordMatchScore(input.goal, entry);
  if (goalScore > 0) {
    score += goalScore * 0.3;
    reasons.push(`goal keywords match memory summary`);
  }

  // 2. Task type / category match
  if (input.task_type) {
    const typeScore = categoryMatchScore(input.task_type, entry);
    if (typeScore > 0) {
      score += typeScore * 0.25;
      reasons.push(`task type "${input.task_type}" aligns with ${entry.category}`);
    }
  }

  // 3. File overlap (for risky_area memories)
  if (input.touched_files && input.touched_files.length > 0) {
    const fileScore = fileOverlapScore(input.touched_files, entry);
    if (fileScore > 0) {
      score += fileScore * 0.2;
      reasons.push(`touched files overlap with memory evidence`);
    }
  }

  // 4. Failure class match (for repair context)
  if (input.failure_class) {
    const fcScore = failureClassMatchScore(input.failure_class, entry);
    if (fcScore > 0) {
      score += fcScore * 0.25;
      reasons.push(`failure class "${input.failure_class}" matches memory`);
    }
  }

  // Category bonus: recurring_failure memories get a small boost in repair contexts
  if (entry.category === 'recurring_failure' && input.failure_class) {
    score += 0.05;
  }
  if (entry.category === 'risky_area' && input.touched_files?.length) {
    score += 0.05;
  }

  return {
    entry,
    relevance_score: Math.min(score, 1.0),
    why: reasons.length > 0 ? reasons.join('; ') : 'weak category-level match',
  };
}

function compositeScore(scored: ScoredMemory): number {
  // Composite: relevance (50%) + confidence (30%) + recency (20%)
  return (
    scored.relevance_score * 0.5 +
    scored.entry.confidence * 0.3 +
    scored.entry.recency * 0.2
  );
}

// ── Keyword Matching ──

function keywordMatchScore(text: string, entry: ProjectMemoryEntry): number {
  const lower = text.toLowerCase();
  const entryWords = tokenize(entry.summary + ' ' + entry.detail);

  let hits = 0;
  for (const word of entryWords) {
    if (word.length < 4) continue; // skip short words
    if (lower.includes(word)) hits++;
  }

  return entryWords.length === 0 ? 0 : hits / entryWords.length;
}

function categoryMatchScore(taskType: string, entry: ProjectMemoryEntry): number {
  const type = taskType.toLowerCase();
  const categoryKeywords = CATEGORY_KEYWORDS[entry.category] || [];

  // Direct category match in entry
  if (entry.summary.toLowerCase().includes(type) ||
      entry.detail.toLowerCase().includes(type)) {
    return 0.8;
  }

  // Keyword overlap
  let hits = 0;
  for (const kw of categoryKeywords) {
    if (type.includes(kw)) hits++;
  }

  return categoryKeywords.length === 0 ? 0 : hits / categoryKeywords.length * 0.5;
}

function fileOverlapScore(touchedFiles: string[], entry: ProjectMemoryEntry): number {
  if (entry.category !== 'risky_area') return 0;

  const evidenceSignals = entry.evidence.map(e => e.signal.toLowerCase()).join(' ');
  const touchedLower = touchedFiles.map(f => f.toLowerCase());

  let hits = 0;
  for (const file of touchedLower) {
    const basename = file.split('/').pop() || file;
    if (evidenceSignals.includes(basename)) hits++;
  }

  return touchedFiles.length === 0 ? 0 : hits / touchedFiles.length;
}

function failureClassMatchScore(fc: FailureClass, entry: ProjectMemoryEntry): number {
  const fcLower = fc.toLowerCase();
  const text = (entry.summary + ' ' + entry.detail).toLowerCase();
  const signals = entry.evidence.map(e => e.signal.toLowerCase()).join(' ');

  if (text.includes(fcLower) || signals.includes(fcLower)) return 0.9;
  // Partial match (e.g. "build" in "build_fail")
  if (text.includes(fcLower.slice(0, 4))) return 0.4;
  return 0;
}

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);
}
