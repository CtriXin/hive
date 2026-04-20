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
  fallback_order: ['kimi-k2.5', 'MiniMax-M2.5', 'claude-sonnet-4-6', 'claude-opus-4-6'],
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
    expect(result.failure_attribution).toBe('unknown');
    expect(result.prompt_fault_confidence).toBe(0);
    expect(result.recommended_fragments).toEqual([]);
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
    expect(result.failure_attribution).toBe('unknown');
    expect(result.prompt_fault_confidence).toBe(0);
    expect(result.recommended_fragments).toEqual([]);
    expect(result.findings.at(-1)?.issue).toContain('higher-confidence pass accepted');
  });

  it('skips synthesis when pair reaches high-confidence pass consensus', async () => {
    queryModelTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.91,
          flagged_issues: [],
          summary: 'primary review pass',
        }),
        tokenUsage: { input: 10, output: 5 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.89,
          flagged_issues: [],
          summary: 'challenger review pass',
        }),
        tokenUsage: { input: 12, output: 6 },
      });

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-consensus-pass',
      description: 'Consensus pass without synthesis',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-consensus-pass',
      goal: 'test pair consensus skips synthesis',
      tasks: [task],
      execution_order: [['task-consensus-pass']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-consensus-pass',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/authority-test',
      branch: 'worker-task-consensus-pass',
      sessionId: 'worker-task-consensus-pass',
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
    expect(result.authority?.mode).toBe('single');
    expect(result.authority?.synthesized_by).toBeUndefined();
    expect(result.authority?.synthesis_strategy).toBeUndefined();
    expect(result.authority?.disagreement_flags || []).toEqual([]);
    expect(result.token_stages?.some((stage) => stage.stage === 'authority-synthesis:task-consensus-pass')).toBe(false);
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
    expect(result.failure_attribution).toBe('unknown');
    expect(result.prompt_fault_confidence).toBe(0);
    expect(result.recommended_fragments).toEqual([]);
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
    expect(result.failure_attribution).toBe('unknown');
    expect(result.prompt_fault_confidence).toBe(0);
    expect(result.recommended_fragments).toEqual([]);
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
    expect(result.failure_attribution).toBe('unknown');
    expect(result.prompt_fault_confidence).toBe(0);
    expect(result.recommended_fragments).toEqual([]);
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

  it('authority verdict is immutable when external advisory findings are merged', async () => {
    // Authority pair: disagree → synthesis says REJECT
    queryModelTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.7,
          flagged_issues: [],
          summary: 'primary: looks ok',
        }),
        tokenUsage: { input: 10, output: 5 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: false,
          confidence: 0.85,
          flagged_issues: [
            { severity: 'red', file: 'src/app.ts:10', description: 'must fix' },
          ],
          summary: 'challenger: real issue',
        }),
        tokenUsage: { input: 12, output: 6 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: false,
          rationale: 'red finding confirmed — reject',
          final_findings: [
            { severity: 'red', file: 'src/app.ts:10', issue: 'must fix', decision: 'flag' },
          ],
        }),
        tokenUsage: { input: 8, output: 4 },
      });

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-ext-1',
      description: 'External advisory immutability',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-ext-1',
      goal: 'test authority verdict immutability with external advisory',
      tasks: [task],
      execution_order: [['task-ext-1']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-ext-1',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/ext-advisory-test',
      branch: 'worker-task-ext-1',
      sessionId: 'worker-task-ext-1',
      output: [],
      changedFiles: ['src/app.ts'],
      success: true,
      duration_ms: 1000,
      token_usage: { input: 20, output: 10 },
      discuss_triggered: false,
      discuss_results: [],
    };

    const result = await runReview(workerResult, task, plan, registry);

    // Snapshot authority state before external advisory merge
    expect(result.passed).toBe(false);
    expect(result.verdict).toBe('REJECT');
    const originalAuthority = result.authority;
    const originalFindingCount = result.findings.length;

    // Simulate what maybeRunExternalReviewSlot does: spread + append advisory findings
    const merged = {
      ...result,
      findings: [
        ...result.findings,
        {
          id: result.findings.length + 1,
          severity: 'yellow' as const,
          lens: 'external-review',
          file: 'review-room:external-a',
          issue: 'External advisory: the red finding may be a false positive',
          decision: 'flag' as const,
          decision_reason: 'External review advisory (500ms, 120 chars)',
        },
      ],
      external_review_collab: {
        card: {
          room_id: 'room-review-ext-1',
          room_kind: 'review',
          status: 'closed',
          replies: 1,
          focus_task_id: 'task-ext-1',
          next: 'external review complete',
        },
        recent_events: [],
      },
    };

    // Authority verdict must be unchanged — external advisory cannot override it
    expect(merged.passed).toBe(false);
    expect(merged.verdict).toBe('REJECT');
    expect(merged.authority).toBe(originalAuthority);
    expect(merged.authority?.source).toBe('authority-layer');
    expect(merged.authority?.disagreement_flags).toContain('conclusion_opposite');
    // External advisory is appended, not replacing
    expect(merged.findings).toHaveLength(originalFindingCount + 1);
    expect(merged.findings.at(-1)?.lens).toBe('external-review');
    expect(merged.findings.at(-1)?.severity).toBe('yellow');
  });

  it('deterministic_vs_opinion persists after external advisory merge', async () => {
    // smokeFailed + reviewers pass → deterministic_vs_opinion → synthesis says FAIL
    queryModelTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.91,
          flagged_issues: [],
          summary: 'primary: LGTM',
        }),
        tokenUsage: { input: 10, output: 5 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: true,
          confidence: 0.88,
          flagged_issues: [],
          summary: 'challenger: also fine',
        }),
        tokenUsage: { input: 12, output: 6 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          passed: false,
          rationale: 'deterministic smoke failure overrides',
          final_findings: [
            { severity: 'red', file: '(smoke)', issue: 'smoke failure', decision: 'flag' },
          ],
        }),
        tokenUsage: { input: 8, output: 4 },
      });

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-ext-2',
      description: 'Deterministic + external advisory',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-ext-2',
      goal: 'test deterministic flag survives external advisory',
      tasks: [task],
      execution_order: [['task-ext-2']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-ext-2',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/det-ext-test',
      branch: 'worker-task-ext-2',
      sessionId: 'worker-task-ext-2',
      output: [],
      changedFiles: ['src/app.ts'],
      success: true,
      duration_ms: 800,
      token_usage: { input: 15, output: 8 },
      discuss_triggered: false,
      discuss_results: [],
    };

    const result = await runReview(workerResult, task, plan, registry, false);

    // Deterministic flag present
    expect(result.authority?.disagreement_flags).toContain('deterministic_vs_opinion');
    expect(result.passed).toBe(false);

    // Simulate external advisory merge (like maybeRunExternalReviewSlot)
    const merged = {
      ...result,
      findings: [
        ...result.findings,
        {
          id: result.findings.length + 1,
          severity: 'yellow' as const,
          lens: 'external-review',
          file: 'review-room:external-b',
          issue: 'External advisory: reviewers were right, code looks fine',
          decision: 'flag' as const,
          decision_reason: 'External review advisory (300ms, 80 chars)',
        },
      ],
      external_review_collab: {
        card: {
          room_id: 'room-review-ext-2',
          room_kind: 'review',
          status: 'closed',
          replies: 1,
          focus_task_id: 'task-ext-2',
          next: 'external review complete',
        },
        recent_events: [],
      },
    };

    // deterministic_vs_opinion must survive — external opinion cannot override it
    expect(merged.authority?.disagreement_flags).toContain('deterministic_vs_opinion');
    expect(merged.passed).toBe(false);
    expect(merged.authority?.source).toBe('authority-layer');
    expect(merged.authority?.synthesized_by).toBe('gpt-5.4');
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

  it('passes observe_only tasks with empty diff under authority review', async () => {
    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-observe',
      description: 'Read and verify planner artifacts, then record findings',
      category: 'docs',
      complexity: 'low',
      estimated_files: ['docs/hiveshell/MAIN_AGENT_PROGRESS_RECEIPTS.md'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
      acceptance_criteria: ['Record findings without editing project files'],
      execution_contract: 'observe_only',
    };
    const plan: TaskPlan = {
      id: 'plan-observe',
      goal: 'review only',
      tasks: [task],
      execution_order: [['task-observe']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-observe',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/authority-test',
      branch: 'worker-task-observe',
      sessionId: 'worker-task-observe',
      output: [],
      changedFiles: [],
      success: true,
      duration_ms: 1000,
      token_usage: { input: 5, output: 2 },
      discuss_triggered: false,
      discuss_results: [],
      execution_contract: 'observe_only',
    };

    const result = await runReview(workerResult, task, plan, registry);

    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.authority?.source).toBe('authority-layer');
    expect(queryModelTextMock).not.toHaveBeenCalled();
  });

  it('passes reconcile_if_needed empty diff under legacy cascade', async () => {
    authorityPolicyMock = {
      ...defaultAuthorityPolicy,
      enabled: false,
    };
    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-sync',
      description: '同步 runOfficialProxy.mjs 行为，如无需改动则说明原因',
      category: 'maintenance',
      complexity: 'low',
      estimated_files: ['scripts/runOfficialProxy.mjs'],
      depends_on: [],
      assigned_model: 'kimi-k2.5',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
      acceptance_criteria: ['If already correct, leave files unchanged and explain why'],
      execution_contract: 'reconcile_if_needed',
    };
    const plan: TaskPlan = {
      id: 'plan-sync',
      goal: 'reconcile only if needed',
      tasks: [task],
      execution_order: [['task-sync']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-sync',
      model: 'kimi-k2.5',
      worktreePath: '/tmp/authority-test',
      branch: 'worker-task-sync',
      sessionId: 'worker-task-sync',
      output: [],
      changedFiles: [],
      success: true,
      duration_ms: 1000,
      token_usage: { input: 5, output: 2 },
      discuss_triggered: false,
      discuss_results: [],
      execution_contract: 'reconcile_if_needed',
    };

    const result = await runReview(workerResult, task, plan, registry);

    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.authority?.source).toBe('legacy-cascade');
    expect(queryModelTextMock).not.toHaveBeenCalled();
  });

  it('fails observe_only tasks that unexpectedly modify files', async () => {
    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-audit',
      description: 'Audit config only; do not modify files',
      category: 'docs',
      complexity: 'low',
      estimated_files: ['config/model-profiles.json'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
      acceptance_criteria: ['No file changes are allowed'],
      execution_contract: 'observe_only',
    };
    const plan: TaskPlan = {
      id: 'plan-audit',
      goal: 'audit only',
      tasks: [task],
      execution_order: [['task-audit']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-audit',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/authority-test',
      branch: 'worker-task-audit',
      sessionId: 'worker-task-audit',
      output: [],
      changedFiles: ['config/model-profiles.json'],
      success: true,
      duration_ms: 1000,
      token_usage: { input: 5, output: 2 },
      discuss_triggered: false,
      discuss_results: [],
      execution_contract: 'observe_only',
    };

    const result = await runReview(workerResult, task, plan, registry);

    expect(result.passed).toBe(false);
    expect(result.findings[0]?.issue).toContain('forbids file edits');
    expect(result.authority?.source).toBe('authority-layer');
    expect(queryModelTextMock).not.toHaveBeenCalled();
  });
});

describe('domestic candidate hard filter', () => {
  it('kimi-k2.5 is not hard-filtered by provider_resolution_failed', () => {
    const registry = new ModelRegistry();
    expect(registry.canResolveForModel('kimi-k2.5')).toBe(true);
  });

  it('MiniMax-M2.5 is not hard-filtered by provider_resolution_failed', () => {
    const registry = new ModelRegistry();
    expect(registry.canResolveForModel('MiniMax-M2.5')).toBe(true);
  });

  it('models with no valid provider and no MMS route are still hard-filtered', () => {
    const registry = new ModelRegistry();
    // A model that doesn't exist in model-capabilities.json and has no MMS route
    expect(registry.canResolveForModel('totally-unknown-model-xyz')).toBe(false);
  });

  it('rankModelsForTask does not block kimi-k2.5 or MiniMax-M2.5 via hard filter', () => {
    const registry = new ModelRegistry();
    const ranked = registry.rankModelsForTask({
      role: 'review',
      domains: ['typescript', 'tests'],
      complexity: 'medium',
      needs_strict_boundary: false,
      needs_fast_turnaround: false,
      is_repair_round: false,
    });

    const kimi = ranked.find((r) => r.model === 'kimi-k2.5');
    const minimax = ranked.find((r) => r.model === 'MiniMax-M2.5');

    // They may be blocked by other filters (e.g. complexity), but NOT by provider_resolution_failed
    expect(kimi?.blocked_by ?? []).not.toContain('provider_resolution_failed');
    expect(minimax?.blocked_by ?? []).not.toContain('provider_resolution_failed');
  });

  it('authority pair mode works with domestic primary candidates', async () => {
    // Uses defaultAuthorityPolicy which has kimi-k2.5 and MiniMax-M2.5 as primary_candidates
    authorityPolicyMock = {
      ...defaultAuthorityPolicy,
      // Force pair mode for this test
      default_mode: 'pair',
    };

    queryModelTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({ passed: true, confidence: 0.9, flagged_issues: [], summary: 'ok' }),
        tokenUsage: { input: 10, output: 5 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ passed: true, confidence: 0.88, flagged_issues: [], summary: 'ok' }),
        tokenUsage: { input: 12, output: 6 },
      });

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-domestic-pair',
      description: 'Test domestic pair mode',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-domestic-pair',
      goal: 'test domestic pair',
      tasks: [task],
      execution_order: [['task-domestic-pair']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-domestic-pair',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/domestic-pair-test',
      branch: 'worker-task-domestic-pair',
      sessionId: 'worker-task-domestic-pair',
      output: [],
      changedFiles: ['src/app.ts'],
      success: true,
      duration_ms: 1000,
      token_usage: { input: 20, output: 10 },
      discuss_triggered: false,
      discuss_results: [],
    };

    const result = await runReview(workerResult, task, plan, registry);

    // With pair mode and domestic candidates available, we should get pair review
    expect(result.authority?.source).toBe('authority-layer');
    expect(result.authority?.mode).toBe('pair');
    expect(result.authority?.members.length).toBe(2);
    // Members should include at least one domestic model
    const hasDomestic = result.authority!.members.some(
      (m) => m.startsWith('kimi-') || m.startsWith('MiniMax-') || m.startsWith('glm-') || m.startsWith('qwen'),
    );
    expect(hasDomestic).toBe(true);
  });
});

describe('authority runtime degradation', () => {
  it('degrades to single when all reviewer candidates fail at runtime', async () => {
    authorityPolicyMock = {
      ...defaultAuthorityPolicy,
      default_mode: 'pair',
    };

    // All queryModelText calls fail — simulating bridge unavailable for all candidates
    queryModelTextMock.mockRejectedValue(new Error('Bridge transport unavailable for model'));

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-all-fail',
      description: 'All candidates fail',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-all-fail',
      goal: 'test all candidates fail',
      tasks: [task],
      execution_order: [['task-all-fail']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-all-fail',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/all-fail-test',
      branch: 'worker-task-all-fail',
      sessionId: 'worker-task-all-fail',
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
    expect(result.authority?.mode).toBe('single');
    expect(result.authority?.members).toEqual([]);
    expect(result.authority?.reviewer_runtime_failures).toBeDefined();
    expect(result.authority!.reviewer_runtime_failures!.length).toBeGreaterThan(0);
    expect(result.authority!.reviewer_runtime_failures![0].reason).toBe('bridge_unavailable');
    expect(result.passed).toBe(false);
    expect(result.findings[0]?.issue).toContain('All reviewer candidates failed at runtime');
  });

  it('degrades pair to single when challenger fails at runtime but primary succeeds', async () => {
    authorityPolicyMock = {
      ...defaultAuthorityPolicy,
      default_mode: 'pair',
    };

    // Primary review: 1st call succeeds
    // Challenger review: 2nd call fails (runCrossReview catches and returns failed result)
    // Challenger fallback (within runCrossReview): 3rd call also fails
    queryModelTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({ passed: true, confidence: 0.9, flagged_issues: [], summary: 'primary ok' }),
        tokenUsage: { input: 10, output: 5 },
      })
      .mockRejectedValueOnce(new Error('Bridge transport unavailable for challenger'))
      .mockRejectedValueOnce(new Error('Bridge transport unavailable for challenger fallback'));

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-challenger-fail',
      description: 'Challenger fails',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-challenger-fail',
      goal: 'test challenger runtime failure',
      tasks: [task],
      execution_order: [['task-challenger-fail']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-challenger-fail',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/challenger-fail-test',
      branch: 'worker-task-challenger-fail',
      sessionId: 'worker-task-challenger-fail',
      output: [],
      changedFiles: ['src/app.ts'],
      success: true,
      duration_ms: 1000,
      token_usage: { input: 20, output: 10 },
      discuss_triggered: false,
      discuss_results: [],
    };

    const result = await runReview(workerResult, task, plan, registry);

    // Should degrade to single since challenger failed and no other candidates available
    expect(result.authority?.mode).toBe('single');
    expect(result.authority?.members.length).toBe(1);
    expect(result.authority?.reviewer_runtime_failures).toBeDefined();
    expect(result.authority!.reviewer_runtime_failures!.length).toBeGreaterThan(0);
    expect(result.passed).toBe(true);
  });

  it('runtime failure reason is classified correctly', async () => {
    authorityPolicyMock = {
      ...defaultAuthorityPolicy,
      default_mode: 'pair',
    };

    queryModelTextMock.mockRejectedValue(new Error('API key not configured for provider "kimi"'));

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-missing-env',
      description: 'Missing env test',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-missing-env',
      goal: 'test missing env classification',
      tasks: [task],
      execution_order: [['task-missing-env']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-missing-env',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/missing-env-test',
      branch: 'worker-task-missing-env',
      sessionId: 'worker-task-missing-env',
      output: [],
      changedFiles: ['src/app.ts'],
      success: true,
      duration_ms: 1000,
      token_usage: { input: 20, output: 10 },
      discuss_triggered: false,
      discuss_results: [],
    };

    const result = await runReview(workerResult, task, plan, registry);

    expect(result.authority?.reviewer_runtime_failures).toBeDefined();
    expect(result.authority!.reviewer_runtime_failures![0].reason).toBe('missing_env');
    expect(result.authority!.reviewer_runtime_failures![0].error_hint).toContain('API key not configured');
  });

  it('legitimate policy filter (complexity capacity) is not confused with runtime failure', async () => {
    // A model blocked by hard filter should NOT appear in reviewer_runtime_failures
    authorityPolicyMock = {
      ...defaultAuthorityPolicy,
      default_mode: 'pair',
    };

    queryModelTextMock
      .mockResolvedValueOnce({
        text: JSON.stringify({ passed: true, confidence: 0.9, flagged_issues: [], summary: 'ok' }),
        tokenUsage: { input: 10, output: 5 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ passed: true, confidence: 0.88, flagged_issues: [], summary: 'ok' }),
        tokenUsage: { input: 12, output: 6 },
      });

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-policy-filter',
      description: 'Policy filter test',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-policy-filter',
      goal: 'test policy vs runtime distinction',
      tasks: [task],
      execution_order: [['task-policy-filter']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-policy-filter',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/policy-filter-test',
      branch: 'worker-task-policy-filter',
      sessionId: 'worker-task-policy-filter',
      output: [],
      changedFiles: ['src/app.ts'],
      success: true,
      duration_ms: 1000,
      token_usage: { input: 20, output: 10 },
      discuss_triggered: false,
      discuss_results: [],
    };

    const result = await runReview(workerResult, task, plan, registry);

    // No runtime failures on a healthy run
    expect(result.authority?.reviewer_runtime_failures).toBeUndefined();
    expect(result.passed).toBe(true);
    expect(result.authority?.mode).toBe('pair');
  });

  it('primary candidate fallback succeeds, review completes normally', async () => {
    // When runCrossReview's internal fallback works, the review succeeds
    // without degradation. This tests that the pipeline handles
    // a single-candidate failure gracefully.
    authorityPolicyMock = {
      ...defaultAuthorityPolicy,
      default_mode: 'single',
    };

    // First call (primary attempt) fails, second call (internal fallback within runCrossReview) succeeds
    queryModelTextMock
      .mockRejectedValueOnce(new Error('BRIDGE_REQUIRED'))
      .mockResolvedValueOnce({
        text: JSON.stringify({ passed: true, confidence: 0.85, flagged_issues: [], summary: 'fallback candidate ok' }),
        tokenUsage: { input: 12, output: 6 },
      });

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-fallback-ok',
      description: 'Fallback succeeds',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-fallback-ok',
      goal: 'test internal fallback succeeds',
      tasks: [task],
      execution_order: [['task-fallback-ok']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-fallback-ok',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/fallback-ok-test',
      branch: 'worker-task-fallback-ok',
      sessionId: 'worker-task-fallback-ok',
      output: [],
      changedFiles: ['src/app.ts'],
      success: true,
      duration_ms: 1000,
      token_usage: { input: 20, output: 10 },
      discuss_triggered: false,
      discuss_results: [],
    };

    const result = await runReview(workerResult, task, plan, registry);

    // Review should succeed via internal fallback
    expect(result.passed).toBe(true);
    expect(result.authority?.mode).toBe('single');
    // No degradation recorded because the fallback worked
    expect(result.authority?.reviewer_runtime_failures).toBeUndefined();
  });

  it('authority retry picks next candidate when first candidate fully fails', async () => {
    // Tests the multi-candidate retry: first candidate fails (both attempts),
    // next authority candidate succeeds. Degradation is recorded.
    authorityPolicyMock = {
      ...defaultAuthorityPolicy,
      default_mode: 'pair',
    };

    // 1st: primary attempt fails
    // 2nd: primary internal fallback also fails (same model via mocked resolveFallback)
    // 3rd: next candidate succeeds
    // 4th: challenger succeeds
    queryModelTextMock
      .mockRejectedValueOnce(new Error('Bridge unavailable for primary'))
      .mockRejectedValueOnce(new Error('Bridge unavailable for primary fallback'))
      .mockResolvedValueOnce({
        text: JSON.stringify({ passed: true, confidence: 0.85, flagged_issues: [], summary: 'next candidate ok' }),
        tokenUsage: { input: 12, output: 6 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ passed: true, confidence: 0.88, flagged_issues: [], summary: 'challenger ok' }),
        tokenUsage: { input: 12, output: 6 },
      });

    const { runReview } = await import('../orchestrator/reviewer.js');
    const registry = new ModelRegistry();
    const task: SubTask = {
      id: 'task-multi-candidate',
      description: 'Multi-candidate retry',
      category: 'api',
      complexity: 'medium',
      estimated_files: ['src/app.ts'],
      depends_on: [],
      assigned_model: 'qwen3.5-plus',
      assignment_reason: 'test',
      discuss_threshold: 0.7,
    };
    const plan: TaskPlan = {
      id: 'plan-multi-candidate',
      goal: 'test multi-candidate retry',
      tasks: [task],
      execution_order: [['task-multi-candidate']],
    };
    const workerResult: WorkerResult = {
      taskId: 'task-multi-candidate',
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/multi-candidate-test',
      branch: 'worker-task-multi-candidate',
      sessionId: 'worker-task-multi-candidate',
      output: [],
      changedFiles: ['src/app.ts'],
      success: true,
      duration_ms: 1000,
      token_usage: { input: 20, output: 10 },
      discuss_triggered: false,
      discuss_results: [],
    };

    const result = await runReview(workerResult, task, plan, registry);

    // Review should succeed after retrying next candidate
    expect(result.passed).toBe(true);
    expect(result.authority?.mode).toBe('pair');
    // Runtime failure should be recorded for the first candidate
    expect(result.authority?.reviewer_runtime_failures).toBeDefined();
    expect(result.authority!.reviewer_runtime_failures!.length).toBeGreaterThan(0);
    expect(result.authority!.reviewer_runtime_failures![0].reason).toBe('bridge_unavailable');
  });
});
