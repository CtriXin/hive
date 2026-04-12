// ═══════════════════════════════════════════════════════════════════
// tests/task-context-pack.test.ts — Phase 1A Context Pack Tests
// ═══════════════════════════════════════════════════════════════════
// Tests for:
//   - TaskContextPack generation
//   - Multi-task isolation (context packs should not cross-contaminate)
//   - Repair task context (fresh pack with repair context)
//   - Stability (same input → same pack output)
//   - Dispatch tracking (recording injected context)
//   - Fresh session enforcement (worktree/session not silently reused)
// ═══════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildTaskContextPack,
  buildRepairContext,
  serializeContextPack,
  createDispatchContextRecorder,
  shouldUseFreshSession,
  generateFreshSessionId,
  buildUpstreamContextPackets,
  resetGlobalDispatchRecorder,
  getGlobalDispatchRecorder,
} from '../orchestrator/task-context-pack.js';
import type { SubTask, WorkerResult, PromptPolicySelection } from '../orchestrator/types.js';

// ── Helpers ──

function makeFakeWorkerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    taskId: 'task-a',
    model: 'qwen3.5-plus',
    worktreePath: '/tmp/fake-worktree',
    branch: 'worktree/task-a',
    sessionId: 'session-123',
    output: [
      { type: 'assistant', content: 'Created schema.ts with User type', timestamp: Date.now() },
    ],
    changedFiles: ['schema.ts'],
    success: true,
    duration_ms: 1000,
    token_usage: { input: 100, output: 200 },
    discuss_triggered: false,
    discuss_results: [],
    ...overrides,
  };
}

function makeFakeTask(overrides: Partial<SubTask> = {}): SubTask {
  return {
    id: 'task-a',
    description: 'Create user schema',
    complexity: 'medium',
    category: 'schema',
    assigned_model: 'qwen3.5-plus',
    assignment_reason: 'Good at schema design',
    estimated_files: ['schema.ts'],
    acceptance_criteria: ['Schema exports User type'],
    discuss_threshold: 0.7,
    depends_on: [],
    review_scale: 'light',
    ...overrides,
  };
}

// ── Tests ──

describe('TaskContextPack', () => {
  beforeEach(() => {
    resetGlobalDispatchRecorder();
  });

  describe('buildTaskContextPack', () => {
    it('should generate a valid context pack for a fresh task', () => {
      const task = makeFakeTask();
      const pack = buildTaskContextPack(task, {
        runId: 'run-123',
        planId: 'plan-456',
        round: 0,
      });

      expect(pack.generated_at).toBeDefined();
      expect(pack.run_id).toBe('run-123');
      expect(pack.plan_id).toBe('plan-456');
      expect(pack.task_id).toBe('task-a');
      expect(pack.task_objective).toBe('Create user schema');
      expect(pack.round).toBe(0);
      expect(pack.is_repair).toBe(false);
      expect(pack.selected_files).toEqual(['schema.ts']);
      expect(pack.upstream_context).toEqual([]);
    });

    it('should include upstream context when provided', () => {
      const task = makeFakeTask({ depends_on: ['task-0'] });
      const upstreamContexts = [
        {
          from_task: 'task-0',
          summary: 'Created database connection',
          key_outputs: [{ file: 'db.ts', purpose: '数据库连接', key_exports: [] }],
          decisions_made: ['Use PostgreSQL'],
        },
      ];

      const pack = buildTaskContextPack(task, {
        runId: 'run-123',
        planId: 'plan-456',
        round: 0,
      }, upstreamContexts);

      expect(pack.upstream_context).toHaveLength(1);
      expect(pack.upstream_context[0].from_task).toBe('task-0');
      expect(pack.upstream_context[0].summary).toBe('Created database connection');
    });

    it('should mark round > 0 as repair', () => {
      const task = makeFakeTask();
      const pack = buildTaskContextPack(task, {
        runId: 'run-123',
        planId: 'plan-456',
        round: 2,
      });

      expect(pack.round).toBe(2);
      expect(pack.is_repair).toBe(true);
    });
  });

  describe('buildRepairContext', () => {
    it('should build repair context from previous failure', () => {
      const repairCtx = buildRepairContext({
        previousError: 'TypeError: Cannot read property of undefined',
        previousChangedFiles: ['schema.ts'],
        reviewFindings: [
          {
            id: 1,
            severity: 'red',
            lens: 'cross-review',
            file: 'schema.ts',
            line: 10,
            issue: 'Missing export statement',
            decision: 'flag',
          },
        ],
        repairGuidance: ['Add export statement', 'Check null safety'],
      });

      expect(repairCtx?.previous_error).toContain('TypeError');
      expect(repairCtx?.previous_changed_files).toEqual(['schema.ts']);
      expect(repairCtx?.review_findings).toHaveLength(1);
      expect(repairCtx?.review_findings?.[0].severity).toBe('red');
      expect(repairCtx?.repair_guidance).toHaveLength(2);
    });

    it('should handle empty repair options gracefully', () => {
      const repairCtx = buildRepairContext({});
      expect(repairCtx).toEqual({});
    });
  });

  describe('serializeContextPack', () => {
    it('should serialize context pack to readable format', () => {
      const task = makeFakeTask();
      const pack = buildTaskContextPack(task, {
        runId: 'run-123',
        planId: 'plan-456',
        round: 0,
        promptPolicy: {
          version: '1.0.0',
          fragments: ['strict_file_boundary', 'output_format_guard'],
          reasons: ['Task modifies files'],
        },
      });

      const serialized = serializeContextPack(pack);

      expect(serialized).toContain('Task Objective');
      expect(serialized).toContain('task-a');
      expect(serialized).toContain('Selected Files');
      expect(serialized).toContain('schema.ts');
      expect(serialized).toContain('Prompt Policy');
      expect(serialized).toContain('strict_file_boundary');
    });

    it('should include repair context section when is_repair=true', () => {
      const task = makeFakeTask();
      const pack = buildTaskContextPack(task, {
        runId: 'run-123',
        planId: 'plan-456',
        round: 1,
      }, [], {
        previousError: 'Build failed',
        reviewFindings: [
          {
            id: 1,
            severity: 'red',
            lens: 'cross-review',
            file: 'schema.ts',
            issue: 'Type error',
            decision: 'flag',
          },
        ],
      });

      const serialized = serializeContextPack(pack);

      expect(serialized).toContain('Repair Context');
      expect(serialized).toContain('Previous Error');
      expect(serialized).toContain('Build failed');
      expect(serialized).toContain('Review Findings');
    });
  });
});

describe('Multi-task isolation', () => {
  it('should generate separate context packs for different tasks', () => {
    const taskA = makeFakeTask({ id: 'task-a', description: 'Task A work' });
    const taskB = makeFakeTask({ id: 'task-b', description: 'Task B work' });

    const packA = buildTaskContextPack(taskA, {
      runId: 'run-123',
      planId: 'plan-456',
      round: 0,
    });

    const packB = buildTaskContextPack(taskB, {
      runId: 'run-123',
      planId: 'plan-456',
      round: 0,
    });

    // Verify isolation
    expect(packA.task_id).toBe('task-a');
    expect(packB.task_id).toBe('task-b');
    expect(packA.task_objective).toBe('Task A work');
    expect(packB.task_objective).toBe('Task B work');

    // Different tasks should have different packs
    expect(packA).not.toEqual(packB);
  });

  it('should not include upstream context from unrelated tasks', () => {
    const taskC = makeFakeTask({
      id: 'task-c',
      depends_on: ['task-a'], // Only depends on task-a
    });

    const completedResults = [
      makeFakeWorkerResult({ taskId: 'task-a', changedFiles: ['a.ts'] }),
      makeFakeWorkerResult({ taskId: 'task-b', changedFiles: ['b.ts'] }), // Not a dependency
    ];

    const upstreamContexts = buildUpstreamContextPackets(
      completedResults,
      taskC.depends_on,
    );

    // Should only include task-a, not task-b
    expect(upstreamContexts).toHaveLength(1);
    expect(upstreamContexts[0].from_task).toBe('task-a');
  });
});

describe('Repair task context', () => {
  it('should generate fresh pack with repair context for failed task', () => {
    const task = makeFakeTask();
    const pack = buildTaskContextPack(task, {
      runId: 'run-123',
      planId: 'plan-456',
      round: 1, // Repair round
    }, [], {
      previousError: 'Test failure in schema.test.ts',
      reviewFindings: [
        {
          id: 1,
          severity: 'red',
          lens: 'cross-review',
          file: 'schema.ts',
          issue: 'Missing type annotation',
          decision: 'flag',
        },
      ],
    });

    expect(pack.is_repair).toBe(true);
    expect(pack.repair_context).toBeDefined();
    expect(pack.repair_context?.previous_error).toContain('Test failure');
    expect(pack.repair_context?.review_findings).toHaveLength(1);
  });

  it('should use fresh session for repair round', () => {
    expect(shouldUseFreshSession({
      taskId: 'task-a',
      round: 1,
      isRepair: true,
    })).toBe(true);

    expect(shouldUseFreshSession({
      taskId: 'task-a',
      round: 2,
      isRepair: true,
    })).toBe(true);
  });
});

describe('Context pack stability', () => {
  it('should produce stable output for same input', () => {
    const task = makeFakeTask();
    const options = {
      runId: 'run-123',
      planId: 'plan-456',
      round: 0,
      selectedFiles: ['schema.ts'],
    };

    const pack1 = buildTaskContextPack(task, options);
    const pack2 = buildTaskContextPack(task, options);

    // Generated_at will differ, but other fields should be identical
    expect(pack1.task_id).toBe(pack2.task_id);
    expect(pack1.task_objective).toBe(pack2.task_objective);
    expect(pack1.run_id).toBe(pack2.run_id);
    expect(pack1.plan_id).toBe(pack2.plan_id);
    expect(pack1.round).toBe(pack2.round);
    expect(pack1.selected_files).toEqual(pack2.selected_files);
    expect(pack1.upstream_context).toEqual(pack2.upstream_context);
  });
});

describe('Dispatch context tracking', () => {
  beforeEach(() => {
    resetGlobalDispatchRecorder();
  });

  it('should record dispatch context for later inspection', () => {
    const recorder = createDispatchContextRecorder();

    const record = {
      recorded_at: new Date().toISOString(),
      run_id: 'run-123',
      plan_id: 'plan-456',
      task_id: 'task-a',
      round: 0,
      context_pack: buildTaskContextPack(makeFakeTask(), {
        runId: 'run-123',
        planId: 'plan-456',
        round: 0,
      }),
      assigned_model: 'qwen3.5-plus',
      assigned_provider: 'bailian-codingplan',
      artifact_path: '.ai/runs/run-123/context-packs/context-pack-task-a-r0.json',
    };

    recorder.record(record);

    const records = recorder.getRecords('task-a');
    expect(records).toHaveLength(1);
    expect(records[0].task_id).toBe('task-a');
    expect(records[0].run_id).toBe('run-123');
  });

  it('should track multiple dispatches for same task', () => {
    const recorder = createDispatchContextRecorder();

    recorder.record({
      recorded_at: new Date().toISOString(),
      run_id: 'run-123',
      plan_id: 'plan-456',
      task_id: 'task-a',
      round: 0,
      context_pack: buildTaskContextPack(makeFakeTask(), {
        runId: 'run-123',
        planId: 'plan-456',
        round: 0,
      }),
      round: 0,
    });

    recorder.record({
      recorded_at: new Date().toISOString(),
      run_id: 'run-123',
      plan_id: 'plan-456',
      task_id: 'task-a',
      round: 1,
      context_pack: buildTaskContextPack(makeFakeTask(), {
        runId: 'run-123',
        planId: 'plan-456',
        round: 1,
      }),
      round: 1,
    });

    const records = recorder.getRecords('task-a');
    expect(records).toHaveLength(2);
    expect(records[0].round).toBe(0);
    expect(records[1].round).toBe(1);
  });

  it('global recorder should persist across calls', () => {
    resetGlobalDispatchRecorder();

    const recorder1 = getGlobalDispatchRecorder();
    recorder1.record({
      recorded_at: new Date().toISOString(),
      run_id: 'run-123',
      plan_id: 'plan-456',
      task_id: 'task-a',
      round: 0,
      context_pack: buildTaskContextPack(makeFakeTask(), {
        runId: 'run-123',
        planId: 'plan-456',
        round: 0,
      }),
      round: 0,
    });

    const recorder2 = getGlobalDispatchRecorder();
    const records = recorder2.getRecords('task-a');

    // Should be the same recorder instance with the same data
    expect(records).toHaveLength(1);
    expect(records[0].task_id).toBe('task-a');
  });
});

describe('Fresh session enforcement', () => {
  describe('shouldUseFreshSession', () => {
    it('should always return true for first round', () => {
      expect(shouldUseFreshSession({
        taskId: 'task-a',
        round: 0,
        isRepair: false,
      })).toBe(true);
    });

    it('should always return true for repair rounds', () => {
      expect(shouldUseFreshSession({
        taskId: 'task-a',
        round: 1,
        isRepair: true,
      })).toBe(true);

      expect(shouldUseFreshSession({
        taskId: 'task-a',
        round: 3,
        isRepair: true,
      })).toBe(true);
    });
  });

  describe('generateFreshSessionId', () => {
    it('should generate unique session IDs', () => {
      const sessionId1 = generateFreshSessionId('task-a', 0);
      const sessionId2 = generateFreshSessionId('task-a', 0);

      expect(sessionId1).toMatch(/^fresh-task-a-r0-/);
      expect(sessionId2).toMatch(/^fresh-task-a-r0-/);
      expect(sessionId1).not.toBe(sessionId2);
    });

    it('should include round number in session ID', () => {
      const sessionId0 = generateFreshSessionId('task-a', 0);
      const sessionId1 = generateFreshSessionId('task-a', 1);

      expect(sessionId0).toMatch(/-r0-/);
      expect(sessionId1).toMatch(/-r1-/);
    });
  });
});

describe('buildUpstreamContextPackets', () => {
  it('should filter results by dependency list', () => {
    const completedResults = [
      makeFakeWorkerResult({ taskId: 'task-a', changedFiles: ['a.ts'] }),
      makeFakeWorkerResult({ taskId: 'task-b', changedFiles: ['b.ts'] }),
      makeFakeWorkerResult({ taskId: 'task-c', changedFiles: ['c.ts'] }),
    ];

    const packets = buildUpstreamContextPackets(completedResults, ['task-a', 'task-c']);

    expect(packets).toHaveLength(2);
    expect(packets.map(p => p.from_task)).toEqual(['task-a', 'task-c']);
  });

  it('should only include successful results', () => {
    const completedResults = [
      makeFakeWorkerResult({ taskId: 'task-a', success: true }),
      makeFakeWorkerResult({ taskId: 'task-b', success: false }),
    ];

    const packets = buildUpstreamContextPackets(completedResults, ['task-a', 'task-b']);

    expect(packets).toHaveLength(1);
    expect(packets[0].from_task).toBe('task-a');
  });

  it('should limit number of contexts', () => {
    const completedResults = [
      makeFakeWorkerResult({ taskId: 'task-1' }),
      makeFakeWorkerResult({ taskId: 'task-2' }),
      makeFakeWorkerResult({ taskId: 'task-3' }),
      makeFakeWorkerResult({ taskId: 'task-4' }),
      makeFakeWorkerResult({ taskId: 'task-5' }),
    ];

    const packets = buildUpstreamContextPackets(completedResults, ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'], {
      maxContexts: 3,
    });

    expect(packets).toHaveLength(3);
  });
});
