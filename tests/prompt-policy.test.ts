import { describe, expect, it } from 'vitest';
import { buildTaskPrompt } from '../orchestrator/dispatcher.js';
import { renderPromptPolicy, selectPromptPolicy } from '../orchestrator/prompt-policy.js';
import type { SubTask } from '../orchestrator/types.js';

function makeTask(overrides: Partial<SubTask> = {}): SubTask {
  return {
    id: 'task-a',
    description: 'Update API integration and emit markdown report',
    complexity: 'medium',
    category: 'api',
    assigned_model: 'qwen3-max',
    assignment_reason: 'best available',
    estimated_files: ['src/api.ts', 'report.md'],
    acceptance_criteria: ['Keep API signatures correct', 'Write markdown report'],
    discuss_threshold: 0.7,
    depends_on: [],
    review_scale: 'auto',
    ...overrides,
  };
}

describe('prompt-policy', () => {
  it('selects heuristic fragments and merges learned hints', () => {
    const policy = selectPromptPolicy(
      makeTask({ category: 'config', estimated_files: ['config/app.json'] }),
      ['output_format_guard'],
    );

    expect(policy.version).toBe('worker-policy-v1');
    expect(policy.fragments).toContain('strict_file_boundary');
    expect(policy.fragments).toContain('json_structure_sample');
    expect(policy.fragments).toContain('acceptance_checklist');
    expect(policy.fragments).toContain('output_format_guard');
  });

  it('renders a prompt policy section with fragment text', () => {
    const rendered = renderPromptPolicy(selectPromptPolicy(makeTask()));

    expect(rendered).toContain('### Prompt Policy');
    expect(rendered).toContain('strict_file_boundary');
    expect(rendered).toContain('acceptance_checklist');
  });

  it('injects the selected prompt policy into the worker task prompt', () => {
    const prompt = buildTaskPrompt(makeTask({ estimated_files: ['config/app.json'] }));

    expect(prompt).toContain('### Prompt Policy');
    expect(prompt).toContain('output_format_guard');
    expect(prompt).toContain('json_structure_sample');
  });
});
