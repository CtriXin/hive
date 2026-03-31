# AgentBus — Room-Based Async Collaboration Bus

> **System name**: `AgentBus` (successor to session-mailbox v1)
> **Status**: Design v1.2 (post Codex review: message/delivery split, cursor model)
> **Date**: 2026-03-30

### Scope disclaimer

> **"All CLI / all model / MMS"** is the **architectural north star**, not the MVP commitment.
> MVP delivers: filesystem backend + Claude Code adapter + basic orchestrator loop.
> Cross-CLI compatibility (Codex, generic) and MCP tools are Phase 2.
> The protocol and IBackend interface are designed to support all hosts eventually,
> but v1 ships with one adapter only.

---

## 0. Naming Decision

`session-mailbox v2` → **AgentBus**

- "Agent" = any LLM CLI agent, not Claude-specific
- "Bus" = broadcast topology, not point-to-point mail
- Short, memorable, CLI-friendly (`agentbus create`, `agentbus join`)

---

## 1. Problem Framing

### What v1 mailbox gets wrong

The `/mail` pattern is 1:1, pull-based, single-round. It works for "ask B a question, get an answer." It breaks down when:

- You need multiple agents answering simultaneously
- The orchestrator must judge "is this enough?" and follow up
- Sessions must not block each other
- Multiple collaboration threads run in parallel

### What AgentBus must solve

| Requirement | v1 mailbox | AgentBus |
|-------------|------------|----------|
| Multi-participant | ✗ | ✓ |
| Broadcast | ✗ | ✓ |
| Orchestrator loop | ✗ | ✓ |
| Background workers | partial | ✓ |
| Parallel rooms | ✗ | ✓ |
| CLI-agnostic | ✗ | ✓ |
| Crash recovery | ✗ | ✓ |

### Non-goals (v1)

- Real-time push (no websockets, no SSE)
- Encryption or auth beyond filesystem permissions
- Cross-machine transport (filesystem-local only in v1)
- Persistent agent memory across rooms

---

## 2. Core Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     HOST LAYER                          │
│  Claude Code     │  Codex CLI    │  Generic CLI / MCP   │
│  /mail skill     │  agentbus cmd │  agentbus cmd / tools│
└────────┬─────────┴──────┬────────┴──────────┬───────────┘
         │                │                   │
         └────────────────┼───────────────────┘
                          │  Host Adapter API
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   BACKEND ENGINE                        │
│  Room CRUD │ Message Dispatch │ Worker Poller │ OrchestratorLoop │
└────────────────────────────┬────────────────────────────┘
                             │  Protocol I/O
                             ▼
┌─────────────────────────────────────────────────────────┐
│                  PROTOCOL LAYER                         │
│  Filesystem Mailbox  │  JSON Schemas  │  State Machine  │
│  /Users/xin/.agentbus/                                  │
└─────────────────────────────────────────────────────────┘
```

### Layer responsibilities

| Layer | Owns | Does NOT own |
|-------|------|--------------|
| Protocol | File formats, schema, directory structure, state transitions | Any logic |
| Backend Engine | Room lifecycle, message routing, polling, orchestrator loop | UI, CLI syntax |
| Host Adapter | CLI command parsing, slash command, MCP tool wrapper | Business logic |

**Rule**: No business logic in adapters. No CLI syntax in backend. No adapter calls in protocol.

---

## 3. Layer Separation (detailed)

### 3.1 Protocol Layer (protocol-level decisions)

Everything a future adapter needs to implement to be compatible:

- Directory structure (§5)
- JSON schemas (§6)
- File naming conventions
- Atomic write rules
- Lock acquisition protocol
- State machine transitions (§7)

Protocol decisions are **permanent**. Changing them breaks all adapters.

### 3.2 Backend Engine

> **v1.1**: Backend Engine is defined as an **interface** from day one.
> Filesystem is the first (and MVP-only) implementation.
> This costs ~50 lines of interface code and prevents the architecture
> from ossifying around filesystem assumptions.

Written once in TypeScript (`src/agentbus/`), called by all adapters.

```
src/agentbus/
├── types.ts         # IBackend interface definition
├── backend-fs.ts    # filesystem implementation of IBackend
├── room.ts          # create, join, close, status (calls IBackend)
├── message.ts       # send, dispatch, route, ack (calls IBackend)
├── worker.ts        # poll loop, claim, process
├── orchestrator.ts  # resolve-or-followup loop
├── watchdog.ts      # orchestrator crash detection (v1.1)
├── hmac.ts          # message signing/verification (v1.1)
├── lock.ts          # atomic file lock primitives
├── schema.ts        # Zod schemas, validation
└── index.ts         # public API surface
```

```typescript
// types.ts — Backend Engine interface (v1.2)
interface IBackend {
  // Room
  createRoom(opts: CreateRoomOpts): Promise<Room>;
  readManifest(roomId: string): Promise<Manifest>;
  writeManifest(roomId: string, manifest: Manifest): Promise<void>;
  setRoomState(roomId: string, state: RoomState): Promise<void>;

  // Messages (append-only log)
  writeMessage(roomId: string, msg: Message): Promise<void>;
  listMessages(roomId: string, filter?: { seqGreaterThan?: number }): Promise<Message[]>;

  // Receipts (per-participant, per-message)
  writeReceipt(roomId: string, participantId: string, msgId: string, state: ReceiptState, answerMsgId?: string): Promise<void>;
  hasReceipt(roomId: string, participantId: string, msgId: string): Promise<boolean>;
  listReceipts(roomId: string, participantId: string): Promise<Receipt[]>;

  // Cursors
  readCursor(roomId: string, participantId: string): Promise<number>;
  writeCursor(roomId: string, participantId: string, seq: number): Promise<void>;

  // Participants
  writeParticipant(roomId: string, participant: Participant): Promise<void>;
  readParticipant(roomId: string, participantId: string): Promise<Participant>;
  listParticipants(roomId: string): Promise<Participant[]>;

  // Locks (compound key: msg_id + participant_id)
  acquireLock(roomId: string, msgId: string, participantId: string): Promise<boolean>;
  releaseLock(roomId: string, msgId: string, participantId: string): Promise<void>;
  cleanStaleLocks(roomId: string): Promise<number>;
}
```

MVP ships `BackendFs implements IBackend`. Future transports (SQLite, Redis)
implement the same interface.

### 3.3 Host Adapter Layer (host-specific decisions)

Each adapter wraps the backend engine. Adapters handle:
- How the user types commands
- How output is formatted for their terminal
- Whether background polling runs as a thread, subprocess, or cron

Adapters do NOT handle room logic.

### 3.4 Orchestrator / Worker behavior

- **Orchestrator (A)**: the session that created the room. Evaluates answers, decides follow-up or resolve.
- **Worker (participant)**: background poller that reads messages/ via cursor, generates answer via MMS, writes reply.

Both use the same backend engine. Difference is role, not code.

---

## 4. Room Lifecycle

```
create(question) → room_id
    │
    ▼
[PENDING] ─── participants join via hash ───► [OPEN]
                                                │
                                    A broadcasts / directed ask
                                                │
                                    participants reply (async)
                                                │
                                    A evaluates: enough?
                                    ┌───────────┴───────────┐
                                    │ no                    │ yes
                                    ▼                       ▼
                               A followup            [RESOLVING]
                               (loop back)                  │
                                                       A sends resolve
                                                            │
                                                        [CLOSED]

At any point: timeout / max_rounds → [FAILED]
```

### Lifecycle operations

| Operation | Who | Effect |
|-----------|-----|--------|
| `create` | Orchestrator | Creates room dir, manifest, returns hash |
| `join` | Participant | Writes participant.json, initializes cursor to 0 |
| `watch` | Participant | Starts background poll loop (cursor-based) |
| `ask` | Orchestrator | Writes message to `messages/` (directed or broadcast) |
| `broadcast` | Orchestrator | Writes message to `messages/` with `to: "broadcast"` |
| `reply` | Participant | Writes answer message to `messages/`, updates receipt |
| `followup` | Orchestrator | Writes followup message after evaluating answers |
| `resolve` | Orchestrator | Sets room state RESOLVING → CLOSED, writes resolve msg |
| `close` | Orchestrator | Writes .closed sentinel, cleans up locks |

---

## 5. Filesystem Protocol

### 5.1 Root

```
/Users/xin/.agentbus/          ← absolute path, never ~ or $HOME
├── .version                   ← protocol version: "2"
├── rooms/
│   └── {room_id}/             ← 8-char hex, e.g. a3f7b2e1
│       ├── manifest.json
│       ├── .state             ← plain text: PENDING|OPEN|RESOLVING|CLOSED|FAILED
│       ├── .closed            ← sentinel: exists iff room is closed
│       ├── messages/          ← append-only log, source of truth
│       │   └── {seq}_{msg_id}.json  ← e.g. 000007_msg_1743300000_a3b1.json
│       ├── receipts/          ← per-participant delivery state (v1.2)
│       │   └── {participant_id}/
│       │       └── {msg_id}.json    ← {state, processed_at, answer_msg_id}
│       ├── cursors/           ← per-participant read position (v1.2)
│       │   └── {participant_id}.cursor  ← plain text: last processed seq number
│       ├── participants/
│       │   └── {participant_id}.json
│       └── locks/
│           └── {msg_id}_{participant_id}.lock/  ← compound key (v1.2)
│               └── meta.json
└── registry/
    └── {participant_id}.json        ← global participant identity
```

> **v1.2 breaking changes**:
> - `inbox/` removed. Workers read `messages/` and skip entries where seq <= cursor.
> - `locks/` key changed from `{msg_id}` to `{msg_id}_{participant_id}` — each participant
>   locks independently, enabling parallel processing of the same broadcast message.
> - `receipts/` replaces `processed_msgs` array in participant.json — one file per ack,
>   no hot-file contention.
> - `cursors/` provides crash-safe read position per participant.

### 5.2 File naming conventions (protocol-level)

| Entity | Format | Example |
|--------|--------|---------|
| Room ID | 8 hex chars | `a3f7b2e1` |
| Message ID | `msg_{unix_ms}_{4hex}` | `msg_1743300000123_a3b1` |
| Participant ID | `p_{alias}_{4hex}` | `p_claude_main_f2a9` |
| Message file | `{seq:06d}_{msg_id}.json` | `000007_msg_...json` |
| Receipt file | `{msg_id}.json` in `receipts/{pid}/` | `msg_...json` |
| Cursor file | `{participant_id}.cursor` | `p_claude_main_f2a9.cursor` |
| Lock dir | `{msg_id}_{participant_id}.lock/` | compound key (v1.2) |

Sequence numbers are monotonic per room. Message files sort chronologically by name.

### 5.3 Atomic write rules (protocol-level)

All writes must be atomic. Rule: **write to `.tmp`, then `rename`**.

```
write(path, content):
  tmp = path + ".tmp." + random()
  write(tmp, content)
  rename(tmp, path)  # atomic on POSIX
```

Never write directly to the target path. A partial write that crashes leaves a `.tmp` file, never corrupts the target.

### 5.4 Lock acquisition protocol (protocol-level)

> **v1.2**: Lock key changed from `{msg_id}` to `{msg_id}_{participant_id}`.
> This fixes the broadcast concurrency bug — each participant locks independently,
> so all participants can process the same broadcast message in parallel.

File locks use `mkdir` (atomic on POSIX):

```
acquire(msg_id, participant_id):
  lock_key = "{msg_id}_{participant_id}"
  lock_path = locks/{lock_key}.lock/   # directory, not file
  try mkdir(lock_path):
    write lock_path/meta.json: {pid, participant_id, expires_at}
    return SUCCESS
  catch EEXIST:
    meta = read lock_path/meta.json
    if now() > meta.expires_at:
      rmdir(lock_path)  # stale lock
      retry acquire()
    return BUSY

release(msg_id, participant_id):
  lock_key = "{msg_id}_{participant_id}"
  rmdir(lock_path/meta.json first, then lock_path)
```

Lock TTL: **60 seconds** for processing. If a worker holds a lock beyond TTL, another worker can steal it.

**Why compound key**: A broadcast message goes to N participants. Each participant must be able to process it independently. With a single `msg_id` lock, only one participant can process a broadcast — the others are blocked. Compound key `msg_id + participant_id` means each participant gets its own lock on the same message.

---

## 6. JSON Schemas

### 6.1 manifest.json

```json
{
  "room_id": "a3f7b2e1",
  "version": 2,
  "created_at": "2026-03-30T10:00:00Z",
  "orchestrator_id": "p_claude_main_f2a9",
  "question": "How should we handle the auth middleware rewrite?",
  "state": "OPEN",
  "participants": ["p_claude_main_f2a9", "p_codex_arch_b3c1"],
  "message_seq": 7,
  "max_rounds": 5,
  "current_round": 1,
  "round_timeout_seconds": 300,
  "room_secret": "hex_32bytes_generated_at_create",
  "resolved_at": null,
  "closed_at": null,
  "resolve_reason": null
}
```

### 6.2 Message schema

> **v1.2**: Messages are now append-only log entries. They no longer carry mutable `state`.
> Delivery state (DELIVERED/PROCESSING/ANSWERED) lives in `receipts/{participant_id}/`.

```json
{
  "msg_id": "msg_1743300000123_a3b1",
  "seq": 7,
  "room_id": "a3f7b2e1",
  "type": "broadcast",
  "from": "p_claude_main_f2a9",
  "to": "broadcast",
  "body": "What are the tradeoffs between JWT and session tokens here?",
  "parent_msg_id": null,
  "created_at": "2026-03-30T10:01:00Z",
  "ttl_seconds": 300,
  "idempotency_key": "sha256_of_room_id+seq+from",
  "hmac": "sha256_hmac(room_secret, msg_id+from+body)",
  "round": 1,
  "metadata": {}
}
```

`type` values: `question | directed_ask | broadcast | answer | followup | resolve | close | error | timeout | escalate`

`to` values: `"broadcast"` | `["p_id1", "p_id2"]`

Message files are **immutable after write**. No in-place updates. All mutable state lives in receipts.

### 6.2.1 Receipt schema (v1.2)

Per-participant processing state for each message. Stored in `receipts/{participant_id}/{msg_id}.json`.

```json
{
  "msg_id": "msg_1743300000123_a3b1",
  "participant_id": "p_codex_arch_b3c1",
  "state": "ANSWERED",
  "processing_at": "2026-03-30T10:01:05Z",
  "answered_at": "2026-03-30T10:01:30Z",
  "answer_msg_id": "msg_1743300030000_c2d3"
}
```

`state` values: `PROCESSING | ANSWERED | TIMEOUT | ERROR`

> No `DELIVERED` state. "Message at seq > cursor, no receipt" = implicitly delivered.
> Receipt is created at PROCESSING, not before.

**Why receipts?** A broadcast message (msg_id X) goes to participants B, C, D.
Each participant has its own receipt: B may be ANSWERED, C may be PROCESSING, D may be TIMEOUT.
The message file itself stays immutable — only receipts track per-participant state.

### 6.3 Participant schema

> **v1.2**: `processed_msgs` removed from participant.json.
> Processing state now tracked via `receipts/` (per-message files) and
> `cursors/` (read position). participant.json is no longer a hot file.

```json
{
  "participant_id": "p_codex_arch_b3c1",
  "alias": "codex-arch",
  "model": "gpt-4o",
  "cli": "codex",
  "role": "participant",
  "joined_at": "2026-03-30T10:00:30Z",
  "state": "ACTIVE",
  "last_seen_at": "2026-03-30T10:01:00Z",
  "poll_interval_seconds": 5,
  "capabilities": ["reply", "followup"]
}
```

`role` values: `orchestrator | participant`
`state` values: `JOINING | ACTIVE | IDLE | OFFLINE | EVICTED`

Heartbeat (`last_seen_at`) is the only field that changes frequently.
It is now the ONLY mutable field in participant.json — no more contention
with processed_msgs or other writes.

### 6.4 Lock meta schema

```json
{
  "pid": 12345,
  "participant_id": "p_codex_arch_b3c1",
  "acquired_at": "2026-03-30T10:01:00Z",
  "expires_at": "2026-03-30T10:02:00Z"
}
```

### 6.5 Resolve record

Written to `manifest.json` on resolve, and as a `resolve` type message:

```json
{
  "type": "resolve",
  "resolved_by": "p_claude_main_f2a9",
  "reason": "Both participants confirmed JWT is appropriate. Security concern addressed.",
  "answer_summary": "Use short-lived JWT (15min) + refresh token rotation.",
  "source_msg_ids": ["msg_...b3", "msg_...c4"],
  "round": 2
}
```

---

## 7. State Machine

### 7.1 Room states

```
PENDING ──► OPEN ──► RESOLVING ──► CLOSED
              │                      ▲
              └──── FAILED ──────────┘
                 (timeout/max_rounds)
```

| Transition | Trigger | Guard |
|------------|---------|-------|
| PENDING → OPEN | first participant joins | orchestrator already joined |
| OPEN → RESOLVING | orchestrator calls resolve() | at least 1 answer received |
| RESOLVING → CLOSED | resolve message written, .closed sentinel created | - |
| OPEN → FAILED | max_rounds exceeded OR room TTL expired | - |
| FAILED → CLOSED | cleanup routine | - |

### 7.2 Participant states

```
JOINING ──► ACTIVE ──► IDLE ──► OFFLINE
                               ▲
                          EVICTED (stale, no heartbeat)
```

Heartbeat: participant writes `last_seen_at` on every poll. If `now - last_seen_at > 2 * poll_interval * 3`, orchestrator may mark EVICTED.

### 7.3 Message and receipt states (v1.2)

> Messages are immutable. State lives in per-participant receipts.

```
Message (immutable):  written to messages/ ──► done, never changes

Receipt (per participant, per message):
  PROCESSING ──► ANSWERED
             └──► TIMEOUT
             └──► ERROR
```

> **v1.2 note**: `DELIVERED` state removed. It had no real write point in the
> implementation — the cursor model means "message exists in messages/ at
> seq > my cursor" IS the delivered state implicitly. Receipt is only created
> when a worker claims the message (PROCESSING). Fewer states = fewer bugs.

A single broadcast message has N independent receipt state machines (one per participant).
Participant B can be ANSWERED while participant C is still PROCESSING.
This is the fundamental fix for broadcast concurrency — no shared lock, no shared state.

`PROCESSING` = participant-specific lock acquired, receipt file created.
`ANSWERED` = reply written to messages/, receipt updated with answer_msg_id.

---

## 8. Background Worker Model

### 8.1 How workers run

A worker is a **polling loop** running in the background of the participant's session. It does NOT block the main conversation thread.

For Claude Code: runs as a background `setInterval`-style loop via the skill's async mechanism.
For Codex / generic: runs as a detached subprocess (`agentbus worker --room <id> --participant <id> &`).

### 8.2 Poll loop (pseudocode)

> **v1.2**: Cursor-based polling replaces inbox scanning.
> Worker reads messages/ where seq > cursor, skipping messages that already
> have a receipt. No physical inbox, no inbox overflow, no message loss.

```typescript
async function workerLoop(roomId, participantId, options) {
  while (true) {
    if (isRoomClosed(roomId)) break;

    const cursor = readCursor(roomId, participantId);  // last processed seq
    const msgs = listMessages(roomId, { seqGreaterThan: cursor });

    for (const msg of msgs) {
      // Skip messages not addressed to us
      if (!isAddressedTo(msg, participantId)) continue;

      // Skip if already have a receipt (idempotency)
      if (hasReceipt(roomId, participantId, msg.msg_id)) continue;

      // Lock with compound key: each participant locks independently
      const locked = acquireLock(roomId, msg.msg_id, participantId);
      if (!locked) continue;

      try {
        writeReceipt(roomId, participantId, msg.msg_id, 'PROCESSING');
        const answer = await generateAnswer(msg);  // LLM call via MMS
        const answerMsg = writeReply(roomId, msg, answer, participantId);
        writeReceipt(roomId, participantId, msg.msg_id, 'ANSWERED', answerMsg.msg_id);
      } catch (err) {
        writeReceipt(roomId, participantId, msg.msg_id, 'ERROR');
      } finally {
        releaseLock(roomId, msg.msg_id, participantId);
      }
    }

    // Advance cursor to highest seq we've seen this poll, regardless of
    // whether messages were addressed to us or already had receipts.
    // This prevents re-scanning irrelevant messages on every poll cycle.
    if (msgs.length > 0) {
      const maxSeq = msgs[msgs.length - 1].seq;
      writeCursor(roomId, participantId, maxSeq);
    }

    updateHeartbeat(roomId, participantId);
    watchdogCheck(roomId);  // v1.1: piggyback watchdog on poll
    await sleep(options.poll_interval_ms ?? 5000);
  }
}
```

### 8.3 Claiming work safely (deduplication)

> **v1.2**: Three-layer dedup, redesigned around receipts instead of processed_msgs array.

1. **Receipt file** in `receipts/{participant_id}/` — if receipt exists, skip
2. **Compound file lock** (`{msg_id}_{participant_id}`) — only this participant's worker processes it
3. **Idempotency key** on message — if duplicate message was written, same key = skip

No hot-file contention: each receipt is its own file, cursor is a separate file,
participant.json only stores heartbeat.

### 8.4 Avoiding duplicate processing

- Receipt check before lock attempt = fast path (no lock needed for already-processed)
- Compound lock key = no cross-participant blocking on broadcast
- Cursor provides crash recovery: on restart, cursor tells worker where to resume
- If worker crashes mid-PROCESSING: lock TTL expires, receipt stays at PROCESSING,
  next poll re-acquires lock, re-processes (receipt is overwritten = idempotent)

---

## 9. Orchestrator Logic

> **v1.1 revision**: confidence threshold replaced with orchestrator verification.
> Cross-model review found that `confidence >= 0.8` measures self-assessed certainty,
> not correctness. In 2-3 agent rooms this degenerates to "who sounds most confident wins."

### 9.1 The resolve-or-followup loop

```typescript
async function orchestratorLoop(room, originalQuestion) {
  let round = 0;

  while (round < room.max_rounds) {
    round++;
    await broadcastOrDirectedAsk(room, buildQuestion(originalQuestion, round));
    await waitForReplies(room, round, timeout=room.round_timeout_seconds);

    const answers = collectAnswers(room, round);

    // Step 1: Synthesize a candidate answer from all replies
    const candidate = await synthesizeCandidate(originalQuestion, answers);

    // Step 2: Independently verify — can A reproduce/validate
    //         the candidate WITHOUT referencing the original answers?
    const verification = await verifyAnswer(originalQuestion, candidate);

    if (verification.verified) {
      await resolveRoom(room, { candidate, verification, answers });
      return;
    }

    // Step 3: Not verified — plan followup based on verification gaps
    const followup = await planFollowup(originalQuestion, answers, verification);
    if (followup.target === 'specific') {
      await directedAsk(room, followup.participants, followup.question);
    } else {
      await broadcast(room, followup.question);
    }
  }

  await failRoom(room, 'max_rounds_exceeded');
}
```

### 9.2 Answer verification prompt (protocol-level)

> Replaces the old confidence-threshold evaluation.
> The key insight: **verify the answer, don't score the confidence.**
>
> **v1.2 clarification**: This is a **resolution heuristic**, not a correctness guarantee.
> If orchestrator and responders are highly correlated (same model family, same training data),
> verification may have blind spots. The heuristic works best when models are diverse.
> Do not frame this as "provably correct" — it's "good enough to close the room."

**Step 1 — Synthesis prompt** (distill answers into a candidate):

```
SYSTEM: You are synthesizing multiple agent answers into one candidate answer.

QUESTION: {original_question}

ANSWERS:
{answers}

Return JSON:
{
  "candidate_answer": "synthesized answer",
  "supporting_evidence": ["key points from answers that support this"],
  "contradictions": ["points where answers disagreed"]
}
```

**Step 2 — Verification prompt** (independent check, no access to original answers):

```
SYSTEM: You are verifying whether a proposed answer to a question is correct.
You must evaluate based on your own knowledge and reasoning.
Do NOT assume the answer is correct just because it was proposed.

QUESTION: {original_question}

PROPOSED ANSWER: {candidate_answer}

Return JSON:
{
  "verified": boolean,
  "reasoning": "your independent assessment",
  "gaps": ["what you cannot verify or find problematic"],
  "followup_needed": "specific question to ask if not verified | null"
}

verified = true ONLY if you can independently confirm the answer is correct
and complete. When in doubt, verified = false.
```

### 9.3 When A broadcasts vs directed ask

| Condition | Action |
|-----------|--------|
| First question, all participants relevant | broadcast |
| Evaluation gaps point to specific domain | directed ask to relevant participants |
| One participant gave partial answer | directed followup to that participant |
| All participants gave contradictory answers | broadcast with synthesis request |

### 9.4 Escalation

If `max_rounds` exceeded:
1. Write `escalate` message to room
2. Set room state FAILED
3. Write summary of what was gathered so far
4. Notify orchestrator's main session

### 9.5 Silent orchestrator mode

Orchestrator can run fully silent: it only surfaces to the user when:
- Room resolved (prints answer summary)
- Room failed (prints what was gathered)
- Explicit `status` request

All intermediate broadcasts/followups happen in background. The user sees only the final outcome.

### 9.6 Orchestrator watchdog (v1.1)

> Added post cross-model review. GLM identified that orchestrator crash mid-RESOLVING
> leaves the room permanently stuck with no recovery path.

A separate lightweight watchdog runs alongside (or is triggered by participant poll loops):

```typescript
function watchdogCheck(roomId) {
  const manifest = readManifest(roomId);

  // Case 1: RESOLVING for too long — orchestrator probably crashed
  if (manifest.state === 'RESOLVING') {
    const resolving_since = getStateChangeTime(roomId, 'RESOLVING');
    if (now() - resolving_since > WATCHDOG_TIMEOUT_SECONDS) {
      failRoom(roomId, 'orchestrator_timeout_in_resolving');
    }
  }

  // Case 2: OPEN but orchestrator heartbeat stale
  if (manifest.state === 'OPEN') {
    const orch = readParticipant(roomId, manifest.orchestrator_id);
    if (now() - orch.last_seen_at > ORCHESTRATOR_STALE_SECONDS) {
      // Write warning, don't auto-fail yet — give grace period
      writeMessage(roomId, { type: 'escalate', body: 'Orchestrator unresponsive' });
    }
  }
}
```

Watchdog is NOT a separate daemon. It piggybacks on participant poll loops:
every `workerLoop` iteration calls `watchdogCheck()` after processing messages.
This means watchdog granularity = poll interval (acceptable for async system).

---

## 10. MCP Integration Design

### 10.1 Tool list

| Tool | Who calls it | Description |
|------|-------------|-------------|
| `agentbus_create` | Orchestrator | Create room, return room_id |
| `agentbus_join` | Participant | Join room by room_id |
| `agentbus_watch` | Participant | Start background worker loop |
| `agentbus_ask` | Orchestrator | Send directed ask or broadcast |
| `agentbus_reply` | Participant | Write reply to a message |
| `agentbus_poll` | Participant | Manual poll: return pending messages |
| `agentbus_status` | Any | Get room status summary |
| `agentbus_resolve` | Orchestrator | Mark room resolved, close it |
| `agentbus_list` | Any | List active rooms for this participant |

### 10.2 Tool shapes

```typescript
// agentbus_create
input:  { question: string; max_rounds?: number; round_timeout_seconds?: number }
output: { room_id: string; join_instruction: string }
// join_instruction: "Share this ID with participants: a3f7b2e1"

// agentbus_join
input:  { room_id: string; alias?: string; model?: string; cli?: string }
output: { participant_id: string; room_state: string; question: string }

// agentbus_watch
input:  { room_id: string; participant_id: string; poll_interval_seconds?: number }
output: { status: "watching"; message: string }
// Non-blocking: starts background loop, returns immediately

// agentbus_ask
input:  { room_id: string; body: string; to?: string[] | "broadcast" }
output: { msg_id: string; delivered_to: string[] }

// agentbus_reply
input:  { room_id: string; parent_msg_id: string; body: string }
output: { msg_id: string; state: "ANSWERED" }

// agentbus_poll
input:  { room_id: string; participant_id: string }
output: { messages: Message[]; room_state: string }

// agentbus_status
input:  { room_id: string }
output: { state: string; participants: Participant[]; round: number; message_count: number }

// agentbus_resolve
input:  { room_id: string; reason: string; answer_summary: string }
output: { closed: true; room_id: string }

// agentbus_list
input:  { participant_id?: string }
output: { rooms: { room_id: string; state: string; question: string; created_at: string }[] }
```

### 10.3 MCP vs local CLI

| Concern | MCP tool | Local CLI (`agentbus` cmd) |
|---------|----------|---------------------------|
| Room creation | ✓ | ✓ |
| Message routing | ✓ | ✓ |
| Background worker | ✗ (MCP is request/response) | ✓ (subprocess) |
| Status polling | ✓ | ✓ |
| Host-agnostic access | ✓ | ✓ |

**Key**: background watching CANNOT be done via MCP (MCP is synchronous request/response). The `agentbus_watch` tool returns immediately after spawning a subprocess, but the actual polling runs outside MCP.

---

## 11. Host Adapters

### 11.1 What is common vs host-specific

| Concern | Common (backend) | Host-specific (adapter) |
|---------|-----------------|------------------------|
| Room CRUD | ✓ | |
| Message routing | ✓ | |
| Lock protocol | ✓ | |
| Worker loop logic | ✓ | |
| Orchestrator evaluation | ✓ | |
| CLI syntax | | ✓ |
| Slash command | | ✓ |
| Output formatting | | ✓ |
| Background process management | | ✓ |
| Error display | | ✓ |

### 11.2 Claude Code adapter

Uses the existing skill mechanism:

```
/mail create "question"        → agentbus_create(...)
/mail join <room_id>           → agentbus_join(...) + agentbus_watch(...)
/mail reply <msg_id> "answer"  → agentbus_reply(...)
/mail status <room_id>         → agentbus_status(...)
/mail list                     → agentbus_list(...)
```

Background worker: runs as a background async task in the skill. Claude Code's skill system supports async patterns; the worker polls without blocking the main conversation.

### 11.3 Codex adapter

No slash commands. Uses CLI subprocess:

```bash
agentbus create "question"
agentbus join a3f7b2e1
agentbus watch a3f7b2e1 --background   # forks worker process
agentbus reply msg_xxx "my answer"
agentbus status a3f7b2e1
```

Background: `agentbus watch` forks a daemon process (`nohup agentbus worker ... &`) and writes PID to `~/.agentbus/workers/{room_id}.pid`.

### 11.4 Generic CLI / MCP adapter

Any CLI that can call MCP tools or run subprocesses uses the same `agentbus` CLI. The MCP server wraps the CLI:

```
mcp-agentbus/
├── server.ts    # MCP server: calls agentbus backend engine
└── index.ts     # entrypoint
```

Generic CLI agents that can't run subprocesses: they manually call `agentbus_poll` on each turn, process pending messages, and call `agentbus_reply`. No true background — they poll when invoked.

### 11.5 Adapter registration

Each adapter registers its CLI type in participant.json (`"cli": "claude-code" | "codex" | "generic"`). The orchestrator uses this to know how to interpret `last_seen_at` staleness (generic adapters will have irregular heartbeats).

---

## 12. Failure Modes and Recovery

### 12.1 Partial replies

If round timeout fires before all participants reply:
- Orchestrator proceeds with available answers
- Missing participants marked `IDLE` (not evicted yet)
- If answer was sufficient: resolve
- If not: followup is sent only to non-responding participants

### 12.2 Worker crash

- Lock TTL expires (60s)
- Next poll by any worker sees stale lock: `mkdir` fails, check TTL, steal lock
- Message is reprocessed
- Idempotency key prevents duplicate answer

### 12.3 Stale locks

Cleanup routine (runs on every `agentbus` invocation):
```
for lock in locks/:
  if lock.expires_at < now(): rmdir(lock)
```

No separate daemon needed — piggybacked on normal operations.

### 12.4 Duplicate answers

- Before writing reply: check if `messages/` already contains an answer for this `parent_msg_id` from this participant
- If yes: skip (idempotent)
- Receipt check (`hasReceipt`) also guards this — if receipt exists for this msg_id, skip

### 12.5 Room never closes

Room-level TTL in manifest: `room_ttl_seconds` (default: 3600). If `now - created_at > room_ttl` AND state != CLOSED: auto-fail.

Cleanup triggered on every `agentbus list` or `agentbus status` call.

### 12.6 Orchestrator crash mid-loop (v1.1 — watchdog)

- Room state stays OPEN or stuck in RESOLVING
- **Watchdog** (piggybacked on participant poll loops) detects staleness
- If RESOLVING for > watchdog timeout: auto-fail room with `orchestrator_timeout_in_resolving`
- If OPEN but orchestrator heartbeat stale: write `escalate` message, give grace period
- Orchestrator can rejoin with `agentbus join a3f7b2e1 --role orchestrator` to resume
- Backend engine reads current round from manifest, resumes loop
- Already-answered messages are skipped

### 12.7 Message delivery (v1.2 — no physical inbox)

- No inbox = no inbox delivery failure, no inbox overflow
- Messages are written once to `messages/` (append-only log)
- Participants read from `messages/` using cursor — cursor file is tiny (one number)
- If message write fails mid-way: `.tmp` file left behind, atomic rename never happened
- Cursor advances to the highest seq seen in the current poll, even if some messages
  were skipped as not addressed to this participant or already had receipts
- Crash before cursor write = re-read from last persisted cursor on next poll

### 12.8 Slow participant backlog (v1.2)

- Slow participants accumulate unprocessed messages in `messages/` (never dropped)
- Bounded by room lifetime: TTL + max_rounds guarantee finite message volume
- If participant is too slow to process within room TTL: room closes, remaining messages are moot
- No disk exhaustion risk: worst case ~50 JSON files per room

### 12.9 Message spoofing (v1.1, v1.2 downgraded)

- HMAC signing guards against **accidental** injection by misconfigured tools
- Workers skip messages with invalid/missing HMAC (log + skip, no crash)
- Does NOT protect against same-user local processes (they can read room_secret)
- This is an integrity guard, not a security boundary

---

## 13. Security and Safety

### 13.1 Writable scope

The root `/Users/xin/.agentbus/` is the only directory AgentBus writes to. No writes to project dirs, no writes to system dirs.

### 13.2 Room isolation

Each room is a separate directory. A participant in room `a3f7b2e1` cannot read or write to room `b9d4c2f0` unless they have joined it (i.e., have a `participant_id` entry in that room).

Room IDs are 8-char hex — 4 billion combinations. Not a security mechanism, but collision-resistant at our scale.

### 13.3 Participant identity

Participant IDs are generated locally with random suffix. No central identity server. Trust model: if you know the room_id, you can join. This is appropriate for a local-filesystem, single-user system.

**Do not** put sensitive data (passwords, keys) in message bodies. Messages are plaintext JSON.

### 13.4 Message integrity guard (v1.1 — HMAC signing)

> **v1.2 clarification**: This is an **integrity guard against accidental injection**,
> NOT a security boundary. On a single-user machine, any local process running as the
> same user can read `manifest.json` and obtain `room_secret`. This protects against
> misconfigured tools accidentally writing to the wrong room or message stream, and against
> "drive-by" writes from processes that don't know the room secret. It does NOT protect
> against a determined local attacker running as the same user.

Room creation generates a 32-byte random `room_secret` stored in `manifest.json`.
The secret is shared with participants at join time (returned in `agentbus_join` response).

Every message includes an `hmac` field:

```
hmac = HMAC-SHA256(room_secret, msg_id + from + body)
```

Validation on read:
- Worker poll loop verifies HMAC before processing any message from `messages/`
- Messages with invalid/missing HMAC are logged and skipped (not processed, not crashed)
- Orchestrator verifies HMAC on all answers before including them in evaluation

This is NOT encryption (messages are still plaintext). It helps detect:
- Message spoofing by tools that do not know the room secret
- Orchestrator impersonation by tools that do not know the room secret
- Drive-by writes from misconfigured local processes

It does NOT prevent:
- A joined participant acting maliciously (they have the secret)
- Message replay (mitigated by idempotency_key)
- Reading messages without joining (filesystem permissions handle this)

### 13.5 No message loss guarantee (v1.2 — cursor model)

> **v1.2**: Replaces the v1.1 inbox backpressure mechanism (oldest-dropped policy).
> Codex review correctly identified that dropping inbox items = silent task loss,
> contradicting the "no data permanently lost" claim.

The cursor model eliminates message loss entirely:
- `messages/` is append-only — no message is ever deleted during room lifetime
- Each participant reads messages where `seq > cursor` — no physical inbox to overflow
- If a participant falls behind, it simply has more messages to process on next poll
- Room TTL + max_rounds provide the natural bound on message volume

The tradeoff: a very slow participant may accumulate a large backlog. This is acceptable
because room lifetime is bounded (default TTL: 3600s, max 5 rounds), so the theoretical
maximum messages is `num_participants * max_rounds * 2` (question + answer per round).
For 5 participants and 5 rounds, that's 50 messages — trivial.

### 13.6 No shell injection

The `agentbus` CLI must validate all inputs before constructing filesystem paths:
- Room IDs: `/^[0-9a-f]{8}$/`
- Participant IDs: `/^p_[a-z0-9_]+_[0-9a-f]{4}$/`
- No path traversal: reject any input containing `..` or `/`

---

## 14. MVP Scope

### What MVP includes

- [x] Filesystem backend (room.ts, message.ts, receipt.ts, cursor.ts, lock.ts)
- [x] `agentbus` CLI: `create`, `join`, `watch`, `ask`, `reply`, `status`, `resolve`
- [x] Background worker (cursor-based polling, MMS integration)
- [x] Orchestrator loop (broadcast → collect → verify → followup or resolve)
- [x] Claude Code adapter (`/mail` skill wrapping CLI)
- [x] Crash recovery: lock TTL, stale cleanup, room TTL, cursor replay
- [x] Deduplication: receipt files + idempotency key

### What MVP defers

- [ ] MCP server wrapper
- [ ] Codex adapter
- [ ] Generic CLI adapter
- [ ] Directed ask (MVP uses broadcast only)
- [ ] Escalation handler
- [ ] Multi-room dashboard
- [ ] Room export / archive

### MVP room flow

```
Session A:          /mail create "How to handle auth?"
                    → room_id: a3f7b2e1
                    → "Share this hash with participants"

Session B:          /mail join a3f7b2e1
                    → joined, watching background

Session A:          (automatic) broadcasts question to room
Session B:          (background worker) sees message, generates answer, replies

Session A:          (orchestrator loop) evaluates answer
                    → if enough: /mail resolve + closes room
                    → if not enough: broadcasts followup
```

---

## 15. Phase 2 / Future Extensions

| Feature | Description |
|---------|-------------|
| MCP server | Wrap backend as MCP tools for any MCP-capable host |
| Codex adapter | `agentbus` subprocess-based integration |
| Directed ask | Route messages to specific participants, not just broadcast |
| Room federation | Cross-machine rooms via HTTP relay (v3) |
| Room archive | Export closed rooms to markdown / JSON for review |
| Multi-room dashboard | `agentbus dashboard` — live view of all active rooms |
| Participant reputation | Track which participants give high-quality answers |
| Room templates | Pre-configured room types (code review, architecture, debugging) |
| Silent orchestrator UI | Show user only final answer, not intermediate rounds |

---

## 16. Migration from v1 Mailbox

v1 mailbox stores messages in a flat file per conversation. v2 AgentBus is a directory-per-room system.

### Migration path

1. **No breaking changes in v1**: keep v1 `/mail send` and `/mail <hash>` working as-is for 1:1 point-to-point use
2. **AgentBus as extension**: `/mail create` triggers the new room-based system; `/mail send` stays on v1
3. **Unified backend later**: once AgentBus is stable, v1 mailbox is reimplemented on top of AgentBus (room with 2 participants = mailbox)

### Compatibility table

| Command | v1 behavior | v2 behavior |
|---------|-------------|-------------|
| `/mail send "question"` | creates mailbox, returns hash | unchanged |
| `/mail <hash>` | joins mailbox, replies | unchanged |
| `/mail create "question"` | N/A | creates room, returns room_id |
| `/mail join <room_id>` | N/A | joins room, starts watching |
| `/mail list` | N/A | lists active rooms |

---

## 17. Recommended Implementation Order

Shortest correct path:

```
1. Schema + directory spec (no code)
   Define all JSON schemas (message, receipt, manifest, participant, cursor)
   Validate with Zod, write schema.ts + types.ts (IBackend interface)

2. Filesystem primitives (lock.ts, hmac.ts)
   atomicWrite, acquireLock (compound key), releaseLock, staleCleanup, hmacSign/verify
   Test: concurrent lock acquisition with same msg_id + different participant_ids

3. Room CRUD (room.ts, backend-fs.ts)
   create, join, close, getState, listParticipants, readCursor, writeCursor
   Test: create → join → close lifecycle, cursor init at 0

4. Message + receipt dispatch (message.ts)
   writeMessage (append-only), listMessages (seq filter), writeReceipt, hasReceipt
   Test: broadcast → each participant gets independent receipt state

5. Worker poll loop (worker.ts, watchdog.ts)
   cursor-based pollOnce, workerLoop, heartbeat, receipt-based dedup, watchdogCheck
   Test: broadcast message → 2 workers process independently → 2 receipts + 2 answers

6. Orchestrator loop (orchestrator.ts)
   broadcastQuestion, synthesizeCandidate, verifyAnswer, planFollowup, resolveRoom
   Test: 2-round conversation, resolve on round 2

7. CLI entrypoint (bin/agentbus.ts)
   create / join / watch / ask / reply / status / resolve
   Manual test: two terminals, end-to-end room

8. Claude Code skill adapter
   /mail skill wrapping CLI commands
   Test: /mail create → /mail join → resolve flow

9. MCP server wrapper (Phase 2)
10. Codex adapter + generic adapter (Phase 2)
```

**Do not skip step 2** (lock primitives + compound key). The broadcast concurrency fix depends on correct compound-key locking from the start.

**Easiest mistake** (v1.2): forgetting to advance the cursor after processing. If cursor doesn't advance, worker reprocesses the same message forever. Receipt check prevents double-answer but wastes cycles.

**Second easiest mistake**: reading `messages/` without seq filter. Always filter by `seq > cursor` — scanning all messages in a long room is O(n) per poll.

---

## Appendix A: Conflicting requirements in the original spec

> *Per the design brief, conflicts are surfaced and resolved here.*

| Conflict | Resolution |
|----------|------------|
| "A 可以静默" + "A is orchestrator who judges answers" | Resolved: A runs silently in background, surfaces only on resolve or failure. Orchestrator loop is always background. |
| "不假设所有 CLI 都支持 /mail" + "支持 /mail 的宿主用 slash command adapter" | Resolved: `/mail` is a Claude Code-specific adapter. Other CLIs use `agentbus` CLI. Same backend, different surface. |
| "Background not blocking" + "MCP tools are synchronous" | Resolved: `agentbus_watch` spawns subprocess and returns immediately. Background work is outside MCP. |
| "Filesystem first" + "cross-CLI" | Resolved in v1: all CLIs share the same filesystem root `/Users/xin/.agentbus/`. Cross-machine federation deferred to v3. |

---

*AgentBus v1.2 Design — post cross-model review + Codex review.*

---

## Appendix B: v1.0 → v1.1 Changelog (cross-model review)

> Review conducted 2026-03-30 via hive-discuss debate mode.
> Round 1: kimi-for-coding + qwen3.5-plus (parallel). Round 2: glm-5.1 (synthesis + confrontation).

| Change | Source | Rationale |
|--------|--------|-----------|
| Confidence threshold → orchestrator verification | GLM synthesis | Confidence/voting measures agreement, not correctness. Verification prompt independently validates the synthesized answer. |
| Added orchestrator watchdog (§9.6) | GLM synthesis | Orchestrator crash mid-RESOLVING = permanent room deadlock. Watchdog piggybacks on participant poll loops. |
| Added per-message HMAC signing (§13.4) | GLM synthesis | Filesystem transport has zero auth — any local process can forge messages. HMAC blocks spoofing with trivial implementation cost. |
| Added inbox backpressure in v1.1, then replaced by cursor model in v1.2 (§13.5) | Qwen + GLM + Codex | v1.1 identified unbounded inbox growth; v1.2 removed inbox entirely, which is a cleaner fix than drop-oldest backpressure. |
| Backend Engine as interface (§3.2) | GLM synthesis | ~50 lines of interface prevents architecture from ossifying around filesystem assumptions. |
| Added `room_secret` to manifest | GLM synthesis | Supports HMAC signing. Generated at room creation, shared at join time. |
| Added `hmac` field to message schema | GLM synthesis | Every message carries HMAC for authenticity verification. |
| Added `watchdog.ts` + `hmac.ts` to src layout | - | Implementation files for new features. |
| Deferred NFS/Docker concern to v2 | GLM synthesis | Single-machine macOS/Linux has atomic mkdir. NFS atomicity is a deployment concern, not MVP concern. |
| Noted: polling latency (5s) is noise vs LLM inference (2-15s) | GLM synthesis | Don't optimize polling interval prematurely — LLM round-trip dominates. |

---

## Appendix C: v1.1 → v1.2 Changelog (Codex review)

> Review conducted 2026-03-30 by Codex. Four protocol-level issues identified and fixed.

| Change | Severity | What was wrong | Fix |
|--------|----------|---------------|-----|
| Message/delivery split | HIGH | Broadcast msg_id used as lock key → only one participant could process a broadcast | Messages are now immutable append-only log. Delivery state lives in `receipts/{pid}/`. Lock key is compound: `{msg_id}_{participant_id}`. |
| Inbox → cursor model | HIGH | Inbox overflow dropped oldest unprocessed messages = silent task loss, contradicted "no data lost" claim | Physical inbox eliminated. Workers read `messages/` with cursor (last processed seq). No message is ever deleted. |
| HMAC language downgraded | MED-HIGH | HMAC was described as "security boundary" but room_secret is readable by any same-user process | Relabeled as "integrity guard against accidental injection". Not a security boundary. |
| processed_msgs hot file | MED | `processed_msgs` array in participant.json: unbounded growth + write contention with heartbeat/state | Split into per-message receipt files in `receipts/{pid}/`. participant.json now only has heartbeat as mutable field. |
| Scope disclaimer added | OPEN | "all CLI / all model" language implied MVP covers all hosts | Added explicit disclaimer: north star ≠ MVP commitment. |
| Verification → resolution heuristic | OPEN | Verification prompt framed as correctness guarantee | Relabeled as "resolution heuristic". Acknowledged correlated-model blind spot. |
