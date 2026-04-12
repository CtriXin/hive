// tests/watch-loader.test.ts — Phase 8C: Watch data aggregation tests

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadWatchData } from '../orchestrator/watch-loader.js';
import { saveRunResult, saveRunSpec, saveRunState } from '../orchestrator/run-store.js';
import { writeLoopProgress } from '../orchestrator/loop-progress-store.js';
import { saveSteeringStore, submitSteeringAction } from '../orchestrator/steering-store.js';
import type { RunSpec, RunState, ProviderHealthStoreData } from '../orchestrator/types.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hive-watch-test-'));
}

const TEST_RUN_ID = 'run-watch-test-001';

function baseSpec(cwd: string): RunSpec {
  return {
    id: TEST_RUN_ID,
    goal: 'Test watch data aggregation',
    cwd,
    mode: 'safe',
    execution_mode: 'auto',
    done_conditions: [],
    max_rounds: 6,
    max_worker_retries: 2,
    max_replans: 1,
    allow_auto_merge: true,
    stop_on_high_risk: false,
    created_at: new Date().toISOString(),
  };
}

function baseState(): RunState {
  return {
    run_id: TEST_RUN_ID,
    status: 'executing',
    round: 2,
    completed_task_ids: [],
    failed_task_ids: [],
    review_failed_task_ids: [],
    merged_task_ids: [],
    retry_counts: {},
    replan_count: 0,
    task_states: {},
    task_verification_results: {},
    repair_history: [],
    round_cost_history: [],
    policy_hook_results: [],
    verification_results: [],
    next_action: { kind: 'execute', reason: 'Dispatching tasks', task_ids: [] },
    updated_at: new Date().toISOString(),
  };
}

describe('watch-loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no artifacts exist', () => {
    const data = loadWatchData(tmpDir, 'run-nonexistent');
    expect(data).toBeNull();
  });

  it('loads data from spec and state only', () => {
    const spec = baseSpec(tmpDir);
    const state = baseState();
    saveRunSpec(tmpDir, spec);
    saveRunState(tmpDir, state);

    const data = loadWatchData(tmpDir, TEST_RUN_ID);
    expect(data).not.toBeNull();
    expect(data!.run_id).toBe(TEST_RUN_ID);
    expect(data!.status).toBe('executing');
    expect(data!.round).toBe(2);
    expect(data!.max_rounds).toBe(6);
    expect(data!.mode.current_mode).toBe('execute-standard');
    expect(data!.mode.escalated).toBe(false);
    expect(data!.provider.total).toBe(0);
    expect(data!.steering.is_paused).toBe(false);
    expect(data!.steering.pending_count).toBe(0);
  });

  it('includes progress data when available', () => {
    saveRunSpec(tmpDir, baseSpec(tmpDir));
    saveRunState(tmpDir, baseState());
    writeLoopProgress(tmpDir, TEST_RUN_ID, {
      run_id: TEST_RUN_ID,
      round: 2,
      phase: 'executing',
      reason: 'Dispatching 2 task(s) to workers',
      focus_task_id: 'task-a',
      focus_agent_id: 'worker-1',
      focus_summary: 'Implementing auth middleware',
      focus_model: 'qwen3.5-plus',
    });

    const data = loadWatchData(tmpDir, TEST_RUN_ID);
    expect(data!.phase).toBe('executing');
    expect(data!.phase_reason).toBe('Dispatching 2 task(s) to workers');
    expect(data!.focus_task).toBe('task-a');
    expect(data!.focus_agent).toBe('worker-1');
    expect(data!.focus_summary).toBe('Implementing auth middleware');
  });

  it('includes steering summary', () => {
    saveRunSpec(tmpDir, baseSpec(tmpDir));
    saveRunState(tmpDir, baseState());
    submitSteeringAction(tmpDir, TEST_RUN_ID, {
      run_id: TEST_RUN_ID,
      action_type: 'pause_run',
      scope: 'run',
      payload: { reason: 'Need to review changes' },
      requested_by: 'cli',
    });

    const data = loadWatchData(tmpDir, TEST_RUN_ID);
    expect(data!.steering.pending_count).toBe(1);
    expect(data!.steering.recent_actions).toHaveLength(1);
    expect(data!.steering.recent_actions[0].type).toBe('pause_run');
  });

  it('includes provider health summary', () => {
    saveRunSpec(tmpDir, baseSpec(tmpDir));
    saveRunState(tmpDir, baseState());

    const healthData: ProviderHealthStoreData = {
      providers: {
        'provider-a': {
          breaker: 'healthy',
          consecutive_failures: 0,
          cycle_failures: 0,
          last_failure_at: 0,
          last_success_at: Date.now(),
          probe_count: 0,
        },
        'provider-b': {
          breaker: 'degraded',
          last_failure_subtype: 'rate_limit',
          consecutive_failures: 1,
          cycle_failures: 1,
          last_failure_at: Date.now() - 30_000,
          last_success_at: Date.now() - 60_000,
          probe_count: 0,
        },
      },
      decisions: [],
      updated_at: new Date().toISOString(),
    };
    const runDir = path.join(tmpDir, '.ai', 'runs', TEST_RUN_ID);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'provider-health.json'), JSON.stringify(healthData, null, 2));

    const data = loadWatchData(tmpDir, TEST_RUN_ID);
    expect(data!.provider.total).toBe(2);
    expect(data!.provider.healthy).toBe(1);
    expect(data!.provider.degraded).toBe(1);
    expect(data!.provider.any_unhealthy).toBe(true);
    expect(data!.provider.details).toHaveLength(2);
  });

  it('uses the latest routed review result order and keeps provider labels', () => {
    saveRunSpec(tmpDir, baseSpec(tmpDir));
    saveRunState(tmpDir, baseState());
    saveRunResult(tmpDir, TEST_RUN_ID, {
      plan: { id: 'plan-1', goal: 'goal', cwd: tmpDir, tasks: [], execution_order: [], parallelizable_groups: [], context_flow: {}, created_at: new Date().toISOString() },
      worker_results: [],
      review_results: [
        {
          taskId: 'task-z',
          final_stage: 'cross-review',
          passed: true,
          findings: [],
          iterations: 1,
          duration_ms: 1,
          requested_model: 'kimi-for-coding',
          requested_provider: 'kimi',
          actual_model: 'kimi-for-coding',
          actual_provider: 'kimi-alt',
          provider_fallback_used: true,
        },
        {
          taskId: 'task-a',
          final_stage: 'cross-review',
          passed: false,
          findings: [],
          iterations: 1,
          duration_ms: 1,
          requested_model: 'gpt-5-mini',
          requested_provider: 'openai',
          actual_model: 'gpt-5-mini',
          actual_provider: 'azure',
          provider_failure_subtype: 'server_error',
        },
      ],
      score_updates: [],
      total_duration_ms: 0,
      cost_estimate: { total_usd: 0, by_model: {} },
      token_breakdown: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        actual_cost_usd: 0,
      },
    } as any);

    const data = loadWatchData(tmpDir, TEST_RUN_ID);
    expect(data!.provider.latest_task_route).toEqual({
      task_id: 'task-a',
      requested_model: 'gpt-5-mini',
      requested_provider: 'openai',
      actual_model: 'gpt-5-mini',
      actual_provider: 'azure',
      failure_subtype: 'server_error',
      fallback_used: false,
    });
  });

  it('includes mode escalation history', () => {
    const state = baseState();
    state.mode_escalation_history = [
      { from: 'quick', to: 'think', reason: 'high_risk_task', round: 1 },
    ];
    const spec = baseSpec(tmpDir);
    spec.execution_mode = 'quick';
    saveRunSpec(tmpDir, spec);
    saveRunState(tmpDir, state);

    const data = loadWatchData(tmpDir, TEST_RUN_ID);
    expect(data!.mode.current_mode).toBe('auto-execute-small');
    expect(data!.mode.escalated).toBe(true);
    expect(data!.mode.escalation_history).toHaveLength(1);
    expect(data!.mode.escalation_history[0].from).toBe('auto-execute-small');
    expect(data!.mode.escalation_history[0].to).toBe('execute-parallel');
  });

  it('tracks available and missing artifacts', () => {
    saveRunSpec(tmpDir, baseSpec(tmpDir));
    saveRunState(tmpDir, baseState());

    const data = loadWatchData(tmpDir, TEST_RUN_ID);
    expect(data!.artifacts_available).toContain('spec');
    expect(data!.artifacts_available).toContain('state');
    expect(data!.artifacts_missing).toContain('progress');
    expect(data!.artifacts_missing).toContain('provider-health');
    expect(data!.artifacts_missing).toContain('steering');
  });

  it('gracefully handles missing steering store', () => {
    saveRunSpec(tmpDir, baseSpec(tmpDir));
    saveRunState(tmpDir, baseState());

    const data = loadWatchData(tmpDir, TEST_RUN_ID);
    expect(data!.steering.is_paused).toBe(false);
    expect(data!.steering.pending_count).toBe(0);
    expect(data!.steering.recent_actions).toEqual([]);
  });

  it('gracefully handles missing provider health', () => {
    saveRunSpec(tmpDir, baseSpec(tmpDir));
    saveRunState(tmpDir, baseState());

    const data = loadWatchData(tmpDir, TEST_RUN_ID);
    expect(data!.provider.total).toBe(0);
    expect(data!.provider.any_unhealthy).toBe(false);
  });

  it('shows runtime_mode_override as current_mode', () => {
    const spec = baseSpec(tmpDir);
    spec.execution_mode = 'quick';
    const state = baseState();
    state.runtime_mode_override = 'think';
    saveRunSpec(tmpDir, spec);
    saveRunState(tmpDir, state);

    const data = loadWatchData(tmpDir, TEST_RUN_ID);
    expect(data!.mode.current_mode).toBe('execute-parallel');
    expect(data!.mode.escalated).toBe(false);
  });

  it('falls back to spec execution_mode when no override', () => {
    const spec = baseSpec(tmpDir);
    spec.execution_mode = 'execute-parallel';
    saveRunSpec(tmpDir, spec);
    saveRunState(tmpDir, baseState());

    const data = loadWatchData(tmpDir, TEST_RUN_ID);
    expect(data!.mode.current_mode).toBe('execute-parallel');
  });

  it('shows escalation history from mode steering', () => {
    const spec = baseSpec(tmpDir);
    spec.execution_mode = 'quick';
    const state = baseState();
    state.mode_escalation_history = [
      { from: 'quick', to: 'think', reason: 'Steering: escalate_mode', round: 2 },
    ];
    saveRunSpec(tmpDir, spec);
    saveRunState(tmpDir, state);

    const data = loadWatchData(tmpDir, TEST_RUN_ID);
    expect(data!.mode.current_mode).toBe('auto-execute-small');
    expect(data!.mode.escalated).toBe(true);
    expect(data!.mode.escalation_history).toHaveLength(1);
  });
});
