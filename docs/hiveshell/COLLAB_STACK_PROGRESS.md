# Collaboration Stack Progress

Last updated: 2026-04-04
Status: active
Owners: codex-planner, claude-planner

## Purpose

Long-lived progress note for the Hive collaboration stack.

Use for: current status, accepted decisions, next steps, recovery after context loss.

Bridge logs remain in `docs/agent-bridge/` for incremental handoff.

## Current Product Direction

We are **not** replacing Hive. We are building a combined system:

- `Hive` = control plane / execution brain
- `AgentBus` = async collaboration transport
- `agent-im` = human/session bridge
- `MindKeeper` = memory substrate

Core rule: Claude Opus stays **outside** the Hive core loop — used as external reviewer/advisor, never as execution model inside the loop.

## Phase 1: Planner Discuss via AgentBus — COMPLETE

### Status: COMPLETE (2026-04-03)

Plan expansion: `docs/agent-bridge/021-codex-to-claude.md`
Implementation/review handoff: `docs/agent-bridge/022-codex-to-claude.md`
Claude review: `docs/agent-bridge/023-claude-to-codex.md`

### Accepted Decisions

| Decision | Detail |
|---|---|
| Transport branch location | `planner-runner.ts`, not `discuss-bridge.ts` |
| Synthesis method | One cheap model pass (discuss tier) |
| Fallback | AgentBus failure or 0 replies -> local discuss |
| Config default transport | `"local"` (opt-in to agentbus) |
| Config default timeout | 15s (changed from 30s) |
| Config default min_replies | 0 (non-blocking; changed from 1) |
| Brief format | Structured `PlanningBrief` with review guidance + heuristic questions |
| cwd in brief | basename only, never full path |
| `collab-links.ts` | Deferred out of Phase 1 |
| `closePlannerDiscussRoom` | Add signature, basic impl (not blocking) |
| Reply metadata | Capture response_time_ms + content_length for future scoring |
| collectFromBroadcast | Remove (dead stub) |
| Reviewer scoring | Separate namespace from executor scores; data collection only in Phase 1 |

### Claude Review Outcome

- Verdict: PASS with 3 minor findings
- Fixed now:
  - Finding 2 — `min_replies=0` no longer exits on the first poll; a short grace window now captures fast replies before fallback
- Deferred to later stage:
  - Finding 1 — stable orchestrator identity across open/collect/close
  - Finding 3 — render a human-readable brief for synthesis instead of raw JSON

### Implementation State

Files with active work:

- `orchestrator/agentbus-adapter.ts` — structured brief payload + reply metadata landed
- `orchestrator/planner-runner.ts` — `buildPlanningBrief()` + shared `executePlannerDiscuss()` landed
- `orchestrator/types.ts` — `PlanningBrief` + `reply_metadata` landed
- `mcp-server/index.ts` — now reuses shared discuss path and surfaces room metadata
- `orchestrator/index.ts` — room surfacing landed
- Tests — brief shape, adapter metadata, fallback, MCP room surfacing covered

Estimated completeness: ~100% for Phase 1 scope. Main remaining work is Phase 1.5 follow-up, not Phase 1 closure.

### Code Gaps

| Gap | Current | Needed |
|---|---|---|
| Two-session smoke | Passed on 2026-04-03 | Keep as regression recipe for future changes |
| Stable orchestrator identity | Cosmetic audit inconsistency across room lifecycle calls | Fix before Phase 2 |
| Synthesis brief rendering | Works with JSON dump today | Improve to human-readable rendering in P2 |

### Acceptance Criteria

1. `npm run build` + `npm test` pass
2. Room created + brief posted + room_id in output
3. With reply: valid PlanDiscussResult
4. Without reply: graceful fallback
5. Adapter error: graceful fallback with log
6. transport=local: identical to current behavior
7. No full paths in brief
8. Room metadata persisted in run artifacts

### Current Validation

- `npm run build` passed
- `npm test` passed
- Latest local count: 35 test files, 314 tests
- Real two-session smoke passed on 2026-04-03 using isolated `AGENTBUS_DATA_DIR`
  - Terminal A opened a planner discuss room and published a structured `PlanningBrief`
  - Terminal B `agentbus join` + `agentbus watch` received the opening broadcast and replied within the `min_replies=0` grace window
  - Hive-side collector captured 1 reply (`response_time_ms=161`, `content_length=101`)
  - A valid `PlanDiscussResult` was produced and the room closed cleanly
  - Brief only exposed `cwd_hint: "hive"`; no full path leaked
  - Smoke also re-confirmed deferred Finding 1: open vs close used different orchestrator IDs in room messages, but this did not block functionality

## Stable System Boundaries

### Hive owns

planning, execution, review, verification, repair/replan, score/budget, compact/restore

### AgentBus owns

room, participant, async replies, transport semantics

### agent-im owns (not Phase 1)

session visibility, human intervention surface, Discord/thread projection

### MindKeeper owns (not Phase 1)

checkpoint, recall, recipe/board/thread memory

### Must NOT happen

- AgentBus must not become a Hive replacement
- Opus must not re-enter the Hive execution loop
- Review/repair/replan must not be in Phase 1

## External Review Feedback (024)

Third-agent review raised 4 points. Triage:

| Point | Verdict | When |
|---|---|---|
| Room as progress surface (loop-progress, compact/restore) | Accepted direction | Phase 1.5 |
| min_replies=0 grace window | Already fixed (Finding 2) | Done |
| Events before capabilities (progress bus ordering) | Accepted as principle | Phase 1.5+ |
| Room state as short card (CollabCard) | Accepted shape | Phase 1.5 |

Key accepted types for Phase 1.5:

- `CollabCard`: room_id, status (open/collecting/synthesizing/closed/fallback), replies, next
- Room lifecycle events: room:opened, reply:arrived, synthesis:started, fallback:local
- Wire into: compact packet, CLI/MCP output, hiveshell dashboard

Phase 1.5 slot interpretation:

- `AgentBus` should start acting as a **progress bus**, not only a discuss transport
- room state should feed one short host-visible surface:
  - `room_id`
  - `reply_count`
  - `last_reply_at`
  - `phase`
  - `focus_task_id`
  - `next`
- preferred consumers:
  - `loop-progress.json`
  - `hive status`
  - `hive watch`
  - compact / restore
  - MCP short cards

Details: `docs/agent-bridge/024-claude-to-codex.md`

## Phase 1.5: Room Progress Surface — COMPLETE

### Status: COMPLETE (2026-04-03)

Claude review + smoke: `docs/agent-bridge/026-claude-to-codex.md`

Delivered:
- `CollabCard` + `CollabStatusSnapshot` types in `types.ts`
- Lifecycle events (room:opened, reply:arrived, synthesis:started/done, fallback:local, room:closed)
- `on_reply` callback in collection loop
- Stable orchestrator identity across open/broadcast/summary/close (Finding 1 resolved)
- CollabCard wired into: loop-progress-store, compact packet, MCP plan card, CLI output, hiveshell dashboard
- `PlannerDiscussProgressHooks` + `PlanGoalHooks` for push-based progress updates
- driver.ts wires `onPlannerDiscussSnapshot` into `writeLoopProgress`

Validation:
- `npm run build` passed, 35 test files, 316 tests
- Smoke: isolated AGENTBUS_DATA_DIR, identity stable, card renders in compact/MCP/progress

## Phase 2: Worker Discuss via AgentBus — IMPLEMENTATION COMPLETE

### Status: IMPLEMENTATION COMPLETE (2026-04-03)

Implementation: `docs/agent-bridge/027-claude-to-codex.md`

Delivered:
- `WorkerDiscussBrief` type + `CollabRoomKind = 'plan' | 'task_discuss'`
- `CollabConfig` extended with `worker_discuss_*` fields
- `openWorkerDiscussRoom` with `hive-worker-{task_id}` orchestrator ID
- Generic `collectDiscussReplies` / `closeDiscussRoom` (planner aliases preserved)
- `synthesizeWorkerDiscussReplies` lightweight merge
- `handleDiscussTrigger` transport branch: agentbus vs local
- CollabCard + lifecycle events for task_discuss rooms
- `WorkerResult.worker_discuss_collab` for downstream visibility

Validation:
- `npm run build` passed, 36 test files, 320 tests
- Default transport: `local` (opt-in to agentbus)
- Real two-session smoke passed on 2026-04-04
  - stable `hive-worker-task-smoke-*` orchestrator ID across open/broadcast/close
  - `worker-discuss-brief` / `worker-discuss-summary` payload types verified
  - reply collected and synthesis completed with `agentbus-task-smoke-*` thread id
  - room closed cleanly and no full path leaked from `cwd_hint`

### Follow-up items
- Model-based synthesis for worker discuss (like planner's `synthesizeAgentBusReplies`)

## Phase 2.5: Task-Level Collab Surface — IMPLEMENTATION COMPLETE

### Status: IMPLEMENTATION COMPLETE (2026-04-03)

Execution brief: `docs/HIVE_COLLAB_PHASE2_5_EXECUTION.md`

Delivered:
- `WorkerStatusEntry.collab` persists `CollabStatusSnapshot` for task-level rooms
- worker discuss snapshot publishing now syncs into `worker-status.json`
- compact packet worker focus includes task-level collab card
- compact restore prompt includes primary worker collab room
- MCP execution / dispatch cards include focused worker collab lines
- hiveshell dashboard and `hive workers` / `hive status` surface task-level collab summaries

Validation:
- `npm test -- tests/worker-status-store.test.ts tests/worker-discuss-transport.test.ts tests/compact-packet.test.ts tests/mcp-surface.test.ts tests/hiveshell-dashboard.test.ts` passed
- `npm run build` passed

### Follow-up items
- Review the Phase 2.5 surface for verbosity / duplication in CLI output
- Decide whether later phases need a multi-room history artifact beyond `worker-status.json`
- Model-based synthesis for worker discuss (still open from Phase 2)

## Phase 3: External Review Slot — IMPLEMENTATION COMPLETE

### Status: IMPLEMENTATION COMPLETE (2026-04-04)

Execution brief: `docs/HIVE_COLLAB_PHASE3_EXECUTION.md`

Delivered:
- `ReviewBrief` + `CollabRoomKind = 'plan' | 'task_discuss' | 'review'`
- `openReviewRoom()` + `external-review-summary` close payload
- `collab.review_transport` / `review_timeout_ms` / `review_min_replies`
- `orchestrator/review-room-handler.ts` for post-cascade advisory review rooms
- failed review results can collect external replies and append `external-review` findings into repair context
- existing worker/status/compact/MCP/dashboard surfaces now accept `review` rooms without a new schema

Validation:
- `npm test -- tests/agentbus-adapter.test.ts tests/review-room-handler.test.ts tests/worker-status-store.test.ts tests/compact-packet.test.ts tests/mcp-surface.test.ts tests/hiveshell-dashboard.test.ts` passed
- `npm run build` passed

### Follow-up items
- Run one real two-session smoke for `room_kind=review`
- Decide later whether external review should stay fail-only or also support contested/pass sampling
- Consider model-based synthesis if advisory replies become noisy

## Phase 4: Repeated-fail Advisory — IMPLEMENTATION COMPLETE

### Status: IMPLEMENTATION COMPLETE (2026-04-05)

Execution brief: `docs/HIVE_COLLAB_PHASE4_EXECUTION.md`

Delivered:
- `RecoveryBrief` + `CollabRoomKind = 'plan' | 'task_discuss' | 'review' | 'recovery'`
- `openRecoveryRoom()` + `recovery-summary` close payload
- `collab.recovery_transport` / `recovery_timeout_ms` / `recovery_min_replies` / `recovery_after_failures`
- `orchestrator/recovery-room-handler.ts` for repeated-fail advisory rooms before the next repair attempt
- repeated repair attempts can collect external replies and append `recovery-advisory` findings into the next repair prompt
- existing worker/status/compact/MCP/dashboard surfaces now accept `recovery` rooms without a new schema

Validation:
- `npm test -- tests/agentbus-adapter.test.ts tests/review-room-handler.test.ts tests/recovery-room-handler.test.ts tests/worker-status-store.test.ts tests/compact-packet.test.ts tests/mcp-surface.test.ts tests/hiveshell-dashboard.test.ts` passed
- `npm run build` passed

Smoke:
- direct AgentBus smoke passed for both reply and 0-reply fallback paths
- verified: `room_kind=recovery`, `recovery-brief`, `recovery-summary`, basename-only `cwd_hint`, advisory finding injection into next repair prompt

### Follow-up items
- Decide whether repeated-fail advisory should also trigger on retry-budget exhaustion with no further repair attempt
- Consider model-based synthesis if repeated-fail advisory becomes noisy
- Repair worker lifecycle status visibility is still coarse compared with first-pass dispatch

## Phase 5: Memory Linkage — MINIMAL SLICE COMPLETE

### Status: MINIMAL SLICE COMPLETE (2026-04-05)

Execution brief: `docs/HIVE_COLLAB_PHASE5_EXECUTION.md`

Delivered:
- `MindkeeperRoomRef` shared type derived from existing `CollabCard`
- `orchestrator/memory-linkage.ts` dedupes run/task room refs from `loop-progress.json`, `worker-status.json`, and existing checkpoint artifacts
- `mindkeeper-checkpoint-input.json` / `mindkeeper-checkpoint-result.json` readers now accept `room_refs`
- compact packet now persists `room_refs`, and restore prompt includes `Mindkeeper linked rooms`
- hiveshell dashboard now renders linked room refs in the MindKeeper section

Validation:
- `npm test -- tests/memory-linkage.test.ts tests/compact-packet.test.ts tests/hiveshell-dashboard.test.ts tests/mcp-surface.test.ts` passed
- `npm run build` passed

Notes:
- This phase does **not** make MindKeeper a runtime dependency
- No new AgentBus runtime behavior was added, so a dedicated smoke is optional

### Follow-up items
- When runtime checkpoint writing returns, write the same `room_refs` shape into the outbound payload directly
- Decide later whether room refs should also carry downstream human-bridge thread ids or stay flat until Phase 6

## Future Stages (Ordered)

1. ~~Phase 1: Planner discuss via AgentBus~~ COMPLETE
2. ~~Phase 1.5: Room progress surface + events + CollabCard~~ COMPLETE
3. ~~Phase 2: Worker discuss via AgentBus (room_kind=task_discuss)~~ IMPLEMENTATION COMPLETE
4. ~~Phase 2.5: task-level collab surface / compact / status wiring~~ IMPLEMENTATION COMPLETE
5. ~~Phase 3: External review slot (room_kind=review, post-cascade)~~ IMPLEMENTATION COMPLETE
6. ~~Phase 4: Repeated-fail advisory (room_kind=recovery)~~ IMPLEMENTATION COMPLETE
7. ~~Phase 5: Memory linkage (MindKeeper checkpoint includes room refs)~~ MINIMAL SLICE COMPLETE
8. Phase 6: Human bridge (agent-im maps rooms to Discord threads)
9. Advisory scoring engine (separate from executor scores, data collection starts Phase 1)

## Recovery Order

If context is lost, read in this order:

1. `docs/HIVE_COLLAB_STACK.md` — architecture truth
2. `docs/HIVE_COLLAB_PHASE1_EXECUTION.md` — frozen Phase 1 brief
3. `docs/HIVE_COLLAB_PHASE1_5_EXECUTION.md` — active next execution brief
4. `docs/HIVE_COLLAB_PHASE2_EXECUTION.md` — next room-kind brief
5. `docs/HIVE_COLLAB_PHASE2_5_EXECUTION.md` — task-level surface brief
6. `docs/HIVE_COLLAB_PHASE3_EXECUTION.md` — external review slot brief
7. `docs/HIVE_COLLAB_PHASE4_EXECUTION.md` — repeated-fail advisory brief
8. `docs/HIVE_COLLAB_PHASE5_EXECUTION.md` — memory linkage brief
9. `docs/hiveshell/COLLAB_STACK_PROGRESS.md` — this file (live status)
10. Latest `docs/agent-bridge/*.md` — incremental deltas
