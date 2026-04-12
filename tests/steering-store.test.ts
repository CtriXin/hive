// tests/steering-store.test.ts

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadSteeringStore,
  saveSteeringStore,
  initSteeringStore,
  submitSteeringAction,
  getSteeringActions,
  getPendingSteeringActions,
  updateSteeringStatus,
  isDuplicateAction,
} from '../orchestrator/steering-store.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steering-store-'));
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('steering-store', () => {
  test('returns null for missing store', () => {
    expect(loadSteeringStore(testDir, 'run-1')).toBeNull();
  });

  test('init creates empty store', () => {
    const store = initSteeringStore(testDir, 'run-1');
    expect(store.run_id).toBe('run-1');
    expect(store.actions).toEqual([]);
  });

  test('init returns existing store if present', () => {
    const s1 = initSteeringStore(testDir, 'run-1');
    s1.actions.push({
      action_id: 'steer-x', run_id: 'run-1', action_type: 'pause_run',
      scope: 'run', payload: {}, requested_by: 'human', requested_at: new Date().toISOString(), status: 'pending',
    } as any);
    saveSteeringStore(testDir, 'run-1', s1);
    const s2 = initSteeringStore(testDir, 'run-1');
    expect(s2.actions.length).toBe(1);
  });

  test('submit creates action with generated ID', () => {
    const action = submitSteeringAction(testDir, 'run-1', {
      run_id: 'run-1',
      action_type: 'pause_run',
      scope: 'run',
      payload: {},
      requested_by: 'cli',
    });
    expect(action.action_id).toMatch(/^steer-/);
    expect(action.status).toBe('pending');
  });

  test('getSteeringActions returns all actions', () => {
    submitSteeringAction(testDir, 'run-1', {
      run_id: 'run-1', action_type: 'pause_run', scope: 'run', payload: {}, requested_by: 'cli',
    });
    submitSteeringAction(testDir, 'run-1', {
      run_id: 'run-1', action_type: 'resume_run', scope: 'run', payload: {}, requested_by: 'human',
    });
    expect(getSteeringActions(testDir, 'run-1').length).toBe(2);
  });

  test('getPendingSteeringActions filters by status', () => {
    submitSteeringAction(testDir, 'run-1', {
      run_id: 'run-1', action_type: 'pause_run', scope: 'run', payload: {}, requested_by: 'cli',
    });
    submitSteeringAction(testDir, 'run-1', {
      run_id: 'run-1', action_type: 'resume_run', scope: 'run', payload: {}, requested_by: 'human',
    });
    // Mark first as applied
    const actions = getSteeringActions(testDir, 'run-1');
    updateSteeringStatus(testDir, 'run-1', actions[0].action_id, 'applied', 'done');
    expect(getPendingSteeringActions(testDir, 'run-1').length).toBe(1);
  });

  test('updateSteeringStatus changes status', () => {
    const action = submitSteeringAction(testDir, 'run-1', {
      run_id: 'run-1', action_type: 'pause_run', scope: 'run', payload: {}, requested_by: 'cli',
    });
    const ok = updateSteeringStatus(testDir, 'run-1', action.action_id, 'rejected', 'not allowed');
    expect(ok).toBe(true);
    const updated = getSteeringActions(testDir, 'run-1')[0];
    expect(updated.status).toBe('rejected');
    expect(updated.outcome).toBe('not allowed');
    expect(updated.applied_at).toBeDefined();
  });

  test('updateSteeringStatus returns false for unknown action', () => {
    const ok = updateSteeringStatus(testDir, 'run-1', 'steer-nonexistent', 'applied');
    expect(ok).toBe(false);
  });

  test('isDuplicateAction detects recent duplicates', () => {
    submitSteeringAction(testDir, 'run-1', {
      run_id: 'run-1', action_type: 'retry_task', scope: 'task',
      payload: {}, requested_by: 'cli', task_id: 'task-a',
    });
    expect(isDuplicateAction(testDir, 'run-1', 'retry_task', 'task-a')).toBe(true);
  });

  test('isDuplicateAction returns false for different action type', () => {
    submitSteeringAction(testDir, 'run-1', {
      run_id: 'run-1', action_type: 'retry_task', scope: 'task',
      payload: {}, requested_by: 'cli', task_id: 'task-a',
    });
    expect(isDuplicateAction(testDir, 'run-1', 'skip_task', 'task-a')).toBe(false);
  });

  test('isDuplicateAction returns false for different task', () => {
    submitSteeringAction(testDir, 'run-1', {
      run_id: 'run-1', action_type: 'retry_task', scope: 'task',
      payload: {}, requested_by: 'cli', task_id: 'task-a',
    });
    expect(isDuplicateAction(testDir, 'run-1', 'retry_task', 'task-b')).toBe(false);
  });

  test('isDuplicateAction returns false for run-level actions with no task', () => {
    submitSteeringAction(testDir, 'run-1', {
      run_id: 'run-1', action_type: 'pause_run', scope: 'run',
      payload: {}, requested_by: 'cli',
    });
    expect(isDuplicateAction(testDir, 'run-1', 'pause_run')).toBe(true);
    expect(isDuplicateAction(testDir, 'run-1', 'pause_run', 'task-a')).toBe(false);
  });

  test('isDuplicateAction excludes current action_id (self-duplicate bug fix)', () => {
    const action = submitSteeringAction(testDir, 'run-1', {
      run_id: 'run-1', action_type: 'pause_run', scope: 'run',
      payload: {}, requested_by: 'cli',
    });
    // Without excludeActionId: would return true (the action matches itself)
    expect(isDuplicateAction(testDir, 'run-1', 'pause_run', undefined, 30_000)).toBe(true);
    // With excludeActionId: should return false (the action excludes itself)
    expect(isDuplicateAction(testDir, 'run-1', 'pause_run', undefined, 30_000, action.action_id)).toBe(false);
  });

  test('isDuplicateAction still catches real duplicates when excluding current', () => {
    submitSteeringAction(testDir, 'run-1', {
      run_id: 'run-1', action_type: 'pause_run', scope: 'run',
      payload: {}, requested_by: 'cli',
    });
    const action2 = submitSteeringAction(testDir, 'run-1', {
      run_id: 'run-1', action_type: 'pause_run', scope: 'run',
      payload: {}, requested_by: 'cli',
    });
    // Excluding action2, action1 still matches → true
    expect(isDuplicateAction(testDir, 'run-1', 'pause_run', undefined, 30_000, action2.action_id)).toBe(true);
  });
});
