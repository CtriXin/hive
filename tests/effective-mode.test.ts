// tests/effective-mode.test.ts — Phase 8D: Effective Mode Consistency

import { describe, test, expect } from 'vitest';
import {
  resolveEffectiveMode,
  normalizeExecutionMode,
  getModeContract,
} from '../orchestrator/mode-policy.js';

describe('resolveEffectiveMode', () => {
  test('uses runtime_mode_override when present', () => {
    const result = resolveEffectiveMode(
      { execution_mode: 'execute-standard' },
      { runtime_mode_override: 'execute-parallel' },
    );
    expect(result.mode).toBe('execute-parallel');
    expect(result.normalized).toBe('execute-parallel');
    expect(result.contract.review_intensity).toBe('full-cascade');
    expect(result.source).toBe('runtime_override');
    expect(result.overridden).toBe(true);
  });

  test('falls back to spec.execution_mode when no override', () => {
    const result = resolveEffectiveMode(
      { execution_mode: 'auto-execute-small' },
      {},
    );
    expect(result.mode).toBe('auto-execute-small');
    expect(result.source).toBe('spec');
    expect(result.overridden).toBe(false);
  });

  test('falls back to default "auto" when neither present', () => {
    const result = resolveEffectiveMode({}, {});
    expect(result.mode).toBe('auto');
    expect(result.normalized).toBe('execute-standard');
    expect(result.source).toBe('default');
    expect(result.overridden).toBe(false);
  });

  test('normalizes legacy mode names in override', () => {
    const result = resolveEffectiveMode(
      { execution_mode: 'auto' },
      { runtime_mode_override: 'think' },
    );
    expect(result.mode).toBe('think');
    expect(result.normalized).toBe('execute-parallel');
    expect(result.contract.planning_depth).toBe('full');
  });

  test('normalizes legacy mode names in spec', () => {
    const result = resolveEffectiveMode(
      { execution_mode: 'quick' },
      {},
    );
    expect(result.mode).toBe('quick');
    expect(result.normalized).toBe('auto-execute-small');
    expect(result.contract.dispatch_style).toBe('single');
  });

  test('contract matches the normalized mode', () => {
    const modes: Array<{ raw: string; expectedReview: string }> = [
      { raw: 'execute-standard', expectedReview: 'full-cascade' },
      { raw: 'execute-parallel', expectedReview: 'full-cascade' },
      { raw: 'auto-execute-small', expectedReview: 'light' },
      { raw: 'quick', expectedReview: 'light' },
    ];
    for (const m of modes) {
      const result = resolveEffectiveMode(
        { execution_mode: m.raw as any },
        {},
      );
      expect(result.contract.review_intensity).toBe(m.expectedReview);
    }
  });

  test('override from legacy "quick" to "think" changes allow_repair', () => {
    const before = resolveEffectiveMode(
      { execution_mode: 'quick' },
      {},
    );
    expect(before.contract.allow_repair).toBe(false);

    const after = resolveEffectiveMode(
      { execution_mode: 'quick' },
      { runtime_mode_override: 'think' },
    );
    expect(after.contract.allow_repair).toBe(true);
    expect(after.overridden).toBe(true);
  });
});

describe('effective mode behavior in decision paths', () => {
  test('override changes allow_repair behavior', () => {
    const spec = { execution_mode: 'auto-execute-small' };
    const noOverride = resolveEffectiveMode(spec, {});
    const withOverride = resolveEffectiveMode(spec, { runtime_mode_override: 'execute-standard' });
    expect(noOverride.contract.allow_repair).toBe(false);
    expect(withOverride.contract.allow_repair).toBe(true);
  });

  test('override changes allow_replan behavior', () => {
    const spec = { execution_mode: 'auto-execute-small' };
    const noOverride = resolveEffectiveMode(spec, {});
    const withOverride = resolveEffectiveMode(spec, { runtime_mode_override: 'execute-standard' });
    expect(noOverride.contract.allow_replan).toBe(false);
    expect(withOverride.contract.allow_replan).toBe(true);
  });

  test('override changes verification scope', () => {
    const spec = { execution_mode: 'execute-standard' };
    const noOverride = resolveEffectiveMode(spec, {});
    const withOverride = resolveEffectiveMode(spec, { runtime_mode_override: 'auto-execute-small' });
    expect(noOverride.contract.verification_scope).toBe('standard');
    expect(withOverride.contract.verification_scope).toBe('minimal');
  });

  test('no-override case preserves original spec behavior', () => {
    const modes = ['execute-standard', 'execute-parallel', 'auto-execute-small'] as const;
    for (const mode of modes) {
      const result = resolveEffectiveMode({ execution_mode: mode }, {});
      expect(result.overridden).toBe(false);
      expect(result.source).toBe('spec');
      expect(result.contract).toBe(getModeContract(normalizeExecutionMode(mode)));
    }
  });
});
