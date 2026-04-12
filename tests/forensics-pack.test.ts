// tests/forensics-pack.test.ts — Phase 3A: Forensics Pack Tests

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  buildForensicsPack,
  saveForensicsPack,
  loadForensicsPack,
  listForensicsPacks,
  summarizeForensics,
  generateForensicsForFailedTasks,
  getForensicsDir,
  getForensicPackPath,
} from '../orchestrator/forensics-pack.js';
import type { TaskStateRecord, ReviewResult, VerificationResult, WorkerResult } from '../orchestrator/types.js';
import { recordTaskTransition } from '../orchestrator/run-transition-log.js';

const TEST_CWD = path.join(process.cwd(), '.test-tmp', 'forensics-pack');

function cleanup(): void {
  if (fs.existsSync(TEST_CWD)) {
    fs.rmSync(TEST_CWD, { recursive: true, force: true });
  }
}

beforeEach(() => {
  cleanup();
  fs.mkdirSync(TEST_CWD, { recursive: true });
});

afterEach(() => {
  cleanup();
});

describe('ForensicsPack', () => {
  const TEST_RUN_ID = 'run-test-456';
  const TEST_TASK_ID = 'task-failed-123';

  function createTestTaskState(
    status: TaskStateRecord['status'],
    failureClass?: string,
  ): TaskStateRecord {
    return {
      task_id: TEST_TASK_ID,
      status,
      round: 1,
      changed_files: [],
      merged: false,
      worker_success: false,
      review_passed: false,
      retry_count: 1,
      can_repair: true,
      can_replan: true,
      is_resumable: true,
      failure_class: failureClass as any,
      terminal_reason: 'review_failed',
    };
  }

  function createTestWorkerResult(overrides?: Partial<WorkerResult>): WorkerResult {
    return {
      taskId: TEST_TASK_ID,
      model: 'qwen3.5-plus',
      worktreePath: '/tmp/worktree-test',
      branch: 'worker-task-failed-123',
      sessionId: 'session-test',
      output: [],
      changedFiles: ['src/schema.ts', 'src/utils.ts'],
      success: true,
      duration_ms: 15000,
      token_usage: { input: 5000, output: 2000 },
      discuss_triggered: false,
      discuss_results: [],
      ...overrides,
    };
  }

  function createTestReviewResult(overrides?: Partial<ReviewResult>): ReviewResult {
    return {
      taskId: TEST_TASK_ID,
      final_stage: 'cross-review',
      passed: false,
      findings: [
        {
          id: 1,
          severity: 'red',
          lens: 'challenger',
          file: 'src/schema.ts',
          line: 42,
          issue: 'Missing input validation on user_id field',
          decision: 'flag',
        },
        {
          id: 2,
          severity: 'yellow',
          lens: 'architect',
          file: 'src/utils.ts',
          line: 15,
          issue: 'Consider extracting this to a separate module',
          decision: 'flag',
        },
      ],
      iterations: 1,
      duration_ms: 8000,
      ...overrides,
    };
  }

  function createTestVerificationResult(
    passed: boolean,
    type: string,
  ): VerificationResult {
    return {
      target: {
        type: type as any,
        label: `npm run ${type}`,
        command: `npm run ${type}`,
        must_pass: true,
        timeout_ms: 60000,
      },
      passed,
      exit_code: passed ? 0 : 1,
      stdout_tail: passed ? 'Build succeeded' : '',
      stderr_tail: passed ? '' : 'Error: TypeScript compilation failed',
      duration_ms: 5000,
      failure_class: passed ? undefined : ('build_fail' as any),
    };
  }

  describe('buildForensicsPack', () => {
    it('should build forensic pack for failed task', () => {
      const taskState = createTestTaskState('review_failed', 'review');
      const worker = createTestWorkerResult();
      const review = createTestReviewResult();

      const pack = buildForensicsPack(
        TEST_CWD,
        TEST_RUN_ID,
        TEST_TASK_ID,
        taskState,
        worker,
        review,
      );

      expect(pack.task_id).toBe(TEST_TASK_ID);
      expect(pack.run_id).toBe(TEST_RUN_ID);
      expect(pack.final_status).toBe('review_failed');
      expect(pack.failure_class).toBe('review');
      expect(pack.retry_count).toBe(1);
      expect(pack.worker_summary?.success).toBe(true);
      expect(pack.worker_summary?.changed_files_count).toBe(2);
      expect(pack.review_summary?.passed).toBe(false);
      expect(pack.review_summary?.red_count).toBe(1);
      expect(pack.review_summary?.yellow_count).toBe(1);
      expect(typeof pack.generated_at).toBe('string');
    });

    it('should include verification summary when provided', () => {
      const taskState = createTestTaskState('verification_failed', 'build');
      const verificationResults = [
        createTestVerificationResult(false, 'build'),
      ];

      const pack = buildForensicsPack(
        TEST_CWD,
        TEST_RUN_ID,
        TEST_TASK_ID,
        taskState,
        undefined,
        undefined,
        verificationResults,
      );

      expect(pack.verification_summary).toBeDefined();
      expect(pack.verification_summary?.total_checks).toBe(1);
      expect(pack.verification_summary?.failed_checks).toBe(1);
    });

    it('should include smoke passed status', () => {
      const taskState = createTestTaskState('verification_failed', 'build');
      const verificationResults = [
        createTestVerificationResult(false, 'build'),
      ];

      const pack = buildForensicsPack(
        TEST_CWD,
        TEST_RUN_ID,
        TEST_TASK_ID,
        taskState,
        undefined,
        undefined,
        verificationResults,
        false, // smokePassed = false
      );

      expect(pack.verification_summary?.smoke_passed).toBe(false);
    });

    it('should include transition tail', () => {
      const taskState = createTestTaskState('review_failed', 'review');

      // Record some transitions
      recordTaskTransition(TEST_CWD, {
        run_id: TEST_RUN_ID,
        status: 'executing',
        round: 1,
        completed_task_ids: [],
        failed_task_ids: [],
        review_failed_task_ids: [],
        merged_task_ids: [],
        retry_counts: {},
        replan_count: 0,
        task_states: {},
        task_verification_results: {},
        repair_history: [],
        round_cost_history: [],
        policy_hook_results: [],
        verification_results: [],
        updated_at: new Date().toISOString(),
        transition_log: [],
      } as any, TEST_TASK_ID, 'pending', 'Task dispatched', 1);

      recordTaskTransition(TEST_CWD, {
        run_id: TEST_RUN_ID,
        status: 'executing',
        round: 1,
        completed_task_ids: [],
        failed_task_ids: [],
        review_failed_task_ids: [],
        merged_task_ids: [],
        retry_counts: {},
        replan_count: 0,
        task_states: {},
        task_verification_results: {},
        repair_history: [],
        round_cost_history: [],
        policy_hook_results: [],
        verification_results: [],
        updated_at: new Date().toISOString(),
        transition_log: [],
      } as any, TEST_TASK_ID, 'pending', 'worker_failed', 'Worker failed', 1);

      const pack = buildForensicsPack(
        TEST_CWD,
        TEST_RUN_ID,
        TEST_TASK_ID,
        taskState,
      );

      expect(pack.transition_tail.length).toBeGreaterThan(0);
    });

    it('should generate correct context pack path', () => {
      const taskState = createTestTaskState('review_failed', 'review');
      const pack = buildForensicsPack(
        TEST_CWD,
        TEST_RUN_ID,
        TEST_TASK_ID,
        taskState,
      );

      expect(pack.context_pack_path).toContain('.ai/runs');
      expect(pack.context_pack_path).toContain('context-pack');
    });
  });

  describe('saveForensicsPack and loadForensicsPack', () => {
    it('should save and load forensic pack', () => {
      const taskState = createTestTaskState('review_failed', 'review');
      const pack = buildForensicsPack(
        TEST_CWD,
        TEST_RUN_ID,
        TEST_TASK_ID,
        taskState,
      );

      const savedPath = saveForensicsPack(TEST_CWD, TEST_RUN_ID, pack);
      expect(fs.existsSync(savedPath)).toBe(true);

      const loaded = loadForensicsPack(TEST_CWD, TEST_RUN_ID, TEST_TASK_ID);
      expect(loaded).not.toBe(null);
      expect(loaded?.task_id).toBe(TEST_TASK_ID);
      expect(loaded?.failure_class).toBe('review');
    });

    it('should return null for non-existent pack', () => {
      const loaded = loadForensicsPack(TEST_CWD, 'run-non-existent', TEST_TASK_ID);
      expect(loaded).toBe(null);
    });
  });

  describe('listForensicsPacks', () => {
    it('should return empty array for run with no forensics', () => {
      const packs = listForensicsPacks(TEST_CWD, TEST_RUN_ID);
      expect(packs).toEqual([]);
    });

    it('should list all forensic packs for a run', () => {
      const task1 = 'task-fail-1';
      const task2 = 'task-fail-2';

      const pack1 = buildForensicsPack(TEST_CWD, TEST_RUN_ID, task1, createTestTaskState('review_failed'));
      const pack2 = buildForensicsPack(TEST_CWD, TEST_RUN_ID, task2, createTestTaskState('verification_failed'));

      saveForensicsPack(TEST_CWD, TEST_RUN_ID, pack1);
      saveForensicsPack(TEST_CWD, TEST_RUN_ID, pack2);

      const packs = listForensicsPacks(TEST_CWD, TEST_RUN_ID);
      expect(packs.length).toBe(2);
      expect(packs.map((p) => p.task_id).sort()).toEqual([task1, task2].sort());
    });
  });

  describe('summarizeForensics', () => {
    it('should return message for empty packs', () => {
      const summary = summarizeForensics([]);
      expect(summary).toBe('No forensic packs available');
    });

    it('should summarize multiple packs', () => {
      const packs = [
        buildForensicsPack(TEST_CWD, TEST_RUN_ID, 'task-1', createTestTaskState('review_failed', 'review')),
        buildForensicsPack(TEST_CWD, TEST_RUN_ID, 'task-2', createTestTaskState('verification_failed', 'build')),
      ];

      const summary = summarizeForensics(packs);
      expect(summary).toContain('2 failed tasks');
      expect(summary).toContain('task-1');
      expect(summary).toContain('task-2');
    });
  });

  describe('generateForensicsForFailedTasks', () => {
    it('should generate packs for all failed tasks', () => {
      const taskStates: Record<string, TaskStateRecord> = {
        'task-fail-1': createTestTaskState('review_failed', 'review'),
        'task-fail-2': createTestTaskState('verification_failed', 'build'),
        'task-pass': createTestTaskState('verified'),
      };

      const workerResults = [
        createTestWorkerResult({ taskId: 'task-fail-1' }),
        createTestWorkerResult({ taskId: 'task-fail-2' }),
        createTestWorkerResult({ taskId: 'task-pass' }),
      ];

      const reviewResults = [
        createTestReviewResult({ taskId: 'task-fail-1' }),
        createTestReviewResult({ taskId: 'task-fail-2' }),
      ];

      const packs = generateForensicsForFailedTasks(
        TEST_CWD,
        TEST_RUN_ID,
        taskStates,
        workerResults,
        reviewResults,
        {},
      );

      expect(packs.length).toBe(2); // Only failed tasks
      expect(packs.map((p) => p.task_id).sort()).toEqual(['task-fail-1', 'task-fail-2'].sort());

      // Verify files were written
      const forensicsDir = getForensicsDir(TEST_CWD, TEST_RUN_ID);
      expect(fs.existsSync(forensicsDir)).toBe(true);
      expect(fs.readdirSync(forensicsDir).length).toBe(2);
    });

    it('should include smoke results when provided', () => {
      const taskStates: Record<string, TaskStateRecord> = {
        'task-smoke-fail': createTestTaskState('verification_failed', 'build'),
      };

      const packs = generateForensicsForFailedTasks(
        TEST_CWD,
        TEST_RUN_ID,
        taskStates,
        [createTestWorkerResult({ taskId: 'task-smoke-fail' })],
        [],
        { 'task-smoke-fail': [createTestVerificationResult(false, 'build')] },
        { 'task-smoke-fail': false }, // smoke failed
      );

      expect(packs.length).toBe(1);
      expect(packs[0].verification_summary?.smoke_passed).toBe(false);
    });
  });

  describe('failure class tracking', () => {
    it('should preserve failure_class from task state', () => {
      const failureClasses: Array<TaskStateRecord['failure_class']> = [
        'provider',
        'build',
        'review',
        'context',
        'no_op',
      ];

      for (const failureClass of failureClasses) {
        const taskState = createTestTaskState('review_failed', failureClass);
        const pack = buildForensicsPack(TEST_CWD, TEST_RUN_ID, TEST_TASK_ID, taskState);
        expect(pack.failure_class).toBe(failureClass);
      }
    });

    it('should default to unknown for missing failure_class', () => {
      const taskState = createTestTaskState('review_failed');
      delete (taskState as any).failure_class;

      const pack = buildForensicsPack(TEST_CWD, TEST_RUN_ID, TEST_TASK_ID, taskState);
      expect(pack.failure_class).toBe('unknown');
    });
  });
});
