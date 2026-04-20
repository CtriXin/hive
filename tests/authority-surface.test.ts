// tests/authority-surface.test.ts — Authority degradation CLI visibility tests
// Covers: degraded authority appears in high-priority areas of summary/watch/compact.

import { describe, it, expect } from 'vitest';
import {
  extractAuthorityDegradation,
  formatAuthorityDegradation,
} from '../orchestrator/authority-surface.js';
import { generateRunSummary } from '../orchestrator/operator-summary.js';
import { formatWatch } from '../orchestrator/watch-format.js';
import type { WatchData } from '../orchestrator/watch-loader.js';
import type { RunSpec, RunState, ReviewResult } from '../orchestrator/types.js';

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

function baseWatchData(): WatchData {
  return {
    run_id: 'run-test-001',
    status: 'executing',
    round: 2,
    max_rounds: 6,
    phase: 'executing',
    mode: { current_mode: 'execute-standard', escalated: false, escalation_history: [] },
    focus_task: 'task-a',
    focus_agent: 'worker-1',
    focus_summary: 'Implement auth middleware',
    latest_reason: 'execute: Dispatching tasks',
    steering: { is_paused: false, pending_count: 0, recent_actions: [] },
    provider: { total: 0, healthy: 0, degraded: 0, open: 0, probing: 0, any_unhealthy: false, details: [] },
    updated_at: '2026-04-11T10:00:00.000Z',
    artifacts_available: ['spec', 'state'],
    artifacts_missing: [],
    taskCues: [],
  };
}

describe('authority-surface', () => {
  describe('extractAuthorityDegradation', () => {
    it('returns no degradation when no review results', () => {
      const result = extractAuthorityDegradation(null);
      expect(result.has_degradation).toBe(false);
    });

    it('returns no degradation when review has no authority', () => {
      const results: ReviewResult[] = [{
        taskId: 'task-a', final_stage: 'light', passed: true, findings: [],
        iterations: 1, duration_ms: 1,
      }];
      const result = extractAuthorityDegradation(results);
      expect(result.has_degradation).toBe(false);
    });

    it('detects pair-to-single degradation', () => {
      const results: ReviewResult[] = [{
        taskId: 'task-a', final_stage: 'light', passed: true, findings: [],
        iterations: 1, duration_ms: 1,
        authority: {
          source: 'authority-layer', mode: 'single', members: ['model-a'],
          reviewer_runtime_failures: [
            { model: 'kimi-k2.5', reason: 'bridge_unavailable', error_hint: 'bridge not available' },
          ],
        },
      }];
      const result = extractAuthorityDegradation(results);
      expect(result.has_degradation).toBe(true);
      expect(result.degradation?.kind).toBe('pair_to_single');
      expect(result.degradation?.failed_reviewers[0].model).toBe('kimi-k2.5');
    });

    it('detects all_candidates_failed (high severity)', () => {
      const results: ReviewResult[] = [{
        taskId: 'task-a', final_stage: 'light', passed: false, findings: [],
        iterations: 0, duration_ms: 1,
        authority: {
          source: 'authority-layer', mode: 'single', members: [],
          reviewer_runtime_failures: [
            { model: 'kimi-k2.5', reason: 'bridge_unavailable' },
            { model: 'MiniMax-M2.5', reason: 'missing_env' },
          ],
        },
      }];
      const result = extractAuthorityDegradation(results);
      expect(result.has_degradation).toBe(true);
      expect(result.degradation?.kind).toBe('all_candidates_failed');
      expect(result.degradation?.severity).toBe('high');
    });

    it('detects reviewer_failed_retried in pair mode', () => {
      const results: ReviewResult[] = [{
        taskId: 'task-a', final_stage: 'light', passed: true, findings: [],
        iterations: 1, duration_ms: 1,
        authority: {
          source: 'authority-layer', mode: 'pair', members: ['model-a', 'model-b'],
          reviewer_runtime_failures: [
            { model: 'kimi-k2.5', reason: 'reviewer_timeout' },
          ],
        },
      }];
      const result = extractAuthorityDegradation(results);
      expect(result.has_degradation).toBe(true);
      expect(result.degradation?.kind).toBe('reviewer_failed_retried');
    });
  });

  describe('formatAuthorityDegradation', () => {
    it('formats degradation signal for CLI', () => {
      const lines = formatAuthorityDegradation({
        kind: 'pair_to_single',
        severity: 'medium',
        description: 'Review degraded: pair → single (kimi-k2.5 failed)',
        failed_reviewers: [
          { model: 'kimi-k2.5', reason: 'bridge_unavailable', error_hint: 'bridge not available' },
        ],
        actual_mode: 'single',
      });
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toContain('AUTHORITY');
      expect(lines[0]).toContain('pair');
      expect(lines[1]).toContain('kimi-k2.5');
    });
  });

  describe('authority in operator summary', () => {
    it('exposes authority_degradation in run summary', () => {
      const spec = createMockSpec();
      const state = createMockState();
      const reviewResults: ReviewResult[] = [{
        taskId: 'task-a', final_stage: 'light', passed: true, findings: [],
        iterations: 1, duration_ms: 1,
        authority: {
          source: 'authority-layer', mode: 'single', members: ['claude-sonnet-4-6'],
          reviewer_runtime_failures: [
            { model: 'kimi-k2.5', reason: 'bridge_unavailable', error_hint: 'bridge not reachable' },
          ],
        },
      }];

      const summary = generateRunSummary({
        runId: spec.id, spec, state, reviewResults,
      });

      expect(summary.authority_degradation).toBeDefined();
      expect(summary.authority_degradation?.kind).toBe('pair_to_single');
    });

    it('includes authority hint in next_action_hints', () => {
      const spec = createMockSpec();
      const state = createMockState();
      const reviewResults: ReviewResult[] = [{
        taskId: 'task-a', final_stage: 'light', passed: false, findings: [],
        iterations: 0, duration_ms: 1,
        authority: {
          source: 'authority-layer', mode: 'single', members: [],
          reviewer_runtime_failures: [
            { model: 'kimi-k2.5', reason: 'missing_env' },
          ],
        },
      }];

      const summary = generateRunSummary({
        runId: spec.id, spec, state, reviewResults,
      });

      const authHint = summary.next_action_hints.find(
        (h) => h.description.includes('All reviewer candidates failed'),
      );
      expect(authHint).toBeDefined();
      expect(authHint?.priority).toBe('high');
    });
  });

  describe('authority in watch output', () => {
    it('shows Authority section when degradation present', () => {
      const reviewResults: ReviewResult[] = [{
        taskId: 'task-a', final_stage: 'light', passed: true, findings: [],
        iterations: 1, duration_ms: 1,
        authority: {
          source: 'authority-layer', mode: 'single', members: ['model-a'],
          reviewer_runtime_failures: [
            { model: 'kimi-k2.5', reason: 'bridge_unavailable' },
          ],
        },
      }];

      const output = formatWatch(baseWatchData(), undefined, { reviewResults });
      expect(output).toContain('Authority');
      expect(output).toContain('kimi-k2.5');
      expect(output).toContain('bridge_unavailable');
    });

    it('does not show Authority section when healthy', () => {
      const reviewResults: ReviewResult[] = [{
        taskId: 'task-a', final_stage: 'light', passed: true, findings: [],
        iterations: 1, duration_ms: 1,
        authority: {
          source: 'authority-layer', mode: 'pair', members: ['model-a', 'model-b'],
        },
      }];

      const output = formatWatch(baseWatchData(), undefined, { reviewResults });
      expect(output).not.toContain('Authority');
    });
  });
});
