# Phase 10A Closeout: Collaboration Surface

**Date**: 2026-04-12
**Status**: delivered

## Verification Results

| Check | Result |
|-------|--------|
| `npm run build` | Pass |
| `vitest run collab-cues.test.ts` | 18/18 pass |
| `vitest run collab-summary.test.ts` | 9/9 pass |
| `vitest run handoff-summary.test.ts` | 9/9 pass |
| TypeScript compilation | Pass (no errors) |

## Changed Files

### New files (6)
1. `orchestrator/collab-cues.ts` — Task-level cue derivation
2. `orchestrator/collab-summary.ts` — Run-level collaboration summary
3. `orchestrator/handoff-summary.ts` — Handoff surface packet
4. `tests/collab-cues.test.ts` — 18 tests
5. `tests/collab-summary.test.ts` — 9 tests
6. `tests/handoff-summary.test.ts` — 9 tests

### Modified files (4)
1. `orchestrator/watch-loader.ts` — Added taskCues to WatchData
2. `orchestrator/watch-format.ts` — Added Collaboration Cues section
3. `orchestrator/hiveshell-dashboard.ts` — Added Collab Cues section
4. `orchestrator/index.ts` — Added Collaboration section to `hive status`

### Documentation (1)
1. `docs/PHASE10A_COLLABORATION_SURFACE.md` — Design doc

## Implementation Summary

### What was built

A lightweight collaboration surface with three layers:

1. **Task cues** (collab-cues.ts): Each task gets a deriveable cue based on its state, review results, provider health, and steering context. 6 canonical labels: needs_review, needs_human, blocked, watch, ready, passive. All cues are explainable with reason + evidence fields.

2. **Run summary** (collab-summary.ts): Aggregates task cues into distribution counts, top 5 attention items, blocker categories by cause, and handoff readiness assessment. Output is concise — no long dumps.

3. **Handoff packet** (handoff-summary.ts): One-line current truth, top blockers, top 3 attention items, 2-4 suggested CLI commands. Designed for a new接手者 to understand the run in <30 seconds.

### Integration points

- `hive status`: Shows `== Collaboration ==` section when active cues exist
- `hive watch`: Shows `== Collaboration Cues ==` section when active cues exist
- `hive shell`: Shows `Collab Cues` section in dashboard
- All use the same cue labels — language aligned across surfaces

### Design decisions

- **Derived, not stored**: Cues are computed from existing artifacts on demand. No new state persistence layer.
- **Explainable**: Every cue carries a reason string and evidence array.
- **Bounded**: Top 5 attention items, top 4 commands, max ~10 lines for handoff.
- **Graceful**: Missing artifacts return empty arrays, not errors.

## How to Handoff a Run

### For the current operator

```bash
# See collaboration status at a glance
hive status --run-id <id>

# Live watch with collaboration cues
hive watch --run-id <id> --once

# Full dashboard with collab cues
hive shell --run-id <id>
```

### For the接手者

```bash
# Quick handoff: understand the run in <30s
hive status --run-id <id>
# Look for == Collaboration == section — shows cues, blockers, handoff readiness

# Drill into failed tasks
hive workers --run-id <id> --worker <task-id>

# Single snapshot with collaboration cues
hive watch --run-id <id> --once

# Resume if paused
hive resume --run-id <id> --execute
```

### For an agent接手

Read these artifacts in order:
1. `.ai/runs/<run-id>/state.json` — current run state
2. `hive status --run-id <id>` — collaboration summary
3. `hive workers --run-id <id>` — task-level details
4. `hive watch --run-id <id> --once` — full snapshot with cues

## Recommended Archival/Retention

1. **Design doc**: `docs/PHASE10A_COLLABORATION_SURFACE.md` — primary reference
2. **Core modules**: `collab-cues.ts`, `collab-summary.ts`, `handoff-summary.ts`
3. **Test coverage**: 36 tests across 3 files
4. **Extension points**:
   - Add new cue types in `collab-cues.ts` deriveCueForTask()
   - Adjust urgency ordering in `collab-summary.ts` CUE_URGENCY map
   - Extend handoff commands in `handoff-summary.ts` buildSuggestedCommands()
