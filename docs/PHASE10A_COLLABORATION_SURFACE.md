# Phase 10A: Collaboration Surface

**Date**: 2026-04-12
**Status**: implemented
**Theme**: Lightweight collaboration surface for run handoff and接力

## Problem

Hive has strong single-operator surfaces (progress, forensics, steering, provider health, modes) but the "collaboration relay" surface is underdeveloped:
1. New接手者 can't quickly identify the key collaboration points of a run
2. Tasks needing discussion, human review, or follow-up have no unified surface
3. Information is scattered across steering/provider/progress/review/memory
4. Current surfaces are "I can understand my own run" but not "someone else can quickly pick up"

## Solution

A lightweight collaboration surface derived from existing artifacts:
1. **Task-level collaboration cues** — each task gets a deriveable cue (needs_review/needs_human/blocked/watch/ready/passive)
2. **Run-level collaboration summary** — aggregates cues into distribution, attention items, blocker categories, handoff readiness
3. **Handoff surface** — concise packet with current truth, top blockers, attention items, suggested commands
4. **Language alignment** — same cue labels across status/watch/summary/handoff

## Architecture

### A. Collaboration Cue Schema

```
needs_review  — review failed or review findings need attention
needs_human   — human input requested or steering pending on this task
blocked       — provider down, merge blocked, or verification exhausted
watch         — in progress or recently failed, retry in progress
ready         — verified/merged, no action needed
passive       — completed/superseded, zero collaboration need
```

Cues are **derived**, not stored. No new state machine.

### B. Cue Derivation Rules

| Task State | Additional Signals | Cue |
|------------|-------------------|-----|
| merged / verified | — | ready |
| superseded | — | passive |
| pending / any | pending steering for task | needs_human |
| any | next_action=request_human targets task | needs_human |
| review_failed | — | needs_review |
| any | reviewFindingsCount > 0 | needs_review |
| pending / worker_failed | provider breaker=open | blocked |
| merge_blocked | — | blocked |
| verification_failed | retry_count >= 2 | blocked |
| worker_failed | retry_count < 2 | watch |
| pending | — | watch |
| worker_failed / verification_failed | else | watch (with failure_class) |

### C. Collaboration Summary

Aggregates task cues into:
- **cue_distribution** — count per cue category
- **top_attention_items** — non-passive/non-ready cues sorted by urgency (max 5)
- **blocker_categories** — grouped by cause: needs_human, blocked_by_provider, blocked, needs_review
- **handoff_ready** — boolean (always true except no artifacts)
- **handoff_notes** — human-readable notes for接手

### D. Handoff Surface

Concise packet (~10 lines):
- **current_truth** — one-line: status + round + mode
- **top_blockers** — tasks that block progress
- **top_attention** — top 3 collaboration items
- **suggested_commands** — 2-4 real CLI commands
- **handoff_ready** — yes/no with notes

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `orchestrator/collab-cues.ts` | **New** | Task-level cue derivation (160 lines) |
| `orchestrator/collab-summary.ts` | **New** | Run-level collaboration summary (170 lines) |
| `orchestrator/handoff-summary.ts` | **New** | Handoff surface packet (100 lines) |
| `orchestrator/watch-loader.ts` | Modified | Added taskCues to WatchData |
| `orchestrator/watch-format.ts` | Modified | Added Collaboration Cues section |
| `orchestrator/hiveshell-dashboard.ts` | Modified | Added Collab Cues section |
| `orchestrator/index.ts` | Modified | Added Collaboration section to `hive status` |
| `tests/collab-cues.test.ts` | **New** | 18 tests for cue derivation |
| `tests/collab-summary.test.ts` | **New** | 9 tests for summary aggregation |
| `tests/handoff-summary.test.ts` | **New** | 9 tests for handoff surface |

## Design Guardrails

1. **Cues are derived** — no new state machine, no persistent cue storage
2. **Handoff is short** — max ~10 lines, not a long dump
3. **Same language** — cue labels used consistently across status/watch/summary
4. **Graceful fallback** — missing artifacts don't crash, just return empty
5. **CLI-first** — plain text output, no heavy UI

## Blast Radius

### Changed
1. `hive status` gains optional `== Collaboration ==` section (only shown when active_cues > 0)
2. `hive watch` gains optional `== Collaboration Cues ==` section (only when active cues exist)
3. `hive shell/dashboard` gains `Collab Cues` section
4. WatchData gains `taskCues` field (backward compatible — derived, not stored)

### NOT Changed
1. Run state machine — unchanged
2. Steering / provider / review logic — unchanged
3. Existing test expectations — unchanged
4. No new CLI commands

## Verification

### Build
```bash
npm run build  # passes
```

### Tests
| Test File | Tests | Status |
|-----------|-------|--------|
| `collab-cues.test.ts` | 18 | All pass |
| `collab-summary.test.ts` | 9 | All pass |
| `handoff-summary.test.ts` | 9 | All pass |

### Coverage
- review_failed task → needs_review
- paused + steering pending → needs_human / handoff_ready
- provider-open + task pending → watch / blocked_by_provider
- merged / verified task → ready / passive
- handoff summary contains top blockers + top commands
- graceful fallback with missing artifacts

## Language Alignment

| Concept | Used In | Label |
|---------|---------|-------|
| needs_review | cues, summary, status | `[review] Needs Review` |
| needs_human | cues, summary, status | `[human] Needs Human` |
| blocked | cues, summary, status | `[blocked] Blocked` |
| watch | cues, summary, status | `[watch] Watch` |
| ready | cues, summary, status | `[ready] Ready` |
| passive | cues | `[ok] OK` |

## Acceptance Criteria

| Criterion | Status |
|-----------|--------|
| Collaboration summary exists | ✅ |
| Task-level collaboration cues visible | ✅ |
| Handoff surface helps接手者 understand run | ✅ |
| status/watch/summary terminology consistent | ✅ |
| `npm run build` passes | ✅ |
| Targeted tests pass (36) | ✅ |
| Short design document | ✅ |
| Closeout report | ✅ |

---

**Phase 10A is complete.**
