// tests/mode-enforcement.test.ts — Phase 5A.1: Mode enforcement + escalation tests

import { describe, test, expect } from 'vitest';
import {
  getModeContract,
  inferExecutionMode,
  shouldEscalateMode,
  shouldEscalateModeRich,
} from '../orchestrator/mode-policy.js';

// ── Review intensity enforcement ──

describe('Review intensity enforcement', () => {
  test('Quick mode uses light review intensity', () => {
    const c = getModeContract('quick');
    expect(c.review_intensity).toBe('light');
  });

  test('Think mode uses full-cascade review', () => {
    const c = getModeContract('think');
    expect(c.review_intensity).toBe('full-cascade');
  });

  test('Auto mode uses full-cascade review', () => {
    const c = getModeContract('auto');
    expect(c.review_intensity).toBe('full-cascade');
  });

  test('All three modes have distinct review paths', () => {
    const quick = getModeContract('quick');
    const think = getModeContract('think');
    const auto = getModeContract('auto');
    // Quick is lighter than Think/Auto
    expect(quick.review_intensity).not.toBe(think.review_intensity);
    // Think and Auto can share the same review intensity
    // (Think distinguishes on verification scope and no auto-merge)
    expect(think.review_intensity).toBe(auto.review_intensity);
  });
});

// ── Verification scope enforcement ──

describe('Verification scope enforcement', () => {
  test('Quick mode uses minimal verification', () => {
    const c = getModeContract('quick');
    expect(c.verification_scope).toBe('minimal');
  });

  test('Think mode uses standard verification', () => {
    const c = getModeContract('think');
    expect(c.verification_scope).toBe('standard');
  });

  test('Auto mode uses full-suite verification', () => {
    const c = getModeContract('auto');
    expect(c.verification_scope).toBe('full-suite');
  });

  test('Verification scopes are all different across modes', () => {
    const quick = getModeContract('quick');
    const think = getModeContract('think');
    const auto = getModeContract('auto');
    expect(quick.verification_scope).not.toBe(think.verification_scope);
    expect(think.verification_scope).not.toBe(auto.verification_scope);
    expect(quick.verification_scope).not.toBe(auto.verification_scope);
  });
});

// ── Planning depth differentiation ──

describe('Planning depth differentiation', () => {
  test('Quick mode uses minimal planning', () => {
    const c = getModeContract('quick');
    expect(c.planning_depth).toBe('minimal');
  });

  test('Think mode uses full planning', () => {
    const c = getModeContract('think');
    expect(c.planning_depth).toBe('full');
  });

  test('Auto mode uses full planning', () => {
    const c = getModeContract('auto');
    expect(c.planning_depth).toBe('full');
  });
});

// ── Dispatch style differentiation ──

describe('Dispatch style differentiation', () => {
  test('Quick mode dispatches single', () => {
    expect(getModeContract('quick').dispatch_style).toBe('single');
  });

  test('Think mode dispatches parallel', () => {
    expect(getModeContract('think').dispatch_style).toBe('parallel');
  });

  test('Auto mode dispatches full-orchestration', () => {
    expect(getModeContract('auto').dispatch_style).toBe('full-orchestration');
  });
});

// ── Mode contract coherence ──

describe('Mode contract coherence', () => {
  test('Quick mode contract is consistently lightweight', () => {
    const c = getModeContract('quick');
    expect(c.planning_depth).toBe('minimal');
    expect(c.verification_scope).toBe('minimal');
    expect(c.review_intensity).toBe('light');
    expect(c.discuss_gate).toBe('disabled');
    expect(c.allow_repair).toBe(false);
    expect(c.allow_replan).toBe(false);
  });

  test('Think mode contract is consistently analytical', () => {
    const c = getModeContract('think');
    expect(c.planning_depth).toBe('full');
    expect(c.review_intensity).toBe('full-cascade');
    expect(c.discuss_gate).toBe('standard');
    expect(c.allow_repair).toBe(true);
    expect(c.allow_replan).toBe(true);
    // Key Think distinction: no auto-merge
    expect(c.allow_auto_merge).toBe(false);
  });

  test('Auto mode contract is consistently full-stack', () => {
    const c = getModeContract('auto');
    expect(c.planning_depth).toBe('full');
    expect(c.review_intensity).toBe('full-cascade');
    expect(c.verification_scope).toBe('full-suite');
    expect(c.discuss_gate).toBe('enforced');
    expect(c.allow_repair).toBe(true);
    expect(c.allow_replan).toBe(true);
    expect(c.allow_auto_merge).toBe(true);
  });
});

// ── Automatic mode escalation ──

describe('Automatic mode escalation (rich inputs)', () => {
  test('Quick + high risk escalates to Think', () => {
    const result = shouldEscalateModeRich({
      currentMode: 'quick',
      riskLevel: 'high',
      retryCount: 0,
      discussGateHit: false,
      verificationSeverity: 'none',
      taskComplexity: 'low',
      providerInstability: false,
      replanCount: 0,
    });
    expect(result.escalated).toBe(true);
    expect(result.from).toBe('quick');
    expect(result.to).toBe('think');
    expect(result.triggers).toContain('high_risk_task');
  });

  test('Quick + discuss gate hit escalates to Think', () => {
    const result = shouldEscalateModeRich({
      currentMode: 'quick',
      riskLevel: 'low',
      retryCount: 0,
      discussGateHit: true,
      verificationSeverity: 'none',
      taskComplexity: 'low',
      providerInstability: false,
      replanCount: 0,
    });
    expect(result.escalated).toBe(true);
    expect(result.to).toBe('think');
    expect(result.triggers).toContain('discuss_gate_in_quick');
  });

  test('Quick + high complexity escalates to Think', () => {
    const result = shouldEscalateModeRich({
      currentMode: 'quick',
      riskLevel: 'low',
      retryCount: 0,
      discussGateHit: false,
      verificationSeverity: 'none',
      taskComplexity: 'high',
      providerInstability: false,
      replanCount: 0,
    });
    expect(result.escalated).toBe(true);
    expect(result.to).toBe('think');
    expect(result.triggers).toContain('high_complexity_in_quick');
  });

  test('Quick + multiple triggers escalates once with combined reason', () => {
    const result = shouldEscalateModeRich({
      currentMode: 'quick',
      riskLevel: 'high',
      retryCount: 0,
      discussGateHit: true,
      verificationSeverity: 'none',
      taskComplexity: 'high',
      providerInstability: false,
      replanCount: 0,
    });
    expect(result.escalated).toBe(true);
    expect(result.triggers.length).toBeGreaterThan(1);
    expect(result.triggers).toContain('high_risk_task');
    expect(result.triggers).toContain('discuss_gate_in_quick');
    expect(result.triggers).toContain('high_complexity_in_quick');
  });

  test('Think + repeated failure escalates to Auto', () => {
    const result = shouldEscalateModeRich({
      currentMode: 'think',
      riskLevel: 'medium',
      retryCount: 2,
      discussGateHit: false,
      verificationSeverity: 'smoke',
      taskComplexity: 'medium',
      providerInstability: false,
      replanCount: 0,
    });
    expect(result.escalated).toBe(true);
    expect(result.from).toBe('think');
    expect(result.to).toBe('auto');
    expect(result.triggers).toContain('repeated_failure_in_think');
  });

  test('Think + critical verification failure escalates to Auto', () => {
    const result = shouldEscalateModeRich({
      currentMode: 'think',
      riskLevel: 'medium',
      retryCount: 0,
      discussGateHit: false,
      verificationSeverity: 'critical',
      taskComplexity: 'medium',
      providerInstability: false,
      replanCount: 0,
    });
    expect(result.escalated).toBe(true);
    expect(result.to).toBe('auto');
    expect(result.triggers).toContain('critical_verify_in_think');
  });

  test('Quick + provider instability escalates to Think', () => {
    const result = shouldEscalateModeRich({
      currentMode: 'quick',
      riskLevel: 'low',
      retryCount: 0,
      discussGateHit: false,
      verificationSeverity: 'none',
      taskComplexity: 'low',
      providerInstability: true,
      replanCount: 0,
    });
    expect(result.escalated).toBe(true);
    expect(result.to).toBe('think');
    expect(result.triggers).toContain('provider_instability_in_quick');
  });

  test('Quick + planner failure escalates to Think', () => {
    const result = shouldEscalateModeRich({
      currentMode: 'quick',
      riskLevel: 'low',
      failureClass: 'planner',
      retryCount: 0,
      discussGateHit: false,
      verificationSeverity: 'none',
      taskComplexity: 'low',
      providerInstability: false,
      replanCount: 0,
    });
    expect(result.escalated).toBe(true);
    expect(result.to).toBe('think');
    expect(result.triggers).toContain('planner_failure_in_quick');
  });

  test('Auto never escalates regardless of failures', () => {
    const result = shouldEscalateModeRich({
      currentMode: 'auto',
      riskLevel: 'high',
      retryCount: 5,
      discussGateHit: true,
      verificationSeverity: 'critical',
      taskComplexity: 'high',
      providerInstability: true,
      replanCount: 3,
    });
    expect(result.escalated).toBe(false);
  });

  test('No escalation when conditions are clean', () => {
    const result = shouldEscalateModeRich({
      currentMode: 'quick',
      riskLevel: 'low',
      retryCount: 0,
      discussGateHit: false,
      verificationSeverity: 'none',
      taskComplexity: 'low',
      providerInstability: false,
      replanCount: 0,
    });
    expect(result.escalated).toBe(false);
  });

  test('Think with low retries does not escalate', () => {
    const result = shouldEscalateModeRich({
      currentMode: 'think',
      riskLevel: 'low',
      retryCount: 1,
      discussGateHit: false,
      verificationSeverity: 'none',
      taskComplexity: 'medium',
      providerInstability: false,
      replanCount: 0,
    });
    expect(result.escalated).toBe(false);
  });

  test('Escalation reason is human-readable', () => {
    const result = shouldEscalateModeRich({
      currentMode: 'quick',
      riskLevel: 'high',
      retryCount: 0,
      discussGateHit: false,
      verificationSeverity: 'none',
      taskComplexity: 'low',
      providerInstability: false,
      replanCount: 0,
    });
    expect(result.reason).toContain('quick');
    expect(result.reason).toContain('think');
    expect(result.reason.length).toBeGreaterThan(10);
  });

  test('Escalation triggers list is non-empty', () => {
    const result = shouldEscalateModeRich({
      currentMode: 'quick',
      riskLevel: 'high',
      retryCount: 0,
      discussGateHit: false,
      verificationSeverity: 'none',
      taskComplexity: 'low',
      providerInstability: false,
      replanCount: 0,
    });
    expect(result.triggers).toBeDefined();
    expect(result.triggers.length).toBeGreaterThan(0);
  });
});

// ── Backward compat: legacy shouldEscalateMode ──

describe('Backward compat: legacy shouldEscalateMode', () => {
  test('Quick + high risk escalates', () => {
    const result = shouldEscalateMode('quick', 'high');
    expect(result.escalated).toBe(true);
    expect(result.to).toBe('think');
  });

  test('Quick + low risk does not escalate', () => {
    const result = shouldEscalateMode('quick', 'low');
    expect(result.escalated).toBe(false);
  });

  test('Auto never escalates', () => {
    expect(shouldEscalateMode('auto', 'high').escalated).toBe(false);
  });

  test('Think does not escalate', () => {
    expect(shouldEscalateMode('think', 'high').escalated).toBe(false);
  });
});

// ── Infer execution mode ──

describe('inferExecutionMode', () => {
  test('returns explicit mode when provided', () => {
    expect(inferExecutionMode({ explicit: 'quick' })).toBe('auto-execute-small');
    expect(inferExecutionMode({ explicit: 'think' })).toBe('execute-parallel');
    expect(inferExecutionMode({ explicit: 'auto' })).toBe('execute-standard');
  });

  test('defaults to auto when not specified', () => {
    expect(inferExecutionMode()).toBe('execute-standard');
    expect(inferExecutionMode({})).toBe('execute-standard');
  });
});
