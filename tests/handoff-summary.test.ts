// tests/handoff-summary.test.ts — Phase 10A: Handoff Surface
import { describe, it, expect } from 'vitest';
import {
  generateHandoffSummary,
  formatHandoffSummary,
} from '../orchestrator/handoff-summary.js';
import type { RunState, RunSpec } from '../orchestrator/types.js';

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

describe('generateHandoffSummary', () => {
  it('contains current truth line', () => {
    const handoff = generateHandoffSummary({
      runId: 'run-1',
      state: makeState({
        status: 'partial',
        round: 2,
        task_states: makeTaskState({
          'task-a': { status: 'merged' },
          'task-b': { status: 'review_failed' },
        }),
      }),
      spec: makeSpec({ execution_mode: 'execute-standard', max_rounds: 6 }),
    });
    expect(handoff.current_truth).toContain('partial');
    expect(handoff.current_truth).toContain('round 2');
    expect(handoff.current_truth).toContain('execute-standard');
  });

  it('top blockers includes review_failed tasks', () => {
    const handoff = generateHandoffSummary({
      runId: 'run-1',
      state: makeState({
        status: 'partial',
        task_states: makeTaskState({
          'task-a': { status: 'review_failed' },
        }),
      }),
      spec: makeSpec(),
    });
    expect(handoff.top_blockers.some((b) => b.task_id === 'task-a')).toBe(true);
  });

  it('top attention limited to 3', () => {
    const taskStates = makeTaskState({
      'task-a': { status: 'review_failed' },
      'task-b': { status: 'worker_failed', retry_count: 1 },
      'task-c': { status: 'pending' },
      'task-d': { status: 'worker_failed', retry_count: 1 },
      'task-e': { status: 'pending' },
    });
    const handoff = generateHandoffSummary({
      runId: 'run-1',
      state: makeState({ status: 'executing', task_states: taskStates }),
      spec: makeSpec(),
    });
    expect(handoff.top_attention.length).toBeLessThanOrEqual(3);
  });

  it('suggested commands includes status', () => {
    const handoff = generateHandoffSummary({
      runId: 'run-1',
      state: makeState({
        status: 'executing',
        task_states: makeTaskState({
          'task-a': { status: 'merged' },
          'task-b': { status: 'review_failed' },
        }),
      }),
      spec: makeSpec(),
    });
    expect(handoff.suggested_commands.some((c) => c.command.includes('hive status'))).toBe(true);
  });

  it('paused run shows resume command', () => {
    const handoff = generateHandoffSummary({
      runId: 'run-1',
      state: makeState({
        status: 'executing',
        steering: { paused: true, pending_actions: ['steer-1'] },
        task_states: makeTaskState({
          'task-a': { status: 'pending' },
        }),
      }),
      spec: makeSpec(),
    });
    expect(handoff.suggested_commands.some((c) => c.command.includes('resume'))).toBe(true);
  });

  it('suggested commands limited to 4', () => {
    const handoff = generateHandoffSummary({
      runId: 'run-1',
      state: makeState({
        status: 'partial',
        steering: { paused: true, pending_actions: ['steer-1'] },
        next_action: { kind: 'request_human', reason: 'needs API key', task_ids: ['task-a'] },
        task_states: makeTaskState({
          'task-a': { status: 'pending' },
          'task-b': { status: 'review_failed' },
        }),
      }),
      spec: makeSpec(),
    });
    expect(handoff.suggested_commands.length).toBeLessThanOrEqual(4);
  });

  it('graceful fallback with no state', () => {
    const handoff = generateHandoffSummary({
      runId: 'run-1',
      state: null,
      spec: null,
    });
    expect(handoff.current_truth).toContain('unknown');
    expect(handoff.top_blockers.length).toBe(0);
    expect(handoff.top_attention.length).toBe(0);
  });

  it('includes provider route and resilience summary when available', () => {
    const handoff = generateHandoffSummary({
      runId: 'run-1',
      state: makeState(),
      spec: makeSpec(),
      reviewResults: [
        {
          taskId: 'task-b',
          final_stage: 'cross-review',
          passed: true,
          findings: [],
          iterations: 1,
          duration_ms: 1,
          requested_model: 'qwen-max',
          requested_provider: 'dashscope',
          actual_model: 'qwen-max',
          actual_provider: 'bailian',
          provider_fallback_used: true,
        },
      ] as any,
      providerHealth: {
        providers: {
          bailian: {
            breaker: 'degraded',
            consecutive_failures: 1,
            cycle_failures: 1,
            last_failure_at: 10,
            last_success_at: 5,
            probe_count: 0,
            last_failure_subtype: 'rate_limit',
          },
        },
        decisions: [
          {
            provider: 'dashscope',
            failure_subtype: 'rate_limit',
            action: 'fallback',
            action_reason: 'channel fallback to bailian',
            dispatch_affected: true,
            fallback_provider: 'bailian',
            backoff_ms: 0,
            attempt: 1,
            timestamp: 10,
          },
        ],
        updated_at: new Date().toISOString(),
      },
    });

    expect(handoff.provider_summary).toContain('1 total');
    expect(handoff.latest_route).toContain('task-b');
    expect(handoff.latest_route).toContain('qwen-max@dashscope -> qwen-max@bailian');
    expect(handoff.latest_resilience).toContain('dashscope | rate_limit -> fallback -> bailian');
  });
});

describe('formatHandoffSummary', () => {
  it('includes all key sections', () => {
    const handoff = generateHandoffSummary({
      runId: 'run-1',
      state: makeState({
        status: 'partial',
        task_states: makeTaskState({
          'task-a': { status: 'review_failed' },
        }),
      }),
      spec: makeSpec(),
    });
    const output = formatHandoffSummary(handoff);
    expect(output).toContain('Handoff');
    expect(output).toContain('Truth:');
    expect(output).toContain('Blockers:');
    expect(output).toContain('Next Commands:');
    expect(output).toContain('Handoff Ready:');
  });

  it('concise output for simple state', () => {
    const handoff = generateHandoffSummary({
      runId: 'run-1',
      state: makeState({
        status: 'done',
        task_states: makeTaskState({
          'task-a': { status: 'merged' },
        }),
      }),
      spec: makeSpec(),
    });
    const output = formatHandoffSummary(handoff);
    const lineCount = output.split('\n').length;
    // Should be short — under 15 lines for a simple done state
    expect(lineCount).toBeLessThan(15);
  });

  it('prints provider route and resilience lines when present', () => {
    const output = formatHandoffSummary({
      run_id: 'run-1',
      current_truth: 'executing | round 1/6 | mode: auto',
      provider_summary: '2 total | 1 healthy | 1 degraded',
      latest_route: 'task-a | gpt-5-mini@openai -> gpt-5-mini@azure [fallback] | server_error',
      latest_resilience: 'openai | server_error -> fallback -> azure | channel fallback to azure',
      top_blockers: [],
      top_attention: [],
      suggested_commands: [],
      handoff_ready: true,
      collab_summary: {
        run_id: 'run-1',
        cue_distribution: {
          needs_review: 0,
          needs_human: 0,
          blocked: 0,
          watch: 0,
          ready: 0,
          passive: 0,
        },
        top_attention_items: [],
        handoff_ready: true,
        handoff_notes: [],
        blocker_categories: [],
        total_tasks: 0,
        active_cues: 0,
      },
    });

    expect(output).toContain('Provider Health: 2 total | 1 healthy | 1 degraded');
    expect(output).toContain('Latest Route: task-a | gpt-5-mini@openai -> gpt-5-mini@azure [fallback] | server_error');
    expect(output).toContain('Latest Resilience: openai | server_error -> fallback -> azure | channel fallback to azure');
  });
});
