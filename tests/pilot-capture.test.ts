import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { DiscussTrigger, DiscussResult } from '../orchestrator/types.js';
import { captureDiscussLesson, loadStore } from '../orchestrator/pilot-memory.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-capture-test-'));
}

function makeTrigger(overrides: Partial<DiscussTrigger> = {}): DiscussTrigger {
  return {
    uncertain_about: 'Should we use Option A or Option B for the cache layer?',
    options: ['Option A: in-memory map', 'Option B: SQLite-backed store'],
    leaning: 'Option A',
    why: 'Simpler implementation, no disk I/O',
    task_id: 'task-capture-test',
    worker_model: 'qwen3-max',
    ...overrides,
  };
}

function makeResult(overrides: Partial<DiscussResult> = {}): DiscussResult {
  return {
    decision: 'Use Option A with periodic flush',
    reasoning: 'In-memory is faster for the hot path; add a flush interval for durability.',
    escalated: false,
    thread_id: 'discuss-task-capture-test-1234',
    quality_gate: 'pass',
    ...overrides,
  };
}

describe('pilot-capture', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Basic capture from discuss result ──

  it('captures a lesson from a successful discuss result', () => {
    tmpDir = makeTmpDir();
    const trigger = makeTrigger();
    const result = makeResult();

    captureDiscussLesson(trigger, result, 'qwen3-max', 'kimi-k2.5', tmpDir);

    const store = loadStore(tmpDir);
    expect(store.lessons).toHaveLength(1);

    const lesson = store.lessons[0];
    expect(lesson.source_kind).toBe('discuss');
    expect(lesson.worker_model).toBe('qwen3-max');
    expect(lesson.reviewer_model).toBe('kimi-k2.5');
    expect(lesson.outcome).toBe('unknown');
    expect(lesson.symptom).toBeTruthy();
    expect(lesson.rule).toBeTruthy();
    expect(lesson.evidence).toContain('gate=pass');
    expect(lesson.lesson_id).toMatch(/^les-/);
  });

  it('captures escalated discuss with fail quality gate', () => {
    tmpDir = makeTmpDir();
    const trigger = makeTrigger();
    const result = makeResult({
      quality_gate: 'fail',
      escalated: true,
      escalated_to: 'sonnet',
    });

    captureDiscussLesson(trigger, result, 'qwen3-max', 'kimi-k2.5', tmpDir);

    const store = loadStore(tmpDir);
    expect(store.lessons).toHaveLength(1);
    expect(store.lessons[0].rule).toContain('escalated');
    expect(store.lessons[0].evidence).toContain('gate=fail');
  });

  // ── Symptom truncation ──

  it('truncates long reasoning to 120 chars', () => {
    tmpDir = makeTmpDir();
    const longReasoning = 'A'.repeat(200);
    const trigger = makeTrigger();
    const result = makeResult({ reasoning: longReasoning });

    captureDiscussLesson(trigger, result, 'model-a', 'model-b', tmpDir);

    const store = loadStore(tmpDir);
    expect(store.lessons[0].symptom.length).toBeLessThanOrEqual(120);
    expect(store.lessons[0].symptom).toMatch(/\.\.\.$/);
  });

  // ── Evidence construction ──

  it('truncates long uncertain_about in evidence', () => {
    tmpDir = makeTmpDir();
    const longQuestion = 'Q'.repeat(200);
    const trigger = makeTrigger({ uncertain_about: longQuestion });

    captureDiscussLesson(trigger, makeResult(), 'm1', 'm2', tmpDir);

    const store = loadStore(tmpDir);
    const ev = store.lessons[0].evidence;
    expect(ev).toContain('q=');
    expect(ev.length).toBeLessThanOrEqual(200);
  });

  // ── Multiple captures accumulate ──

  it('accumulates multiple captures in the store', () => {
    tmpDir = makeTmpDir();

    captureDiscussLesson(makeTrigger({ task_id: 't1' }), makeResult(), 'm1', 'm2', tmpDir);
    captureDiscussLesson(makeTrigger({ task_id: 't2' }), makeResult(), 'm3', 'm4', tmpDir);

    const store = loadStore(tmpDir);
    expect(store.lessons).toHaveLength(2);
  });

  // ── Fail-open: capture does not throw on write failure ──

  it('does not throw when lessonsDir is read-only', () => {
    tmpDir = makeTmpDir();
    const readOnlyDir = path.join(tmpDir, 'readonly');
    fs.mkdirSync(readOnlyDir, { recursive: true });

    // Make dir read-only (won't prevent writes on all OS, but tests intent)
    try {
      fs.chmodSync(readOnlyDir, 0o444);
    } catch {
      // chmod may fail on some platforms; skip this check
    }

    // Should not throw — fail open
    expect(() => {
      captureDiscussLesson(
        makeTrigger(), makeResult(), 'm1', 'm2',
        path.join(readOnlyDir, 'subdir'),
      );
    }).not.toThrow();
  });

  // ── Fail-open: capture does not throw on corrupt existing store ──

  it('captures into a directory with corrupt existing store', () => {
    tmpDir = makeTmpDir();
    const lessonsDir = path.join(tmpDir, '.ai', 'pilot-lessons');
    fs.mkdirSync(lessonsDir, { recursive: true });
    fs.writeFileSync(path.join(lessonsDir, 'lessons.json'), '{not valid json');

    // Should not throw — corrupt store is handled by loadStore
    expect(() => {
      captureDiscussLesson(makeTrigger(), makeResult(), 'm1', 'm2', tmpDir);
    }).not.toThrow();

    // The lesson should have been written (overwrites corrupt store)
    const store = loadStore(tmpDir);
    expect(store.lessons).toHaveLength(1);
  });

  // ── Smoke: end-to-end synthetic discuss capture ──

  it('smoke: synthetic discuss capture roundtrip', () => {
    tmpDir = makeTmpDir();

    // Simulate a discuss trigger + result
    const trigger: DiscussTrigger = {
      uncertain_about: 'Should the worker retry on transient provider errors?',
      options: ['retry 3x with backoff', 'fail fast', 'delegate to orchestrator'],
      leaning: 'retry 3x with backoff',
      why: 'Transient errors are common with domestic providers',
      task_id: 'task-smoke-001',
      worker_model: 'glm-4-plus',
    };

    const result: DiscussResult = {
      decision: 'Use retry with exponential backoff, cap at 3 retries',
      reasoning: 'Retry is appropriate for transient errors but must be capped to avoid infinite loops. Add jitter to prevent thundering herd.',
      escalated: false,
      thread_id: 'discuss-task-smoke-001',
      quality_gate: 'pass',
    };

    captureDiscussLesson(trigger, result, 'glm-4-plus', 'claude-sonnet-4-6', tmpDir);

    const store = loadStore(tmpDir);
    expect(store.lessons).toHaveLength(1);

    const lesson = store.lessons[0];
    expect(lesson.source_kind).toBe('discuss');
    expect(lesson.worker_model).toBe('glm-4-plus');
    expect(lesson.reviewer_model).toBe('claude-sonnet-4-6');
    expect(lesson.symptom).toBeTruthy();
    expect(lesson.rule).toBeTruthy();
    expect(lesson.evidence).toContain('gate=pass');
    expect(lesson.evidence).toContain('q=');
    expect(lesson.lesson_id).toMatch(/^les-/);
    expect(lesson.created_at).toBeTruthy();

    // Verify store file exists on disk
    const storePath = path.join(
      tmpDir, '.ai', 'pilot-lessons', 'lessons.json',
    );
    expect(fs.existsSync(storePath)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    expect(raw.schema_version).toBe('1.0');
    expect(raw.lessons).toHaveLength(1);
  });
});
