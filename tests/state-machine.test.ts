// ═══════════════════════════════════════════════════════════════════
// tests/state-machine.test.ts — Phase 2A: State Machine Tests
// ═══════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  createRunSpec,
  createInitialRunState,
  setTerminalState,
} from '../orchestrator/driver.js';
import {
  FailureClassifier,
} from '../orchestrator/failure-classifier.js';
import type { RunStatus, TaskRunStatus, FailureClass } from '../orchestrator/types.js';

describe('Phase 2A: State Machine', () => {
  describe('RunStatus transitions', () => {
    it('should start in init state', () => {
      const spec = createRunSpec({
        goal: 'Test goal',
        cwd: '/tmp/test',
      });
      const state = createInitialRunState(spec);
      expect(state.status).toBe('init');
    });

    it('should allow valid terminal states', () => {
      const spec = createRunSpec({
        goal: 'Test goal',
        cwd: '/tmp/test',
      });
      const state = createInitialRunState(spec);

      // Simulate terminal state transition
      state.status = 'done';
      state.terminal_reason = 'all_gates_passed';

      expect(state.status).toBe('done');
      expect(state.terminal_reason).toBe('all_gates_passed');
    });

    it('should track terminal reason for blocked state', () => {
      const spec = createRunSpec({
        goal: 'Test goal',
        cwd: '/tmp/test',
      });
      const state = createInitialRunState(spec);

      state.status = 'blocked';
      state.terminal_reason = 'planner_failure';

      expect(state.status).toBe('blocked');
      expect(state.terminal_reason).toBe('planner_failure');
    });

    it('should inherit auto-merge from the execution mode contract by default', () => {
      const spec = createRunSpec({
        goal: 'Test goal',
        cwd: '/tmp/test',
        execution_mode: 'auto-execute-small',
      });

      expect(spec.allow_auto_merge).toBe(true);
    });

    it('should still honor an explicit allowAutoMerge override', () => {
      const spec = createRunSpec({
        goal: 'Test goal',
        cwd: '/tmp/test',
        execution_mode: 'auto-execute-small',
        allowAutoMerge: false,
      });

      expect(spec.allow_auto_merge).toBe(false);
    });
  });

  describe('TaskRunStatus transitions', () => {
    it('should classify worker failure correctly', () => {
      const mockWorkerResult = {
        success: false,
        changedFiles: [],
        output: [
          { type: 'error' as const, content: 'API Error: 429 rate limit', timestamp: Date.now() },
        ],
        taskId: 'task-a',
        model: 'test-model',
        worktreePath: '/tmp/test',
        branch: 'test-branch',
        sessionId: 'test-session',
        duration_ms: 1000,
        token_usage: { input: 0, output: 0 },
        discuss_triggered: false,
        discuss_results: [],
      };

      const failureClass = FailureClassifier.classifyWorkerFailure(mockWorkerResult as any);
      expect(failureClass).toBe('provider');
    });

    it('should classify no_op failure correctly', () => {
      const mockWorkerResult = {
        success: true,
        changedFiles: [],
        output: [],
        taskId: 'task-a',
        model: 'test-model',
        worktreePath: '/tmp/test',
        branch: 'test-branch',
        sessionId: 'test-session',
        duration_ms: 1000,
        token_usage: { input: 0, output: 0 },
        discuss_triggered: false,
        discuss_results: [],
      };

      const failureClass = FailureClassifier.classifyWorkerFailure(mockWorkerResult as any);
      expect(failureClass).toBe('no_op');
    });

    it('should classify review failure correctly', () => {
      const mockReviewResult = {
        taskId: 'task-a',
        final_stage: 'cross-review' as const,
        passed: false,
        findings: [
          {
            id: 1,
            severity: 'red' as const,
            lens: 'cross-review',
            file: 'src/index.ts',
            issue: 'Security vulnerability: potential XSS attack',
            decision: 'flag' as const,
          },
        ],
        iterations: 1,
        duration_ms: 1000,
      };

      const failureClass = FailureClassifier.classifyReviewFailure(mockReviewResult as any);
      expect(failureClass).toBe('review');
    });
  });

  describe('FailureClassifier', () => {
    describe('classifyWorkerFailure', () => {
      it('should return provider for rate limit errors', () => {
        const result = FailureClassifier.classifyWorkerFailure({
          success: false,
          changedFiles: [],
          output: [{ type: 'error', content: 'API Error: 429 rate limit exceeded', timestamp: 0 }],
        } as any);
        expect(result).toBe('provider');
      });

      it('should return tool for tool misuse', () => {
        const result = FailureClassifier.classifyWorkerFailure({
          success: false,
          changedFiles: [],
          output: [{ type: 'error', content: 'invalid tool: Edit', timestamp: 0 }],
        } as any);
        expect(result).toBe('tool');
      });

      it('should return context for misunderstanding', () => {
        const result = FailureClassifier.classifyWorkerFailure({
          success: false,
          changedFiles: [],
          output: [{ type: 'error', content: 'I misunderstood the task', timestamp: 0 }],
        } as any);
        expect(result).toBe('context');
      });

      it('should return no_op for empty diff', () => {
        const result = FailureClassifier.classifyWorkerFailure({
          success: true,
          changedFiles: [],
          output: [],
        } as any);
        expect(result).toBe('no_op');
      });
    });

    describe('classifyReviewFailure', () => {
      it('should return review for security issues', () => {
        const result = FailureClassifier.classifyReviewFailure({
          passed: false,
          findings: [{ issue: 'Security vulnerability found', severity: 'red', lens: 'cross-review', file: 'x', decision: 'flag', id: 1 }],
        } as any);
        expect(result).toBe('review');
      });

      it('should return context for missing functionality', () => {
        const result = FailureClassifier.classifyReviewFailure({
          passed: false,
          findings: [{ issue: 'Missing implementation', severity: 'red', lens: 'cross-review', file: 'x', decision: 'flag', id: 1 }],
        } as any);
        expect(result).toBe('context');
      });
    });

    describe('classifyVerificationFailure', () => {
      it('should return build for build failures', () => {
        const result = FailureClassifier.classifyVerificationFailure({
          passed: false,
          target: { type: 'build', label: 'npm run build', must_pass: true },
          stderr_tail: 'error TS2345: Argument not found',
          stdout_tail: '',
          exit_code: 1,
          duration_ms: 1000,
        } as any);
        expect(result).toBe('build');
      });

      it('should return test for test failures', () => {
        const result = FailureClassifier.classifyVerificationFailure({
          passed: false,
          target: { type: 'test', label: 'npm test', must_pass: true },
          stderr_tail: '',
          stdout_tail: '1 failing',
          exit_code: 1,
          duration_ms: 1000,
        } as any);
        expect(result).toBe('test');
      });

      it('should return lint for lint failures', () => {
        const result = FailureClassifier.classifyVerificationFailure({
          passed: false,
          target: { type: 'lint', label: 'npm run lint', must_pass: true },
          stderr_tail: '',
          stdout_tail: 'eslint error',
          exit_code: 1,
          duration_ms: 1000,
        } as any);
        expect(result).toBe('lint');
      });
    });

    describe('classifyMergeFailure', () => {
      it('should return scope for scope_violation', () => {
        expect(FailureClassifier.classifyMergeFailure('scope_violation')).toBe('scope');
      });

      it('should return merge for merge_conflict', () => {
        expect(FailureClassifier.classifyMergeFailure('merge_conflict')).toBe('merge');
      });

      it('should return policy for hook_failed', () => {
        expect(FailureClassifier.classifyMergeFailure('hook_failed')).toBe('policy');
      });
    });

    describe('classifyPlannerFailure', () => {
      it('should return provider for API errors', () => {
        expect(FailureClassifier.classifyPlannerFailure('API Error: 500')).toBe('provider');
      });

      it('should return context for misunderstanding', () => {
        expect(FailureClassifier.classifyPlannerFailure('I misunderstood the instructions')).toBe('context');
      });

      it('should return planner for unknown errors', () => {
        expect(FailureClassifier.classifyPlannerFailure('Unknown error')).toBe('planner');
      });
    });

    describe('isFailureRepairable', () => {
      it('should return true for repairable failures', () => {
        const repairable: FailureClass[] = ['context', 'review', 'no_op', 'scope'];
        for (const fc of repairable) {
          expect(FailureClassifier.isFailureRepairable(fc)).toBe(true);
        }
      });

      it('should return false for non-repairable failures', () => {
        expect(FailureClassifier.isFailureRepairable('budget')).toBe(false);
        expect(FailureClassifier.isFailureRepairable('provider')).toBe(false);
      });
    });

    describe('shouldReplanVsRepair', () => {
      it('should return blocked for budget failures', () => {
        expect(FailureClassifier.shouldReplanVsRepair('budget', 0, 2)).toBe('blocked');
      });

      it('should return replan for planner failures', () => {
        expect(FailureClassifier.shouldReplanVsRepair('planner', 0, 2)).toBe('replan');
      });

      it('should return repair for first context failure', () => {
        expect(FailureClassifier.shouldReplanVsRepair('context', 0, 2)).toBe('repair');
      });

      it('should return replan for repeated context failures', () => {
        expect(FailureClassifier.shouldReplanVsRepair('context', 2, 2)).toBe('replan');
      });
    });
  });
});
