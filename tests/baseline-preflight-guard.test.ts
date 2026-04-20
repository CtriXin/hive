import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunSpec, RunState, VerificationResult } from '../orchestrator/types.js';

const { extractAndSaveUserProfileMock } = vi.hoisted(() => ({
  extractAndSaveUserProfileMock: vi.fn(() => Promise.resolve()),
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
  runVerificationSuite: vi.fn(),
  allRequiredChecksPassed: vi.fn((results: VerificationResult[]) =>
    results.every((result) => !result.target.must_pass || result.passed),
  ),
}));

vi.mock('../orchestrator/run-store.js', () => ({
  saveRunState: vi.fn(),
  saveRunResult: vi.fn(),
  saveRunSpec: vi.fn(),
  saveRunPlan: vi.fn(),
  loadRunPlan: vi.fn(() => null),
  loadRunResult: vi.fn(() => null),
  loadRunSpec: vi.fn(() => null),
  loadRunState: vi.fn(() => null),
}));

vi.mock('../orchestrator/hive-config.js', () => ({
  getBudgetStatus: vi.fn(() => null),
  loadConfig: vi.fn(() => ({
    high_tier: 'upper-model',
    default_worker: 'test-model',
    fallback_worker: 'glm-5-turbo',
    tiers: {
      executor: { model: 'test-model', fallback: 'glm-5-turbo' },
    },
  })),
  recordSpending: vi.fn(() => null),
}));

vi.mock('../orchestrator/project-policy.js', () => ({
  loadProjectVerificationPolicy: vi.fn(() => null),
  loadTaskVerificationRules: vi.fn(() => ({})),
}));

vi.mock('../orchestrator/lesson-store.js', () => ({
  loadLessonStore: vi.fn(() => null),
  refreshLessonStore: vi.fn(() => ({ lessons: [] })),
  loadAllTransitionLogs: vi.fn(() => []),
  loadTaskStates: vi.fn(() => ({})),
  extractLessons: vi.fn(() => []),
}));

vi.mock('../orchestrator/project-memory-store.js', () => ({
  initProjectMemory: vi.fn(() => ({})),
  loadProjectMemory: vi.fn(() => ({})),
  saveProjectMemory: vi.fn(),
  refreshMemoryFreshness: vi.fn(),
}));

vi.mock('../orchestrator/memory-extractor.js', () => ({
  extractProjectMemories: vi.fn(),
}));

vi.mock('../orchestrator/loop-progress-store.js', () => ({
  readLoopProgress: vi.fn(() => null),
  writeLoopProgress: vi.fn(),
}));

vi.mock('../orchestrator/worker-status-store.js', () => ({
  updateWorkerStatus: vi.fn(),
  loadWorkerStatusSnapshot: vi.fn(() => null),
}));

vi.mock('../orchestrator/advisory-score.js', () => ({
  saveAdvisoryScoreSignals: vi.fn(),
}));

vi.mock('../orchestrator/score-history.js', () => ({
  saveRoundScore: vi.fn(),
}));

vi.mock('../orchestrator/recovery-room-handler.js', () => ({
  maybeRunRecoveryAdvisory: vi.fn(),
}));

vi.mock('../orchestrator/review-room-handler.js', () => ({
  maybeRunExternalReviewSlot: vi.fn(),
}));

vi.mock('../orchestrator/user-profile-extractor.js', () => ({
  extractAndSaveUserProfile: extractAndSaveUserProfileMock,
}));

vi.mock('../orchestrator/model-registry.js', () => {
  class ModelRegistry {
    get(_id: string) {
      return {
        id: 'test-model',
        provider: 'test-provider',
        cost_per_mtok_input: 0.5,
        cost_per_mtok_output: 1.5,
      };
    }
    getClaudeTier() {
      return { cost_per_1k: 0.003 };
    }
    rankModelsForTask() {
      return [];
    }
  }
  return { ModelRegistry };
});

import { executeRun } from '../orchestrator/driver.js';
import { planGoal } from '../orchestrator/planner-runner.js';
import { dispatchBatch } from '../orchestrator/dispatcher.js';
import { runVerificationSuite } from '../orchestrator/verifier.js';

const buildPass: VerificationResult = {
  target: {
    type: 'build',
    label: 'npm run build',
    command: 'npm run build',
    must_pass: true,
    scope: 'both',
  },
  passed: true,
  exit_code: 0,
  stdout_tail: '',
  stderr_tail: '',
  duration_ms: 100,
};

const buildFail: VerificationResult = {
  ...buildPass,
  passed: false,
  exit_code: 1,
  stderr_tail: 'build failed',
  failure_class: 'build_fail',
};

const makeSpec = (goal: string): RunSpec => ({
  id: 'run-preflight-guard',
  goal,
  cwd: '/tmp/test',
  mode: 'safe',
  done_conditions: [buildPass.target],
  max_rounds: 2,
  max_worker_retries: 1,
  max_replans: 1,
  allow_auto_merge: false,
  stop_on_high_risk: false,
  created_at: new Date().toISOString(),
});

const makeInitialState = (spec: RunSpec): RunState => ({
  run_id: spec.id,
  status: 'init',
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
  next_action: { kind: 'execute', reason: 'Initial', task_ids: [] },
  updated_at: new Date().toISOString(),
});

describe('baseline preflight guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('short-circuits compile-repair goals when build baseline already passes', async () => {
    vi.mocked(runVerificationSuite).mockReturnValue([buildPass]);

    const spec = makeSpec('Pre-Phase 8C Baseline Repair: reviewer.ts Compile Errors');
    const initialState = makeInitialState(spec);
    const { state, plan } = await executeRun(spec, initialState);

    expect(state.status).toBe('done');
    expect(state.next_action?.kind).toBe('finalize');
    expect(state.final_summary).toContain('Preflight satisfied');
    expect(state.verification_results[0]?.passed).toBe(true);
    expect(plan).toBeNull();
    expect(planGoal).not.toHaveBeenCalled();
    expect(dispatchBatch).not.toHaveBeenCalled();
  });

  it('continues into planning when compile baseline is still failing', async () => {
    vi.mocked(runVerificationSuite).mockReturnValue([buildFail]);
    vi.mocked(planGoal).mockResolvedValue({
      plan: null,
      translation: null,
      planner_model: 'glm-5-turbo',
      planner_stage_usage: null,
      extra_stage_usages: [],
      planner_raw_output: '',
      planner_error: 'planner stub',
      planner_diagnostics: null,
      plan_discuss: null,
      discuss_diag: null,
      plan_discuss_room: null,
      plan_discuss_collab: null,
      budget_warning: null,
    });

    const spec = makeSpec('Pre-Phase 8C Baseline Repair: reviewer.ts Compile Errors');
    const initialState = makeInitialState(spec);
    const { state } = await executeRun(spec, initialState);

    expect(planGoal).toHaveBeenCalledOnce();
    expect(state.status).toBe('blocked');
    expect(state.final_summary).toBe('planner stub');
  });

  it('does not short-circuit unrelated goals even when build already passes', async () => {
    vi.mocked(runVerificationSuite).mockReturnValue([buildPass]);
    vi.mocked(planGoal).mockResolvedValue({
      plan: null,
      translation: null,
      planner_model: 'glm-5-turbo',
      planner_stage_usage: null,
      extra_stage_usages: [],
      planner_raw_output: '',
      planner_error: 'planner stub',
      planner_diagnostics: null,
      plan_discuss: null,
      discuss_diag: null,
      plan_discuss_room: null,
      plan_discuss_collab: null,
      budget_warning: null,
    });

    const spec = makeSpec('Add a new dashboard widget for live watch');
    const initialState = makeInitialState(spec);
    const { state } = await executeRun(spec, initialState);

    expect(planGoal).toHaveBeenCalledOnce();
    expect(state.status).toBe('blocked');
  });

  it('fires best-effort user profile extraction on early record-only completion', async () => {
    vi.mocked(runVerificationSuite).mockReturnValue([buildPass]);

    const spec = {
      ...makeSpec('Record the run only'),
      execution_mode: 'record-only' as const,
    };
    const initialState = makeInitialState(spec);

    await executeRun(spec, initialState);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(extractAndSaveUserProfileMock).toHaveBeenCalledTimes(1);
    expect(extractAndSaveUserProfileMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: spec.id,
      goal: spec.goal,
      finalSummary: expect.stringContaining('Record-only'),
      executionMode: 'record-only',
      changedFiles: [],
    }));
  });
});
