import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunSpec, RunState } from '../orchestrator/types.js';

const {
  writeLoopProgressMock,
  planGoalMock,
} = vi.hoisted(() => ({
  writeLoopProgressMock: vi.fn(),
  planGoalMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: '',
    stderr: null,
    error: null,
  })),
}));

vi.mock('../orchestrator/planner-runner.js', () => ({
  planGoal: planGoalMock,
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
  allRequiredChecksPassed: vi.fn(() => true),
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
      planner: { model: 'gpt-5.4', fallback: 'glm-5-turbo' },
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
  writeLoopProgress: writeLoopProgressMock,
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

const makeSpec = (): RunSpec => ({
  id: 'run-heartbeat-test',
  goal: 'Design a new dashboard widget',
  cwd: '/tmp/test',
  mode: 'safe',
  done_conditions: [],
  max_rounds: 1,
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

describe('progress heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits planning heartbeat while planner is still running', async () => {
    planGoalMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              plan: null,
              translation: null,
              planner_model: 'gpt-5.4',
              planner_stage_usage: null,
              extra_stage_usages: [],
              planner_raw_output: '',
              planner_error: 'planner stub timeout',
              planner_diagnostics: null,
              plan_discuss: null,
              discuss_diag: null,
              plan_discuss_room: null,
              plan_discuss_collab: null,
              budget_warning: null,
            });
          }, 16_000);
        }),
    );

    const spec = makeSpec();
    const initialState = makeInitialState(spec);

    const executionPromise = executeRun(spec, initialState);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(
      writeLoopProgressMock.mock.calls.some((call) =>
        String(call?.[2]?.reason || '').includes('still running 15s'),
      ),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    const { state } = await executionPromise;
    expect(state.status).toBe('blocked');
  });
});
