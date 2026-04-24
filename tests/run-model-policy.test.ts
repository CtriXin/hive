import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRunSpec, createInitialRunState } from '../orchestrator/driver.js';
import {
  loadRunModelOverrides,
  previewResolvedModelPolicy,
  resetRunModelOverrides,
  resolveEffectiveRunModelPolicy,
  updateRunModelOverrides,
  consumeRuntimeModelOverrides,
} from '../orchestrator/run-model-policy.js';

const TMP_DIR = '/tmp/hive-run-model-policy-test';

function resetDir(): void {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true });
  }
  fs.mkdirSync(path.join(TMP_DIR, '.ai', 'runs'), { recursive: true });
}

describe('run-model-policy', () => {
  beforeEach(() => {
    resetDir();
  });

  afterEach(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true });
    }
  });

  it('persists start-run and runtime overrides and resets back to default', () => {
    const spec = createRunSpec({ goal: 'test', cwd: TMP_DIR });
    updateRunModelOverrides(TMP_DIR, spec.id, 'start-run', {
      planner: { model: 'qwen3-max', fallback: 'glm-5-turbo' },
      reviewer: { final_review: { model: 'claude-opus-4-6' } },
    });
    updateRunModelOverrides(TMP_DIR, spec.id, 'runtime-next-stage', {
      executor: { model: 'kimi-k2.5', fallback: 'glm-5-turbo' },
    });

    const stored = loadRunModelOverrides(TMP_DIR, spec.id);
    expect(stored?.start_time?.planner?.model).toBe('qwen3-max');
    expect(stored?.runtime_next_stage?.executor?.model).toBe('kimi-k2.5');

    resetRunModelOverrides(TMP_DIR, spec.id, 'runtime-next-stage');
    const afterRuntimeReset = loadRunModelOverrides(TMP_DIR, spec.id);
    expect(afterRuntimeReset?.runtime_next_stage).toBeUndefined();
    expect(afterRuntimeReset?.start_time?.planner?.model).toBe('qwen3-max');

    resetRunModelOverrides(TMP_DIR, spec.id);
    expect(loadRunModelOverrides(TMP_DIR, spec.id)).toBeNull();
  });

  it('resolves effective policy with runtime override precedence over run-scoped override', () => {
    const spec = createRunSpec({ goal: 'test', cwd: TMP_DIR });
    updateRunModelOverrides(TMP_DIR, spec.id, 'start-run', {
      planner: { model: 'qwen3-max' },
      reviewer: { final_review: { model: 'claude-opus-4-6' } },
    });
    updateRunModelOverrides(TMP_DIR, spec.id, 'runtime-next-stage', {
      planner: { model: 'kimi-for-coding' },
    });

    const effective = resolveEffectiveRunModelPolicy(TMP_DIR, spec.id);
    expect(effective.run_override?.planner?.model).toBe('qwen3-max');
    expect(effective.runtime_override?.planner?.model).toBe('kimi-for-coding');
    expect(effective.effective_policy.planner.model).toBe('kimi-for-coding');
    expect(effective.effective_policy.reviewer.final_review.model).not.toMatch(/^claude-/);
    expect(effective.stages.find((stage) => stage.stage === 'planner')?.source).toBe('runtime-next-stage');
  });

  it('applies runtime override only after safe point consumption', () => {
    const spec = createRunSpec({ goal: 'test', cwd: TMP_DIR });
    const state = createInitialRunState(spec);
    updateRunModelOverrides(TMP_DIR, spec.id, 'start-run', {
      planner: { model: 'qwen3-max' },
    });
    updateRunModelOverrides(TMP_DIR, spec.id, 'runtime-next-stage', {
      planner: { model: 'kimi-k2.5' },
    });

    const before = resolveEffectiveRunModelPolicy(TMP_DIR, spec.id);
    expect(before.effective_policy.planner.model).toBe('kimi-k2.5');

    const consumed = consumeRuntimeModelOverrides(spec, state);
    expect(consumed).toBe(true);

    const after = loadRunModelOverrides(TMP_DIR, spec.id);
    expect(after?.runtime_next_stage).toBeUndefined();
    expect(after?.start_time?.planner?.model).toBe('kimi-k2.5');
  });

  it('previews effective policy before run start', () => {
    const preview = previewResolvedModelPolicy(TMP_DIR, {
      planner: { model: 'qwen3-max' },
      discuss: { model: ['kimi-k2.5', 'qwen3-max'] },
    });
    expect(preview.override_active).toBe(true);
    expect(preview.run_override?.planner?.model).toBe('qwen3-max');
    expect(preview.stages.find((stage) => stage.stage === 'planner')).toBeTruthy();
    expect(preview.stages.find((stage) => stage.stage === 'discuss')).toBeTruthy();
  });
});
