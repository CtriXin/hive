# Hive Collaboration Phase 6 Execution Plan

Date: 2026-04-05
Status: minimal slice implementation complete, smoke optional
Owner: codex-planner

## Purpose

This document is the executable brief for Phase 6 of the Hive collaboration stack.

Phase 6 exists after:

- Phase 5 memory linkage
- existing compact / restore / dashboard collab surfaces
- stable room refs already carried into MindKeeper-facing artifacts

and before:

- real `agent-im` posting
- Discord write-path integration
- authority-layer routing

Its job is to make human-thread linkage visible as a first-class artifact without turning `agent-im` into a runtime dependency.

## Phase 6 Goal

Make room-to-human-thread linkage visible in host-visible surfaces.

Expected outcome:

1. Hive can read a small `bridge_refs` shape that links `room_id` to a human-visible thread
2. `human-bridge-state.json`, `mindkeeper-checkpoint-input.json`, and `mindkeeper-checkpoint-result.json` can all carry the same shape
3. compact packet / restore prompt / hiveshell dashboard surface linked human threads
4. room linkage stays flat and artifact-driven; no bridge runtime state machine is introduced
5. Hive still works normally when no human-bridge artifacts exist

## Explicit Non-Goals

Do **not** implement any of the following in Phase 6:

- posting to Discord
- making `agent-im` a required runtime service
- changing room authority / execution control
- adding new AgentBus room kinds
- advisory scoring or committee routing
- human approval gates in the runtime loop

## Minimal Slice

### 1. Shared bridge ref shape

Use one compact linkage schema:

```typescript
interface HumanBridgeRef {
  room_id: string;
  room_kind: 'plan' | 'task_discuss' | 'review' | 'recovery';
  scope: 'run' | 'task';
  bridge_kind: 'agent-im';
  thread_kind: 'discord' | 'session';
  thread_id: string;
  status: 'linked' | 'active' | 'closed';
  focus_task_id?: string;
  thread_title?: string;
  last_human_reply_at?: string;
  updated_at?: string;
}
```

This stays intentionally flat: one ref says which room is exposed to which human-visible thread.

### 2. Artifact sources only

Read bridge refs only from passive artifacts:

- `human-bridge-state.json`
- `mindkeeper-checkpoint-input.json`
- `mindkeeper-checkpoint-result.json`

No runtime publisher or transport dependency is introduced in this phase.

### 3. Host-visible surfaces

Update only the smallest host-visible surfaces:

- `compact-packet.ts`
- compact restore prompt
- `hiveshell-dashboard.ts`

These surfaces should show linked human threads separately from `room_refs`.

## Validation

Local validation for the minimal slice:

- `npm test -- tests/human-bridge-linkage.test.ts tests/compact-packet.test.ts tests/hiveshell-dashboard.test.ts tests/mcp-surface.test.ts`
- `npm run build`

Smoke is optional for this phase because there is no new AgentBus or Discord runtime behavior; the slice is artifact + surface wiring only.

## Delivered in the minimal slice

- `HumanBridgeRef` added to shared collab types
- `orchestrator/human-bridge-linkage.ts` collects and dedupes bridge refs from passive artifacts
- compact packet now persists `bridge_refs`, and restore prompt includes `Human bridge threads`
- hiveshell dashboard now renders a dedicated `Human Bridge` section
- checkpoint artifact readers now accept `bridge_refs`

## Follow-up items

- when `agent-im` is ready, write the same `bridge_refs` shape from the runtime publisher
- decide whether one room should later support multiple downstream thread projections or stay single-primary
- keep authority routing and human approval outside this phase
