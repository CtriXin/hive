import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  saveWorkerResult, saveCheckpoint, loadCheckpoint,
  loadWorkerResult, saveFinalResult,
} from '../orchestrator/result-store.js';
import type { WorkerResult, OrchestratorResult, PlanCheckpoint } from '../orchestrator/types.js';

const TMP_DIR = '/tmp/hive-result-store-test';
const PLAN_ID = 'plan-test-123';

function makeWorkerResult(taskId: string, overrides?: Partial<WorkerResult>): WorkerResult {
  return {
    taskId,
    model: 'glm-5-turbo',
    worktreePath: '/tmp/wt',
    branch: 'test-branch',
    sessionId: `session-${taskId}`,
    output: [{ type: 'assistant', content: 'done', timestamp: Date.now() }],
    changedFiles: ['foo.ts'],
    success: true,
    duration_ms: 1000,
    token_usage: { input: 100, output: 50 },
    discuss_triggered: false,
    discuss_results: [],
    ...overrides,
  };
}

describe('result-store', () => {
  beforeEach(() => {
    if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true });
    fs.mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true });
  });

  describe('saveWorkerResult + loadWorkerResult', () => {
    it('round-trips a worker result', () => {
      const result = makeWorkerResult('task-a');
      saveWorkerResult(PLAN_ID, TMP_DIR, result);
      const loaded = loadWorkerResult(PLAN_ID, TMP_DIR, 'task-a');
      expect(loaded).not.toBeNull();
      expect(loaded!.taskId).toBe('task-a');
      expect(loaded!.model).toBe('glm-5-turbo');
      expect(loaded!.success).toBe(true);
    });

    it('returns null for missing task', () => {
      expect(loadWorkerResult(PLAN_ID, TMP_DIR, 'nonexistent')).toBeNull();
    });

    it('truncates output to 20 messages', () => {
      const messages = Array.from({ length: 30 }, (_, i) => ({
        type: 'assistant' as const,
        content: `msg-${i}`,
        timestamp: Date.now(),
      }));
      const result = makeWorkerResult('task-big', { output: messages });
      saveWorkerResult(PLAN_ID, TMP_DIR, result);
      const loaded = loadWorkerResult(PLAN_ID, TMP_DIR, 'task-big');
      expect(loaded!.output).toHaveLength(20);
      expect(loaded!.output[0].content).toBe('msg-10');
    });
  });

  describe('saveCheckpoint + loadCheckpoint', () => {
    it('round-trips a checkpoint', () => {
      const cp: PlanCheckpoint = {
        plan_id: PLAN_ID,
        completed_groups: 2,
        completed_task_ids: ['task-a', 'task-b'],
        context_cache: {
          'task-a': {
            from_task: 'task-a',
            summary: 'did stuff',
            key_outputs: [],
            decisions_made: ['use X'],
          },
        },
        worker_results_refs: ['task-a', 'task-b'],
        updated_at: new Date().toISOString(),
      };
      saveCheckpoint(PLAN_ID, TMP_DIR, cp);
      const loaded = loadCheckpoint(PLAN_ID, TMP_DIR);
      expect(loaded).not.toBeNull();
      expect(loaded!.completed_groups).toBe(2);
      expect(loaded!.completed_task_ids).toEqual(['task-a', 'task-b']);
      expect(loaded!.context_cache['task-a'].summary).toBe('did stuff');
    });

    it('returns null when no checkpoint exists', () => {
      expect(loadCheckpoint('no-such-plan', TMP_DIR)).toBeNull();
    });

    it('overwrites previous checkpoint', () => {
      const cp1: PlanCheckpoint = {
        plan_id: PLAN_ID, completed_groups: 1,
        completed_task_ids: ['task-a'], context_cache: {},
        worker_results_refs: ['task-a'], updated_at: new Date().toISOString(),
      };
      saveCheckpoint(PLAN_ID, TMP_DIR, cp1);

      const cp2: PlanCheckpoint = { ...cp1, completed_groups: 3 };
      saveCheckpoint(PLAN_ID, TMP_DIR, cp2);

      const loaded = loadCheckpoint(PLAN_ID, TMP_DIR);
      expect(loaded!.completed_groups).toBe(3);
    });
  });

  describe('saveFinalResult', () => {
    it('writes final.json with truncated outputs', () => {
      const messages = Array.from({ length: 25 }, (_, i) => ({
        type: 'assistant' as const,
        content: `msg-${i}`,
        timestamp: Date.now(),
      }));
      const result: OrchestratorResult = {
        plan: { id: PLAN_ID, goal: 'test', cwd: TMP_DIR, tasks: [], execution_order: [], context_flow: {}, created_at: '' },
        worker_results: [makeWorkerResult('task-a', { output: messages })],
        review_results: [],
        score_updates: [],
        total_duration_ms: 5000,
        cost_estimate: { opus_tokens: 0, sonnet_tokens: 0, haiku_tokens: 0, domestic_tokens: 100, estimated_cost_usd: 0.01 },
      };
      saveFinalResult(PLAN_ID, TMP_DIR, result);

      const filePath = path.join(TMP_DIR, '.ai', 'results', PLAN_ID, 'final.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(loaded.worker_results[0].output).toHaveLength(20);
    });
  });
});
