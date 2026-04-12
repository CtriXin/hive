import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { LessonRecord } from '../orchestrator/pilot-types.js';
import { PILOT_SCHEMA_VERSION, RECALL_TOP_N } from '../orchestrator/pilot-types.js';
import { recall, appendLesson, loadStore } from '../orchestrator/pilot-memory.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-recall-test-'));
}

const FP_IMPL = JSON.stringify({ role: 'implementation', domains: ['backend'], complexity: 'medium' });
const FP_REVIEW = JSON.stringify({ role: 'review', domains: ['typescript'], complexity: 'high' });
const FP_REPAIR = JSON.stringify({ role: 'repair', domains: ['backend'], complexity: 'low' });

function makeLesson(overrides: Partial<LessonRecord> = {}): LessonRecord {
  return {
    lesson_id: `les-recall-${Math.random().toString(36).slice(2, 8)}`,
    created_at: '2026-04-09T00:00:00Z',
    source_kind: 'discuss',
    task_category: 'backend',
    task_fingerprint: FP_IMPL,
    worker_model: 'test-model',
    reviewer_model: 'test-reviewer',
    symptom: 'scope creep',
    rule: 'Constrain file list',
    evidence: 'Worker touched extra files',
    outcome: 'unknown',
    adoption_count: 0,
    helped_count: 0,
    ...overrides,
  };
}

describe('pilot-recall', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty when store is empty', () => {
    tmpDir = makeTmpDir();
    const result = recall({ task_category: 'backend' }, tmpDir);
    expect(result.lessons).toEqual([]);
    expect(result.total_matched).toBe(0);
  });

  it('returns empty when no query fields provided', () => {
    tmpDir = makeTmpDir();
    appendLesson(makeLesson(), tmpDir);
    const result = recall({}, tmpDir);
    // No filters → all pass through, but query is empty so returns all
    expect(result.lessons.length).toBeGreaterThan(0);
  });

  // ── Category filter ──

  it('filters by task_category', () => {
    tmpDir = makeTmpDir();
    appendLesson(makeLesson({ lesson_id: 'l1', task_category: 'backend' }), tmpDir);
    appendLesson(makeLesson({ lesson_id: 'l2', task_category: 'frontend' }), tmpDir);
    const result = recall({ task_category: 'backend' }, tmpDir);
    expect(result.total_matched).toBe(1);
    expect(result.lessons[0].lesson_id).toBe('l1');
  });

  // ── Source kind filter ──

  it('filters by source_kind', () => {
    tmpDir = makeTmpDir();
    appendLesson(makeLesson({ lesson_id: 'l1', source_kind: 'a2a' }), tmpDir);
    appendLesson(makeLesson({ lesson_id: 'l2', source_kind: 'discuss' }), tmpDir);
    const result = recall({ source_kind: 'a2a' }, tmpDir);
    expect(result.total_matched).toBe(1);
    expect(result.lessons[0].lesson_id).toBe('l1');
  });

  // ── Fingerprint filter ──

  it('filters by task_fingerprint with role + domain overlap', () => {
    tmpDir = makeTmpDir();
    appendLesson(makeLesson({ lesson_id: 'l1', task_fingerprint: FP_IMPL }), tmpDir);
    appendLesson(makeLesson({ lesson_id: 'l2', task_fingerprint: FP_REVIEW }), tmpDir);

    // Query with implementation + backend → matches l1 only
    const result = recall({ task_fingerprint: FP_IMPL }, tmpDir);
    expect(result.total_matched).toBe(1);
    expect(result.lessons[0].lesson_id).toBe('l1');
  });

  it('rejects fingerprint with same role but no domain overlap', () => {
    tmpDir = makeTmpDir();
    appendLesson(makeLesson({
      lesson_id: 'l1',
      task_fingerprint: JSON.stringify({ role: 'implementation', domains: ['frontend'], complexity: 'medium' }),
    }), tmpDir);

    // Query: implementation + backend — no overlap
    const result = recall({ task_fingerprint: FP_IMPL }, tmpDir);
    expect(result.total_matched).toBe(0);
  });

  it('skips fingerprint filter on malformed query JSON', () => {
    tmpDir = makeTmpDir();
    appendLesson(makeLesson({ lesson_id: 'l1' }), tmpDir);
    const result = recall({ task_fingerprint: 'not-json' }, tmpDir);
    // Bad JSON → skip filter → returns all
    expect(result.total_matched).toBe(1);
  });

  // ── Ranking ──

  it('ranks helped outcomes higher than unknown', () => {
    tmpDir = makeTmpDir();
    appendLesson(makeLesson({ lesson_id: 'l-unknown', outcome: 'unknown', created_at: '2026-04-09T00:00:00Z' }), tmpDir);
    appendLesson(makeLesson({ lesson_id: 'l-helped', outcome: 'helped', created_at: '2026-04-09T00:00:00Z' }), tmpDir);
    const result = recall({ task_category: 'backend' }, tmpDir);
    expect(result.lessons[0].lesson_id).toBe('l-helped');
  });

  it('ranks failed outcomes lower', () => {
    tmpDir = makeTmpDir();
    appendLesson(makeLesson({ lesson_id: 'l-ok', outcome: 'unknown', created_at: '2026-04-09T00:00:00Z' }), tmpDir);
    appendLesson(makeLesson({ lesson_id: 'l-fail', outcome: 'failed', created_at: '2026-04-09T00:00:00Z' }), tmpDir);
    const result = recall({ task_category: 'backend' }, tmpDir);
    expect(result.lessons[0].lesson_id).toBe('l-ok');
  });

  it('ranks higher adoption_count higher', () => {
    tmpDir = makeTmpDir();
    appendLesson(makeLesson({ lesson_id: 'l-fresh', outcome: 'helped', adoption_count: 0, created_at: '2026-04-09T00:00:00Z' }), tmpDir);
    appendLesson(makeLesson({ lesson_id: 'l-adopted', outcome: 'helped', adoption_count: 5, created_at: '2026-04-09T00:00:00Z' }), tmpDir);
    const result = recall({ task_category: 'backend' }, tmpDir);
    expect(result.lessons[0].lesson_id).toBe('l-adopted');
  });

  it('prefers newer lessons by recency', () => {
    tmpDir = makeTmpDir();
    appendLesson(makeLesson({ lesson_id: 'l-old', outcome: 'helped', created_at: '2026-01-01T00:00:00Z' }), tmpDir);
    appendLesson(makeLesson({ lesson_id: 'l-new', outcome: 'helped', created_at: '2026-04-09T00:00:00Z' }), tmpDir);
    const result = recall({ task_category: 'backend' }, tmpDir);
    expect(result.lessons[0].lesson_id).toBe('l-new');
  });

  // ── Top-N truncation ──

  it('truncates to RECALL_TOP_N', () => {
    tmpDir = makeTmpDir();
    for (let i = 0; i < 10; i++) {
      appendLesson(makeLesson({
        lesson_id: `l-many-${i}`,
        task_category: 'backend',
        created_at: new Date(Date.now() - i * 1000).toISOString(),
      }), tmpDir);
    }
    const result = recall({ task_category: 'backend' }, tmpDir);
    expect(result.lessons.length).toBe(RECALL_TOP_N);
    expect(result.total_matched).toBe(10);
  });

  // ── Combined filters ──

  it('combines category + source_kind filters', () => {
    tmpDir = makeTmpDir();
    appendLesson(makeLesson({ lesson_id: 'l1', task_category: 'backend', source_kind: 'discuss' }), tmpDir);
    appendLesson(makeLesson({ lesson_id: 'l2', task_category: 'backend', source_kind: 'a2a' }), tmpDir);
    appendLesson(makeLesson({ lesson_id: 'l3', task_category: 'frontend', source_kind: 'discuss' }), tmpDir);

    const result = recall({ task_category: 'backend', source_kind: 'discuss' }, tmpDir);
    expect(result.total_matched).toBe(1);
    expect(result.lessons[0].lesson_id).toBe('l1');
  });

  it('combines all three filters', () => {
    tmpDir = makeTmpDir();
    appendLesson(makeLesson({
      lesson_id: 'l-match',
      task_category: 'backend',
      source_kind: 'discuss',
      task_fingerprint: FP_IMPL,
    }), tmpDir);
    appendLesson(makeLesson({
      lesson_id: 'l-no-fp',
      task_category: 'backend',
      source_kind: 'discuss',
      task_fingerprint: FP_REVIEW,
    }), tmpDir);

    const result = recall({
      task_category: 'backend',
      source_kind: 'discuss',
      task_fingerprint: FP_IMPL,
    }, tmpDir);
    expect(result.total_matched).toBe(1);
    expect(result.lessons[0].lesson_id).toBe('l-match');
  });
});
