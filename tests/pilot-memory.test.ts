import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { LessonRecord, AdoptionReceipt, PilotLessonsStore } from '../orchestrator/pilot-types.js';
import { PILOT_SCHEMA_VERSION, MAX_LESSONS } from '../orchestrator/pilot-types.js';
import {
  loadStore,
  saveStore,
  appendLesson,
  appendAdoptionReceipt,
  readAdoptionLog,
  resolveLessonsDir,
} from '../orchestrator/pilot-memory.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-mem-test-'));
}

function makeLesson(overrides: Partial<LessonRecord> = {}): LessonRecord {
  return {
    lesson_id: `les-test-${Math.random().toString(36).slice(2, 8)}`,
    created_at: new Date().toISOString(),
    source_kind: 'discuss',
    task_category: 'backend',
    task_fingerprint: JSON.stringify({ role: 'implementation', domains: ['backend'], complexity: 'medium' }),
    worker_model: 'test-model',
    reviewer_model: 'test-reviewer',
    symptom: 'scope creep in worker output',
    rule: 'Constrain file list explicitly',
    evidence: 'Worker modified 3 extra files',
    outcome: 'unknown',
    adoption_count: 0,
    helped_count: 0,
    ...overrides,
  };
}

describe('pilot-memory', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── loadStore ──

  describe('loadStore', () => {
    it('returns empty store when dir does not exist', () => {
      tmpDir = makeTmpDir();
      const store = loadStore(path.join(tmpDir, 'nonexistent'));
      expect(store.lessons).toEqual([]);
      expect(store.schema_version).toBe(PILOT_SCHEMA_VERSION);
    });

    it('loads a valid store', () => {
      tmpDir = makeTmpDir();
      const lesson = makeLesson();
      const dir = path.join(tmpDir, '.ai', 'pilot-lessons');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'lessons.json'),
        JSON.stringify({ schema_version: PILOT_SCHEMA_VERSION, lessons: [lesson] }),
      );
      const store = loadStore(tmpDir);
      expect(store.lessons).toHaveLength(1);
      expect(store.lessons[0].lesson_id).toBe(lesson.lesson_id);
    });

    it('returns empty on corrupt JSON', () => {
      tmpDir = makeTmpDir();
      const dir = path.join(tmpDir, '.ai', 'pilot-lessons');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'lessons.json'), '{not valid json');
      const store = loadStore(tmpDir);
      expect(store.lessons).toEqual([]);
    });

    it('returns empty when lessons field is not an array', () => {
      tmpDir = makeTmpDir();
      const dir = path.join(tmpDir, '.ai', 'pilot-lessons');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'lessons.json'),
        JSON.stringify({ schema_version: '1.0', lessons: 'oops' }),
      );
      const store = loadStore(tmpDir);
      expect(store.lessons).toEqual([]);
    });
  });

  // ── saveStore + roundtrip ──

  describe('saveStore', () => {
    it('roundtrips a store through save then load', () => {
      tmpDir = makeTmpDir();
      const lessons = [makeLesson(), makeLesson()];
      saveStore({ schema_version: PILOT_SCHEMA_VERSION, lessons }, tmpDir);
      const loaded = loadStore(tmpDir);
      expect(loaded.lessons).toHaveLength(2);
    });

    it('dedupes by lesson_id keeping newer', () => {
      tmpDir = makeTmpDir();
      const id = 'les-dup-001';
      const old = makeLesson({ lesson_id: id, created_at: '2026-01-01T00:00:00Z' });
      const new_ = makeLesson({ lesson_id: id, created_at: '2026-06-01T00:00:00Z' });
      saveStore({ schema_version: PILOT_SCHEMA_VERSION, lessons: [old, new_] }, tmpDir);
      const loaded = loadStore(tmpDir);
      expect(loaded.lessons).toHaveLength(1);
      expect(loaded.lessons[0].created_at).toBe('2026-06-01T00:00:00Z');
    });

    it('caps lessons to MAX_LESSONS keeping newest', () => {
      tmpDir = makeTmpDir();
      const lessons: LessonRecord[] = [];
      for (let i = 0; i < MAX_LESSONS + 10; i++) {
        lessons.push(makeLesson({
          lesson_id: `les-cap-${i}`,
          created_at: new Date(Date.now() + i * 1000).toISOString(),
        }));
      }
      saveStore({ schema_version: PILOT_SCHEMA_VERSION, lessons }, tmpDir);
      const loaded = loadStore(tmpDir);
      expect(loaded.lessons).toHaveLength(MAX_LESSONS);
    });
  });

  // ── appendLesson ──

  describe('appendLesson', () => {
    it('appends to existing store', () => {
      tmpDir = makeTmpDir();
      const l1 = makeLesson({ lesson_id: 'les-a1' });
      const l2 = makeLesson({ lesson_id: 'les-a2' });
      appendLesson(l1, tmpDir);
      appendLesson(l2, tmpDir);
      const store = loadStore(tmpDir);
      expect(store.lessons).toHaveLength(2);
    });

    it('creates store from scratch', () => {
      tmpDir = makeTmpDir();
      const lesson = makeLesson();
      appendLesson(lesson, tmpDir);
      const store = loadStore(tmpDir);
      expect(store.lessons).toHaveLength(1);
    });

    it('dedupes on append', () => {
      tmpDir = makeTmpDir();
      const id = 'les-dup-app';
      appendLesson(makeLesson({ lesson_id: id, symptom: 'old', created_at: '2026-01-01T00:00:00Z' }), tmpDir);
      appendLesson(makeLesson({ lesson_id: id, symptom: 'new', created_at: '2026-06-01T00:00:00Z' }), tmpDir);
      const store = loadStore(tmpDir);
      expect(store.lessons).toHaveLength(1);
      expect(store.lessons[0].symptom).toBe('new');
    });
  });

  // ── Adoption log ──

  describe('adoption log', () => {
    it('appends and reads receipts', () => {
      tmpDir = makeTmpDir();
      const r1: AdoptionReceipt = {
        run_id: 'run-1',
        task_id: 'task-1',
        used_lessons: ['les-1'],
        adopted_lessons: [],
        ignored_lessons: ['les-1'],
        still_failed_patterns: [],
        final_outcome: 'pass',
        created_at: new Date().toISOString(),
      };
      appendAdoptionReceipt(r1, tmpDir);
      const log = readAdoptionLog(tmpDir);
      expect(log).toHaveLength(1);
      expect(log[0].run_id).toBe('run-1');
    });

    it('returns empty array when no log file', () => {
      tmpDir = makeTmpDir();
      const log = readAdoptionLog(tmpDir);
      expect(log).toEqual([]);
    });

    it('returns empty on corrupt log', () => {
      tmpDir = makeTmpDir();
      const dir = path.join(tmpDir, '.ai', 'pilot-lessons');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'adoption-log.jsonl'), 'not json\n');
      const log = readAdoptionLog(tmpDir);
      expect(log).toEqual([]);
    });

    it('appends multiple receipts preserving order', () => {
      tmpDir = makeTmpDir();
      appendAdoptionReceipt({ run_id: 'r1', task_id: 't1', used_lessons: [], adopted_lessons: [], ignored_lessons: [], still_failed_patterns: [], final_outcome: 'pass', created_at: '2026-01-01T00:00:00Z' }, tmpDir);
      appendAdoptionReceipt({ run_id: 'r2', task_id: 't2', used_lessons: [], adopted_lessons: [], ignored_lessons: [], still_failed_patterns: [], final_outcome: 'fail', created_at: '2026-01-02T00:00:00Z' }, tmpDir);
      const log = readAdoptionLog(tmpDir);
      expect(log).toHaveLength(2);
      expect(log[0].run_id).toBe('r1');
      expect(log[1].run_id).toBe('r2');
    });
  });

  // ── resolveLessonsDir ──

  describe('resolveLessonsDir', () => {
    it('uses provided cwd', () => {
      const dir = resolveLessonsDir('/tmp/my-project');
      expect(dir).toBe(path.resolve('/tmp/my-project', '.ai', 'pilot-lessons'));
    });

    it('defaults to process.cwd()', () => {
      const dir = resolveLessonsDir();
      expect(dir).toContain('.ai');
      expect(dir).toContain('pilot-lessons');
    });
  });
});
