import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveRunPlan, saveRunSpec, saveRunState } from '../orchestrator/run-store.js';
import { writeLoopProgress } from '../orchestrator/loop-progress-store.js';
import { updateWorkerStatus } from '../orchestrator/worker-status-store.js';
import { ProviderHealthStore } from '../orchestrator/provider-resilience.js';
import type { RunSpec, RunState, TaskPlan } from '../orchestrator/types.js';

const TMP_DIR = '/tmp/hive-handoff-surfaces-test';
const RUN_ID = 'run-handoff-surface';

function resetDir(): void {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function makeSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    id: RUN_ID,
    goal: 'Ship thin handoff surfaces',
    cwd: TMP_DIR,
    mode: 'safe',
    done_conditions: [],
    max_rounds: 6,
    max_worker_retries: 2,
    max_replans: 1,
    allow_auto_merge: false,
    stop_on_high_risk: true,
    created_at: '2026-04-23T10:00:00.000Z',
    ...overrides,
  };
}

function makePlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    id: 'plan-1',
    goal: 'Ship thin handoff surfaces',
    cwd: TMP_DIR,
    created_at: '2026-04-23T10:00:00.000Z',
    execution_order: [['task-a']],
    context_flow: {},
    tasks: [
      {
        id: 'task-a',
        description: 'Render a compact human progress surface',
        complexity: 'medium',
        category: 'docs',
        assigned_model: 'kimi-for-coding',
        assignment_reason: 'good for concise surface shaping',
        estimated_files: ['orchestrator/handoff-surfaces.ts'],
        acceptance_criteria: ['write handoff.md', 'write packet.json'],
        discuss_threshold: 0.7,
        depends_on: [],
        review_scale: 'medium',
      },
    ],
    ...overrides,
  };
}

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: RUN_ID,
    status: 'executing',
    round: 1,
    completed_task_ids: [],
    failed_task_ids: [],
    review_failed_task_ids: [],
    merged_task_ids: [],
    retry_counts: {},
    replan_count: 0,
    task_states: {
      'task-a': {
        task_id: 'task-a',
        status: 'pending',
        round: 1,
        changed_files: [],
        merged: false,
        worker_success: false,
        review_passed: false,
        retry_count: 0,
      },
    },
    task_verification_results: {},
    repair_history: [],
    round_cost_history: [],
    policy_hook_results: [],
    verification_results: [],
    updated_at: '2026-04-23T10:01:00.000Z',
    ...overrides,
  };
}

describe('handoff-surfaces', () => {
  beforeEach(() => {
    resetDir();
  });

  afterEach(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });

  it('writes packet, handoff markdown, and human progress for active work', () => {
    saveRunSpec(TMP_DIR, makeSpec());
    saveRunPlan(TMP_DIR, RUN_ID, makePlan());
    saveRunState(TMP_DIR, makeState());
    writeLoopProgress(TMP_DIR, RUN_ID, {
      run_id: RUN_ID,
      round: 1,
      phase: 'executing',
      reason: 'dispatching active worker',
      focus_task_id: 'task-a',
      focus_agent_id: 'task-a@run-handoff-surface',
      focus_model: 'kimi-for-coding',
    });
    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-a',
      plan_id: 'plan-1',
      status: 'running',
      assigned_model: 'kimi-for-coding',
      active_model: 'kimi-for-coding',
      provider: 'newapi',
      task_summary: 'Rendering handoff surfaces',
      event_message: 'Started',
    });

    const packetPath = path.join(TMP_DIR, '.ai', 'plan', 'packet.json');
    const handoffPath = path.join(TMP_DIR, '.ai', 'plan', 'handoff.md');
    const humanPath = path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'human-progress.md');
    const latestHumanPath = path.join(TMP_DIR, '.ai', 'restore', 'latest-human-progress.md');

    expect(fs.existsSync(packetPath)).toBe(true);
    expect(fs.existsSync(handoffPath)).toBe(true);
    expect(fs.existsSync(humanPath)).toBe(true);
    expect(fs.existsSync(latestHumanPath)).toBe(true);

    const packet = JSON.parse(fs.readFileSync(packetPath, 'utf-8'));
    expect(packet.run_id).toBe(RUN_ID);
    expect(packet.task_id).toBe('task-a');
    expect(packet.cli).toBe('hive');
    expect(packet.refs).toContain(`.ai/runs/${RUN_ID}/human-progress.md`);

    const handoff = fs.readFileSync(handoffPath, 'utf-8');
    expect(handoff).toContain('- run_id: run-handoff-surface');
    expect(handoff).toContain('## Expected Output');

    const human = fs.readFileSync(humanPath, 'utf-8');
    expect(human).toContain('- overall status: running');
    expect(human).toContain('| task-a | kimi-for-coding@newapi | running |');
  });

  it('surfaces request_human and queued_retry reasons in human progress', () => {
    saveRunSpec(TMP_DIR, makeSpec());
    saveRunPlan(TMP_DIR, RUN_ID, makePlan());
    saveRunState(TMP_DIR, makeState({
      next_action: {
        kind: 'request_human',
        reason: 'Need approval for risky merge',
        task_ids: ['task-a'],
        instructions: 'Approve or reject the risky merge for task-a',
      },
      task_states: {
        'task-a': {
          task_id: 'task-a',
          status: 'review_failed',
          round: 1,
          changed_files: ['orchestrator/handoff-surfaces.ts'],
          merged: false,
          worker_success: true,
          review_passed: false,
          retry_count: 1,
          last_error: 'Risky change requires approval',
        },
      },
    }));

    let human = fs.readFileSync(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'human-progress.md'), 'utf-8');
    expect(human).toContain('- overall status: request_human');
    expect(human).toContain('Approve or reject the risky merge for task-a');
    expect(human).toContain('- request_human: 1');

    saveRunState(TMP_DIR, makeState({
      next_action: {
        kind: 'retry_task',
        reason: 'Retry after provider cooldown',
        task_ids: ['task-a'],
      },
      task_states: {
        'task-a': {
          task_id: 'task-a',
          status: 'worker_failed',
          round: 1,
          changed_files: [],
          merged: false,
          worker_success: false,
          review_passed: false,
          retry_count: 1,
          last_error: 'provider timeout',
        },
      },
    }));

    const healthStore = new ProviderHealthStore(path.join(TMP_DIR, '.ai', 'runs', RUN_ID));
    healthStore.recordFailure('newapi', 'timeout', 1000);
    healthStore.recordDecision({
      provider: 'newapi',
      failure_subtype: 'timeout',
      action: 'cooldown',
      action_reason: 'queued for retry in 5m',
      dispatch_affected: true,
      backoff_ms: 300000,
      attempt: 1,
      timestamp: 1000,
    });
    healthStore.save();

    human = fs.readFileSync(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'human-progress.md'), 'utf-8');
    expect(human).toContain('- overall status: queued_retry');
    expect(human).toContain('- queued_retry: 1');
    expect(human).toContain('queued for retry in 5m');
  });
});
