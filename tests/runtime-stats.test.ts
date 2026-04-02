import { describe, it, expect } from 'vitest';
import { collectRuntimeStats } from '../orchestrator/runtime-stats.js';
import type { OrchestratorResult, WorkerResult } from '../orchestrator/types.js';

describe('collectRuntimeStats', () => {
  it('should count completed and failed tasks correctly with models used', () => {
    const mockWorkerResults: WorkerResult[] = [
      {
        taskId: 'task-a',
        model: 'kimi-k2.5',
        worktreePath: '/mock/worktree-a',
        branch: 'worktree/task-a',
        sessionId: 'session-1',
        output: [],
        changedFiles: ['file1.ts'],
        success: true,
        duration_ms: 1000,
        token_usage: { input: 100, output: 50 },
        discuss_triggered: false,
        discuss_results: [],
      },
      {
        taskId: 'task-b',
        model: 'glm-5-turbo',
        worktreePath: '/mock/worktree-b',
        branch: 'worktree/task-b',
        sessionId: 'session-2',
        output: [],
        changedFiles: [],
        success: false,
        duration_ms: 500,
        token_usage: { input: 50, output: 20 },
        discuss_triggered: false,
        discuss_results: [],
      },
    ];

    const mockResult: Partial<OrchestratorResult> = {
      worker_results: mockWorkerResults,
    };

    const stats = collectRuntimeStats(mockResult as OrchestratorResult);

    expect(stats.tasksCompleted).toBe(1);
    expect(stats.tasksFailed).toBe(1);
    expect(stats.modelsUsed).toContain('kimi-k2.5');
    expect(stats.modelsUsed).toContain('glm-5-turbo');
    expect(stats.modelsUsed.length).toBe(2);
  });

  it('should return zero stats and empty models array for empty tasks', () => {
    const mockResult: Partial<OrchestratorResult> = {
      worker_results: [],
    };

    const stats = collectRuntimeStats(mockResult as OrchestratorResult);

    expect(stats.tasksCompleted).toBe(0);
    expect(stats.tasksFailed).toBe(0);
    expect(stats.modelsUsed).toEqual([]);
  });
});
