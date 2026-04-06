import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RunSpec,
  RunState,
  TaskPlan,
  SubTask,
  WorkerResult,
  ReviewResult,
} from '../orchestrator/types.js';
import { mergePassedTasks } from '../orchestrator/driver.js';

// Mock worktree-manager to isolate merge logic from git operations
vi.mock('../orchestrator/worktree-manager.js', () => ({
  commitAndMergeWorktree: vi.fn((_worktreePath: string, branch: string) => {
    const taskId = branch.replace('worker-', '');
    return { merged: true, branch, taskId };
  }),
}));

describe('repair → re-smoke → merge flow simulation', () => {
  const makeTask = (id: string): SubTask => ({
    id,
    description: `Task ${id}`,
    category: 'api',
    complexity: 'medium',
    estimated_files: [`src/${id}.ts`],
    depends_on: [],
    assigned_model: 'qwen3.5-plus',
    assignment_reason: 'test',
    discuss_threshold: 0.7,
    review_scale: 'medium',
    acceptance_criteria: ['Code compiles', 'Tests pass'],
  });

  const makeWorkerResult = (taskId: string, success: boolean, worktreePath?: string): WorkerResult => ({
    taskId,
    model: 'qwen3.5-plus',
    worktreePath: worktreePath || `/tmp/worktree-${taskId}`,
    branch: `worker-${taskId}`,
    sessionId: `session-${taskId}`,
    output: [],
    changedFiles: [`src/${taskId}.ts`],
    success,
    duration_ms: 500,
    token_usage: { input: 100, output: 50 },
    discuss_triggered: false,
    discuss_results: [],
  });

  const makeReviewResult = (taskId: string, passed: boolean): ReviewResult => ({
    taskId,
    final_stage: 'cross-review',
    passed,
    findings: passed ? [] : [{
      id: 1,
      severity: 'red',
      lens: 'cross-review',
      file: `src/${taskId}.ts`,
      issue: 'Test failure',
      decision: 'flag',
    }],
    iterations: 1,
    duration_ms: 100,
  });

  const makeMockSpec = (): RunSpec => ({
    id: 'run-repair-test',
    goal: 'Test repair flow',
    cwd: '/tmp/test',
    mode: 'safe',
    done_conditions: [{ type: 'build', command: 'npm run build', scope: 'worktree' }],
    max_rounds: 3,
    max_worker_retries: 2,
    max_replans: 1,
    allow_auto_merge: true,
    stop_on_high_risk: false,
    created_at: new Date().toISOString(),
  });

  const makeMockPlan = (): TaskPlan => ({
    id: 'plan-repair-test',
    goal: 'Test repair flow',
    cwd: '/tmp/test',
    tasks: [makeTask('task-a')],
    execution_order: [['task-a']],
    context_flow: {},
    created_at: new Date().toISOString(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mergePassedTasks gating logic (what executeRun uses)', () => {
    it('allows merge when smoke passes', () => {
      const mockSpec = makeMockSpec();
      const mockPlan = makeMockPlan();
      const workerResults = [makeWorkerResult('task-a', true)];
      const reviewResults = [makeReviewResult('task-a', true)];

      // Simulates: after repair, re-smoke passed
      const smokeResults = { 'task-a': true };

      const merged = mergePassedTasks(
        mockSpec, mockPlan, workerResults, reviewResults,
        smokeResults, [], [], 1
      );

      expect(merged).toContain('task-a');
    });

    it('blocks merge when smoke fails (even if review passed)', () => {
      const mockSpec = makeMockSpec();
      const mockPlan = makeMockPlan();
      const workerResults = [makeWorkerResult('task-a', true)];
      const reviewResults = [makeReviewResult('task-a', true)];

      // Simulates: after repair, re-smoke still fails
      const smokeResults = { 'task-a': false };

      const merged = mergePassedTasks(
        mockSpec, mockPlan, workerResults, reviewResults,
        smokeResults, [], [], 1
      );

      expect(merged).not.toContain('task-a');
    });

    it('allows merge when no smoke ran (backward compat)', () => {
      const mockSpec = makeMockSpec();
      const mockPlan = makeMockPlan();
      const workerResults = [makeWorkerResult('task-a', true)];
      const reviewResults = [makeReviewResult('task-a', true)];

      // No smoke verification configured
      const smokeResults = {};

      const merged = mergePassedTasks(
        mockSpec, mockPlan, workerResults, reviewResults,
        smokeResults, [], [], 1
      );

      expect(merged).toContain('task-a');
    });

    it('blocks merge when review fails (regardless of smoke)', () => {
      const mockSpec = makeMockSpec();
      const mockPlan = makeMockPlan();
      const workerResults = [makeWorkerResult('task-a', true)];
      const reviewResults = [makeReviewResult('task-a', false)]; // Review failed

      // Even with smoke passing
      const smokeResults = { 'task-a': true };

      const merged = mergePassedTasks(
        mockSpec, mockPlan, workerResults, reviewResults,
        smokeResults, [], [], 1
      );

      expect(merged).not.toContain('task-a');
    });
  });

  describe('Phase 4 decision logic simulation', () => {
    it('all smoke pass + all reviews pass → can finalize', () => {
      const reviewResults = [makeReviewResult('task-a', true)];

      // Simulates: refreshed smoke state after repair
      const refreshedSmokePass = { 'task-a': true };

      // This is the logic from driver.ts Phase 4
      const allReviewsPassed = reviewResults.every(r => r.passed);
      const smokeFailedTaskIds = Object.entries(refreshedSmokePass)
        .filter(([, passed]) => passed === false)
        .map(([taskId]) => taskId);
      const allSmokeChecksPassed = smokeFailedTaskIds.length === 0;

      expect(allReviewsPassed).toBe(true);
      expect(allSmokeChecksPassed).toBe(true);
      // In real executeRun, this leads to: status='done', next_action='finalize'
    });

    it('smoke fails → needs repair (even if reviews pass)', () => {
      const reviewResults = [makeReviewResult('task-a', true)];

      // Simulates: refreshed smoke state still failing after repair
      const refreshedSmokeFail = { 'task-a': false };

      const allReviewsPassed = reviewResults.every(r => r.passed);
      const smokeFailedTaskIds = Object.entries(refreshedSmokeFail)
        .filter(([, passed]) => passed === false)
        .map(([taskId]) => taskId);
      const allSmokeChecksPassed = smokeFailedTaskIds.length === 0;

      expect(allReviewsPassed).toBe(true);
      expect(allSmokeChecksPassed).toBe(false);
      expect(smokeFailedTaskIds).toContain('task-a');
      // In real executeRun, this leads to: status='partial', next_action='repair_task'
    });
  });

  describe('Type safety verification', () => {
    it('RunState._smokeResults typed access works without as any', () => {
      const state: RunState = {
        run_id: 'test',
        status: 'running',
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
        _smokeResults: { 'task-a': true, 'task-b': false },
      };

      // Typed access - no 'as any' needed
      expect(state._smokeResults['task-a']).toBe(true);
      expect(state._smokeResults['task-b']).toBe(false);

      // Can update without type casting
      state._smokeResults = { ...state._smokeResults, 'task-c': true };
      expect(state._smokeResults['task-c']).toBe(true);
    });
  });
});
