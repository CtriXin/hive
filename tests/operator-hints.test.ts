// tests/operator-hints.test.ts — Phase 9A: Operator Experience Pack
// Tests for operator hint generation from run state.

import { describe, it, expect } from 'vitest';
import { generateOperatorHints } from '../orchestrator/operator-hints.js';
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

describe('generateOperatorHints', () => {
  describe('paused run hints', () => {
    it('should generate resume hint for paused run', () => {
      const spec = createMockSpec();
      const state = createMockState({
        steering: { paused: true, pending_actions: [] },
      });

      const result = generateOperatorHints({ spec, state });

      const resumeHint = result.hints.find((h) => h.action === 'resume_run');
      expect(resumeHint).toBeDefined();
      expect(resumeHint?.priority).toBe('high');
      expect(resumeHint?.description).toContain('Resume');
    });

    it('should generate steering hint for paused run with pending actions', () => {
      const spec = createMockSpec();
      const state = createMockState({
        steering: { paused: true, pending_actions: ['action-1', 'action-2'] },
      });

      const result = generateOperatorHints({ spec, state });

      const steeringHint = result.hints.find((h) => h.action === 'steering_recommended');
      expect(steeringHint).toBeDefined();
    });
  });

  describe('human input hints', () => {
    it('should generate human input hint when request_human is set', () => {
      const spec = createMockSpec();
      const state = createMockState({
        next_action: {
          kind: 'request_human',
          reason: 'Need clarification on API design',
          task_ids: ['task-a', 'task-b'],
        },
      });

      const result = generateOperatorHints({ spec, state });

      const humanHint = result.hints.find((h) => h.action === 'request_human_input');
      expect(humanHint).toBeDefined();
      expect(humanHint?.priority).toBe('high');
      expect(humanHint?.task_id).toBe('task-a');
    });
  });

  describe('provider hints', () => {
    it('should generate provider wait/fallback hint for open circuit breaker', () => {
      const spec = createMockSpec();
      const state = createMockState();
      const providerHealth = {
        providers: {
          'provider-a': {
            breaker: 'open',
            consecutive_failures: 3,
            cycle_failures: 3,
            last_failure_at: Date.now(),
            last_success_at: Date.now() - 100000,
            probe_count: 0,
            last_failure_subtype: 'rate_limit',
            opened_at: Date.now() - 60000,
          },
        },
        decisions: [],
        updated_at: new Date().toISOString(),
      };

      const result = generateOperatorHints({ spec, state, providerHealth });

      const providerHint = result.hints.find((h) => h.action === 'provider_wait_fallback');
      expect(providerHint).toBeDefined();
      expect(providerHint?.priority).toBe('high');
      expect(providerHint?.provider).toBe('provider-a');
    });

    it('should generate degraded provider hint', () => {
      const spec = createMockSpec();
      const state = createMockState();
      const providerHealth = {
        providers: {
          'provider-b': {
            breaker: 'degraded',
            consecutive_failures: 1,
            cycle_failures: 1,
            last_failure_at: Date.now(),
            last_success_at: Date.now() - 10000,
            probe_count: 0,
            last_failure_subtype: 'timeout',
          },
        },
        decisions: [],
        updated_at: new Date().toISOString(),
      };

      const result = generateOperatorHints({ spec, state, providerHealth });

      const providerHint = result.hints.find((h) => h.action === 'provider_wait_fallback');
      expect(providerHint).toBeDefined();
      expect(providerHint?.priority).toBe('medium');
    });
  });

  describe('task failure hints', () => {
    it('should generate replan hint for task with 2+ retries', () => {
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
            last_error: 'Build failed repeatedly',
            failure_class: 'build',
          } as any,
        },
      });

      const result = generateOperatorHints({ spec, state });

      const replanHint = result.hints.find((h) => h.action === 'replan');
      expect(replanHint).toBeDefined();
      expect(replanHint?.priority).toBe('high');
      expect(replanHint?.task_id).toBe('task-a');
    });

    it('should generate stronger mode hint for single retry', () => {
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

      const result = generateOperatorHints({ spec, state });

      const strongerModeHint = result.hints.find((h) => h.action === 'rerun_stronger_mode');
      expect(strongerModeHint).toBeDefined();
      expect(strongerModeHint?.priority).toBe('medium');
    });

    it('should generate inspect forensics hint for first failure', () => {
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
            retry_count: 0,
            last_error: 'First failure',
          } as any,
        },
      });

      const result = generateOperatorHints({ spec, state });

      const forensicsHint = result.hints.find((h) => h.action === 'inspect_forensics');
      expect(forensicsHint).toBeDefined();
      expect(forensicsHint?.priority).toBe('medium');
    });
  });

  describe('budget hints', () => {
    it('should generate budget hint when blocked', () => {
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
          warning: 'Budget limit reached',
        },
      });

      const result = generateOperatorHints({ spec, state });

      const budgetHint = result.hints.find((h) => h.action === 'check_budget');
      expect(budgetHint).toBeDefined();
      expect(budgetHint?.priority).toBe('high');
    });

    it('should generate budget warning hint when ratio low', () => {
      const spec = createMockSpec();
      const state = createMockState({
        budget_status: {
          monthly_limit_usd: 100,
          current_spent_usd: 85,
          remaining_usd: 15,
          remaining_ratio: 0.15,
          warn_at: 0.2,
          block: false,
          blocked: false,
          warning: null,
        },
      });

      const result = generateOperatorHints({ spec, state });

      const budgetHint = result.hints.find((h) => h.action === 'check_budget');
      expect(budgetHint).toBeDefined();
      expect(budgetHint?.priority).toBe('medium');
    });
  });

  describe('repair/replan hints', () => {
    it('should generate retry_later hint for repair_task action', () => {
      const spec = createMockSpec();
      const state = createMockState({
        next_action: {
          kind: 'repair_task',
          reason: 'Repairing failed task task-a',
          task_ids: ['task-a'],
        },
      });

      const result = generateOperatorHints({ spec, state });

      const retryHint = result.hints.find((h) => h.action === 'retry_later');
      expect(retryHint).toBeDefined();
      expect(retryHint?.priority).toBe('medium');
    });

    it('should generate replan hint for replan action', () => {
      const spec = createMockSpec();
      const state = createMockState({
        next_action: {
          kind: 'replan',
          reason: 'Replanning with failure context',
          task_ids: [],
        },
      });

      const result = generateOperatorHints({ spec, state });

      const replanHint = result.hints.find((h) => h.action === 'replan');
      expect(replanHint).toBeDefined();
      expect(replanHint?.priority).toBe('high');
    });
  });

  describe('review hints', () => {
    it('should generate review_findings hint for review failures', () => {
      const spec = createMockSpec();
      const state = createMockState({
        review_failed_task_ids: ['task-a', 'task-b'],
      });

      const result = generateOperatorHints({ spec, state });

      const reviewHint = result.hints.find((h) => h.action === 'review_findings');
      expect(reviewHint).toBeDefined();
      expect(reviewHint?.priority).toBe('high');
      expect(reviewHint?.task_id).toBe('task-a');
    });
  });

  describe('merge hints', () => {
    it('should generate merge_changes hint when done with merged tasks', () => {
      const spec = createMockSpec();
      const state = createMockState({
        status: 'done',
        merged_task_ids: ['task-a', 'task-b'],
        failed_task_ids: [],
      });

      const result = generateOperatorHints({ spec, state });

      const mergeHint = result.hints.find((h) => h.action === 'merge_changes');
      expect(mergeHint).toBeDefined();
      expect(mergeHint?.priority).toBe('low');
    });

    it('should generate partial progress hint when some tasks merged and some failed', () => {
      const spec = createMockSpec();
      const state = createMockState({
        status: 'partial',
        merged_task_ids: ['task-a'],
        failed_task_ids: ['task-b'],
      });

      const result = generateOperatorHints({ spec, state });

      const mergeHint = result.hints.find((h) => h.action === 'merge_changes');
      expect(mergeHint).toBeDefined();
      expect(mergeHint?.priority).toBe('low');
    });
  });

  describe('hint ordering', () => {
    it('should sort hints by priority (high first)', () => {
      const spec = createMockSpec();
      const state = createMockState({
        next_action: { kind: 'replan', reason: 'Replan', task_ids: [] },
        review_failed_task_ids: ['task-a'],
        merged_task_ids: ['task-b'],
        status: 'partial',
      });

      const result = generateOperatorHints({ spec, state });

      expect(result.hints.length).toBeGreaterThan(1);
      const priorities = result.hints.map((h) => h.priority);

      const priorityOrder = { high: 0, medium: 1, low: 2 };
      for (let i = 1; i < priorities.length; i++) {
        expect(priorityOrder[priorities[i]] >= priorityOrder[priorities[i - 1]]).toBe(true);
      }
    });

    it('should limit to max 5 hints', () => {
      const spec = createMockSpec();
      const state = createMockState({
        steering: { paused: true, pending_actions: ['a'] },
        next_action: { kind: 'request_human', reason: 'Help', task_ids: ['task-a'] },
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
        review_failed_task_ids: ['task-b'],
        merged_task_ids: ['task-c'],
      });

      const result = generateOperatorHints({ spec, state });

      expect(result.hints.length).toBeLessThanOrEqual(5);
    });
  });

  describe('top hint selection', () => {
    it('should set top_hint to the first high priority hint', () => {
      const spec = createMockSpec();
      const state = createMockState({
        next_action: { kind: 'request_human', reason: 'Need help', task_ids: ['task-a'] },
      });

      const result = generateOperatorHints({ spec, state });

      expect(result.top_hint).toBeDefined();
      expect(result.top_hint?.priority).toBe('high');
    });

    it('top_hint should match first hint when sorted', () => {
      const spec = createMockSpec();
      const state = createMockState({
        next_action: { kind: 'request_human', reason: 'Help', task_ids: ['task-a'] },
      });

      const result = generateOperatorHints({ spec, state });

      expect(result.top_hint).toBe(result.hints[0]);
    });
  });
});
