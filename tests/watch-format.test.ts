// tests/watch-format.test.ts — Phase 8C: Watch formatter tests

import { describe, it, expect } from 'vitest';
import { formatWatch, formatWatchCompact } from '../orchestrator/watch-format.js';
import type { WatchData } from '../orchestrator/watch-loader.js';

function baseData(): WatchData {
  return {
    run_id: 'run-test-001',
    status: 'executing',
    round: 2,
    max_rounds: 6,
    phase: 'executing',
    phase_reason: 'Dispatching tasks',
    mode: {
      current_mode: 'execute-standard',
      escalated: false,
      escalation_history: [],
    },
    focus_task: 'task-a',
    focus_agent: 'worker-1',
    focus_summary: 'Implement auth middleware',
    latest_reason: 'execute: Dispatching tasks',
    steering: {
      is_paused: false,
      pending_count: 0,
      recent_actions: [],
    },
    provider: {
      total: 0,
      healthy: 0,
      degraded: 0,
      open: 0,
      probing: 0,
      any_unhealthy: false,
      details: [],
    },
    updated_at: '2026-04-11T10:00:00.000Z',
    artifacts_available: ['spec', 'state', 'progress'],
    artifacts_missing: ['provider-health', 'steering'],
    taskCues: [],
  };
}

describe('watch-format', () => {
  describe('formatWatch', () => {
    it('renders basic run info', () => {
      const output = formatWatch(baseData(), '2026-04-11T10:00:00Z');
      expect(output).toContain('run-test-001');
      expect(output).toContain('executing');
      expect(output).toContain('round: 2/6');
    });

    it('renders phase information', () => {
      const output = formatWatch(baseData());
      expect(output).toContain('phase: executing');
      expect(output).toContain('Dispatching tasks');
    });

    it('renders mode with icon', () => {
      const output = formatWatch(baseData());
      expect(output).toContain('mode: execute-standard');
    });

    it('renders focus task', () => {
      const output = formatWatch(baseData());
      expect(output).toContain('focus: task-a');
      expect(output).toContain('worker-1');
    });

    it('shows exact queued_retry progress without reading transcripts', () => {
      const data = baseData();
      data.progress_status = 'queued_retry';
      data.progress_why = 'queued for retry in 5m';
      data.progress_next_action = 'retry_task: Retry after provider cooldown';
      data.handoff = {
        task_id: 'task-a',
        owner: 'task-a@run-test-001',
        model: 'glm-5-turbo',
        refs: ['.ai/plan/handoff.md'],
      };
      const output = formatWatch(data);
      expect(output).toContain('progress: queued_retry');
      expect(output).toContain('why: queued for retry in 5m');
      expect(output).toContain('handoff: task-a | task-a@run-test-001 | glm-5-turbo');
    });

    it('shows exact fallback progress without reading transcripts', () => {
      const data = baseData();
      data.progress_status = 'fallback';
      data.progress_why = 'channel fallback to provider-b';
      const output = formatWatch(data);
      expect(output).toContain('progress: fallback');
      expect(output).toContain('why: channel fallback to provider-b');
    });

    it('shows exact request_human progress without reading transcripts', () => {
      const data = baseData();
      data.progress_status = 'request_human';
      data.progress_why = 'Approve risky change before merge';
      const output = formatWatch(data);
      expect(output).toContain('progress: request_human');
      expect(output).toContain('why: Approve risky change before merge');
    });

    it('shows escalated mode indicator', () => {
      const data = baseData();
      data.mode.escalated = true;
      data.mode.escalation_history = [
        { from: 'auto-execute-small', to: 'execute-parallel', reason: 'high risk', round: 1 },
      ];
      const output = formatWatch(data);
      expect(output).toContain('[ESCALATED]');
    });

    it('shows paused state in steering', () => {
      const data = baseData();
      data.steering.is_paused = true;
      const output = formatWatch(data);
      expect(output).toContain('PAUSED');
    });

    it('shows pending steering count', () => {
      const data = baseData();
      data.steering.pending_count = 3;
      const output = formatWatch(data);
      expect(output).toContain('pending: 3 action(s)');
    });

    it('shows last applied steering', () => {
      const data = baseData();
      data.steering.last_applied = { action_type: 'pause_run', outcome: 'Run paused at safe point', applied_at: Date.now() };
      const output = formatWatch(data);
      expect(output).toContain('applied: pause_run');
    });

    it('shows last rejected steering', () => {
      const data = baseData();
      data.steering.last_rejected = { action_type: 'resume_run', reason: 'Run is not paused', applied_at: Date.now() };
      const output = formatWatch(data);
      expect(output).toContain('rejected: resume_run');
    });

    it('shows provider health summary', () => {
      const data = baseData();
      data.provider = {
        total: 3,
        healthy: 2,
        degraded: 1,
        open: 0,
        probing: 0,
        any_unhealthy: true,
        details: [
          { provider: 'p1', breaker: 'healthy' },
          { provider: 'p2', breaker: 'healthy' },
          { provider: 'p3', breaker: 'degraded', subtype: 'rate_limit' },
        ],
      };
      const output = formatWatch(data);
      expect(output).toContain('3 total');
      expect(output).toContain('2 healthy');
      expect(output).toContain('1 degraded');
      expect(output).toContain('rate_limit');
    });

    it('shows latest provider decision and provider-aware route labels', () => {
      const data = baseData();
      data.provider = {
        total: 2,
        healthy: 1,
        degraded: 1,
        open: 0,
        probing: 0,
        any_unhealthy: true,
        details: [
          { provider: 'openai', breaker: 'healthy' },
          { provider: 'azure', breaker: 'degraded', subtype: 'server_error' },
        ],
        summary_text: '2 total | 1 healthy | 1 degraded',
        latest_decision: 'openai | server_error -> fallback -> azure | channel fallback to azure',
        latest_task_route: {
          task_id: 'task-route',
          requested_model: 'gpt-5-mini',
          requested_provider: 'openai',
          actual_model: 'gpt-5-mini',
          actual_provider: 'azure',
          failure_subtype: 'server_error',
          fallback_used: true,
        },
      };
      const output = formatWatch(data);
      expect(output).toContain('resilience: openai | server_error -> fallback -> azure');
      expect(output).toContain('route: task-route | gpt-5-mini@openai -> gpt-5-mini@azure [fallback] | server_error');
    });

    it('shows mode escalation history section', () => {
      const data = baseData();
      data.mode.escalated = true;
      data.mode.escalation_history = [
        { from: 'auto-execute-small', to: 'execute-parallel', reason: 'high_risk_task', round: 1 },
      ];
      const output = formatWatch(data);
      expect(output).toContain('Mode Escalation');
      expect(output).toContain('auto-execute-small');
      expect(output).toContain('execute-parallel');
    });

    it('does not show missing artifacts section (clean output)', () => {
      const output = formatWatch(baseData());
      expect(output).not.toContain('Missing Artifacts');
    });

    it('omits steering section when no actions', () => {
      const output = formatWatch(baseData());
      expect(output).not.toContain('no steering actions');
    });

    it('omits provider section when total is 0 (clean output)', () => {
      const output = formatWatch(baseData());
      expect(output).not.toContain('no provider health data');
      expect(output).not.toContain('Provider');
    });
  });

  describe('formatWatchCompact', () => {
    it('renders one-line summary', () => {
      const output = formatWatchCompact(baseData());
      expect(output).toContain('run-test-001');
      expect(output).toContain('executing');
      expect(output).toContain('r2');
      expect(output).toContain('execute-standard');
    });

    it('includes paused indicator', () => {
      const data = baseData();
      data.steering.is_paused = true;
      const output = formatWatchCompact(data);
      expect(output).toContain('\u23F8\uFE0F');
    });

    it('includes provider warning', () => {
      const data = baseData();
      data.provider.any_unhealthy = true;
      const output = formatWatchCompact(data);
      expect(output).toContain('provider');
    });

    it('includes escalation indicator', () => {
      const data = baseData();
      data.mode.escalated = true;
      const output = formatWatchCompact(data);
      expect(output).toContain('escalated');
    });

    it('prefers progress status in compact output', () => {
      const data = baseData();
      data.progress_status = 'queued_retry';
      const output = formatWatchCompact(data);
      expect(output).toContain('queued_retry');
    });
  });

  describe('suggested commands', () => {
    it('shows suggested commands for paused state', () => {
      const data = baseData();
      data.status = 'executing';
      data.steering.is_paused = true;
      const output = formatWatch(data);
      expect(output).toContain('Suggested Commands');
      expect(output).toContain('hive resume');
      expect(output).toContain('hive steer');
    });

    it('shows suggested commands for done state', () => {
      const data = baseData();
      data.status = 'done';
      const output = formatWatch(data);
      expect(output).toContain('Suggested Commands');
      expect(output).toContain('hive compact');
    });

    it('omits suggested commands for running state', () => {
      const data = baseData();
      data.status = 'executing';
      const output = formatWatch(data);
      expect(output).not.toContain('Suggested Commands');
    });

    it('includes description in next actions', () => {
      const data = baseData();
      data.status = 'executing';
      data.steering.is_paused = true;
      const output = formatWatch(data);
      expect(output).toContain('Resume the paused run');
    });
  });
});
