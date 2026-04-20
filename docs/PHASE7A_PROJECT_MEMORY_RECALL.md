# Phase 7A Design: Project Memory + Cross-Session Recall

**Date**: 2026-04-10
**Phase**: 7A — Project Memory & Cross-Session Recall
**Status**: Complete

## Problem Statement

Hive runs are stateless — each session starts with no memory of what worked or failed before. This means:
- Recurring failure patterns are rediscovered every run
- Effective repair strategies are lost between sessions
- Risky file areas aren't flagged proactively
- Model routing tendencies aren't learned

Phase 7A adds a project-level memory system that persists across sessions with controlled, explainable recall.

## Architecture

### Two-Component Design

```
┌─────────────────────┐     ┌──────────────────────┐
│  Project Memory     │     │  Cross-Session       │
│  Store              │     │  Recall              │
│                     │     │                      │
│  - File-backed JSON │────►│  - Keyword matching  │
│  - Evidence merge   │     │  - File overlap      │
│  - Recency decay    │     │  - Failure class     │
│  - Staleness prune  │     │  - Composite ranking │
└─────────────────────┘     └──────────────────────┘
         ▲                            │
         │                            ▼
   upsertMemory()              recallProjectMemories()
                                formatMemoryRecall()
```

### Memory Categories

| Category | Purpose | Example |
|----------|---------|---------|
| `recurring_failure` | Patterns that fail repeatedly | "Build failures in test tasks" |
| `effective_repair` | Repairs that consistently work | "Retry resolves provider timeout" |
| `stable_preference` | Stable config/style choices | "Prettier config stable across runs" |
| `risky_area` | Fragile files/areas | "schema.ts breaks on validation changes" |
| `routing_tendency` | Model routing patterns | "Think tasks prefer opus for complexity" |

### Evidence Thresholds

- Minimum 2 observations before memory creation (prevents single-event overfitting)
- Confidence floor 0.25 — below this, memory is deactivated
- Staleness: 14-day max age OR recency < 0.1

### Confidence Scoring

Composite formula:
```
confidence = countScore * 0.4 + diversityScore * 0.3 + avgWeight * 0.3

where:
  countScore = min(observations / 5, 1.0)     // saturates at 5
  diversityScore = min(unique_runs / 3, 1.0)  // saturates at 3 runs
  avgWeight = mean(evidence weights)
```

### Recency Decay

- 3-day half-life: weight halves every 3 days
- 14-day max window: weight drops to 0
- Formula: `weight = 0.5 ^ (age_ms / half_life_ms)`

### Recall Scoring

When recalling memories for a task:
1. **Filter**: active, non-stale memories only
2. **Score** each candidate:
   - Goal keyword match: 30% (keyword overlap with summary/detail)
   - Task type match: 25% (category keywords vs task type)
   - File overlap: 20% (touched files vs risky_area evidence signals)
   - Failure class match: 25% (failure class in summary/evidence)
3. **Rank** by composite: `relevance * 0.5 + confidence * 0.3 + recency * 0.2`
4. **Return** top-N (default 3, configurable)

### Priority Chain

```
Explicit config > Current context > Memory recall
```

Memory is advisory only — it never overrides explicit configuration or current context decisions.

## Integration Points

### Driver (orchestrator/driver.ts)

At the start of each run loop:
```
1. initProjectMemory(cwd) — load or create store
2. extractProjectMemories(cwd, store) — mine historical runs
3. saveProjectMemory(cwd, store) — persist changes
```

### Planner (orchestrator/planner-runner.ts)

When planning a goal, memories are recalled and injected into the prompt:
```
## Project Memory (cross-session recall)
### [recurring_failure] Build failures in test tasks
- Confidence: high (0.85), Recency: 0.90
- Source: run-123, run-456
- Relevance: 0.45 — goal keywords match memory summary
```

This is compact (top 3, max ~500 chars) so it doesn't dominate the prompt.

### Extraction Pipeline (orchestrator/memory-extractor.ts)

Scans existing run artifacts:
- **Transition logs**: buckets failure classes, detects recurring patterns
- **Forensics packs**: identifies risky files from diff analysis
- **Verification outcomes**: clusters verification failures by task type

## Guardrails

1. **Recency decay**: old memories naturally fade (3-day half-life)
2. **Evidence threshold**: ≥2 observations required (no single-event memories)
3. **Staleness marking**: memories marked stale but not deleted (auditability)
4. **Explicit override**: config/current context always wins over memory
5. **Compact output**: recall capped at top 3 by default, ~500 char budget
6. **Low relevance filter**: memories scoring <0.03 are excluded from results

## Files

### Created
- `orchestrator/project-memory-store.ts` — File-backed store, persistence, upsert, freshness
- `orchestrator/memory-extractor.ts` — Extraction from historical artifacts
- `orchestrator/memory-recall.ts` — Recall, scoring, ranking, formatting
- `tests/project-memory-store.test.ts` — 15 tests
- `tests/memory-recall.test.ts` — 15 tests

### Modified
- `orchestrator/types.ts` — Added MemoryCategory, MemoryEvidence, ProjectMemoryEntry, ProjectMemoryStore, MemoryRecallInput, MemoryRecallResult types
- `orchestrator/driver.ts` — Memory extraction at loop start, pass to planner
- `orchestrator/planner-runner.ts` — Accept optional projectMemory, inject recall into prompt

## Testing Strategy

### Store Tests (15)
- Persistence: null on missing file, save/load round-trip, directory creation
- Init: project ID assignment, existing store with freshness refresh
- Upsert: creation with evidence threshold, rejection below minimum, merging by summary, separate categories
- Freshness: stale deactivation, fresh retention, pruning of stale+inactive, confidence floor deactivation
- Confidence: higher evidence → higher confidence

### Recall Tests (15)
- Empty/null store handling, all-stale filtering
- Goal keyword matching, task type boosting
- Failure class matching in repair context
- File overlap for risky_area memories
- Composite ranking, topN limit
- Explainability (why_relevant), formatted output, truncation
- Guardrails: stale exclusion, irrelevant goal returns low matches

## Open Questions / Future Work

1. **Memory distillation**: as memory count grows, consider merging similar memories automatically
2. **Cross-project memory sharing**: could share routing_tendency memories across similar projects
3. **Memory verification loop**: after a memory is recalled and the task completes, feed back whether it was useful
4. **Semantic search**: current keyword matching is simple — could use embeddings for better recall
