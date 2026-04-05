import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRegistry } from '../orchestrator/model-registry.js';
import type { SubTask, TaskPlan, WorkerResult } from '../orchestrator/types.js';

const queryModelTextMock = vi.fn();
const noopUpdateScore = vi.fn();
const defaultAuthorityPolicy = {
  enabled: true,
  default_mode: 'single',
  max_models: 2,
  primary_candidates: ['kimi-k2.5', 'MiniMax-M2.5'],
  fallback_order: ['kimi-k2.5', 'MiniMax-M2.5'],
  escalate_on: ['low_confidence', 'failed_review', 'disagreement'],
  low_confidence_threshold: 0.75,
  timeout_ms: 30000,
  partial_result_policy: 'proceed_if_min_met',
  synthesizer: 'gpt-5.4',
  synthesis_failure_policy: 'fail_closed',
} as const;
let authorityPolicyMock = { ...defaultAuthorityPolicy };

vi.mock('../orchestrator/authority-policy.js', () => ({
  loadReviewAuthorityPolicy: () => authorityPolicyMock,
}));

vi.mock('../orchestrator/hive-config.js', () => ({
  loadConfig: () => ({
    tiers: {
      reviewer: {
        cross_review: { model: 'auto' },
        arbitration: { model: 'auto' },
        final_review: { model: 'auto' },
      },
    },
  }),
  resolveFallback: (modelId: string) => modelId,
  resolveTierModel: (model: string, fallback: () => string) => (model === 'auto' ? fallback() : model),
}));

vi.mock('../orchestrator/review-utils.js', async () => {
  const actual = await vi.importActual<typeof import('../orchestrator/review-utils.js')>(
    '../orchestrator/review-utils.js',
  );
  return {
    ...actual,
    loadReviewPolicy: () => ({
      auto_pass_categories: ['docs', 'comments', 'formatting', 'i18n'],
      cross_review: {
        min_confidence_to_skip: 0.85,
        min_pass_rate_for_skip: 0.9,
        max_complexity_for_skip: 'medium',
      },
      a2a: { max_reject_iterations: 1, contested_threshold: 'CONTESTED' },
      arbitration: { sonnet_max_iterations: 1 },
    }),
    shouldAutoPass: () => false,
    getWorktreeFullDiff: () => 'diff',
    queryModelText: queryModelTextMock,
  };
});

vi.mock('../orchestrator/lesson-extractor.js', () => ({
  extractLessons: () => [],
  updateDisciplineScores: () => undefined,
  persistLessons: () => undefined,
}));

describe('reviewer authority path', () => {
  beforeEach(() => {
    queryModelTextMock.mockReset();
    noopUpdateScore.mockReset();
    authorityPolicyMock = { ...defaultAuthorityPolicy };
    vi.spyOn(ModelRegistry.prototype, 'updateScore').mockImplementation(noopUpdateScore);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns authority pair metadata and synthesis flags', async () => {
    queryModelTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.6,
          flagged_issues: [],
          summary: 'primary review',
        }),
        tokenUsage: { input: 10, output: 5 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: false,
          confidence: 0.82,
          flagged_issues: [
            { severity: 'red', file: 'src/app.ts:10', description: 'must fix' },
          ],
          summary: 'challenger review',
        }),
        tokenUsage: { input: 12, output: 6 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: false,
          rationale: 'blocking issue confirmed',
          final_findings: [
            { severity: 'red', file: 'src/app.ts:10', issue: 'must fix', decision: 'flag' },
          ],
        }),
        tokenUsage: { input: 8, output: 4 },
      });

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-a',
      description: 'Implement authority review',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-a',
      goal: 'test authority',
      tasks: [task],
      execution_order: [['task-a']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-a',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/authority-test',
      branch: 'worker-task-a',
      sessionId: 'worker-task-a',
      output: [],
      changedFiles: ['src/app.ts'],
      success: true,
      duration_ms: 1000,
      token_usage: { input: 20, output: 10 },
      discuss_triggered: false,
      discuss_results: [],
    };

    const result = await runReview(workerResult, task, plan, registry);

    expect(result.authority?.source).toBe('authority-layer');
    expect(result.authority?.mode).toBe('pair');
    expect(result.authority?.members.length).toBe(2);
    expect(result.authority?.synthesized_by).toBe('gpt-5.4');
    expect(result.authority?.synthesis_strategy).toBe('model');
    expect(result.authority?.disagreement_flags).toContain('conclusion_opposite');
    expect(result.passed).toBe(false);
    expect(result.findings.at(-1)?.issue).toContain('gpt-5.4 synthesis');
  });

  it('can tie-break to pass when the higher-confidence reviewer clears the change', async () => {
    queryModelTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: false,
          confidence: 0.52,
          flagged_issues: [
            { severity: 'yellow', file: 'src/app.ts:10', description: 'maybe refactor' },
          ],
          summary: 'primary review',
        }),
        tokenUsage: { input: 10, output: 5 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.9,
          flagged_issues: [],
          summary: 'challenger review',
        }),
        tokenUsage: { input: 12, output: 6 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          rationale: 'higher-confidence pass accepted',
          final_findings: [],
        }),
        tokenUsage: { input: 8, output: 4 },
      });

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-b',
      description: 'Tie-break review',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-b',
      goal: 'test synthesis pass',
      tasks: [task],
      execution_order: [['task-b']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-b',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/authority-test',
      branch: 'worker-task-b',
      sessionId: 'worker-task-b',
      output: [],
      changedFiles: ['src/app.ts'],
      success: true,
      duration_ms: 1000,
      token_usage: { input: 20, output: 10 },
      discuss_triggered: false,
      discuss_results: [],
    };

    const result = await runReview(workerResult, task, plan, registry);

    expect(result.passed).toBe(true);
    expect(result.verdict).toBe('PASS');
    expect(result.authority?.synthesized_by).toBe('gpt-5.4');
    expect(result.authority?.synthesis_strategy).toBe('model');
    expect(result.findings.at(-1)?.issue).toContain('higher-confidence pass accepted');
  });

  it('marks heuristic fallback honestly when synthesis model output is unusable', async () => {
    authorityPolicyMock = {
      ...defaultAuthorityPolicy,
      synthesis_failure_policy: 'heuristic_fallback',
    };
    queryModelTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.61,
          flagged_issues: [],
          summary: 'primary review',
        }),
        tokenUsage: { input: 10, output: 5 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: false,
          confidence: 0.8,
          flagged_issues: [
            { severity: 'red', file: 'src/app.ts:10', description: 'must fix' },
          ],
          summary: 'challenger review',
        }),
        tokenUsage: { input: 12, output: 6 },
      })
      .mockResolvedValueOnce({
        text: 'not-json',
        tokenUsage: { input: 8, output: 4 },
      });

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-c',
      description: 'Fallback review',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-c',
      goal: 'test synthesis fallback',
      tasks: [task],
      execution_order: [['task-c']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-c',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/authority-test',
      branch: 'worker-task-c',
      sessionId: 'worker-task-c',
      output: [],
      changedFiles: ['src/app.ts'],
      success: true,
      duration_ms: 1000,
      token_usage: { input: 20, output: 10 },
      discuss_triggered: false,
      discuss_results: [],
    };

    const result = await runReview(workerResult, task, plan, registry);

    expect(result.passed).toBe(false);
    expect(result.authority?.synthesized_by).toBeUndefined();
    expect(result.authority?.synthesis_strategy).toBe('heuristic');
    expect(result.findings.at(-1)?.issue).toContain('heuristic synthesis');
    expect(result.token_stages?.some((stage) =>
      stage.stage === 'authority-synthesis:task-c'
      && stage.model === 'gpt-5.4'
      && stage.input_tokens === 8
      && stage.output_tokens === 4,
    )).toBe(true);
  });

  it('fails closed when synthesis output is unusable under fail_closed policy', async () => {
    queryModelTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.61,
          flagged_issues: [],
          summary: 'primary review',
        }),
        tokenUsage: { input: 10, output: 5 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: false,
          confidence: 0.8,
          flagged_issues: [
            { severity: 'red', file: 'src/app.ts:10', description: 'must fix' },
          ],
          summary: 'challenger review',
        }),
        tokenUsage: { input: 12, output: 6 },
      })
      .mockResolvedValueOnce({
        text: 'not-json',
        tokenUsage: { input: 8, output: 4 },
      });

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-d',
      description: 'Fail closed review',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-d',
      goal: 'test synthesis fail closed',
      tasks: [task],
      execution_order: [['task-d']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-d',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/authority-test',
      branch: 'worker-task-d',
      sessionId: 'worker-task-d',
      output: [],
      changedFiles: ['src/app.ts'],
      success: true,
      duration_ms: 1000,
      token_usage: { input: 20, output: 10 },
      discuss_triggered: false,
      discuss_results: [],
    };

    const result = await runReview(workerResult, task, plan, registry);

    expect(result.passed).toBe(false);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.authority?.synthesized_by).toBeUndefined();
    expect(result.authority?.synthesis_strategy).toBeUndefined();
    expect(result.authority?.synthesis_attempted_by).toBe('gpt-5.4');
    expect(result.findings[0]?.issue).toContain('fail_closed policy');
    expect(result.findings[0]?.severity).toBe('red');
    expect(result.token_stages?.some((stage) =>
      stage.stage === 'authority-synthesis:task-d'
      && stage.model === 'gpt-5.4'
      && stage.input_tokens === 8
      && stage.output_tokens === 4,
    )).toBe(true);
    expect(noopUpdateScore).not.toHaveBeenCalled();
  });

  it('surfaces deterministic_vs_opinion when smokePassed=false and reviewers say pass', async () => {
    // Integration test: smokeFailed → runReview(smokePassed=false)
    //   → authority pair escalation → synthesis
    //   → disagreement_flags includes 'deterministic_vs_opinion'
    queryModelTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.91,
          flagged_issues: [],
          summary: 'primary: looks fine',
        }),
        tokenUsage: { input: 10, output: 5 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.88,
          flagged_issues: [],
          summary: 'challenger: also looks fine',
        }),
        tokenUsage: { input: 12, output: 6 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: false,
          rationale: 'smoke failed but reviewers passed — deterministic layer overrides',
          final_findings: [
            { severity: 'red', file: '(smoke)', issue: 'deterministic smoke failure overrides reviewer pass', decision: 'flag' },
          ],
        }),
        tokenUsage: { input: 8, output: 4 },
      });

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-e',
      description: 'Deterministic wiring test',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-e',
      goal: 'test deterministic signal wiring end-to-end',
      tasks: [task],
      execution_order: [['task-e']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-e',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/deterministic-test',
      branch: 'worker-task-e',
      sessionId: 'worker-task-e',
      output: [],
      changedFiles: ['src/app.ts'],
      success: true,
      duration_ms: 1000,
      token_usage: { input: 20, output: 10 },
      discuss_triggered: false,
      discuss_results: [],
    };

    // KEY: pass smokePassed=false to simulate smoke failure
    const result = await runReview(workerResult, task, plan, registry, false);

    // Authority pair must be triggered (both reviewers agree pass, but smoke failed)
    expect(result.authority?.source).toBe('authority-layer');
    expect(result.authority?.mode).toBe('pair');
    // The deterministic_vs_opinion flag must appear in disagreement
    expect(result.authority?.disagreement_flags).toContain('deterministic_vs_opinion');
    // Synthesis must happen — model synthesis resolves the conflict
    expect(result.authority?.synthesized_by).toBe('gpt-5.4');
  });

  it('repair path preserves deterministic signal from original smoke failure', async () => {
    // Simulates: original execution had smoke failure → repair re-dispatches worker
    // → runReview called with inherited smokePassed=false
    // → authority must still see deterministic failure
    queryModelTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.92,
          flagged_issues: [],
          summary: 'repair looks good to me',
        }),
        tokenUsage: { input: 10, output: 5 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.87,
          flagged_issues: [],
          summary: 'challenger: repair is acceptable',
        }),
        tokenUsage: { input: 12, output: 6 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: false,
          rationale: 'original smoke failure still overrides — deterministic layer',
          final_findings: [
            { severity: 'red', file: '(smoke)', issue: 'inherited smoke failure persists through repair', decision: 'flag' },
          ],
        }),
        tokenUsage: { input: 8, output: 4 },
      });

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-repair',
      description: 'Repair after smoke failure',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-repair',
      goal: 'test repair-path deterministic preservation',
      tasks: [task],
      execution_order: [['task-repair']],
    };
    // Worker succeeded on repair attempt — but original smoke still failed
    const workerResult: WorkerResult = {
      taskId: 'task-repair',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/repair-test',
      branch: 'worker-task-repair',
      sessionId: 'worker-task-repair',
      output: [],
      changedFiles: ['src/app.ts'],
      success: true,
      duration_ms: 800,
      token_usage: { input: 15, output: 8 },
      discuss_triggered: false,
      discuss_results: [],
    };

    // Simulate what runRepairRound does: pass inherited smoke result
    const result = await runReview(workerResult, task, plan, registry, false);

    // Repair review must still see deterministic failure → escalate to pair
    expect(result.authority?.source).toBe('authority-layer');
    expect(result.authority?.mode).toBe('pair');
    expect(result.authority?.disagreement_flags).toContain('deterministic_vs_opinion');
    // Synthesis must trigger because deterministic overrides reviewer pass
    expect(result.authority?.synthesized_by).toBe('gpt-5.4');
  });

  it('smoke-failed task clears deterministic flag when re-reviewed with smokePassed=true after repair', async () => {
    // Round 1: original execution — smoke failed, both reviewers pass → escalated
    queryModelTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.9,
          flagged_issues: [],
          summary: 'looks ok',
        }),
        tokenUsage: { input: 10, output: 5 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.88,
          flagged_issues: [],
          summary: 'challenger agrees',
        }),
        tokenUsage: { input: 12, output: 6 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: false,
          rationale: 'smoke failed — blocking',
          final_findings: [
            { severity: 'red', file: '(smoke)', issue: 'deterministic failure', decision: 'flag' },
          ],
        }),
        tokenUsage: { input: 8, output: 4 },
      });

    // Round 2: after repair — smoke now passes, single reviewer passes → no escalation
    // (low confidence triggers pair for coverage)
    queryModelTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.61,
          flagged_issues: [],
          summary: 'repaired code looks acceptable',
        }),
        tokenUsage: { input: 10, output: 5 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.9,
          flagged_issues: [],
          summary: 'challenger: repair is solid',
        }),
        tokenUsage: { input: 12, output: 6 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          rationale: 'both reviewers pass, smoke now passes — accept',
          final_findings: [],
        }),
        tokenUsage: { input: 8, output: 4 },
      });

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-recovery',
      description: 'Recovery test',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-recovery',
      goal: 'test smoke recovery after repair',
      tasks: [task],
      execution_order: [['task-recovery']],
    };
    const makeWorker = (): WorkerResult => ({
      taskId: 'task-recovery',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/recovery-test',
      branch: 'worker-task-recovery',
      sessionId: 'worker-task-recovery',
      output: [],
      changedFiles: ['src/app.ts'],
      success: true,
      duration_ms: 800,
      token_usage: { input: 15, output: 8 },
      discuss_triggered: false,
      discuss_results: [],
    });

    // Round 1: smoke failure → deterministic escalation
    const round1 = await runReview(makeWorker(), task, plan, registry, false);
    expect(round1.authority?.disagreement_flags).toContain('deterministic_vs_opinion');

    // Round 2: repair succeeded, smoke now passes → no deterministic flag
    const round2 = await runReview(makeWorker(), task, plan, registry, true);
    expect(round2.authority?.disagreement_flags).not.toContain('deterministic_vs_opinion');
    expect(round2.passed).toBe(true);
  });

  it('deterministic signal is independent of review outcome — smoke still fails after repair review passes', async () => {
    // Scenario: repair worker succeeds, review passes, but smoke re-run still fails.
    // The review escalation must still fire because original smoke failed.
    // This proves review.passed is NOT used as a proxy for smoke.passed.
    queryModelTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.9,
          flagged_issues: [],
          summary: 'code change looks acceptable',
        }),
        tokenUsage: { input: 10, output: 5 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.88,
          flagged_issues: [],
          summary: 'challenger: LGTM',
        }),
        tokenUsage: { input: 12, output: 6 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: false,
          rationale: 'deterministic smoke still fails despite review pass',
          final_findings: [
            { severity: 'red', file: '(smoke)', issue: 'build still failing after repair', decision: 'flag' },
          ],
        }),
        tokenUsage: { input: 8, output: 4 },
      });

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-smoke-still-fails',
      description: 'Repair where smoke still fails',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-smoke-still-fails',
      goal: 'prove review.passed != smoke.passed',
      tasks: [task],
      execution_order: [['task-smoke-still-fails']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-smoke-still-fails',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/smoke-still-fails',
      branch: 'worker-task-smoke-still-fails',
      sessionId: 'worker-task-smoke-still-fails',
      output: [],
      changedFiles: ['src/app.ts'],
      success: true,
      duration_ms: 800,
      token_usage: { input: 15, output: 8 },
      discuss_triggered: false,
      discuss_results: [],
    };

    // Original smoke failure → review escalation still fires even though review would pass
    const result = await runReview(workerResult, task, plan, registry, false);

    expect(result.authority?.mode).toBe('pair');
    expect(result.authority?.disagreement_flags).toContain('deterministic_vs_opinion');
    // Synthesis overrides to REJECT — smoke failure trumps reviewer pass
    expect(result.passed).toBe(false);
  });
});
