import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerResult, ReviewResult, RunSpec, TaskPlan, SubTask, PolicyHookResult } from '../orchestrator/types.js';

// Mock worktree-manager module BEFORE importing driver
const mockMergeResult = { merged: false };
vi.mock('../orchestrator/worktree-manager.js', () => ({
  commitAndMergeWorktree: vi.fn(() => mockMergeResult),
}));

// Spy on spawnSync so runPolicyHooks doesn't actually exec
vi.spyOn(require('child_process'), 'spawnSync').mockReturnValue({
  status: 0, error: undefined, stderr: '', stdout: '',
} as any);

import { mergePassedTasks } from '../orchestrator/driver.js';

describe('repair merge smoke gating', () => {
  let mockSpec: RunSpec;
  let mockPlan: TaskPlan;
  let mockWorkerResults: WorkerResult[];
  let noOpHooks: PolicyHookResult[];

  beforeEach(() => {
    mockMergeResult.merged = false;
    mockWorkerResults = [];
    noOpHooks = [];

    mockSpec = {
      id: 'run-001',
      goal: 'test',
      cwd: '/tmp/test',
      mode: 'safe',
      done_conditions: [],
      max_rounds: 3,
      max_worker_retries: 2,
      max_replans: 1,
      allow_auto_merge: true,
      stop_on_high_risk: true,
      created_at: new Date().toISOString(),
    };

    const taskA: SubTask = {
      id: 'task-a', description: 'task a', category: 'api', complexity: 'medium',
      estimated_files: [], depends_on: [], assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test', discuss_threshold: 0.7, review_scale: 'medium',
    };
    const taskB: SubTask = {
      id: 'task-b', description: 'task b', category: 'api', complexity: 'medium',
      estimated_files: [], depends_on: [], assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test', discuss_threshold: 0.7, review_scale: 'medium',
    };
    const taskC: SubTask = {
      id: 'task-c', description: 'task c', category: 'api', complexity: 'medium',
      estimated_files: [], depends_on: [], assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test', discuss_threshold: 0.7, review_scale: 'medium',
    };

    mockPlan = {
      id: 'plan-1', goal: 'test plan', cwd: '/tmp/test',
      tasks: [taskA, taskB, taskC],
      execution_order: [['task-a', 'task-b'], ['task-c']],
      context_flow: {},
      created_at: new Date().toISOString(),
    };

    const makeWorker = (taskId: string): WorkerResult => ({
      taskId,
      model: 'qwen3.5-plus',
      worktreePath: `/tmp/worktree-${taskId}`,
      branch: `worker-${taskId}`,
      sessionId: `session-${taskId}`,
      output: [],
      changedFiles: [`${taskId}.ts`],
      success: true,
      duration_ms: 500,
      token_usage: { input: 100, output: 50 },
      discuss_triggered: false,
      discuss_results: [],
    });

    mockWorkerResults = [makeWorker('task-a'), makeWorker('task-b'), makeWorker('task-c')];
  });

  // Smoke gating: review.passed && smokeResults !== false
  // repair path refreshes _smokeResults with real re-smoke results, then calls mergePassedTasks

  it('blocks merge when review passes but smoke fails (smokeResults=false)', () => {
    const smokeResults: Record<string, boolean> = { 'task-a': false };
    const reviews: ReviewResult[] = [
      { taskId: 'task-a', final_stage: 'cross-review', passed: true, findings: [], iterations: 1, duration_ms: 100 },
    ];

    const merged = mergePassedTasks(
      mockSpec, mockPlan, mockWorkerResults, reviews, smokeResults,
      [], noOpHooks, 1,
    );

    expect(merged).toHaveLength(0);
  });

  it('allows merge when review passes and smoke passes', () => {
    mockMergeResult.merged = true;
    const smokeResults: Record<string, boolean> = { 'task-a': true };
    const reviews: ReviewResult[] = [
      { taskId: 'task-a', final_stage: 'cross-review', passed: true, findings: [], iterations: 1, duration_ms: 100 },
    ];

    const merged = mergePassedTasks(
      mockSpec, mockPlan, mockWorkerResults, reviews, smokeResults,
      [], noOpHooks, 1,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe('task-a');
  });

  it('allows merge when review passes and no smoke ran (undefined)', () => {
    mockMergeResult.merged = true;
    const smokeResults: Record<string, boolean> = {};
    const reviews: ReviewResult[] = [
      { taskId: 'task-b', final_stage: 'cross-review', passed: true, findings: [], iterations: 1, duration_ms: 100 },
    ];

    const merged = mergePassedTasks(
      mockSpec, mockPlan, mockWorkerResults, reviews, smokeResults,
      [], noOpHooks, 1,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe('task-b');
  });

  it('blocks merge when review fails regardless of smoke', () => {
    const smokeResults: Record<string, boolean> = { 'task-c': true };
    const reviews: ReviewResult[] = [
      {
        taskId: 'task-c', final_stage: 'cross-review', passed: false,
        findings: [{ id: 1, severity: 'red', lens: 'cross-review', file: 'src/a.ts', issue: 'bug', decision: 'flag' }],
        iterations: 1, duration_ms: 100,
      },
    ];

    const merged = mergePassedTasks(
      mockSpec, mockPlan, mockWorkerResults, reviews, smokeResults,
      [], noOpHooks, 1,
    );

    expect(merged).toHaveLength(0);
  });

  it('merges only smoke-passing task in mixed repair batch — smoke-fail task is blocked even if review passes', () => {
    // task-a: repair → re-smoke passes (true) → review passes → MERGE
    // task-b: repair → re-smoke fails (false) → review passes → NO MERGE
    mockMergeResult.merged = true;
    const smokeResults: Record<string, boolean> = { 'task-a': true, 'task-b': false };
    const reviews: ReviewResult[] = [
      { taskId: 'task-a', final_stage: 'cross-review', passed: true, findings: [], iterations: 1, duration_ms: 100 },
      { taskId: 'task-b', final_stage: 'cross-review', passed: true, findings: [], iterations: 1, duration_ms: 100 },
    ];

    const merged = mergePassedTasks(
      mockSpec, mockPlan, mockWorkerResults, reviews, smokeResults,
      [], noOpHooks, 1,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe('task-a');
    // task-b is blocked by smoke failure even though review passed
  });

  it('merge gating uses refreshed smokeResults from real re-smoke after repair', () => {
    // Simulates what happens in driver.ts after repair:
    // 1. old smokeResults had task-a=false (original failure)
    // 2. repair re-smokes and gets task-a=true (repair succeeded)
    // 3. _smokeResults is refreshed with { task-a: true }
    // 4. mergePassedTasks uses the refreshed state

    // After repair: re-smoke passes — this is what gets written to _smokeResults
    mockMergeResult.merged = true;
    const refreshedSmokeResults: Record<string, boolean> = { 'task-a': true };
    const reviews: ReviewResult[] = [
      { taskId: 'task-a', final_stage: 'cross-review', passed: true, findings: [], iterations: 1, duration_ms: 100 },
    ];

    const merged = mergePassedTasks(
      mockSpec, mockPlan, mockWorkerResults, reviews, refreshedSmokeResults,
      [], noOpHooks, 2,
    );

    // With refreshed smoke=true, task-a should now merge
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe('task-a');

    // If we had used the old smoke state (false), merge would be blocked
    const oldSmokeResults: Record<string, boolean> = { 'task-a': false };
    const blocked = mergePassedTasks(
      mockSpec, mockPlan, mockWorkerResults, reviews, oldSmokeResults,
      [], noOpHooks, 1,
    );
    expect(blocked).toHaveLength(0);
  });

  it('allows auto_merge=false to disable all merging', () => {
    mockMergeResult.merged = true;
    const disabledSpec = { ...mockSpec, allow_auto_merge: false };
    const smokeResults: Record<string, boolean> = { 'task-a': true };
    const reviews: ReviewResult[] = [
      { taskId: 'task-a', final_stage: 'cross-review', passed: true, findings: [], iterations: 1, duration_ms: 100 },
    ];

    const merged = mergePassedTasks(
      disabledSpec, mockPlan, mockWorkerResults, reviews, smokeResults,
      [], noOpHooks, 1,
    );

    expect(merged).toHaveLength(0);
  });
});
