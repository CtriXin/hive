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

  it('drops read-only tasks and rewires downstream dependencies', () => {
    const plan = buildPlanFromClaudeOutput({
      goal: 'create one doc',
      tasks: [
        {
          id: 'task-a',
          description: 'Review existing artifacts without changing any files.',
          complexity: 'medium',
          category: 'docs',
          estimated_files: ['docs/source.md'],
          acceptance_criteria: ['No files are modified in this step.'],
          depends_on: [],
        },
        {
          id: 'task-b',
          description: 'Create the requested doc file',
          complexity: 'low',
          category: 'docs',
          estimated_files: ['docs/output.md'],
          acceptance_criteria: ['docs/output.md exists'],
          depends_on: ['task-a'],
        },
      ],
    });

    expect(plan.tasks.map((task) => task.id)).toEqual(['task-b']);
    expect(plan.tasks[0].depends_on).toEqual([]);
    expect(plan.execution_order).toEqual([['task-b']]);
  });
});
