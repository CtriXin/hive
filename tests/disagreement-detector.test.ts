import { describe, expect, it } from 'vitest';
import { detectReviewDisagreement } from '../orchestrator/disagreement-detector.js';
import type { ReviewFinding } from '../orchestrator/types.js';

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: overrides.id ?? 1,
    severity: overrides.severity ?? 'yellow',
    lens: overrides.lens ?? 'cross-review',
    file: overrides.file ?? 'src/app.ts',
    line: overrides.line ?? 10,
    issue: overrides.issue ?? 'Example finding',
    decision: overrides.decision ?? 'flag',
    decision_reason: overrides.decision_reason,
  };
}

describe('disagreement-detector', () => {
  it('detects opposite conclusions', () => {
    const result = detectReviewDisagreement([
      { model: 'kimi-k2.5', passed: true, confidence: 0.9, findings: [] },
      { model: 'MiniMax-M2.5', passed: false, confidence: 0.8, findings: [] },
    ]);

    expect(result.has_disagreement).toBe(true);
    expect(result.flags).toContain('conclusion_opposite');
  });

  it('detects severity gaps on the same location', () => {
    const result = detectReviewDisagreement([
      {
        model: 'kimi-k2.5',
        passed: false,
        confidence: 0.8,
        findings: [makeFinding({ severity: 'red' })],
      },
      {
        model: 'qwen3.5-plus',
        passed: false,
        confidence: 0.8,
        findings: [makeFinding({ severity: 'green' })],
      },
    ]);

    expect(result.has_disagreement).toBe(true);
    expect(result.flags).toContain('severity_diff_ge_2');
  });

  it('stays quiet for matching outcomes', () => {
    const result = detectReviewDisagreement([
      {
        model: 'kimi-k2.5',
        passed: true,
        confidence: 0.9,
        findings: [makeFinding({ severity: 'yellow', file: 'src/a.ts' })],
      },
      {
        model: 'MiniMax-M2.5',
        passed: true,
        confidence: 0.86,
        findings: [makeFinding({ severity: 'yellow', file: 'src/b.ts' })],
      },
    ]);

    expect(result.has_disagreement).toBe(false);
    expect(result.flags).toEqual([]);
  });
});
