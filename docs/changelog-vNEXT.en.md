# Hive vNEXT Changelog

**Release Date:** TBD
**Status:** In Development

---

## Overview

This release introduces the **Collaboration Stack** — a multi-phase initiative to integrate Hive with AgentBus for asynchronous cross-model collaboration, while maintaining Hive as the control plane for all execution decisions.

---

## Breaking Changes

### Configuration Schema Update

The `collab` configuration block has been extended with new fields for worker discuss transport:

```json
{
  "collab": {
    "plan_discuss_transport": "local",
    "plan_discuss_timeout_ms": 15000,
    "plan_discuss_min_replies": 0,
    "worker_discuss_transport": "local",
    "worker_discuss_timeout_ms": 10000,
    "worker_discuss_min_replies": 0
  }
}
```

**Migration:**
- Existing configurations without `collab` continue to work unchanged (backward compatible)
- To enable AgentBus transport, set `plan_discuss_transport` or `worker_discuss_transport` to `"agentbus"`
- Default transport remains `"local"` for both plan and worker discuss

### Type System Changes

New types added to `orchestrator/types.ts`:

- `CollabCard` — Host-facing collaboration status card
- `CollabLifecycleEvent` — Structured lifecycle events for rooms
- `CollabStatusSnapshot` — Wrapper for card + recent events
- `WorkerDiscussBrief` — Task-scoped seed object for worker discussions
- `PlannerDiscussRoomRef` — Room metadata with reply tracking

**Impact:** Consumers of planning results should now check for `plan_discuss_room` field containing `PlannerDiscussRoomRef`.

### Environment Variable

AgentBus integration requires `AGENTBUS_DATA_DIR` environment variable (defaults to `~/.agentbus` if not set).

---

## New Features

### Phase 1: Planner Discuss via AgentBus

Planner discussions can now route through AgentBus rooms for asynchronous multi-session collaboration.

**Key capabilities:**
- Create planning rooms with compact briefs
- Collect replies asynchronously with configurable timeout
- Synthesize AgentBus replies into `PlanDiscussResult`
- Automatic fallback to local discuss on failure or zero replies
- Room metadata persisted in planning artifacts

**Configuration:**
```json
{
  "collab": {
    "plan_discuss_transport": "agentbus",
    "plan_discuss_timeout_ms": 15000,
    "plan_discuss_min_replies": 0
  }
}
```

### Phase 1.5: Observable Collaboration State

Planning rooms now emit structured lifecycle events and expose a short `CollabCard` for host visibility.

**Lifecycle events:**
- `room:opened` — Room created and seeded with brief
- `reply:arrived` — New participant reply received
- `synthesis:started` — Beginning reply synthesis
- `synthesis:done` — Synthesis complete
- `fallback:local` — Falling back to local discuss
- `room:closed` — Room lifecycle complete

**CollabCard fields:**
- `room_id` — Unique room identifier
- `room_kind` — `"plan"` or `"task_discuss"`
- `status` — `open` | `collecting` | `synthesizing` | `closed` | `fallback`
- `replies` — Reply count
- `last_reply_at` — ISO timestamp of last reply
- `join_hint` — CLI hint for joining room
- `focus_task_id` — Associated task (for task discuss)
- `next` — Human-readable next step

### Phase 2: Worker Discuss via AgentBus

Task-level worker discussions can now route through AgentBus rooms.

**Key capabilities:**
- Create `task_discuss` rooms when worker confidence is below threshold
- Post `WorkerDiscussBrief` with task context
- Collect asynchronous replies from other sessions
- Synthesize into `DiscussResult` for worker decision
- Full lifecycle event emission
- Automatic fallback to local discuss

**Configuration:**
```json
{
  "collab": {
    "worker_discuss_transport": "agentbus",
    "worker_discuss_timeout_ms": 10000,
    "worker_discuss_min_replies": 0
  }
}
```

### AgentBus Adapter

New `orchestrator/agentbus-adapter.ts` provides thin bridge to AgentBus:

- `openPlannerDiscussRoom()` — Create planning room with brief
- `collectPlannerDiscussReplies()` — Poll for replies with timeout
- `closePlannerDiscussRoom()` — Close room with optional summary
- `openWorkerDiscussRoom()` — Create task discuss room
- `collectDiscussReplies()` — Collect replies for any room kind
- `closeDiscussRoom()` — Close any room kind
- `synthesizeWorkerDiscussReplies()` — Merge replies into decision

### Worker Discuss Handler

New `orchestrator/worker-discuss-handler.ts` manages worker discuss lifecycle:

- Reads `discuss-trigger.json` from task work directory
- Routes to AgentBus or local transport based on config
- Publishes `CollabStatusSnapshot` to worker status store
- Handles fallback on adapter failure or zero replies

### Compact Packet Integration

Collaboration state now flows through compact/restore:

- `CollabCard` included in compact output when active
- Lifecycle events available for progress surfaces
- MCP and CLI surfaces render short card consistently

---

## Migration Guide

### For Existing Users

1. **No action required** — Default `local` transport maintains existing behavior
2. **To try AgentBus planning discuss:**
   - Ensure AgentBus is installed and `AGENTBUS_DATA_DIR` is set
   - Add `"plan_discuss_transport": "agentbus"` to `collab` config
   - Run a plan and observe room creation in output
3. **To try AgentBus worker discuss:**
   - Add `"worker_discuss_transport": "agentbus"` to `collab` config
   - Trigger worker uncertainty (or set low threshold)
   - Observe `task_discuss` room creation

### For Developers

1. **Update type imports** — New collaboration types in `orchestrator/types.ts`
2. **Check planning results** — Look for `plan_discuss_room` field
3. **Consume CollabCard** — Use for status/dashboard surfaces instead of ad-hoc text
4. **Handle lifecycle events** — Subscribe to events for real-time collaboration UI

### Configuration Examples

**Local-only (default):**
```json
{
  "collab": {
    "plan_discuss_transport": "local",
    "worker_discuss_transport": "local"
  }
}
```

**AgentBus for planning only:**
```json
{
  "collab": {
    "plan_discuss_transport": "agentbus",
    "plan_discuss_timeout_ms": 20000,
    "worker_discuss_transport": "local"
  }
}
```

**Full AgentBus:**
```json
{
  "collab": {
    "plan_discuss_transport": "agentbus",
    "plan_discuss_timeout_ms": 15000,
    "plan_discuss_min_replies": 1,
    "worker_discuss_transport": "agentbus",
    "worker_discuss_timeout_ms": 10000,
    "worker_discuss_min_replies": 0
  }
}
```

---

## Architecture Changes

### Control Plane Rule

Hive remains the control plane. AgentBus is an adapter/subsystem:

- Hive → AgentBus (room creation, message posting)
- Hive → MindKeeper (checkpoint, recall)
- agent-im → AgentBus (human replies)
- agent-im → Hive (read-only status)

No reverse control from AgentBus or MindKeeper into Hive core loop.

### Room Kinds

Two room kinds introduced:

| Kind | Purpose | Lifecycle |
|------|---------|-----------|
| `plan` | Planner discuss | plan → room → replies → synthesis → close |
| `task_discuss` | Worker uncertainty | trigger → room → replies → decision → close |

### Data Flow

```
Planner/Worker
    │
    ▼
┌─────────────────┐
│  Transport      │── local (existing)
│  Selection      │── agentbus (new)
└─────────────────┘
    │
    ▼
┌─────────────────┐     ┌─────────────┐
│  AgentBus       │────▶│  CollabCard │
│  Adapter        │     │  + Events   │
└─────────────────┘     └─────────────┘
    │                         │
    ▼                         ▼
┌─────────────────┐     ┌─────────────┐
│  Room Lifecycle │     │  Compact    │
│  (open/close)   │     │  MCP/CLI    │
└─────────────────┘     └─────────────┘
```

---

## Known Limitations

- AgentBus transport requires external AgentBus installation
- Room synthesis uses one cheap model pass (intentional collaboration cost)
- No human bridge / Discord integration yet (Phase 3+)
- No review rooms yet (future phase)
- MindKeeper integration limited to existing checkpoint usage

---

## Files Added/Modified

### New Files

- `orchestrator/agentbus-adapter.ts` — AgentBus bridge
- `orchestrator/worker-discuss-handler.ts` — Worker discuss lifecycle
- `orchestrator/collab-types.ts` — Collaboration type definitions

### Modified Files

- `orchestrator/types.ts` — Extended with collaboration types
- `orchestrator/planner-runner.ts` — AgentBus transport branch
- `orchestrator/dispatcher.ts` — Worker discuss transport routing
- `orchestrator/compact-packet.ts` — CollabCard inclusion
- `orchestrator/loop-progress-store.ts` — Collaboration state
- `orchestrator/mcp-surface.ts` — Card rendering
- `orchestrator/hiveshell-dashboard.ts` — Status surfaces
- `orchestrator/index.ts` — CLI output
- `mcp-server/index.ts` — MCP output

---

## References

- `docs/HIVE_COLLAB_STACK.md` — Collaboration stack overview
- `docs/HIVE_COLLAB_PHASE1_EXECUTION.md` — Phase 1 implementation
- `docs/HIVE_COLLAB_PHASE1_5_EXECUTION.md` — Phase 1.5 implementation
- `docs/HIVE_COLLAB_PHASE2_EXECUTION.md` — Phase 2 implementation
