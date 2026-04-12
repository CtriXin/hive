// tests/steering-actions.test.ts

import { describe, test, expect } from 'vitest';

import { validateSteeringAction, applySteeringAction } from '../orchestrator/steering-actions.js';
import type { SteeringAction, RunSpec, RunState, ExecutionMode } from '../orchestrator/types.js';

function makeAction(overrides: Partial<SteeringAction>): SteeringAction {
  return {
    action_id: 'steer-test',
    run_id: 'run-1',
    action_type: 'pause_run',
    scope: 'run',
    payload: {},
    requested_by: 'cli',
    requested_at: new Date().toISOString(),
    status: 'pending',
    ...overrides,
  };
}

function makeState(overrides: Partial<RunState>): RunState {
  return {
    run_id: 'run-1',
    status: 'executing',
    round: 1,
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
    next_action: { kind: 'execute', reason: 'test', task_ids: [] },
    updated_at: new Date().toISOString(),
    steering: { paused: false, pending_actions: [] },
    ...overrides,
  };
}

function makeSpec(overrides: Partial<RunSpec>): RunSpec {
  return {
    id: 'run-1',
    goal: 'test goal',
    cwd: '/tmp/test',
    mode: 'safe',
    execution_mode: 'auto',
    done_conditions: [],
    max_rounds: 6,
    max_worker_retries: 2,
    max_replans: 1,
    allow_auto_merge: false,
    stop_on_high_risk: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const spec = makeSpec({});

describe('steering-actions validation', () => {
  test('pause_run allowed on executing run', () => {
    const state = makeState({ status: 'executing' });
    const action = makeAction({ action_type: 'pause_run' });
    const result = validateSteeringAction(action, spec, state);
    expect(result.allowed).toBe(true);
  });

  test('pause_run rejected when already paused', () => {
    const state = makeState({});
    state.steering!.paused = true;
    const action = makeAction({ action_type: 'pause_run' });
    const result = validateSteeringAction(action, spec, state);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('already paused');
  });

  test('resume_run rejected when not paused', () => {
    const state = makeState({});
    const action = makeAction({ action_type: 'resume_run' });
    const result = validateSteeringAction(action, spec, state);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not currently paused');
  });

  test('resume_run allowed when paused', () => {
    const state = makeState({});
    state.steering!.paused = true;
    const action = makeAction({ action_type: 'resume_run' });
    const result = validateSteeringAction(action, spec, state);
    expect(result.allowed).toBe(true);
  });

  test('retry_task rejected for unknown task', () => {
    const state = makeState({});
    const action = makeAction({ action_type: 'retry_task', task_id: 'task-unknown', payload: { task_id: 'task-unknown' } });
    const result = validateSteeringAction(action, spec, state);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  test('retry_task rejected for merged task', () => {
    const state = makeState({
      task_states: { 'task-a': { task_id: 'task-a', status: 'merged', round: 1, changed_files: [], merged: true, worker_success: true, review_passed: true, retry_count: 0 } },
    });
    const action = makeAction({ action_type: 'retry_task', task_id: 'task-a', payload: { task_id: 'task-a' } });
    const result = validateSteeringAction(action, spec, state);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('already merged');
  });

  test('retry_task allowed for failed task', () => {
    const state = makeState({
      task_states: { 'task-a': { task_id: 'task-a', status: 'worker_failed', round: 1, changed_files: [], merged: false, worker_success: false, review_passed: false, retry_count: 0 } },
    });
    const action = makeAction({ action_type: 'retry_task', task_id: 'task-a', payload: { task_id: 'task-a' } });
    const result = validateSteeringAction(action, spec, state);
    expect(result.allowed).toBe(true);
  });

  test('skip_task rejected for merged task', () => {
    const state = makeState({
      task_states: { 'task-a': { task_id: 'task-a', status: 'merged', round: 1, changed_files: [], merged: true, worker_success: true, review_passed: true, retry_count: 0 } },
    });
    const action = makeAction({ action_type: 'skip_task', task_id: 'task-a', payload: { task_id: 'task-a' } });
    const result = validateSteeringAction(action, spec, state);
    expect(result.allowed).toBe(false);
  });

  test('skip_task allowed for pending task', () => {
    const state = makeState({
      task_states: { 'task-a': { task_id: 'task-a', status: 'pending', round: 1, changed_files: [], merged: false, worker_success: false, review_passed: false, retry_count: 0 } },
    });
    const action = makeAction({ action_type: 'skip_task', task_id: 'task-a', payload: { task_id: 'task-a' } });
    const result = validateSteeringAction(action, spec, state);
    expect(result.allowed).toBe(true);
  });

  test('all actions rejected on terminal run (done)', () => {
    const state = makeState({ status: 'done' });
    for (const actionType of ['pause_run', 'resume_run', 'request_replan', 'escalate_mode']) {
      const action = makeAction({ action_type: actionType as any });
      const result = validateSteeringAction(action, spec, state);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('terminal');
    }
  });

  test('all actions rejected on terminal run (blocked)', () => {
    const state = makeState({ status: 'blocked' });
    const action = makeAction({ action_type: 'pause_run' });
    const result = validateSteeringAction(action, spec, state);
    expect(result.allowed).toBe(false);
  });

  test('inject_steering_note always allowed even on terminal run', () => {
    const state = makeState({ status: 'done' });
    const action = makeAction({ action_type: 'inject_steering_note', payload: { note: 'check this' } });
    const result = validateSteeringAction(action, spec, state);
    expect(result.allowed).toBe(true);
  });

  test('escalate_mode rejected without target_mode', () => {
    const state = makeState({});
    const action = makeAction({ action_type: 'escalate_mode', payload: {} });
    const result = validateSteeringAction(action, spec, state);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('target_mode');
  });

  test('escalate_mode rejected when target is same or lower intensity', () => {
    const state = makeState({});
    const spec2 = makeSpec({ execution_mode: 'auto' });
    // auto has full-cascade review, so nothing escalates above it
    const action = makeAction({ action_type: 'escalate_mode', payload: { target_mode: 'think' } });
    const result = validateSteeringAction(action, spec2, state);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not escalate');
  });

  test('escalate_mode allowed from quick to think', () => {
    const state = makeState({});
    const spec2 = makeSpec({ execution_mode: 'quick' });
    const action = makeAction({ action_type: 'escalate_mode', payload: { target_mode: 'think' } });
    const result = validateSteeringAction(action, spec2, state);
    expect(result.allowed).toBe(true);
  });

  test('request_replan allowed on executing run', () => {
    const state = makeState({ status: 'executing' });
    const action = makeAction({ action_type: 'request_replan' });
    const result = validateSteeringAction(action, spec, state);
    expect(result.allowed).toBe(true);
  });

  test('retry_task rejected without task_id', () => {
    const state = makeState({});
    const action = makeAction({ action_type: 'retry_task', payload: {} });
    const result = validateSteeringAction(action, spec, state);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('requires a task_id');
  });

  test('skip_task rejected without task_id', () => {
    const state = makeState({});
    const action = makeAction({ action_type: 'skip_task', payload: {} });
    const result = validateSteeringAction(action, spec, state);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('requires a task_id');
  });
});

describe('steering-actions apply', () => {
  test('pause_run sets paused flag', () => {
    const state = makeState({});
    const action = makeAction({ action_type: 'pause_run' });
    const result = applySteeringAction(action, state);
    expect(result.applied).toBe(true);
    expect(state.steering!.paused).toBe(true);
    expect(result.effect).toContain('paused');
  });

  test('resume_run clears paused flag', () => {
    const state = makeState({});
    state.steering!.paused = true;
    const action = makeAction({ action_type: 'resume_run' });
    const result = applySteeringAction(action, state);
    expect(result.applied).toBe(true);
    expect(state.steering!.paused).toBe(false);
  });

  test('skip_task marks task as superseded', () => {
    const state = makeState({
      task_states: { 'task-a': { task_id: 'task-a', status: 'pending', round: 1, changed_files: [], merged: false, worker_success: false, review_passed: false, retry_count: 0 } },
    });
    const action = makeAction({ action_type: 'skip_task', task_id: 'task-a', payload: { task_id: 'task-a' } });
    const result = applySteeringAction(action, state);
    expect(result.applied).toBe(true);
    expect(state.task_states['task-a'].status).toBe('superseded');
  });

  test('request_replan returns replan next action', () => {
    const state = makeState({});
    const action = makeAction({ action_type: 'request_replan' });
    const result = applySteeringAction(action, state);
    expect(result.applied).toBe(true);
    expect(result.nextActionKind).toBe('replan');
  });

  test('inject_steering_note records note', () => {
    const state = makeState({});
    const action = makeAction({ action_type: 'inject_steering_note', payload: { note: 'be careful with auth' } });
    const result = applySteeringAction(action, state);
    expect(result.applied).toBe(true);
    expect(result.effect).toContain('be careful with auth');
  });

  test('mark_requires_human sets partial status', () => {
    const state = makeState({ status: 'executing' });
    const action = makeAction({ action_type: 'mark_requires_human', payload: { reason: 'stuck on build' } });
    const result = applySteeringAction(action, state);
    expect(result.applied).toBe(true);
  });

  test('escalate_mode records effect', () => {
    const state = makeState({});
    const action = makeAction({ action_type: 'escalate_mode', payload: { target_mode: 'think' as ExecutionMode } });
    const result = applySteeringAction(action, state, spec);
    expect(result.applied).toBe(true);
    expect(result.effect).toContain('think');
  });

  test('escalate_mode sets runtime_mode_override', () => {
    const state = makeState({});
    const action = makeAction({ action_type: 'escalate_mode', payload: { target_mode: 'think' as ExecutionMode } });
    applySteeringAction(action, state, spec);
    expect(state.runtime_mode_override).toBe('think');
  });

  test('escalate_mode records escalation history', () => {
    const state = makeState({ round: 2 });
    const spec2 = makeSpec({ execution_mode: 'quick' });
    const action = makeAction({ action_type: 'escalate_mode', payload: { target_mode: 'think' as ExecutionMode } });
    applySteeringAction(action, state, spec2);
    expect(state.mode_escalation_history).toHaveLength(1);
    // normalizeExecutionMode maps legacy names to lane names
    expect(state.mode_escalation_history![0].from).toBe('auto-execute-small');
    expect(state.mode_escalation_history![0].to).toBe('execute-parallel');
    expect(state.mode_escalation_history![0].reason).toContain('Steering');
    expect(state.mode_escalation_history![0].round).toBe(2);
  });

  test('downgrade_mode sets runtime_mode_override', () => {
    const state = makeState({ runtime_mode_override: 'think' });
    const action = makeAction({ action_type: 'downgrade_mode', payload: { target_mode: 'quick' as ExecutionMode } });
    applySteeringAction(action, state, spec);
    expect(state.runtime_mode_override).toBe('quick');
  });

  test('escalate_mode validates against runtime_mode_override', () => {
    const state = makeState({ runtime_mode_override: 'quick' as ExecutionMode });
    // Escalating from quick (light review) to think (full-cascade) is an escalation
    const action = makeAction({ action_type: 'escalate_mode', payload: { target_mode: 'think' as ExecutionMode } });
    const result = validateSteeringAction(action, spec, state);
    expect(result.allowed).toBe(true);
  });

  test('chained escalate then downgrade shows correct effective mode', () => {
    const state = makeState({});
    const spec2 = makeSpec({ execution_mode: 'quick' });
    const escalate = makeAction({ action_type: 'escalate_mode', payload: { target_mode: 'think' as ExecutionMode } });
    applySteeringAction(escalate, state, spec2);
    expect(state.runtime_mode_override).toBe('think');

    const downgrade = makeAction({ action_type: 'downgrade_mode', payload: { target_mode: 'quick' as ExecutionMode } });
    applySteeringAction(downgrade, state, spec2);
    expect(state.runtime_mode_override).toBe('quick');
    expect(state.mode_escalation_history).toHaveLength(2);
  });
});
