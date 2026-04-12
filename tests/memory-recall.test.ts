// ═══════════════════════════════════════════════════════════════════
// tests/memory-recall.test.ts — Phase 7A
// ═══════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import type { ProjectMemoryStore } from '../orchestrator/types.js';
import { recallProjectMemories, formatMemoryRecall } from '../orchestrator/memory-recall.js';

const NOW = Date.now();
function runId(offset = 0) {
  return `run-${NOW - offset}`;
}

function makeMemoryEntry(overrides: {
  memory_id?: string;
  category?: 'recurring_failure' | 'effective_repair' | 'stable_preference' | 'risky_area' | 'routing_tendency';
  summary: string;
  detail?: string;
  confidence?: number;
  recency?: number;
  active?: boolean;
  stale?: boolean;
}): ProjectMemoryStore['memories'][0] {
  return {
    memory_id: overrides.memory_id || `mem-${Math.random().toString(36).slice(2, 8)}`,
    category: overrides.category || 'recurring_failure',
    summary: overrides.summary,
    detail: overrides.detail || overrides.summary,
    evidence: [{
      source_run_id: runId(),
      source_artifact: 'transition_log' as const,
      signal: overrides.summary,
      weight: overrides.recency ?? 0.8,
    }],
    source_run_ids: [runId()],
    source_artifacts: ['transition_log'],
    confidence: overrides.confidence ?? 0.7,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    recency: overrides.recency ?? 0.8,
    active: overrides.active ?? true,
    stale: overrides.stale ?? false,
  };
}

function makeStore(memories: ProjectMemoryStore['memories']): ProjectMemoryStore {
  return {
    project_id: 'test-repo',
    memories,
    generated_at: new Date().toISOString(),
  };
}

describe('memory-recall', () => {
  // ── Empty / null store ──

  it('returns empty result when store is null', () => {
    const result = recallProjectMemories(null, { goal: 'build a feature' });
    expect(result.memories).toHaveLength(0);
    expect(result.selection_reason).toContain('No project memory');
  });

  it('returns empty result when store has no memories', () => {
    const store = makeStore([]);
    const result = recallProjectMemories(store, { goal: 'build a feature' });
    expect(result.memories).toHaveLength(0);
    expect(result.total_candidates).toBe(0);
  });

  it('returns empty result when all memories are stale/inactive', () => {
    const store = makeStore([
      makeMemoryEntry({ summary: 'Old stale memory', active: false, stale: true }),
      makeMemoryEntry({ summary: 'Another stale', active: true, stale: true }),
    ]);
    const result = recallProjectMemories(store, { goal: 'build' });
    expect(result.memories).toHaveLength(0);
    expect(result.selection_reason).toContain('stale or inactive');
  });

  // ── Recall by goal ──

  it('recalls memories matching goal keywords', () => {
    const store = makeStore([
      makeMemoryEntry({
        summary: 'Build failures in test tasks',
        detail: 'Tasks that build often fail with errors',
        category: 'recurring_failure',
        confidence: 0.8,
        recency: 0.9,
      }),
    ]);

    const result = recallProjectMemories(store, { goal: 'fix the build system' });
    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories[0].relevance_score).toBeGreaterThan(0.03);
    expect(result.memories[0].why_relevant).toBeTruthy();
  });

  // ── Recall by task type ──

  it('boosts relevance for matching task type', () => {
    const store = makeStore([
      makeMemoryEntry({
        category: 'effective_repair',
        summary: 'Repair works for build failures',
        detail: 'Retrying build tasks after failure usually resolves the issue',
        confidence: 0.7,
        recency: 0.8,
      }),
    ]);

    const resultWithType = recallProjectMemories(store, { goal: 'fix build', task_type: 'repair' });
    const resultWithoutType = recallProjectMemories(store, { goal: 'fix build' });

    expect(resultWithType.memories[0].relevance_score).toBeGreaterThanOrEqual(
      resultWithoutType.memories[0].relevance_score,
    );
  });

  // ── Recall by failure class ──

  it('matches failure class in repair context', () => {
    const store = makeStore([
      makeMemoryEntry({
        summary: 'Build failure is common in compilation',
        detail: 'The build step frequently fails in test tasks',
        category: 'recurring_failure',
        confidence: 0.6,
        recency: 0.7,
      }),
      makeMemoryEntry({
        summary: 'Provider timeout pattern',
        detail: 'API providers occasionally timeout during requests',
        category: 'recurring_failure',
        confidence: 0.5,
        recency: 0.6,
      }),
    ]);

    const result = recallProjectMemories(store, {
      goal: 'retry the task',
      failure_class: 'build',
    });

    expect(result.memories.length).toBeGreaterThan(0);
    // Build-related memory should rank higher
    expect(result.memories[0].entry.summary.toLowerCase()).toContain('build');
  });

  // ── Recall by file overlap ──

  it('boosts risky_area memories for overlapping files', () => {
    const store = makeStore([
      makeMemoryEntry({
        category: 'risky_area',
        summary: 'Schema files are fragile and often break',
        detail: 'Changes to schema cause regressions',
        evidence: [{
          source_run_id: runId(),
          source_artifact: 'forensics_pack' as const,
          signal: 'task broke schema.ts',
          weight: 1.0,
        }],
        confidence: 0.8,
        recency: 0.9,
      }),
      makeMemoryEntry({
        category: 'recurring_failure',
        summary: 'Generic failure pattern',
        detail: 'Some tasks fail sometimes',
        confidence: 0.4,
        recency: 0.5,
      }),
    ]);

    const result = recallProjectMemories(store, {
      goal: 'update schema validation',
      touched_files: ['src/schema.ts', 'src/types.ts'],
    });

    expect(result.memories.length).toBeGreaterThan(0);
    // risky_area with file overlap should rank higher
    expect(result.memories[0].entry.category).toBe('risky_area');
  });

  // ── Ranking ──

  it('ranks by composite score (relevance + confidence + recency)', () => {
    const store = makeStore([
      makeMemoryEntry({
        memory_id: 'mem-low',
        summary: 'Minor issue with logging',
        detail: 'Logging sometimes has minor issues',
        confidence: 0.3,
        recency: 0.3,
      }),
      makeMemoryEntry({
        memory_id: 'mem-high',
        summary: 'Build system critical failure pattern',
        detail: 'Build failures are a major recurring problem',
        confidence: 0.9,
        recency: 0.9,
      }),
    ]);

    const result = recallProjectMemories(store, { goal: 'fix build issues' }, { topN: 2 });
    expect(result.memories).toHaveLength(2);
    expect(result.memories[0].entry.memory_id).toBe('mem-high');
  });

  it('respects topN limit', () => {
    const store = makeStore([
      makeMemoryEntry({ memory_id: 'mem-1', summary: 'Build failure pattern one', confidence: 0.8, recency: 0.8 }),
      makeMemoryEntry({ memory_id: 'mem-2', summary: 'Build failure pattern two', confidence: 0.7, recency: 0.7 }),
      makeMemoryEntry({ memory_id: 'mem-3', summary: 'Build failure pattern three', confidence: 0.6, recency: 0.6 }),
    ]);

    const result = recallProjectMemories(store, { goal: 'build' }, { topN: 2 });
    expect(result.memories).toHaveLength(2);
  });

  // ── Explainability ──

  it('provides why_relevant for each recalled memory', () => {
    const store = makeStore([
      makeMemoryEntry({
        summary: 'Test failures cluster around build step',
        detail: 'Build verification often fails after test changes',
      }),
    ]);

    const result = recallProjectMemories(store, { goal: 'fix test build failures' });
    expect(result.memories[0].why_relevant.length).toBeGreaterThan(0);
  });

  // ── Format output ──

  it('formats recall output as compact text block', () => {
    const store = makeStore([
      makeMemoryEntry({
        summary: 'Build failures recur',
        confidence: 0.8,
        recency: 0.9,
      }),
    ]);

    const recall = recallProjectMemories(store, { goal: 'build fix' });
    expect(recall.memories.length).toBeGreaterThan(0);
    const formatted = formatMemoryRecall(recall);

    expect(formatted).toContain('Project Memory');
    expect(formatted).toContain('Build failures recur');
    expect(formatted).toContain('high'); // confidence label
  });

  it('returns empty string for no memories', () => {
    const formatted = formatMemoryRecall({
      memories: [],
      total_candidates: 0,
      selection_reason: 'none',
    });
    expect(formatted).toBe('');
  });

  it('truncates output if too long', () => {
    const manyMemories: ProjectMemoryStore['memories'] = [];
    for (let i = 0; i < 20; i++) {
      manyMemories.push(makeMemoryEntry({
        memory_id: `mem-${i}`,
        summary: `Memory entry number ${i} with a longer description to increase output size significantly`,
        detail: `Detailed explanation of memory ${i} with additional context and evidence that adds more characters to the output`,
        confidence: 0.5 + (i % 5) * 0.1,
        recency: 0.5 + (i % 3) * 0.1,
      }));
    }
    const store = makeStore(manyMemories);
    const recall = recallProjectMemories(store, { goal: 'test' }, { topN: 20 });
    const formatted = formatMemoryRecall(recall, 200);

    expect(formatted.length).toBeLessThanOrEqual(215); // 200 + tolerance for truncation marker
    if (recall.memories.length > 0) {
      expect(formatted).toContain('truncated');
    }
  });

  // ── Guardrails ──

  it('does not return stale memories', () => {
    const store = makeStore([
      makeMemoryEntry({
        memory_id: 'mem-stale',
        summary: 'Old stale pattern',
        active: true,
        stale: true,
      }),
      makeMemoryEntry({
        memory_id: 'mem-fresh',
        summary: 'Fresh pattern for build',
        active: true,
        stale: false,
        confidence: 0.7,
        recency: 0.8,
      }),
    ]);

    const result = recallProjectMemories(store, { goal: 'build' });
    const staleIncluded = result.memories.some(m => m.entry.stale);
    expect(staleIncluded).toBe(false);
  });

  it('irrelevant goal returns low or no matches', () => {
    const store = makeStore([
      makeMemoryEntry({
        summary: 'Build failures in TypeScript compilation',
        detail: 'tsc often fails',
        confidence: 0.7,
        recency: 0.8,
      }),
    ]);

    const result = recallProjectMemories(store, { goal: 'design a UI component with React' });
    // Low relevance due to no keyword match
    expect(result.memories.length).toBeLessThanOrEqual(1);
    if (result.memories.length > 0) {
      expect(result.memories[0].relevance_score).toBeLessThan(0.4);
    }
  });
});
