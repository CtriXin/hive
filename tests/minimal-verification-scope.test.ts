import { describe, it, expect } from 'vitest';
import { minimalSuiteConditions } from '../orchestrator/driver.js';
import type { DoneCondition } from '../orchestrator/types.js';

describe('minimalSuiteConditions', () => {
  const fullConditions: DoneCondition[] = [
    { type: 'build', label: 'TypeScript build', command: 'npm run build', must_pass: true, scope: 'both' },
    { type: 'test', label: 'Unit test suite', command: 'npm test', must_pass: true, scope: 'suite' },
    { type: 'lint', label: 'Lint check', command: 'npm run lint', must_pass: true, scope: 'suite' },
  ];

  it('excludes suite-scoped conditions', () => {
    const result = minimalSuiteConditions(fullConditions);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('build');
    expect(result[0].label).toBe('TypeScript build');
  });

  it('keeps build with scope "both"', () => {
    const conditions: DoneCondition[] = [
      { type: 'build', label: 'Build', command: 'npm run build', must_pass: true, scope: 'both' },
    ];
    expect(minimalSuiteConditions(conditions)).toHaveLength(1);
  });

  it('keeps build even with no explicit scope', () => {
    const conditions: DoneCondition[] = [
      { type: 'build', label: 'Build', command: 'npm run build', must_pass: true },
    ];
    expect(minimalSuiteConditions(conditions)).toHaveLength(1);
  });

  it('returns empty when no build conditions exist', () => {
    const conditions: DoneCondition[] = [
      { type: 'test', label: 'Tests', command: 'npm test', must_pass: true, scope: 'suite' },
    ];
    expect(minimalSuiteConditions(conditions)).toHaveLength(0);
  });
});
