import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RunSpec,
  RunState,
  TaskPlan,
  SubTask,
  WorkerResult,
  ReviewResult,
  VerificationResult,
  PolicyHook,
} from '../orchestrator/types.js';

// ── Mock external boundaries only ──────────────────────────────────────
// Core control flow (Phase 4 decision matrix, merge gating, state transitions)
// runs REAL against these mocked external surfaces.

vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: '',
    stderr: null,
    error: null,
  })),
}));

vi.mock('../orchestrator/planner-runner.js', () => ({
  planGoal: vi.fn(),
}));

vi.mock('../orchestrator/dispatcher.js', () => ({
  dispatchBatch: vi.fn(),
  spawnWorker: vi.fn(),
}));

vi.mock('../orchestrator/reviewer.js', () => ({
  runReview: vi.fn(),
}));

vi.mock('../orchestrator/verifier.js', () => ({
  runVerification: vi.fn(),
  runVerificationSuite: vi.fn(() => []),
  allRequiredChecksPassed: vi.fn((results: VerificationResult[]) =>
    results.every((r: VerificationResult) => !r.target.must_pass || r.passed),
  ),
}));

vi.mock('../orchestrator/worktree-manager.js', () => ({
  commitAndMergeWorktree: vi.fn((_worktreePath: string, branch: string) => {
    const taskId = branch.replace('worker-', '');
    return { merged: true, branch, taskId };
  }),
}));

vi.mock('../orchestrator/recovery-room-handler.js', () => ({
  maybeRunRecoveryAdvisory: vi.fn((opts: any) =>
    Promise.resolve({ findings: opts.reviewResult.findings }),
  ),
}));

vi.mock('../orchestrator/review-room-handler.js', () => ({
  maybeRunExternalReviewSlot: vi.fn((opts: any) => Promise.resolve(opts.reviewResult)),
}));

vi.mock('../orchestrator/run-store.js', () => ({
  saveRunState: vi.fn(),
  saveRunResult: vi.fn(),
  saveRunSpec: vi.fn(),
  saveRunPlan: vi.fn(),
  loadRunPlan: vi.fn(),
  loadRunResult: vi.fn(() => null),
  loadRunSpec: vi.fn(() => null),
  loadRunState: vi.fn(() => null),
}));

vi.mock('../orchestrator/hive-config.js', () => ({
  getBudgetStatus: vi.fn(() => null),
  loadConfig: vi.fn(() => ({})),
  recordSpending: vi.fn(() => null),
}));

vi.mock('../orchestrator/loop-progress-store.js', () => ({
  writeLoopProgress: vi.fn(),
}));

vi.mock('../orchestrator/worker-status-store.js', () => ({
  updateWorkerStatus: vi.fn(),
  loadWorkerStatusSnapshot: vi.fn(() => null),
}));

vi.mock('../orchestrator/project-policy.js', () => ({
  loadProjectVerificationPolicy: vi.fn(() => ({
    hooks: [
      {
        stage: 'pre_merge',
        label: 'pre-merge-build',
        command: 'true',
        must_pass: false,
      },
    ],
  })),
  loadTaskVerificationRules: vi.fn(() => ({})),
}));

vi.mock('../orchestrator/advisory-score.js', () => ({
  saveAdvisoryScoreSignals: vi.fn(),
}));

vi.mock('../orchestrator/model-registry.js', () => {
  class ModelRegistry {
    get(_id: string) {
      return {
        id: 'test-model',
        provider: 'test-provider',
        display_name: 'Test Model',
        coding: 0.8,
        tool_use_reliability: 0.8,
        reasoning: 0.8,
        chinese: 0.8,
        pass_rate: 0.9,
        avg_iterations: 1.5,
        total_tasks_completed: 100,
        last_updated: new Date().toISOString(),
        context_window: 32000,
        cost_per_mtok_input: 0.5,
        cost_per_mtok_output: 1.5,
        max_complexity: 'high' as const,
        sweet_spot: ['api', 'tests'],
        avoid: [],
      };
    }
    getClaudeTier(_tier: string) {
      return { cost_per_1k: 0.003 };
    }
  }
  return { ModelRegistry };
});

// ── Import after mocks ─────────────────────────────────────────────────
import { executeRun } from '../orchestrator/driver.js';
import { dispatchBatch, spawnWorker } from '../orchestrator/dispatcher.js';
import { runReview } from '../orchestrator/reviewer.js';
import { runVerification, runVerificationSuite } from '../orchestrator/verifier.js';
import { commitAndMergeWorktree } from '../orchestrator/worktree-manager.js';
import { loadRunPlan, loadRunResult } from '../orchestrator/run-store.js';
import { loadProjectVerificationPolicy } from '../orchestrator/project-policy.js';
import { spawnSync } from 'child_process';

// ── Helpers ────────────────────────────────────────────────────────────

const makeTask = (id: string): SubTask => ({
  id,
  description: `Task ${id}`,
  category: 'api',
  complexity: 'medium',
  estimated_files: [`src/${id}.ts`],
  depends_on: [],
  assigned_model: 'test-model',
  assignment_reason: 'test',
  discuss_threshold: 0.7,
  review_scale: 'medium',
  acceptance_criteria: ['Code compiles', 'Tests pass'],
});

const makeWorkerResult = (taskId: string, success: boolean): WorkerResult => ({
  taskId,
  model: 'test-model',
  worktreePath: `/tmp/worktree-${taskId}`,
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

const mockPlan: TaskPlan = {
  id: 'plan-test',
  goal: 'Test repair flow',
  cwd: '/tmp/test',
  tasks: [makeTask('task-a')],
  execution_order: [['task-a']],
  context_flow: {},
  created_at: new Date().toISOString(),
};

const makeSpec = (overrides: Partial<RunSpec> = {}): RunSpec => ({
  id: 'run-repair-integration',
  goal: 'Test repair flow',
  cwd: '/tmp/test',
  mode: 'safe',
  done_conditions: [{
    type: 'build',
    label: 'build check',
    command: 'npm run build',
    must_pass: true,
    scope: 'worktree',
  }],
  max_rounds: 3,
  max_worker_retries: 2,
  max_replans: 1,
  allow_auto_merge: true,
  stop_on_high_risk: false,
  created_at: new Date().toISOString(),
  ...overrides,
});

/** Create initial RunState matching what createInitialRunState produces. */
const makeInitialState = (spec: RunSpec, overrides: Partial<RunState> = {}): RunState => ({
  run_id: spec.id,
  status: 'planning' as const,
  round: 0,
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
  next_action: { kind: 'execute' as const, reason: 'Initial', task_ids: [] },
  updated_at: new Date().toISOString(),
  ...overrides,
});

// Smoke verification result helpers
const smokePass = (): VerificationResult => ({
  target: {
    type: 'build',
    label: 'build check',
    command: 'npm run build',
    must_pass: true,
    scope: 'worktree',
  },
  passed: true,
  exit_code: 0,
  stdout_tail: '',
  stderr_tail: '',
  duration_ms: 100,
});

const smokeFail = (): VerificationResult => ({
  target: {
    type: 'build',
    label: 'build check',
    command: 'npm run build',
    must_pass: true,
    scope: 'worktree',
  },
  passed: false,
  exit_code: 1,
  stdout_tail: '',
  stderr_tail: 'Build failed',
  duration_ms: 100,
  failure_class: 'build_fail',
});

/**
 * Helper: mock runVerification with explicit sequence.
 *
 * Only smokeVerifyWorktree calls runVerification — runVerificationSuite
 * is fully mocked (returns []) and never delegates to runVerification.
 * Each entry maps to one runVerification call:
 *   R1 fresh execute smoke → R2 repair smoke → R3 repair smoke → ...
 */
function mockVerificationSequence(...results: VerificationResult[]) {
  const mock = vi.mocked(runVerification);
  mock.mockReset();
  results.forEach((result) => {
    mock.mockReturnValueOnce(result);
  });
}

/** Helper: mock runReview with explicit per-round sequence. */
function mockReviewSequence(...results: ReviewResult[]) {
  const mock = vi.mocked(runReview);
  mock.mockReset();
  results.forEach((result) => {
    mock.mockResolvedValueOnce(result);
  });
}

/** Setup common mock defaults that every test needs. */
function setupCommonMocks() {
  vi.mocked(dispatchBatch).mockResolvedValue({
    worker_results: [makeWorkerResult('task-a', true)],
    extra_stage_usages: [],
  });
  vi.mocked(spawnWorker).mockResolvedValue(makeWorkerResult('task-a', true));
  vi.mocked(runVerificationSuite).mockReturnValue([]);
  // Pre-merge hook passes (must_pass: false means it can't block anyway)
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '', error: null } as any);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('executeRun() repair flow integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Plan is pre-loaded (skip planning phase)
    vi.mocked(loadRunPlan).mockReturnValue(mockPlan);
    vi.mocked(loadRunResult).mockReturnValue(null);
    setupCommonMocks();
  });

  it('fresh execute + smoke fail → repair_task (Phase 4 decision)', async () => {
    const spec = makeSpec({ max_rounds: 2 });

    // R1: smoke fails → repair_task
    // R2: repair → re-smoke still fails → request_human (post-loop override)
    mockVerificationSequence(
      smokeFail(), // R1 smoke
      smokeFail(), // R2 repair smoke
    );
    mockReviewSequence(
      makeReviewResult('task-a', true), // R1 review pass
      makeReviewResult('task-a', true), // R2 repair review (smoke still fails → request_human via post-loop)
    );

    const initialState = makeInitialState(spec);
    const { state } = await executeRun(spec, initialState);

    // Phase 4 detected smoke failure → repair_task
    // After R2 repair (re-smoke still fails) and max_rounds=2 → post-loop override to request_human
    expect(state._smokeResults?.['task-a']).toBe(false);
    expect(state.status).toBe('partial');
    expect(state.next_action?.kind).toBe('request_human');
  });

  it('review passed + smoke failed → repair → re-smoke pass → merge (critical path)', async () => {
    const spec = makeSpec({ max_rounds: 2 });

    // The real-world scenario: worker produces good code (review passes)
    // but build check fails (smoke). Repair round fixes the build issue.
    // Before the bugfix, the R1 passing review was kept alongside the R2
    // repair review → duplicate for same task → overlap_conflict blocked merge.
    // After the bugfix, repaired task IDs always get fresh review results.
    mockVerificationSequence(
      smokeFail(), // R1 smoke fails
      smokePass(), // R2 repair smoke passes
    );
    mockReviewSequence(
      makeReviewResult('task-a', true), // R1 review PASS
      makeReviewResult('task-a', true), // R2 repair review PASS
    );

    const initialState = makeInitialState(spec);
    const { state } = await executeRun(spec, initialState);

    // Repair succeeded, re-smoke passed, review passed, merge happened → finalize
    expect(state.next_action?.kind).toBe('finalize');
    expect(state.merged_task_ids).toContain('task-a');
    expect(state._smokeResults?.['task-a']).toBe(true);
    expect(commitAndMergeWorktree).toHaveBeenCalledTimes(1);
  });

  it('repair + re-smoke fails → merge blocked → request_human', async () => {
    const spec = makeSpec({ max_rounds: 2 });

    // R1: smoke fail + review FAIL → repair_task
    // R2: repair smoke FAIL → merge blocked → request_human
    mockVerificationSequence(
      smokeFail(), // R1 smoke
      smokeFail(), // R2 repair smoke — still broken
    );
    mockReviewSequence(
      makeReviewResult('task-a', false), // R1 review FAIL → filtered out
      makeReviewResult('task-a', true),  // R2 repair review pass (but smoke failed)
    );

    const initialState = makeInitialState(spec);
    const { state } = await executeRun(spec, initialState);

    // Re-smoke failed → mergePassedTasks blocks (smokeResults[taskId] === false)
    // Phase 4: allReviewsPassed=true, allSmokeChecksPassed=false → repair_task
    // max_rounds=2 reached, loop exits → post-loop: request_human
    expect(state.merged_task_ids).not.toContain('task-a');
    expect(state.status).toBe('partial');
    expect(state._smokeResults?.['task-a']).toBe(false);
    expect(state.next_action?.kind).toBe('request_human');
  });

  it('repair review also fails → retry → merge on second repair pass', async () => {
    const spec = makeSpec({ max_rounds: 3, max_worker_retries: 2 });

    // R1: smoke fail + review FAIL → repair_task
    // R2: repair smoke pass + repair review FAIL → repair_task
    // R3: repair smoke pass + repair review pass → merge → finalize
    mockVerificationSequence(
      smokeFail(), // R1 smoke
      smokePass(), // R2 repair smoke
      smokePass(), // R3 repair smoke
    );
    mockReviewSequence(
      makeReviewResult('task-a', false), // R1 review FAIL → filtered out
      makeReviewResult('task-a', false), // R2 repair review FAIL
      makeReviewResult('task-a', true),  // R3 repair review pass
    );

    const initialState = makeInitialState(spec);
    const { state } = await executeRun(spec, initialState);

    // Round 3: repair → re-smoke pass → review pass → merge → finalize
    expect(state.next_action?.kind).toBe('finalize');
    expect(state.merged_task_ids).toContain('task-a');
    // Two repair history entries: one failed, one fixed
    expect(state.repair_history.length).toBeGreaterThanOrEqual(2);
  });

  it('merge gating blocks when allow_auto_merge is false', async () => {
    const spec = makeSpec({ max_rounds: 2, allow_auto_merge: false });

    mockVerificationSequence(
      smokeFail(), // R1 smoke
      smokePass(), // R2 repair smoke
    );
    mockReviewSequence(
      makeReviewResult('task-a', false),
      makeReviewResult('task-a', true),
    );

    const initialState = makeInitialState(spec);
    const { state } = await executeRun(spec, initialState);

    // Even though review + re-smoke pass, allow_auto_merge=false blocks merge
    expect(state.merged_task_ids).not.toContain('task-a');
    // Phase 4 sees all gates pass → finalize anyway
    expect(state.next_action?.kind).toBe('finalize');
  });

  it('commitAndMergeWorktree is called only when merge gating allows it', async () => {
    const spec = makeSpec({ max_rounds: 2 });

    mockVerificationSequence(
      smokeFail(), // R1 smoke
      smokePass(), // R2 repair smoke
    );
    mockReviewSequence(
      makeReviewResult('task-a', false),
      makeReviewResult('task-a', true),
    );

    const initialState = makeInitialState(spec);
    await executeRun(spec, initialState);

    // commitAndMergeWorktree should be called once for the repair round merge
    // (fresh execute round doesn't merge because smoke failed)
    expect(commitAndMergeWorktree).toHaveBeenCalledTimes(1);
  });

  it('pre-merge hook with must_pass=true blocks merge and triggers request_human', async () => {
    const spec = makeSpec({ max_rounds: 2 });

    // Override policy mock to return a blocking pre-merge hook
    vi.mocked(loadProjectVerificationPolicy).mockReturnValue({
      hooks: [
        {
          stage: 'pre_merge',
          label: 'blocking-check',
          command: 'false',
          must_pass: true,
        },
      ],
    });

    // Pre-merge hook returns non-zero exit
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: 'hook failed', error: null } as any);

    mockVerificationSequence(
      smokeFail(), // R1 smoke
      smokePass(), // R2 repair smoke
    );
    mockReviewSequence(
      makeReviewResult('task-a', false),
      makeReviewResult('task-a', true),
    );

    const initialState = makeInitialState(spec);
    const { state } = await executeRun(spec, initialState);

    // Merge blocked by hook_failed → task not merged
    expect(state.merged_task_ids).not.toContain('task-a');
    // Hook failure blocks merge → Phase 4 falls to otherMergeBlocked path → request_human
    expect(state.next_action?.kind).toBe('request_human');
  });

  it('max_rounds escalation preserves scope_violation context for human follow-up', async () => {
    const spec = makeSpec({ max_rounds: 1 });

    vi.mocked(dispatchBatch).mockResolvedValue({
      worker_results: [{
        ...makeWorkerResult('task-a', true),
        changedFiles: ['src/task-a.ts', 'src/unexpected.ts'],
      }],
      extra_stage_usages: [],
    });

    mockVerificationSequence(smokePass());
    mockReviewSequence(makeReviewResult('task-a', true));

    const initialState = makeInitialState(spec);
    const { state } = await executeRun(spec, initialState);

    expect(state.task_states['task-a']?.status).toBe('merge_blocked');
    expect(state.next_action?.kind).toBe('request_human');
    expect(state.next_action?.task_ids).toEqual(['task-a']);
    expect(state.next_action?.reason).toContain('pending repair_task');
    expect(state.next_action?.reason).toContain('changed files outside estimated_files');
  });
});
