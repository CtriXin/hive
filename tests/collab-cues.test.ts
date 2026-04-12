// tests/collab-cues.test.ts — Phase 10A: Task-Level Collaboration Cues
import { describe, it, expect } from 'vitest';
import {
  deriveCueForTask,
  deriveTaskCues,
  groupCuesByCategory,
  cueIcon,
  cueLabel,
  type CollaborationCue,
} from '../orchestrator/collab-cues.js';
import type { TaskRunRecord, SteeringAction, RunState, ProviderHealthStoreData } from '../orchestrator/types.js';

function makeTask(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
  return {
    task_id: 'task-a',
    status: 'pending',
    round: 1,
    changed_files: [],
    merged: false,
    worker_success: false,
    review_passed: false,
    retry_count: 0,
    ...overrides,
  };
}

function makeSteering(overrides: Partial<SteeringAction> = {}): SteeringAction {
  return {
    action_id: 'steer-1',
    run_id: 'run-1',
    action_type: 'mark_requires_human',
    scope: 'task',
    payload: { task_id: 'task-a' },
    requested_by: 'cli',
    requested_at: '2026-04-12T00:00:00Z',
    status: 'pending',
    ...overrides,
  };
}

describe('deriveCueForTask', () => {
  it('merged task → ready', () => {
    const cue = deriveCueForTask(makeTask({ status: 'merged' }));
    expect(cue.cue).toBe('ready');
    expect(cue.reason).toContain('merged');
  });

  it('verified task → ready', () => {
    const cue = deriveCueForTask(makeTask({ status: 'verified' }));
    expect(cue.cue).toBe('ready');
  });

  it('superseded task → passive', () => {
    const cue = deriveCueForTask(makeTask({ status: 'superseded' }));
    expect(cue.cue).toBe('passive');
  });

  it('review_failed task → needs_review', () => {
    const cue = deriveCueForTask(makeTask({ status: 'review_failed' }));
    expect(cue.cue).toBe('needs_review');
  });

  it('pending task with pending steering → needs_human', () => {
    const cue = deriveCueForTask(makeTask({ status: 'pending' }), {
      pendingSteeringForTask: ['steer-1'],
    });
    expect(cue.cue).toBe('needs_human');
    expect(cue.evidence).toContain('steering:steer-1');
  });

  it('pending task with human request → needs_human', () => {
    const cue = deriveCueForTask(makeTask({ status: 'pending' }), {
      hasPendingHumanRequest: true,
    });
    expect(cue.cue).toBe('needs_human');
    expect(cue.evidence).toContain('next_action:request_human');
  });

  it('provider open + pending task → blocked', () => {
    const cue = deriveCueForTask(makeTask({ status: 'pending' }), {
      hasOpenProvider: true,
    });
    expect(cue.cue).toBe('blocked');
    expect(cue.evidence).toContain('provider:open');
  });

  it('merge_blocked → blocked', () => {
    const cue = deriveCueForTask(makeTask({
      status: 'merge_blocked',
      last_error: 'conflict on schema.ts',
    }));
    expect(cue.cue).toBe('blocked');
    expect(cue.reason).toContain('conflict');
  });

  it('worker_failed with <2 retries → watch', () => {
    const cue = deriveCueForTask(makeTask({
      status: 'worker_failed',
      retry_count: 1,
    }));
    expect(cue.cue).toBe('watch');
  });

  it('worker_failed with >=2 retries + review findings → needs_review', () => {
    const cue = deriveCueForTask(makeTask({
      status: 'worker_failed',
      retry_count: 2,
    }), { reviewFindingsCount: 3 });
    expect(cue.cue).toBe('needs_review');
  });

  it('pending task → watch', () => {
    const cue = deriveCueForTask(makeTask({ status: 'pending' }));
    expect(cue.cue).toBe('watch');
  });

  it('verification_failed with >=2 retries → blocked', () => {
    const cue = deriveCueForTask(makeTask({
      status: 'verification_failed',
      retry_count: 2,
    }));
    expect(cue.cue).toBe('blocked');
  });

  it('worker_failed with 0 retries → watch', () => {
    const cue = deriveCueForTask(makeTask({
      status: 'worker_failed',
      retry_count: 0,
    }));
    expect(cue.cue).toBe('watch');
  });

  it('evidence is explainable', () => {
    const cue = deriveCueForTask(makeTask({
      status: 'review_failed',
      retry_count: 2,
    }));
    expect(cue.evidence.length).toBeGreaterThan(0);
    expect(cue.reason.length).toBeGreaterThan(0);
  });
});

describe('deriveTaskCues', () => {
  it('empty task states → empty array', () => {
    const cues = deriveTaskCues({ taskStates: undefined });
    expect(cues).toEqual([]);
  });

  it('single merged task → ready', () => {
    const cues = deriveTaskCues({
      taskStates: { 'task-a': makeTask({ task_id: 'task-a', status: 'merged' }) },
    });
    expect(cues.length).toBe(1);
    expect(cues[0].cue).toBe('ready');
  });

  it('provider open + pending task → blocked', () => {
    const providerHealth: ProviderHealthStoreData = {
      providers: {
        'provider-a': {
          breaker: 'open',
          last_failure_subtype: 'rate_limit',
          consecutive_failures: 3,
          cycle_failures: 3,
          last_failure_at: Date.now(),
          last_success_at: Date.now() - 60000,
          probe_count: 0,
        },
      },
      decisions: [],
      updated_at: new Date().toISOString(),
    };

    const cues = deriveTaskCues({
      taskStates: { 'task-a': makeTask({ task_id: 'task-a', status: 'pending' }) },
      providerHealth,
    });
    expect(cues[0].cue).toBe('blocked');
  });

  it('steering pending for task → needs_human', () => {
    const steeringActions = [makeSteering({ task_id: 'task-a' })];
    const cues = deriveTaskCues({
      taskStates: { 'task-a': makeTask({ task_id: 'task-a', status: 'pending' }) },
      steeringActions,
    });
    expect(cues[0].cue).toBe('needs_human');
  });

  it('next_action request_human with task_ids → needs_human', () => {
    const nextAction: RunState['next_action'] = {
      kind: 'request_human',
      reason: 'needs API key configuration',
      task_ids: ['task-a'],
    };
    const cues = deriveTaskCues({
      taskStates: { 'task-a': makeTask({ task_id: 'task-a', status: 'pending' }) },
      nextAction,
    });
    expect(cues[0].cue).toBe('needs_human');
  });
});

describe('groupCuesByCategory', () => {
  it('groups cues correctly', () => {
    const cues = [
      { task_id: 'task-a', cue: 'needs_review' as CollaborationCue, reason: 'review failed', evidence: ['status:review_failed'] },
      { task_id: 'task-b', cue: 'ready' as CollaborationCue, reason: 'merged', evidence: ['status:merged'] },
      { task_id: 'task-c', cue: 'blocked' as CollaborationCue, reason: 'provider open', evidence: ['provider:open'] },
      { task_id: 'task-d', cue: 'needs_review' as CollaborationCue, reason: 'review findings', evidence: ['review_findings:2'] },
    ];

    const groups = groupCuesByCategory(cues);
    expect(groups.needs_review.length).toBe(2);
    expect(groups.ready.length).toBe(1);
    expect(groups.blocked.length).toBe(1);
    expect(groups.needs_human.length).toBe(0);
    expect(groups.watch.length).toBe(0);
    expect(groups.passive.length).toBe(0);
  });
});

describe('cueIcon and cueLabel', () => {
  const cues: CollaborationCue[] = ['needs_review', 'needs_human', 'blocked', 'watch', 'ready', 'passive'];

  it('icon is non-empty for all cues', () => {
    for (const cue of cues) {
      expect(cueIcon(cue).length).toBeGreaterThan(0);
    }
  });

  it('label is non-empty for all cues', () => {
    for (const cue of cues) {
      expect(cueLabel(cue).length).toBeGreaterThan(0);
    }
  });

  it('icons are distinct', () => {
    const icons = cues.map(cueIcon);
    const unique = new Set(icons);
    expect(unique.size).toBe(cues.length);
  });
});
