import { describe, expect, it } from 'vitest';
import { reportResults } from '../orchestrator/reporter.js';
import type { OrchestratorResult } from '../orchestrator/types.js';

describe('reporter authority output', () => {
  it('shows authority metadata in summary report', async () => {
    const result: OrchestratorResult = {
      plan: {
        id: 'plan-1',
        goal: 'demo',
        tasks: [],
        execution_order: [],
      },
      worker_results: [
        {
          taskId: 'task-a',
          model: 'qwen3.5-plus',
          worktreePath: '/tmp/a',
          branch: 'worker-task-a',
          sessionId: 'worker-task-a',
          output: [],
          changedFiles: ['src/a.ts'],
          success: true,
          duration_ms: 1000,
          token_usage: { input: 10, output: 5 },
          discuss_triggered: false,
          discuss_results: [],
        },
      ],
      review_results: [
        {
          taskId: 'task-a',
          final_stage: 'cross-review',
          passed: false,
          findings: [],
          iterations: 2,
          duration_ms: 120,
          verdict: 'REJECT',
          authority: {
            source: 'authority-layer',
            mode: 'pair',
            members: ['kimi-k2.5', 'MiniMax-M2.5'],
            disagreement_flags: ['conclusion_opposite'],
            synthesized_by: 'gpt-5.4',
            synthesis_strategy: 'model',
          },
        },
      ],
      score_updates: [],
      total_duration_ms: 2000,
      cost_estimate: {
        opus_tokens: 0,
        sonnet_tokens: 0,
        haiku_tokens: 0,
        domestic_tokens: 100,
        estimated_cost_usd: 0.01,
      },
    };

    const report = await reportResults(result, 'gpt-5.4', 'openai', {
      language: 'zh',
      format: 'summary',
      target: 'stdout',
    });

    expect(report).toContain('authority=authority-layer');
    expect(report).toContain('mode=pair');
    expect(report).toContain('members=kimi-k2.5+MiniMax-M2.5');
    expect(report).toContain('synth=gpt-5.4');
    expect(report).toContain('disagreement=conclusion_opposite');
  });

  it('shows heuristic synthesis fallback in summary report', async () => {
    const result: OrchestratorResult = {
      plan: {
        id: 'plan-2',
        goal: 'demo',
        tasks: [],
        execution_order: [],
      },
      worker_results: [],
      review_results: [
        {
          taskId: 'task-b',
          final_stage: 'cross-review',
          passed: false,
          findings: [],
          iterations: 2,
          duration_ms: 120,
          verdict: 'REJECT',
          authority: {
            source: 'authority-layer',
            mode: 'pair',
            members: ['kimi-k2.5', 'MiniMax-M2.5'],
            disagreement_flags: ['conclusion_opposite'],
            synthesis_strategy: 'heuristic',
          },
        },
      ],
      score_updates: [],
      total_duration_ms: 2000,
      cost_estimate: {
        opus_tokens: 0,
        sonnet_tokens: 0,
        haiku_tokens: 0,
        domestic_tokens: 100,
        estimated_cost_usd: 0.01,
      },
    };

    const report = await reportResults(result, 'gpt-5.4', 'openai', {
      language: 'zh',
      format: 'summary',
      target: 'stdout',
    });

    expect(report).toContain('synth=heuristic');
  });
});
