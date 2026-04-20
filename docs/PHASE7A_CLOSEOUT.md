# Phase 7A Closeout Report

**Date**: 2026-04-10
**Phase**: 7A — Project Memory & Cross-Session Recall
**Status**: Complete

## Executive Summary

Phase 7A implements a project-level memory system that persists knowledge across Hive runs: recurring failure patterns, effective repair strategies, stable preferences, risky file areas, and routing tendencies. Memories are extracted from historical run artifacts, scored by confidence and recency, and recalled in a compact, explainable format during planning. All 30 new tests pass with zero regressions.

## Deliverables

### Complete

| Deliverable | Location | Status |
|-------------|----------|--------|
| Project Memory Store | `orchestrator/project-memory-store.ts` | Complete |
| Memory Extractor | `orchestrator/memory-extractor.ts` | Complete |
| Memory Recall | `orchestrator/memory-recall.ts` | Complete |
| Type Extensions | `orchestrator/types.ts` | Complete |
| Driver Integration | `orchestrator/driver.ts` | Complete |
| Planner Integration | `orchestrator/planner-runner.ts` | Complete |
| Store Tests | `tests/project-memory-store.test.ts` | 15 tests, all passing |
| Recall Tests | `tests/memory-recall.test.ts` | 15 tests, all passing |
| Design Document | `docs/PHASE7A_PROJECT_MEMORY_RECALL.md` | Complete |

## Build & Test Status

```
npm run build:  Passes
npm test:       30 new tests passing, 0 regressions
```

Full test matrix: 874 passing, 11 failing (pre-existing baseline, unchanged):
- `discuss-gate`: 1 failure
- `dispatcher-fallback`: 2 failures
- `failure-classifier`: 2 failures (new file, pre-existing gap)
- `model-proxy`: 3 failures
- `mode-enforcement`: 1 failure
- `mode-policy`: 1 failure
- `prompt-policy`: 1 failure

## What Changed

**8 files created/modified:**

1. **orchestrator/project-memory-store.ts** — File-backed JSON store with recency decay (3-day half-life, 14-day max window), confidence scoring (count + diversity + recency composite), Jaccard similarity dedup, evidence merging, staleness marking and pruning
2. **orchestrator/memory-extractor.ts** — Scans transition logs, forensics packs, and verification outcomes to extract: failure pattern memories (bucketed by failure class), repair pattern memories (worker_failed → verified transitions), risky area memories (multi-retry tasks), verification failure clusters
3. **orchestrator/memory-recall.ts** — Keyword matching (goal, task type, file overlap, failure class), composite ranking (relevance 50% + confidence 30% + recency 20%), compact formatted output capped at ~500 chars
4. **tests/project-memory-store.test.ts** — 15 tests: persistence, init, upsert creation/merge/separation, freshness (staleness, pruning, confidence floor), confidence computation
5. **tests/memory-recall.test.ts** — 15 tests: empty/null store, goal matching, task type boosting, failure class matching, file overlap for risky_area, composite ranking, topN limit, explainability, formatting, truncation, stale exclusion guardrails
6. **orchestrator/types.ts** — Added `MemoryCategory`, `MemoryEvidence`, `ProjectMemoryEntry`, `ProjectMemoryStore`, `MemoryRecallInput`, `MemoryRecallResult` types
7. **orchestrator/driver.ts** — Memory extraction at loop start: init → extract → save, passes projectMemory to planner
8. **orchestrator/planner-runner.ts** — Optional `projectMemory` parameter on `planGoal`, recalls and injects memory context into planner prompt

## Implementation Summary

### Memory Store
- File-backed at `.ai/memory/project-memory.json`
- Supports create, load, merge (upsert by category + Jaccard similarity)
- Automatic freshness refresh on load (decay recency, mark stale, prune)
- Minimum 2 evidence observations required to create a memory
- Confidence floor 0.25 — memories below are deactivated

### Recall System
- Filters to active, non-stale memories
- Scores relevance via 4 signals: goal keywords (30%), task type (25%), file overlap (20%), failure class (25%)
- Ranks by composite: relevance×0.5 + confidence×0.3 + recency×0.2
- Returns top 3 by default with explainability text
- Output formatted as compact markdown for prompt injection

### Guardrails
- Recency decay prevents old memories from dominating
- Evidence threshold prevents single-event overfitting
- Stale memories marked but not deleted (auditability)
- Explicit config > current context > memory recall (memory is advisory only)
- Recall output capped at ~500 chars to avoid prompt dominance

## Unresolved Risks

1. **Memory bloat over time**: No hard cap on memory count. As the store grows, recall scoring remains linear O(n). Mitigated by staleness pruning and compact recall output, but a hard cap (e.g., 50 memories) could be added later.
2. **Keyword-based matching is brittle**: Current recall uses simple keyword overlap. Tasks described differently from how failures were logged may miss relevant memories. Future improvement: embedding-based semantic search.
3. **Extraction runs every loop iteration**: Memory extraction scans all historical artifacts at each run start. For repos with many runs, this could be slow. Future improvement: incremental extraction (only new runs since last extraction).
4. **No memory feedback loop**: After a memory is recalled and the task completes, there's no mechanism to record whether it was actually useful. This means bad memories persist without correction.

## Recommendations for Next Phase

1. **Memory distillation**: Add automatic merging of similar memories (e.g., two `recurring_failure` entries with high summary similarity) to prevent duplication as the store grows.
2. **Feedback loop**: After task completion, compare outcome against recalled memories to adjust confidence up (if memory was accurate) or down (if memory was misleading).
3. **Incremental extraction**: Track last-extraction timestamp and only process new artifacts, reducing startup overhead.
4. **Hard memory cap**: Limit store to ~50 memories to bound recall cost and prompt budget.
5. **Cross-project memory sharing**: `routing_tendency` and `stable_preference` memories could be shared across projects with similar tech stacks.
