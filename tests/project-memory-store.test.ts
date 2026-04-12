// ═══════════════════════════════════════════════════════════════════
// tests/project-memory-store.test.ts — Phase 7A
// ═══════════════════════════════════════════════════════════════════

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initProjectMemory,
  loadProjectMemory,
  saveProjectMemory,
  upsertMemory,
  refreshMemoryFreshness,
} from '../orchestrator/project-memory-store.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mem-test-'));
}

function makeEvidence(runId: string, signal: string, weight = 1.0) {
  return {
    source_run_id: runId,
    source_artifact: 'transition_log' as const,
    signal,
    weight,
  };
}

describe('project-memory-store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Persistence ──

  it('returns null when no memory file exists', () => {
    expect(loadProjectMemory(tmpDir)).toBeNull();
  });

  it('saves and loads memory round-trip', () => {
    const store = initProjectMemory(tmpDir, 'test-project');
    saveProjectMemory(tmpDir, store);

    const loaded = loadProjectMemory(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.project_id).toBe('test-project');
    expect(loaded!.memories).toEqual([]);
  });

  it('creates directory if not exists', () => {
    const nested = path.join(tmpDir, 'deep', 'nested');
    const store = initProjectMemory(nested, 'test-project');
    saveProjectMemory(nested, store);
    expect(fs.existsSync(path.join(nested, '.ai', 'memory', 'project-memory.json'))).toBe(true);
  });

  // ── Init ──

  it('initializes empty store with project id', () => {
    const store = initProjectMemory(tmpDir, 'my-repo');
    expect(store.project_id).toBe('my-repo');
    expect(store.memories).toEqual([]);
  });

  it('uses cwd basename as default project id', () => {
    const store = initProjectMemory(tmpDir);
    expect(store.project_id).toBe(path.basename(tmpDir));
  });

  it('returns existing store with freshness refresh', () => {
    const store = initProjectMemory(tmpDir, 'test-project');
    saveProjectMemory(tmpDir, store);

    const loaded = initProjectMemory(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.project_id).toBe('test-project');
  });

  // ── Upsert ──

  it('creates memory when evidence threshold met', () => {
    const store = initProjectMemory(tmpDir, 'test-project');

    const entry = upsertMemory(store, {
      category: 'recurring_failure',
      summary: 'Build failures in test tasks',
      detail: 'Build failures recur across multiple runs',
      evidence: [
        makeEvidence('run-1', 'task-a → build failure'),
        makeEvidence('run-2', 'task-b → build failure'),
      ],
      source_run_ids: ['run-1', 'run-2'],
      source_artifacts: ['transition_log'],
    });

    expect(entry).not.toBeNull();
    expect(entry.category).toBe('recurring_failure');
    expect(entry.confidence).toBeGreaterThan(0);
    expect(store.memories).toHaveLength(1);
  });

  it('does not create memory below minimum evidence count', () => {
    const store = initProjectMemory(tmpDir, 'test-project');

    const entry = upsertMemory(store, {
      category: 'recurring_failure',
      summary: 'Single event should not form memory',
      detail: 'Only one observation',
      evidence: [makeEvidence('run-1', 'single event')],
      source_run_ids: ['run-1'],
      source_artifacts: ['transition_log'],
    });

    expect(entry).toBeNull();
    expect(store.memories).toHaveLength(0);
  });

  it('merges evidence into existing memory with matching summary', () => {
    const store = initProjectMemory(tmpDir, 'test-project');

    upsertMemory(store, {
      category: 'recurring_failure',
      summary: 'Build failures in test tasks',
      detail: 'Initial detail',
      evidence: [
        makeEvidence('run-1', 'task-a → build'),
        makeEvidence('run-2', 'task-b → build'),
      ],
      source_run_ids: ['run-1', 'run-2'],
      source_artifacts: ['transition_log'],
    });

    // Upsert with same summary → should merge
    upsertMemory(store, {
      category: 'recurring_failure',
      summary: 'Build failures in test tasks',
      detail: 'Updated detail',
      evidence: [makeEvidence('run-3', 'task-c → build')],
      source_run_ids: ['run-3'],
      source_artifacts: ['transition_log'],
    });

    expect(store.memories).toHaveLength(1);
    expect(store.memories[0].source_run_ids).toContain('run-1');
    expect(store.memories[0].source_run_ids).toContain('run-3');
    expect(store.memories[0].source_run_ids.length).toBeGreaterThanOrEqual(3);
  });

  it('creates separate memories for different categories', () => {
    const store = initProjectMemory(tmpDir, 'test-project');

    upsertMemory(store, {
      category: 'recurring_failure',
      summary: 'Build failures recur',
      detail: 'Detail 1',
      evidence: [makeEvidence('run-1', 'build fail'), makeEvidence('run-2', 'build fail')],
      source_run_ids: ['run-1', 'run-2'],
      source_artifacts: ['transition_log'],
    });

    upsertMemory(store, {
      category: 'risky_area',
      summary: 'Schema files are fragile',
      detail: 'Detail 2',
      evidence: [makeEvidence('run-1', 'schema break'), makeEvidence('run-3', 'schema break')],
      source_run_ids: ['run-1', 'run-3'],
      source_artifacts: ['forensics_pack'],
    });

    expect(store.memories).toHaveLength(2);
  });

  // ── Freshness ──

  it('marks stale memories as inactive', () => {
    const store = initProjectMemory(tmpDir, 'test-project');
    const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(); // 15 days ago
    const recentRun = `run-${Date.now() - 1000}`; // recent run ID

    store.memories.push({
      memory_id: 'mem-old',
      category: 'recurring_failure',
      summary: 'Old failure pattern',
      detail: 'This is very old',
      evidence: [{
        source_run_id: recentRun,
        source_artifact: 'transition_log' as const,
        signal: 'old event',
        weight: 0.05,
      }],
      source_run_ids: [recentRun],
      source_artifacts: ['transition_log'],
      confidence: 0.5,
      created_at: oldDate,
      updated_at: oldDate,
      recency: 0.05,
      active: true,
      stale: false,
    });

    // Manually check the staleness logic without pruning
    const mem = store.memories[0];
    const age = Date.now() - new Date(mem.updated_at).getTime();
    const isStale = age > 14 * 24 * 60 * 60 * 1000 || mem.recency < 0.1;
    expect(isStale).toBe(true);
    // After refresh, this memory would be deactivated and pruned
    refreshMemoryFreshness(store);
    expect(store.memories.length).toBe(0); // pruned because stale + inactive
  });

  it('keeps fresh memories active', () => {
    const store = initProjectMemory(tmpDir, 'test-project');
    const now = new Date().toISOString();

    store.memories.push({
      memory_id: 'mem-fresh',
      category: 'effective_repair',
      summary: 'Repair works for build failures',
      detail: 'Recent evidence',
      evidence: [makeEvidence('run-recent', 'recent event', 0.9)],
      source_run_ids: ['run-recent'],
      source_artifacts: ['transition_log'],
      confidence: 0.7,
      created_at: now,
      updated_at: now,
      recency: 0.9,
      active: true,
      stale: false,
    });

    refreshMemoryFreshness(store);
    expect(store.memories[0].active).toBe(true);
    expect(store.memories[0].stale).toBe(false);
  });

  it('prunes stale and inactive memories', () => {
    const store = initProjectMemory(tmpDir, 'test-project');
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();

    // Stale + inactive → pruned
    store.memories.push({
      memory_id: 'mem-stale',
      category: 'recurring_failure',
      summary: 'Old stale memory',
      detail: 'Too old',
      evidence: [makeEvidence('run-old', 'old', 0.01)],
      source_run_ids: ['run-old'],
      source_artifacts: ['transition_log'],
      confidence: 0.3,
      created_at: oldDate,
      updated_at: oldDate,
      recency: 0.01,
      active: false,
      stale: true,
    });

    // Fresh + active → kept
    const now = new Date().toISOString();
    store.memories.push({
      memory_id: 'mem-fresh',
      category: 'effective_repair',
      summary: 'Recent repair pattern',
      detail: 'Fresh',
      evidence: [makeEvidence('run-new', 'new', 0.9)],
      source_run_ids: ['run-new'],
      source_artifacts: ['transition_log'],
      confidence: 0.8,
      created_at: now,
      updated_at: now,
      recency: 0.9,
      active: true,
      stale: false,
    });

    refreshMemoryFreshness(store);
    expect(store.memories).toHaveLength(1);
    expect(store.memories[0].memory_id).toBe('mem-fresh');
  });

  it('deactivates memories below confidence floor', () => {
    const store = initProjectMemory(tmpDir, 'test-project');
    const now = new Date().toISOString();
    const recentRun = `run-${Date.now() - 1000}`;

    store.memories.push({
      memory_id: 'mem-lowconf',
      category: 'routing_tendency',
      summary: 'Low confidence memory',
      detail: 'Not enough evidence',
      evidence: [{
        source_run_id: recentRun,
        source_artifact: 'transition_log' as const,
        signal: 'event',
        weight: 0.1,
      }],
      source_run_ids: [recentRun],
      source_artifacts: ['transition_log'],
      confidence: 0.15, // below MIN_CONFIDENCE of 0.25
      created_at: now,
      updated_at: now,
      recency: 0.5,
      active: true,
      stale: false,
    });

    refreshMemoryFreshness(store);
    expect(store.memories[0].active).toBe(false);
  });

  // ── Confidence computation ──

  it('higher confidence with more evidence and diversity', () => {
    const store = initProjectMemory(tmpDir, 'test-project');

    const entry = upsertMemory(store, {
      category: 'recurring_failure',
      summary: 'High evidence pattern',
      detail: 'Lots of evidence',
      evidence: [
        makeEvidence('run-1', 'event 1'),
        makeEvidence('run-2', 'event 2'),
        makeEvidence('run-3', 'event 3'),
        makeEvidence('run-4', 'event 4'),
        makeEvidence('run-5', 'event 5'),
      ],
      source_run_ids: ['run-1', 'run-2', 'run-3', 'run-4', 'run-5'],
      source_artifacts: ['transition_log', 'forensics_pack'],
    });

    expect(entry).not.toBeNull();
    expect(entry.confidence).toBeGreaterThan(0.5); // Should be reasonably high
  });
});
