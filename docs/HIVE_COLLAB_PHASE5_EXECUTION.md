# Hive Collaboration Phase 5 Execution Plan

Date: 2026-04-05
Status: minimal slice implementation complete, smoke optional
Owner: codex-planner

## Purpose

This document is the executable brief for Phase 5 of the Hive collaboration stack.

Phase 5 exists after:

- Phase 4 repeated-fail advisory
- existing task/run collab surfaces
- compact / restore / dashboard visibility for active rooms

and before:

- agent-im human bridge
- advisory scoring
- authority-layer routing

Its job is to link existing collaboration rooms into the MindKeeper memory surface without making MindKeeper a runtime dependency.

## Phase 5 Goal

Make MindKeeper-facing artifacts and compact / restore surfaces carry stable room refs.

Expected outcome:

1. active run/task collaboration rooms can be summarized into a small, deduped `room_refs` list
2. `mindkeeper-checkpoint-input.json` and `mindkeeper-checkpoint-result.json` can carry the same `room_refs` shape
3. compact packet / restore prompt / hiveshell dashboard surface the linked room refs
4. restore after compact still sees the important room ids even if the active `CollabCard` is no longer the only surface
5. Hive still works normally when no MindKeeper artifacts exist

## Explicit Non-Goals

Do **not** implement any of the following in Phase 5:

- calling MindKeeper from the runtime loop as a hard dependency
- changing retry / replan / review policies
- adding new room kinds
- human bridge / Discord / agent-im wiring
- authority-layer committee logic
- multi-run room history beyond the current run artifacts

## Minimal Slice

### 1. Reuse existing collab state

Source room refs only from already-accepted surfaces:

- `loop-progress.json`
- `worker-status.json`
- existing MindKeeper checkpoint artifacts when present

No new runtime source of truth is introduced.

### 2. Shared room ref shape

Use one compact schema:

```typescript
interface MindkeeperRoomRef {
  room_id: string;
  room_kind: 'plan' | 'task_discuss' | 'review' | 'recovery';
  scope: 'run' | 'task';
  status: 'open' | 'collecting' | 'synthesizing' | 'closed' | 'fallback';
  replies: number;
  focus_task_id?: string;
  join_hint?: string;
  last_reply_at?: string;
}
```

This is intentionally derived from the existing `CollabCard`, not a brand-new memory schema.

### 3. Host-visible surfaces

Update only the smallest host-visible surfaces:

- `compact-packet.ts`
- compact restore prompt
- `hiveshell-dashboard.ts`

These surfaces should show linked room refs in addition to the primary active card.

## Validation

Local validation for the minimal slice:

- `npm test -- tests/memory-linkage.test.ts tests/compact-packet.test.ts tests/hiveshell-dashboard.test.ts tests/mcp-surface.test.ts`
- `npm run build`

Smoke is optional for this phase because there is no new AgentBus runtime behavior; the slice is artifact + surface wiring only.

## Delivered in the minimal slice

- `orchestrator/memory-linkage.ts` builds deduped room refs from live collab artifacts plus checkpoint artifacts
- `MindkeeperRoomRef` added to shared collab types
- compact packet now persists `room_refs` and restore prompt includes `Mindkeeper linked rooms`
- hiveshell dashboard shows linked room refs in the MindKeeper section
- checkpoint artifact readers now accept `room_refs` in both input/result JSON

## Follow-up items

- if/when runtime checkpoint writing returns, write the same `room_refs` shape into the outbound payload directly
- decide whether future phases need per-room thread linkage beyond a flat list
- keep Phase 6 focused on human bridge, not memory schema expansion
