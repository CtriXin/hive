import { describe, expect, it } from 'vitest';
import { buildPlanFromClaudeOutput } from '../orchestrator/planner.js';

describe('planner', () => {
  it('assigns a default worker model for manual plans without assigned_model', () => {
    const plan = buildPlanFromClaudeOutput({
      goal: 'docs-only task',
      tasks: [
        {
          id: 'task-a',
          description: 'Create a docs file',
          complexity: 'low',
          category: 'docs',
          estimated_files: ['docs/example.md'],
          acceptance_criteria: ['file exists'],
          depends_on: [],
        },
      ],
    });

    expect(plan.tasks[0].assigned_model).toBeTruthy();
    expect(plan.tasks[0].assignment_reason).toContain('default plan model selection');
  });

  it('preserves an explicit assigned_model from the incoming plan json', () => {
    const plan = buildPlanFromClaudeOutput({
      goal: 'explicit model',
      tasks: [
        {
          id: 'task-a',
          description: 'Keep explicit model',
          complexity: 'low',
          category: 'docs',
          assigned_model: 'qwen3.5-plus',
          assignment_reason: 'manual override',
          estimated_files: ['docs/example.md'],
          acceptance_criteria: ['file exists'],
          depends_on: [],
        },
      ],
    });

    expect(plan.tasks[0].assigned_model).toBe('qwen3.5-plus');
    expect(plan.tasks[0].assignment_reason).toBe('manual override');
  });
});
