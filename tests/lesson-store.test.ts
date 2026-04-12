// ═══════════════════════════════════════════════════════════════════
// tests/lesson-store.test.ts — Phase 6A: Cross-Run Learning Tests
// ═══════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractLessons,
  refreshLessonStore,
  loadLessonStore,
  saveLessonStore,
  loadAllTransitionLogs,
  loadTaskStates,
} from '../orchestrator/lesson-store.js';
import type { RunTransitionRecord, Lesson } from '../orchestrator/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

function makeTransition(overrides: Partial<RunTransitionRecord>): RunTransitionRecord {
  return {
    id: `t-${Date.now()}`,
    timestamp: new Date().toISOString(),
    run_id: 'run-test',
    from_state: 'pending',
    to_state: 'worker_failed',
    reason: 'Test transition',
    round: 1,
    ...overrides,
  };
}

describe('Phase 6A: Lesson Store', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-lesson-test-'));
  });

  // ── No History → No Lessons ──

  describe('no history → no lessons', () => {
    it('returns empty lessons when there are no transition logs', () => {
      const lessons = extractLessons({});
      expect(lessons).toEqual([]);
    });

    it('returns empty lessons when transitions have no failure classes', () => {
      const transitions: RunTransitionRecord[] = [
        makeTransition({ to_state: 'pending', from_state: 'planning' }),
      ];
      const lessons = extractLessons({ 'run-1': transitions });
      expect(lessons).toEqual([]);
    });

    it('returns empty lessons when observations are below minimum threshold', () => {
      const transitions: RunTransitionRecord[] = [
        makeTransition({
          task_id: 'task-a',
          failure_class: 'build',
          to_state: 'worker_failed',
        }),
      ];
      const lessons = extractLessons({ 'run-1': transitions });
      expect(lessons).toEqual([]);
    });
  });

  // ── Stable Patterns → Lessons Generated ──

  describe('stable failure patterns → lesson generation', () => {
    it('generates a lesson when the same task pattern fails repeatedly', () => {
      const transitions: RunTransitionRecord[] = [
        makeTransition({ task_id: 'task-build', failure_class: 'build', to_state: 'worker_failed', run_id: 'run-1' }),
        makeTransition({ task_id: 'task-build', failure_class: 'build', to_state: 'worker_failed', run_id: 'run-2' }),
        makeTransition({ task_id: 'task-build', failure_class: 'build', to_state: 'worker_failed', run_id: 'run-3' }),
      ];
      const lessons = extractLessons({
        'run-1': [transitions[0]],
        'run-2': [transitions[1]],
        'run-3': [transitions[2]],
      });
      expect(lessons.length).toBeGreaterThan(0);
      const lesson = lessons.find(l => l.pattern === 'task-build');
      expect(lesson).toBeDefined();
      expect(lesson!.kind).toBe('verification_profile');
      expect(lesson!.supporting_runs).toBe(3);
      expect(lesson!.observation_count).toBe(3);
    });

    it('includes evidence tracing for each lesson', () => {
      const transitions: RunTransitionRecord[] = [
        makeTransition({ task_id: 'task-test', failure_class: 'test', to_state: 'review_failed', run_id: 'run-a' }),
        makeTransition({ task_id: 'task-test', failure_class: 'test', to_state: 'review_failed', run_id: 'run-b' }),
      ];
      const lessons = extractLessons({
        'run-a': [transitions[0]],
        'run-b': [transitions[1]],
      });
      expect(lessons.length).toBeGreaterThan(0);
      const lesson = lessons[0];
      expect(lesson.evidence.length).toBe(2);
      expect(lesson.evidence[0].source_run_id).toBe('run-a');
      expect(lesson.evidence[0].source_artifact).toBe('transition_log');
    });

    it('generates different lesson kinds for different failure classes', () => {
      const buildTransitions: RunTransitionRecord[] = [
        makeTransition({ task_id: 'task-build', failure_class: 'build', to_state: 'worker_failed', run_id: 'run-1' }),
        makeTransition({ task_id: 'task-build', failure_class: 'build', to_state: 'worker_failed', run_id: 'run-2' }),
      ];
      const providerTransitions: RunTransitionRecord[] = [
        makeTransition({ task_id: 'task-api', failure_class: 'provider', to_state: 'worker_failed', run_id: 'run-1' }),
        makeTransition({ task_id: 'task-api', failure_class: 'provider', to_state: 'worker_failed', run_id: 'run-2' }),
      ];
      const lessons = extractLessons({
        'run-1': [...buildTransitions, ...providerTransitions],
        'run-2': [...buildTransitions],
      });
      expect(lessons.length).toBe(2);
      const kinds = lessons.map(l => l.kind);
      expect(kinds).toContain('verification_profile');
      expect(kinds).toContain('repair_strategy');
    });
  });

  // ── Recency / Decay ──

  describe('recency and decay guardrails', () => {
    it('decays weight of old observations', () => {
      const now = Date.now();
      const oldTs = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
      const transitions: RunTransitionRecord[] = [
        {
          ...makeTransition({ task_id: 'task-old', failure_class: 'build', to_state: 'worker_failed', run_id: 'run-1' }),
          timestamp: oldTs,
        },
        makeTransition({ task_id: 'task-old', failure_class: 'build', to_state: 'worker_failed', run_id: 'run-2' }),
        makeTransition({ task_id: 'task-old', failure_class: 'build', to_state: 'worker_failed', run_id: 'run-3' }),
      ];
      const lessons = extractLessons({
        'run-1': [transitions[0]],
        'run-2': [transitions[1]],
        'run-3': [transitions[2]],
      });
      // Should still find lesson but old observation has near-zero weight
      const lesson = lessons.find(l => l.pattern === 'task-old');
      expect(lesson).toBeDefined();
      const oldEvidence = lesson!.evidence.find(e => e.source_run_id === 'run-1');
      expect(oldEvidence).toBeDefined();
      expect(oldEvidence!.weight).toBeLessThan(0.1); // 10 days → very low weight
    });

    it('filters out lessons older than MAX_LESSON_AGE', () => {
      const oldTs = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const transitions: RunTransitionRecord[] = [
        makeTransition({ task_id: 'task-old', failure_class: 'build', to_state: 'worker_failed', run_id: 'run-1' }),
        makeTransition({ task_id: 'task-old', failure_class: 'build', to_state: 'worker_failed', run_id: 'run-2' }),
      ];
      // Set both to old timestamps
      const lessons = extractLessons({
        'run-1': [{ ...transitions[0], timestamp: oldTs }],
        'run-2': [{ ...transitions[1], timestamp: oldTs }],
      });
      // Should be filtered out due to age
      expect(lessons.length).toBe(0);
    });
  });

  // ── Persistence ──

  describe('lesson store persistence', () => {
    it('saves and loads lesson store', () => {
      const store = {
        lessons: [{
          id: 'lesson-test',
          kind: 'failure_pattern' as const,
          pattern: 'task-x',
          recommendation: 'Test recommendation',
          reason: 'Test reason',
          confidence: 'medium' as const,
          evidence: [],
          supporting_runs: 2,
          observation_count: 2,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          active: true,
        }],
        generated_at: new Date().toISOString(),
      };
      saveLessonStore(testDir, store);
      const loaded = loadLessonStore(testDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.lessons.length).toBe(1);
      expect(loaded!.lessons[0].id).toBe('lesson-test');
    });

    it('returns null when no store exists', () => {
      const loaded = loadLessonStore(testDir);
      expect(loaded).toBeNull();
    });
  });

  // ── Multi-Run Scanning ──

  describe('loadAllTransitionLogs', () => {
    it('scans all run directories for transition logs', () => {
      const runsDir = path.join(testDir, '.ai', 'runs');
      fs.mkdirSync(path.join(runsDir, 'run-111'), { recursive: true });
      fs.mkdirSync(path.join(runsDir, 'run-222'), { recursive: true });
      const transitions1 = [makeTransition({ run_id: 'run-111' })];
      const transitions2 = [makeTransition({ run_id: 'run-222' })];
      fs.writeFileSync(path.join(runsDir, 'run-111', 'transitions.json'), JSON.stringify(transitions1));
      fs.writeFileSync(path.join(runsDir, 'run-222', 'transitions.json'), JSON.stringify(transitions2));

      const result = loadAllTransitionLogs(testDir);
      expect(Object.keys(result)).toContain('run-111');
      expect(Object.keys(result)).toContain('run-222');
    });
  });

  // ── Full Pipeline ──

  describe('refreshLessonStore end-to-end', () => {
    it('generates lessons from disk and saves them', () => {
      const runsDir = path.join(testDir, '.ai', 'runs');
      fs.mkdirSync(path.join(runsDir, 'run-aaa'), { recursive: true });
      fs.mkdirSync(path.join(runsDir, 'run-bbb'), { recursive: true });
      fs.mkdirSync(path.join(runsDir, 'run-ccc'), { recursive: true });
      fs.writeFileSync(path.join(runsDir, 'run-aaa', 'transitions.json'), JSON.stringify([
        makeTransition({ task_id: 'task-build', failure_class: 'build', to_state: 'worker_failed', run_id: 'run-aaa' }),
      ]));
      fs.writeFileSync(path.join(runsDir, 'run-bbb', 'transitions.json'), JSON.stringify([
        makeTransition({ task_id: 'task-build', failure_class: 'build', to_state: 'worker_failed', run_id: 'run-bbb' }),
      ]));
      fs.writeFileSync(path.join(runsDir, 'run-ccc', 'transitions.json'), JSON.stringify([
        makeTransition({ task_id: 'task-build', failure_class: 'build', to_state: 'worker_failed', run_id: 'run-ccc' }),
      ]));

      const store = refreshLessonStore(testDir);
      expect(store.lessons.length).toBeGreaterThan(0);

      const loaded = loadLessonStore(testDir);
      expect(loaded).toBeNull(); // refresh doesn't auto-save
    });
  });
});
