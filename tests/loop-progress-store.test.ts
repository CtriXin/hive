// tests/loop-progress-store.test.ts — Phase 3A: Loop Progress Store Tests

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { writeLoopProgress, readLoopProgress, type LoopPhase } from '../orchestrator/loop-progress-store.js';
import type { CollabStatusSnapshot } from '../orchestrator/types.js';

const TEST_CWD = path.join(process.cwd(), '.test-tmp', 'loop-progress');

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

describe('LoopProgressStore', () => {
  const TEST_RUN_ID = 'run-test-123';

  describe('writeLoopProgress', () => {
    it('should write progress artifact to disk', () => {
      writeLoopProgress(TEST_CWD, TEST_RUN_ID, {
        run_id: TEST_RUN_ID,
        round: 1,
        phase: 'executing',
        reason: 'Dispatching tasks to workers',
        focus_task_id: 'task-a',
        focus_model: 'qwen3.5-plus',
        focus_summary: 'Implementing schema changes',
      });

      const progressPath = path.join(TEST_CWD, '.ai', 'runs', TEST_RUN_ID, 'loop-progress.json');
      expect(fs.existsSync(progressPath)).toBe(true);

      const content = fs.readFileSync(progressPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.run_id).toBe(TEST_RUN_ID);
      expect(parsed.round).toBe(1);
      expect(parsed.phase).toBe('executing');
      expect(parsed.focus_task_id).toBe('task-a');
      expect(typeof parsed.updated_at).toBe('string');
    });

    it('should create directory if it does not exist', () => {
      const newRunId = 'run-new-dir-test';
      writeLoopProgress(TEST_CWD, newRunId, {
        run_id: newRunId,
        round: 0,
        phase: 'planning',
        reason: 'Generating initial plan',
      });

      const progressPath = path.join(TEST_CWD, '.ai', 'runs', newRunId, 'loop-progress.json');
      expect(fs.existsSync(progressPath)).toBe(true);
    });

    it('should preserve planner_discuss_conclusion across updates', () => {
      // First write with discuss conclusion
      writeLoopProgress(TEST_CWD, TEST_RUN_ID, {
        run_id: TEST_RUN_ID,
        round: 0,
        phase: 'planning',
        reason: 'Plan generated',
        planner_model: 'claude-opus-4-6',
        planner_discuss_conclusion: {
          quality_gate: 'pass',
          overall_assessment: 'Plan looks solid',
        },
      });

      // Second write without discuss conclusion
      writeLoopProgress(TEST_CWD, TEST_RUN_ID, {
        run_id: TEST_RUN_ID,
        round: 1,
        phase: 'executing',
        reason: 'Dispatching tasks',
      });

      const progress = readLoopProgress(TEST_CWD, TEST_RUN_ID);
      expect(progress).not.toBe(null);
      expect(progress?.planner_discuss_conclusion?.quality_gate).toBe('pass');
      expect(progress?.phase).toBe('executing'); // New phase updated
    });

    it('should include collab snapshot when provided', () => {
      const collabSnapshot: CollabStatusSnapshot = {
        card: {
          room_id: 'room-123',
          room_kind: 'plan',
          status: 'active',
          replies: 2,
          next: 'Waiting for partner response',
          created_at: new Date().toISOString(),
        },
        recent_events: [],
      };

      writeLoopProgress(TEST_CWD, TEST_RUN_ID, {
        run_id: TEST_RUN_ID,
        round: 0,
        phase: 'discussing',
        reason: 'Planner discuss in progress',
        collab: collabSnapshot,
      });

      const progress = readLoopProgress(TEST_CWD, TEST_RUN_ID);
      expect(progress?.collab?.card.room_id).toBe('room-123');
      expect(progress?.collab?.card.replies).toBe(2);
    });
  });

  describe('readLoopProgress', () => {
    it('should return null for non-existent run', () => {
      const progress = readLoopProgress(TEST_CWD, 'run-non-existent');
      expect(progress).toBe(null);
    });

    it('should return null for malformed JSON', () => {
      const progressDir = path.join(TEST_CWD, '.ai', 'runs', TEST_RUN_ID);
      fs.mkdirSync(progressDir, { recursive: true });
      const progressPath = path.join(progressDir, 'loop-progress.json');
      fs.writeFileSync(progressPath, 'invalid json {{{', 'utf-8');

      const progress = readLoopProgress(TEST_CWD, TEST_RUN_ID);
      expect(progress).toBe(null);
    });

    it('should read previously written progress', () => {
      const initialProgress = {
        run_id: TEST_RUN_ID,
        round: 2,
        phase: 'reviewing' as LoopPhase,
        reason: 'Review cascade in progress',
        focus_task_id: 'task-b',
        focus_summary: 'Security review',
      };

      writeLoopProgress(TEST_CWD, TEST_RUN_ID, initialProgress);
      const progress = readLoopProgress(TEST_CWD, TEST_RUN_ID);

      expect(progress).not.toBe(null);
      expect(progress?.run_id).toBe(TEST_RUN_ID);
      expect(progress?.round).toBe(2);
      expect(progress?.phase).toBe('reviewing');
      expect(progress?.focus_task_id).toBe('task-b');
    });
  });

  describe('phase transitions', () => {
    it('should track full loop progression', () => {
      const phases: LoopPhase[] = ['planning', 'executing', 'reviewing', 'verifying', 'done'];

      for (const phase of phases) {
        writeLoopProgress(TEST_CWD, TEST_RUN_ID, {
          run_id: TEST_RUN_ID,
          round: 1,
          phase,
          reason: `Transitioned to ${phase}`,
        });
      }

      const progress = readLoopProgress(TEST_CWD, TEST_RUN_ID);
      expect(progress?.phase).toBe('done');
    });

    it('should handle repair round progression', () => {
      // Initial execution
      writeLoopProgress(TEST_CWD, TEST_RUN_ID, {
        run_id: TEST_RUN_ID,
        round: 1,
        phase: 'executing',
        reason: 'First execution round',
      });

      // Repair round
      writeLoopProgress(TEST_CWD, TEST_RUN_ID, {
        run_id: TEST_RUN_ID,
        round: 2,
        phase: 'repairing',
        reason: 'Repairing failed tasks',
        focus_task_id: 'task-failed',
      });

      const progress = readLoopProgress(TEST_CWD, TEST_RUN_ID);
      expect(progress?.round).toBe(2);
      expect(progress?.phase).toBe('repairing');
      expect(progress?.focus_task_id).toBe('task-failed');
    });
  });

  describe('focus tracking', () => {
    it('should track focus task changes', () => {
      writeLoopProgress(TEST_CWD, TEST_RUN_ID, {
        run_id: TEST_RUN_ID,
        round: 1,
        phase: 'executing',
        reason: 'Dispatching task-a',
        focus_task_id: 'task-a',
        focus_summary: 'Schema definition',
      });

      writeLoopProgress(TEST_CWD, TEST_RUN_ID, {
        run_id: TEST_RUN_ID,
        round: 1,
        phase: 'executing',
        reason: 'Dispatching task-b',
        focus_task_id: 'task-b',
        focus_summary: 'API implementation',
      });

      const progress = readLoopProgress(TEST_CWD, TEST_RUN_ID);
      expect(progress?.focus_task_id).toBe('task-b'); // Latest focus
    });

    it('should track focus model', () => {
      writeLoopProgress(TEST_CWD, TEST_RUN_ID, {
        run_id: TEST_RUN_ID,
        round: 1,
        phase: 'executing',
        reason: 'Using specialized model',
        focus_task_id: 'task-security',
        focus_model: 'claude-opus-4-6',
        focus_summary: 'Security-critical implementation',
      });

      const progress = readLoopProgress(TEST_CWD, TEST_RUN_ID);
      expect(progress?.focus_model).toBe('claude-opus-4-6');
    });
  });
});
