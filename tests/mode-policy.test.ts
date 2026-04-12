// tests/mode-policy.test.ts — Phase 5A: Quick/Think/Auto mode policy tests

import { describe, test, expect } from 'vitest';
import { getModeContract, inferExecutionMode, normalizeExecutionMode, shouldEscalateMode } from '../orchestrator/mode-policy.js';

describe('Mode Contracts', () => {
  test('auto-execute-small is lightweight', () => {
    const c = getModeContract('auto-execute-small');
    expect(c.planning_depth).toBe('minimal');
    expect(c.dispatch_style).toBe('single');
    expect(c.review_intensity).toBe('light');
    expect(c.verification_scope).toBe('minimal');
    expect(c.discuss_gate).toBe('disabled');
    expect(c.allow_auto_merge).toBe(true);
    expect(c.allow_repair).toBe(false);
    expect(c.allow_replan).toBe(false);
  });

  test('execute-parallel is analysis-heavy with no auto-merge', () => {
    const c = getModeContract('execute-parallel');
    expect(c.planning_depth).toBe('full');
    expect(c.dispatch_style).toBe('parallel');
    expect(c.review_intensity).toBe('full-cascade');
    expect(c.verification_scope).toBe('standard');
    expect(c.discuss_gate).toBe('standard');
    expect(c.allow_auto_merge).toBe(false);
    expect(c.allow_repair).toBe(true);
    expect(c.allow_replan).toBe(true);
  });

  test('execute-standard is canonical default lane', () => {
    const c = getModeContract('execute-standard');
    expect(c.planning_depth).toBe('full');
    expect(c.dispatch_style).toBe('single');
    expect(c.review_intensity).toBe('full-cascade');
    expect(c.verification_scope).toBe('standard');
    expect(c.discuss_gate).toBe('standard');
    expect(c.allow_auto_merge).toBe(true);
    expect(c.allow_repair).toBe(true);
    expect(c.allow_replan).toBe(true);
  });

  test('legacy names normalize to canonical lane contracts', () => {
    expect(normalizeExecutionMode('quick')).toBe('auto-execute-small');
    expect(normalizeExecutionMode('think')).toBe('execute-parallel');
    expect(normalizeExecutionMode('auto')).toBe('execute-standard');
  });
});

describe('inferExecutionMode', () => {
  test('returns canonical lane when explicit mode is provided', () => {
    expect(inferExecutionMode({ explicit: 'quick' })).toBe('auto-execute-small');
    expect(inferExecutionMode({ explicit: 'think' })).toBe('execute-parallel');
    expect(inferExecutionMode({ explicit: 'auto' })).toBe('execute-standard');
    expect(inferExecutionMode({ explicit: 'execute-standard' })).toBe('execute-standard');
  });

  test('defaults to execute-standard when not specified', () => {
    expect(inferExecutionMode()).toBe('execute-standard');
    expect(inferExecutionMode({})).toBe('execute-standard');
  });
});

describe('shouldEscalateMode', () => {
  test('Quick + high risk escalates to Think', () => {
    const result = shouldEscalateMode('quick', 'high');
    expect(result.escalated).toBe(true);
    expect(result.from).toBe('quick');
    expect(result.to).toBe('think');
    expect(result.reason).toContain('high_risk_task');
  });

  test('Quick + low risk does not escalate', () => {
    const result = shouldEscalateMode('quick', 'low');
    expect(result.escalated).toBe(false);
  });

  test('Auto never escalates', () => {
    expect(shouldEscalateMode('auto', 'high').escalated).toBe(false);
    expect(shouldEscalateMode('auto', 'low').escalated).toBe(false);
  });

  test('Think does not escalate', () => {
    expect(shouldEscalateMode('think', 'high').escalated).toBe(false);
  });
});
