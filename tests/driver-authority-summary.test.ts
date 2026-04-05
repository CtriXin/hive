import { describe, expect, it } from 'vitest';
import { mergeWorkerTaskSummary, summarizeAuthorityReview } from '../orchestrator/driver.js';

describe('driver authority summary merge', () => {
  it('preserves collab summary while appending authority summary', () => {
    const merged = mergeWorkerTaskSummary(
      'External review collecting: 2 replies',
      'review passed | authority-layer | mode=pair',
    );

    expect(merged).toContain('External review collecting: 2 replies');
    expect(merged).toContain('review passed | authority-layer | mode=pair');
  });

  it('avoids duplicating the authority summary', () => {
    const summary = 'External review closed || review failed | authority-layer | mode=pair';
    expect(mergeWorkerTaskSummary(summary, 'review failed | authority-layer | mode=pair')).toBe(summary);
  });

  it('shows heuristic synthesis fallback in authority summary', () => {
    const summary = summarizeAuthorityReview({
      taskId: 'task-c',
      final_stage: 'cross-review',
      passed: false,
      findings: [],
      iterations: 2,
      duration_ms: 100,
      authority: {
        source: 'authority-layer',
        mode: 'pair',
        members: ['kimi-k2.5', 'MiniMax-M2.5'],
        disagreement_flags: ['conclusion_opposite'],
        synthesis_strategy: 'heuristic',
      },
    });

    expect(summary).toContain('mode=pair');
    expect(summary).toContain('synth=heuristic');
    expect(summary).toContain('disagreement=conclusion_opposite');
  });

  it('shows blocked synthesis attempt in authority summary', () => {
    const summary = summarizeAuthorityReview({
      taskId: 'task-d',
      final_stage: 'cross-review',
      passed: false,
      verdict: 'BLOCKED',
      findings: [],
      iterations: 2,
      duration_ms: 100,
      authority: {
        source: 'authority-layer',
        mode: 'pair',
        members: ['kimi-k2.5', 'MiniMax-M2.5'],
        disagreement_flags: ['conclusion_opposite'],
        synthesis_attempted_by: 'gpt-5.4',
      },
    });

    expect(summary).toContain('review blocked');
    expect(summary).toContain('synth=blocked(gpt-5.4)');
  });
});
