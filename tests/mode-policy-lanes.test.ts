import { describe, it, expect } from 'vitest';
import {
  normalizeExecutionMode,
  autoClassifyLane,
  inferExecutionMode,
  getModeContract,
} from '../orchestrator/mode-policy.js';
import type { ExecutionMode, LaneName } from '../orchestrator/types.js';

describe('normalizeExecutionMode', () => {
  it('maps legacy quick to auto-execute-small', () => {
    expect(normalizeExecutionMode('quick')).toBe('auto-execute-small');
  });

  it('maps legacy think to execute-parallel', () => {
    expect(normalizeExecutionMode('think')).toBe('execute-parallel');
  });

  it('maps legacy auto to execute-standard', () => {
    expect(normalizeExecutionMode('auto')).toBe('execute-standard');
  });

  it('passes through new lane names unchanged', () => {
    expect(normalizeExecutionMode('record-only')).toBe('record-only');
    expect(normalizeExecutionMode('clarify-first')).toBe('clarify-first');
    expect(normalizeExecutionMode('auto-execute-small')).toBe('auto-execute-small');
    expect(normalizeExecutionMode('execute-standard')).toBe('execute-standard');
    expect(normalizeExecutionMode('execute-parallel')).toBe('execute-parallel');
  });
});

describe('getModeContract', () => {
  it('record-only skips all phases', () => {
    const c = getModeContract('record-only');
    expect(c.dispatch_style).toBe('skip');
    expect(c.review_intensity).toBe('skip');
    expect(c.allow_repair).toBe(false);
    expect(c.allow_replan).toBe(false);
  });

  it('clarify-first skips all phases', () => {
    const c = getModeContract('clarify-first');
    expect(c.dispatch_style).toBe('skip');
  });

  it('auto-execute-small is lite path', () => {
    const c = getModeContract('auto-execute-small');
    expect(c.dispatch_style).toBe('single');
    expect(c.review_intensity).toBe('light');
    expect(c.discuss_gate).toBe('disabled');
    expect(c.allow_repair).toBe(false);
    expect(c.allow_replan).toBe(false);
  });

  it('execute-standard allows full lifecycle', () => {
    const c = getModeContract('execute-standard');
    expect(c.dispatch_style).toBe('single');
    expect(c.review_intensity).toBe('full-cascade');
    expect(c.allow_repair).toBe(true);
    expect(c.allow_replan).toBe(true);
  });

  it('execute-parallel allows multi-agent', () => {
    const c = getModeContract('execute-parallel');
    expect(c.dispatch_style).toBe('parallel');
    expect(c.review_intensity).toBe('full-cascade');
  });
});

describe('autoClassifyLane', () => {
  it('classifies small task as auto-execute-small', () => {
    expect(autoClassifyLane('fix typo in README')).toBe('auto-execute-small');
  });

  it('classifies feature request as execute-standard', () => {
    expect(autoClassifyLane('add user authentication feature')).toBe('execute-standard');
  });

  it('blocks lite path for multi-repo', () => {
    expect(autoClassifyLane('update multi-repo config')).toBe('execute-standard');
  });

  it('blocks lite path for schema change', () => {
    expect(autoClassifyLane('schema migration for user table')).toBe('execute-standard');
  });

  it('blocks lite path for deploy', () => {
    expect(autoClassifyLane('deploy to production')).toBe('execute-standard');
  });

  it('blocks lite path for public API change', () => {
    expect(autoClassifyLane('update public API contract')).toBe('execute-standard');
  });

  it('promotes complex task to execute-parallel', () => {
    expect(autoClassifyLane('implement backend API and frontend client with tests')).toBe('execute-parallel');
  });

  it('qualifies simple fix as auto-execute-small', () => {
    expect(autoClassifyLane('fix lint style issues')).toBe('auto-execute-small');
  });

  it('qualifies simple test addition as auto-execute-small', () => {
    expect(autoClassifyLane('add a test for the utility function')).toBe('auto-execute-small');
  });

  it('defaults to execute-standard for ambiguous goals', () => {
    expect(autoClassifyLane('improve the system')).toBe('execute-standard');
  });
});

describe('inferExecutionMode', () => {
  it('explicit override wins', () => {
    expect(inferExecutionMode({ explicit: 'auto-execute-small' })).toBe('auto-execute-small');
    expect(inferExecutionMode({ explicit: 'record-only' })).toBe('record-only');
  });

  it('normalizes legacy modes when explicit', () => {
    expect(inferExecutionMode({ explicit: 'quick' })).toBe('auto-execute-small');
    expect(inferExecutionMode({ explicit: 'think' })).toBe('execute-parallel');
    expect(inferExecutionMode({ explicit: 'auto' })).toBe('execute-standard');
  });

  it('auto-classifies without explicit mode', () => {
    expect(inferExecutionMode({ goal: 'fix typo in README' })).toBe('auto-execute-small');
    expect(inferExecutionMode({ goal: 'add user auth feature' })).toBe('execute-standard');
  });

  it('explicit overrides auto-classification', () => {
    const goal = 'fix typo';
    const result = inferExecutionMode({ goal, explicit: 'execute-standard' });
    expect(result).toBe('execute-standard');
  });
});
