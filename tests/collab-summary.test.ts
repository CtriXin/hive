// tests/collab-summary.test.ts — Phase 10A: Run-Level Collaboration Summary
import { describe, it, expect } from 'vitest';
import {
  generateCollaborationSummary,
  formatCollabSummary,
} from '../orchestrator/collab-summary.js';
import type { RunState, RunSpec, SteeringAction, ProviderHealthStoreData } from '../orchestrator/types.js';

function makeTaskState(overrides: Record<string, Partial<import('../orchestrator/types.js').TaskRunRecord>> = {}): Record<string, import('../orchestrator/types.js').TaskRunRecord> {
  const states: Record<string, import('../orchestrator/types.js').TaskRunRecord> = {};
  for (const [id, task] of Object.entries(overrides)) {
    states[id] = {
      task_id: id,
      status: 'pending',
      round: 1,
      changed_files: [],
      merged: false,
      worker_success: false,
      review_passed: false,
      retry_count: 0,
      ...task,
    };
  }
  return states;
}

function makeState(overrides: Partial<RunState> = {}): RunState {
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
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    id: 'run-1',
    goal: 'test goal',
    cwd: '/tmp',
    mode: 'safe',
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

describe('generateCollaborationSummary', () => {
  it('empty state → minimal summary', () => {
    const summary = generateCollaborationSummary({
      runId: 'run-1',
      state: null,
      spec: null,
    });
    expect(summary.run_id).toBe('run-1');
    expect(summary.total_tasks).toBe(0);
    expect(summary.active_cues).toBe(0);
    expect(summary.handoff_ready).toBe(false);
  });

  it('merged tasks → ready cues', () => {
    const summary = generateCollaborationSummary({
      runId: 'run-1',
      state: makeState({
        status: 'done',
        task_states: makeTaskState({
          'task-a': { status: 'merged' },
          'task-b': { status: 'merged' },
        }),
      }),
      spec: makeSpec(),
    });
    expect(summary.cue_distribution.ready).toBe(2);
    expect(summary.active_cues).toBe(0);
    expect(summary.top_attention_items.length).toBe(0);
  });

  it('review_failed task → needs_review in attention', () => {
    const summary = generateCollaborationSummary({
      runId: 'run-1',
      state: makeState({
        status: 'partial',
        task_states: makeTaskState({
          'task-a': { status: 'merged' },
          'task-b': { status: 'review_failed' },
        }),
      }),
      spec: makeSpec(),
    });
    expect(summary.cue_distribution.needs_review).toBe(1);
    expect(summary.active_cues).toBe(1);
    expect(summary.top_attention_items[0].cue).toBe('needs_review');
  });

  it('paused run with pending steering → needs_human + handoff_ready', () => {
    const summary = generateCollaborationSummary({
      runId: 'run-1',
      state: makeState({
        status: 'executing',
        steering: { paused: true, pending_actions: ['steer-1'] },
        task_states: makeTaskState({
          'task-a': { status: 'merged' },
          'task-b': { status: 'pending' },
        }),
      }),
      spec: makeSpec(),
      steeringActions: [
        {
          action_id: 'steer-1',
          run_id: 'run-1',
          action_type: 'pause_run',
          scope: 'run',
          payload: {},
          requested_by: 'cli',
          requested_at: '2026-04-12T00:00:00Z',
          status: 'applied',
        },
      ],
    });
    expect(summary.handoff_ready).toBe(true);
    expect(summary.handoff_notes.some((n) => n.includes('paused'))).toBe(true);
  });

  it('provider open + pending task → blocked_by_provider', () => {
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

    const summary = generateCollaborationSummary({
      runId: 'run-1',
      state: makeState({
        status: 'executing',
        task_states: makeTaskState({
          'task-a': { status: 'pending' },
        }),
      }),
      spec: makeSpec(),
      providerHealth,
    });
    expect(summary.cue_distribution.blocked).toBe(1);
    expect(summary.blocker_categories.some((b) => b.category === 'blocked_by_provider')).toBe(true);
  });

  it('request_human next_action → needs_human', () => {
    const summary = generateCollaborationSummary({
      runId: 'run-1',
      state: makeState({
        status: 'partial',
        next_action: {
          kind: 'request_human',
          reason: 'needs API key',
          task_ids: ['task-a'],
        },
        task_states: makeTaskState({
          'task-a': { status: 'pending' },
        }),
      }),
      spec: makeSpec(),
    });
    expect(summary.cue_distribution.needs_human).toBe(1);
  });

  it('graceful fallback with no artifacts', () => {
    const summary = generateCollaborationSummary({
      runId: 'run-1',
      state: null,
      spec: null,
    });
    expect(summary.total_tasks).toBe(0);
    expect(summary.blocker_categories.length).toBe(0);
    expect(summary.handoff_notes.length).toBe(0);
  });
});

describe('formatCollabSummary', () => {
  it('formats output with cues and handoff info', () => {
    const summary = generateCollaborationSummary({
      runId: 'run-1',
      state: makeState({
        status: 'partial',
        task_states: makeTaskState({
          'task-a': { status: 'merged' },
          'task-b': { status: 'review_failed' },
        }),
      }),
      spec: makeSpec(),
    });

    const output = formatCollabSummary(summary);
    expect(output).toContain('run-1');
    expect(output).toContain('Collaboration Summary');
    expect(output).toContain('[review]');
    expect(output).toContain('[ready]');
    expect(output).toContain('Handoff:');
  });
});
