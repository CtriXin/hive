// tests/operator-summary.test.ts — Phase 9A: Operator Experience Pack
// Tests for run summary generation from existing artifacts.

import { describe, it, expect } from 'vitest';
import { generateRunSummary } from '../orchestrator/operator-summary.js';
import type { RunSpec, RunState } from '../orchestrator/types.js';

function createMockSpec(overrides?: Partial<RunSpec>): RunSpec {
  return {
    id: 'run-test-123',
    goal: 'Test goal',
    cwd: '/test',
    mode: 'safe',
    execution_mode: 'execute-standard',
    done_conditions: [],
    max_rounds: 6,
    max_worker_retries: 3,
    max_replans: 2,
    allow_auto_merge: true,
    stop_on_high_risk: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function createMockState(overrides?: Partial<RunState>): RunState {
  return {
    run_id: 'run-test-123',
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

describe('generateRunSummary', () => {
  describe('overall state detection', () => {
    it('should detect done state', () => {
      const spec = createMockSpec();
      const state = createMockState({ status: 'done' });
      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
      });
      expect(summary.overall_state).toBe('done');
    });

    it('should detect blocked state', () => {
      const spec = createMockSpec();
      const state = createMockState({ status: 'blocked' });
      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
      });
      expect(summary.overall_state).toBe('blocked');
    });

    it('should detect partial state', () => {
      const spec = createMockSpec();
      const state = createMockState({ status: 'partial' });
      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
      });
      expect(summary.overall_state).toBe('partial');
    });

    it('should detect paused state from steering', () => {
      const spec = createMockSpec();
      const state = createMockState({
        status: 'executing',
        steering: { paused: true, pending_actions: [] },
      });
      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
      });
      expect(summary.overall_state).toBe('paused');
    });

    it('should detect running state', () => {
      const spec = createMockSpec();
      const state = createMockState({ status: 'executing' });
      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
      });
      expect(summary.overall_state).toBe('running');
    });
  });

  describe('success extraction', () => {
    it('should extract top successes (merged tasks)', () => {
      const spec = createMockSpec();
      const state = createMockState({
        task_states: {
          'task-a': {
            task_id: 'task-a',
            status: 'merged',
            round: 1,
            changed_files: ['a.ts'],
            merged: true,
            worker_success: true,
            review_passed: true,
            retry_count: 0,
          } as any,
          'task-b': {
            task_id: 'task-b',
            status: 'verified',
            round: 1,
            changed_files: ['b.ts'],
            merged: false,
            worker_success: true,
            review_passed: true,
            retry_count: 0,
          } as any,
        },
      });
      const plan = {
        tasks: [
          { id: 'task-a', description: 'Task A' },
          { id: 'task-b', description: 'Task B' },
        ],
      };

      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
        plan,
      });

      expect(summary.top_successes.length).toBeGreaterThan(0);
      expect(summary.top_successes[0].task_id).toBe('task-a');
    });

    it('should limit to max 3 successes', () => {
      const spec = createMockSpec();
      const state = createMockState({
        task_states: {
          'task-a': { task_id: 'task-a', status: 'merged', round: 1, changed_files: [], merged: true, worker_success: true, review_passed: true, retry_count: 0 } as any,
          'task-b': { task_id: 'task-b', status: 'merged', round: 1, changed_files: [], merged: true, worker_success: true, review_passed: true, retry_count: 0 } as any,
          'task-c': { task_id: 'task-c', status: 'merged', round: 1, changed_files: [], merged: true, worker_success: true, review_passed: true, retry_count: 0 } as any,
          'task-d': { task_id: 'task-d', status: 'merged', round: 1, changed_files: [], merged: true, worker_success: true, review_passed: true, retry_count: 0 } as any,
          'task-e': { task_id: 'task-e', status: 'merged', round: 1, changed_files: [], merged: true, worker_success: true, review_passed: true, retry_count: 0 } as any,
        },
      });

      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
      });

      expect(summary.top_successes.length).toBeLessThanOrEqual(3);
    });
  });

  describe('failure extraction', () => {
    it('should extract top failures', () => {
      const spec = createMockSpec();
      const state = createMockState({
        task_states: {
          'task-a': {
            task_id: 'task-a',
            status: 'worker_failed',
            round: 1,
            changed_files: [],
            merged: false,
            worker_success: false,
            review_passed: false,
            retry_count: 2,
            last_error: 'Build failed',
            failure_class: 'build',
          } as any,
        },
      });

      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
      });

      expect(summary.top_failures.length).toBeGreaterThan(0);
      expect(summary.top_failures[0].task_id).toBe('task-a');
      expect(summary.top_failures[0].failure_class).toBe('build');
    });

    it('should sort failures by retry count', () => {
      const spec = createMockSpec();
      const state = createMockState({
        task_states: {
          'task-a': { task_id: 'task-a', status: 'worker_failed', round: 1, changed_files: [], merged: false, worker_success: false, review_passed: false, retry_count: 1, last_error: 'Error A' } as any,
          'task-b': { task_id: 'task-b', status: 'worker_failed', round: 1, changed_files: [], merged: false, worker_success: false, review_passed: false, retry_count: 3, last_error: 'Error B' } as any,
          'task-c': { task_id: 'task-c', status: 'worker_failed', round: 1, changed_files: [], merged: false, worker_success: false, review_passed: false, retry_count: 2, last_error: 'Error C' } as any,
        },
      });

      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
      });

      expect(summary.top_failures[0].task_id).toBe('task-b');
      expect(summary.top_failures[1].task_id).toBe('task-c');
      expect(summary.top_failures[2].task_id).toBe('task-a');
    });
  });

  describe('blocker identification', () => {
    it('should identify paused run as blocker', () => {
      const spec = createMockSpec();
      const state = createMockState({
        steering: { paused: true, pending_actions: [] },
      });

      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
      });

      expect(summary.primary_blocker).toBeDefined();
      expect(summary.primary_blocker?.type).toBe('human_input');
    });

    it('should identify budget exhausted as blocker', () => {
      const spec = createMockSpec();
      const state = createMockState({
        budget_status: {
          monthly_limit_usd: 100,
          current_spent_usd: 100,
          remaining_usd: 0,
          remaining_ratio: 0,
          warn_at: 0.8,
          block: true,
          blocked: true,
          warning: 'Budget exceeded',
        },
      });

      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
      });

      expect(summary.primary_blocker).toBeDefined();
      expect(summary.primary_blocker?.type).toBe('budget_exhausted');
    });

    it('should identify human input request as blocker', () => {
      const spec = createMockSpec();
      const state = createMockState({
        next_action: {
          kind: 'request_human',
          reason: 'Need clarification on requirements',
          task_ids: ['task-a'],
        },
      });

      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
      });

      expect(summary.primary_blocker).toBeDefined();
      expect(summary.primary_blocker?.type).toBe('human_input');
    });

    it('should identify task failure as blocker', () => {
      const spec = createMockSpec();
      const state = createMockState({
        task_states: {
          'task-a': {
            task_id: 'task-a',
            status: 'worker_failed',
            round: 1,
            changed_files: [],
            merged: false,
            worker_success: false,
            review_passed: false,
            retry_count: 3,
            last_error: 'Persistent failure',
          } as any,
        },
      });

      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
      });

      expect(summary.primary_blocker).toBeDefined();
      expect(summary.primary_blocker?.type).toBe('task_failure');
    });
  });

  describe('next action hints', () => {
    it('should generate resume hint for paused run', () => {
      const spec = createMockSpec();
      const state = createMockState({
        steering: { paused: true, pending_actions: [] },
      });

      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
      });

      const resumeHint = summary.next_action_hints.find((h) => h.action === 'resume_run');
      expect(resumeHint).toBeDefined();
      expect(resumeHint?.priority).toBe('high');
    });

    it('should generate replan hint for repeated failures', () => {
      const spec = createMockSpec();
      const state = createMockState({
        task_states: {
          'task-a': {
            task_id: 'task-a',
            status: 'worker_failed',
            round: 1,
            changed_files: [],
            merged: false,
            worker_success: false,
            review_passed: false,
            retry_count: 2,
            last_error: 'Failed twice',
          } as any,
        },
      });

      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
      });

      const replanHint = summary.next_action_hints.find((h) => h.action === 'replan');
      expect(replanHint).toBeDefined();
      expect(replanHint?.priority).toBe('high');
    });

    it('should generate stronger mode hint for single failure', () => {
      const spec = createMockSpec();
      const state = createMockState({
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
            last_error: 'Failed once',
          } as any,
        },
      });

      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
      });

      const strongerModeHint = summary.next_action_hints.find((h) => h.action === 'rerun_stronger_mode');
      expect(strongerModeHint).toBeDefined();
      expect(strongerModeHint?.priority).toBe('medium');
    });

    it('should limit to max 3 hints', () => {
      const spec = createMockSpec();
      const state = createMockState({
        steering: { paused: true, pending_actions: ['a', 'b', 'c'] },
        next_action: {
          kind: 'request_human',
          reason: 'Need help',
          task_ids: ['task-a'],
        },
        budget_status: {
          monthly_limit_usd: 100,
          current_spent_usd: 100,
          remaining_usd: 0,
          remaining_ratio: 0,
          warn_at: 0.8,
          block: true,
          blocked: true,
          warning: 'Budget exceeded',
        },
        task_states: {
          'task-a': { task_id: 'task-a', status: 'worker_failed', round: 1, changed_files: [], merged: false, worker_success: false, review_passed: false, retry_count: 2, last_error: 'Error' } as any,
        },
      });

      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
      });

      expect(summary.next_action_hints.length).toBeLessThanOrEqual(3);
    });
  });

  describe('graceful fallback', () => {
    it('should handle null spec and state gracefully', () => {
      const summary = generateRunSummary({
        runId: 'test',
        spec: null,
        state: null,
      });

      expect(summary.overall_state).toBe('blocked');
      expect(summary.round).toBe(0);
    });

    it('should handle missing plan gracefully', () => {
      const spec = createMockSpec();
      const state = createMockState();

      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
        plan: null,
      });

      expect(summary.top_successes).toEqual([]);
      expect(summary.top_failures).toEqual([]);
    });
  });

  describe('provider-facing surface', () => {
    it('surfaces provider summary, latest route, and latest resilience decision', () => {
      const spec = createMockSpec();
      const state = createMockState();
      const providerHealth = {
        providers: {
          kimi: {
            breaker: 'degraded',
            consecutive_failures: 1,
            cycle_failures: 1,
            last_failure_at: 20,
            last_success_at: 10,
            probe_count: 0,
            last_failure_subtype: 'timeout',
          },
        },
        decisions: [
          {
            provider: 'kimi',
            failure_subtype: 'timeout',
            action: 'fallback',
            action_reason: 'channel fallback to kimi-alt',
            dispatch_affected: true,
            fallback_provider: 'kimi-alt',
            backoff_ms: 0,
            attempt: 1,
            timestamp: 20,
          },
        ],
        updated_at: new Date().toISOString(),
      };

      const summary = generateRunSummary({
        runId: spec.id,
        spec,
        state,
        reviewResults: [
          {
            taskId: 'task-z',
            final_stage: 'light',
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
            final_stage: 'light',
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
        ] as any,
        providerHealth,
      });

      expect(summary.provider_summary).toContain('1 total');
      expect(summary.latest_route).toContain('task-a');
      expect(summary.latest_route).toContain('gpt-5-mini@openai -> gpt-5-mini@azure');
      expect(summary.latest_resilience).toContain('kimi | timeout -> fallback -> kimi-alt');
    });
  });
});
