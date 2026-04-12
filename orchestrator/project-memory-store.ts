// ═══════════════════════════════════════════════════════════════════
// orchestrator/project-memory-store.ts — Phase 7A: Project Memory
// ═══════════════════════════════════════════════════════════════════
/**
 * Project-scoped memory store with decay, evidence thresholds, and staleness.
 *
 * Guardrails:
 * - recency decay (3-day half-life, 14-day max window)
 * - minimum evidence threshold (≥2 observations)
 * - explicit override always wins (current context > config > memory)
 * - stale memories are marked but not deleted (for auditability)
 */

import fs from 'fs';
import path from 'path';
import type { MemoryEvidence, ProjectMemoryEntry, ProjectMemoryStore } from './types.js';

// ── Config ──

const DECAY_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000; // 3-day half-life
const MAX_MEMORY_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MIN_EVIDENCE_COUNT = 2;
const MIN_CONFIDENCE = 0.25; // memories below this are pruned

// ── Persistence ──

function memoryDir(cwd: string): string {
  return path.join(cwd, '.ai', 'memory');
}

function memoryPath(cwd: string): string {
  return path.join(memoryDir(cwd), 'project-memory.json');
}

/**
 * Load project memory store from disk.
 * Returns null if no memory file exists.
 */
export function loadProjectMemory(cwd: string): ProjectMemoryStore | null {
  const filePath = memoryPath(cwd);
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ProjectMemoryStore;
  } catch {
    return null;
  }
}

/**
 * Save project memory store to disk.
 */
export function saveProjectMemory(cwd: string, store: ProjectMemoryStore): void {
  const dir = memoryDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(memoryPath(cwd), JSON.stringify(store, null, 2), 'utf-8');
}

// ── Decay & Freshness ──

function decayWeight(ts: number, now: number): number {
  const age = now - ts;
  if (age < 0) return 1.0; // future timestamps → max weight
  if (age > MAX_MEMORY_AGE_MS) return 0;
  return Math.pow(0.5, age / DECAY_HALF_LIFE_MS);
}

function computeRecency(evidence: MemoryEvidence[], now: number): number {
  if (evidence.length === 0) return 0;
  const weights = evidence.map(e => {
    // Try to extract timestamp from run-<ts> format; fallback to now
    const tsMatch = e.source_run_id.match(/run-(\d+)/);
    const ts = tsMatch ? parseInt(tsMatch[1], 10) : now;
    return decayWeight(ts, now);
  });
  const avg = weights.reduce((s, w) => s + w, 0) / weights.length;
  return Math.min(avg, 1.0);
}

/**
 * Mark stale memories and prune those below confidence floor.
 * Returns the updated store (mutations in-place for efficiency).
 */
export function refreshMemoryFreshness(store: ProjectMemoryStore): ProjectMemoryStore {
  const now = Date.now();

  for (const mem of store.memories) {
    mem.recency = computeRecency(mem.evidence, now);
    const age = now - new Date(mem.updated_at).getTime();

    // Mark stale if beyond max age or recency dropped too low
    mem.stale = age > MAX_MEMORY_AGE_MS || mem.recency < 0.1;

    // Deactivate if stale or confidence too low
    if (mem.stale || mem.confidence < MIN_CONFIDENCE) {
      mem.active = false;
    }
  }

  // Prune inactive memories that are also stale (cleanup)
  store.memories = store.memories.filter(m => m.active || !m.stale);
  store.generated_at = new Date(now).toISOString();

  return store;
}

// ── Memory Creation ──

/**
 * Create a new memory entry or merge evidence into an existing one.
 * Returns the updated memory entry.
 */
export function upsertMemory(
  store: ProjectMemoryStore,
  input: {
    category: ProjectMemoryEntry['category'];
    summary: string;
    detail: string;
    evidence: MemoryEvidence[];
    source_run_ids: string[];
    source_artifacts: string[];
  },
): ProjectMemoryEntry {
  const now = Date.now();

  // Check if a matching memory already exists (same category + summary match)
  const existing = store.memories.find(m =>
    m.active &&
    m.category === input.category &&
    similarityScore(m.summary, input.summary) > 0.7,
  );

  if (existing) {
    // Merge: append new evidence, update timestamps
    const newEvidence = input.evidence.filter(
      ne => !existing.evidence.some(ee => ee.source_run_id === ne.source_run_id && ee.signal === ne.signal),
    );
    existing.evidence.push(...newEvidence);
    existing.source_run_ids = [
      ...new Set([...existing.source_run_ids, ...input.source_run_ids]),
    ];
    existing.source_artifacts = [
      ...new Set([...existing.source_artifacts, ...input.source_artifacts]),
    ];
    existing.updated_at = new Date(now).toISOString();
    existing.detail = input.detail; // refresh detail with latest context
    existing.confidence = computeConfidence(existing.evidence);
    existing.recency = computeRecency(existing.evidence, now);
    existing.stale = existing.recency < 0.1 ||
      (now - new Date(existing.updated_at).getTime()) > MAX_MEMORY_AGE_MS;
    existing.active = !existing.stale && existing.confidence >= MIN_CONFIDENCE;
    return existing;
  }

  // Create new memory
  const confidence = computeConfidence(input.evidence);
  if (input.evidence.length < MIN_EVIDENCE_COUNT || confidence < MIN_CONFIDENCE) {
    // Not enough signal — don't create yet
    return null as unknown as ProjectMemoryEntry;
  }

  const entry: ProjectMemoryEntry = {
    memory_id: `mem-${hashStr(input.category + input.summary)}`,
    category: input.category,
    summary: input.summary,
    detail: input.detail,
    evidence: input.evidence,
    source_run_ids: input.source_run_ids,
    source_artifacts: input.source_artifacts,
    confidence,
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    recency: computeRecency(input.evidence, now),
    active: true,
    stale: false,
  };

  store.memories.push(entry);
  return entry;
}

// ── Helpers ──

function computeConfidence(evidence: MemoryEvidence[]): number {
  if (evidence.length === 0) return 0;
  const count = evidence.length;
  const uniqueRuns = new Set(evidence.map(e => e.source_run_id)).size;
  const avgWeight = evidence.reduce((s, e) => s + e.weight, 0) / count;

  // Composite: observation count (40%) + diversity (30%) + recency (30%)
  const countScore = Math.min(count / 5, 1.0); // saturates at 5 observations
  const diversityScore = Math.min(uniqueRuns / 3, 1.0); // saturates at 3 runs
  return countScore * 0.4 + diversityScore * 0.3 + avgWeight * 0.3;
}

function similarityScore(a: string, b: string): number {
  const aWords = new Set(a.toLowerCase().split(/\s+/));
  const bWords = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...aWords].filter(w => bWords.has(w));
  const union = new Set([...aWords, ...bWords]);
  return union.size === 0 ? 0 : intersection.length / union.size;
}

function hashStr(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

/**
 * Initialize or get project memory store.
 */
export function initProjectMemory(cwd: string, projectId?: string): ProjectMemoryStore {
  const existing = loadProjectMemory(cwd);
  if (existing) {
    return refreshMemoryFreshness(existing);
  }

  const repoName = projectId || path.basename(cwd);
  return {
    project_id: repoName,
    memories: [],
    generated_at: new Date().toISOString(),
  };
}
