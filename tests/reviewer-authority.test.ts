import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRegistry } from '../orchestrator/model-registry.js';
import type { SubTask, TaskPlan, WorkerResult } from '../orchestrator/types.js';

const queryModelTextMock = vi.fn();
const noopUpdateScore = vi.fn();

vi.mock('../orchestrator/authority-policy.js', () => ({
  loadReviewAuthorityPolicy: () => ({
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
  }),
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
});
