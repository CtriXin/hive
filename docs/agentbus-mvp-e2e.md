# AgentBus MVP End-to-End Test

This document provides a step-by-step manual test path for validating the AgentBus MVP.

## Prerequisites

```bash
# Build the project
npm install
npm run build

# Ensure CLI is available
npm link
agentbus --help
```

## Test 1: Basic Create/Join Flow

### Terminal A - Create Room
```bash
$ agentbus create "What is 2+2?"

✓ Created room: room-k2m9p3x7q
  Status:      OPEN
  Created by:  orch-a1b2c3d
  Question:    What is 2+2?

To join this room:
  agentbus join room-k2m9p3x7q

To resolve:
  agentbus resolve room-k2m9p3x7q "What is 2+2?"
```

**Expected:** Room ID is auto-generated, clear join instructions shown.

### Terminal B - Join Room
```bash
$ agentbus join room-k2m9p3x7q

✓ Joined room: room-k2m9p3x7q
  Participant: worker-x7k2m9p3q
  Alias:       alice-macbook
  Model:       default

To start watching (foreground):
  agentbus watch room-k2m9p3x7q

To start watching (background):
  agentbus watch room-k2m9p3x7q --background
```

**Expected:** Participant ID auto-generated and persisted for reuse.

## Test 2: Background Watch

### Terminal B - Start Background Worker
```bash
$ agentbus watch room-k2m9p3x7q --background

Started background worker (pid: 12345)
Participant: worker-x7k2m9p3q
Room: room-k2m9p3x7q
```

**Expected:** Process forks, PID file written to `/Users/xin/.agentbus/pids/`.
If this identity was not joined yet, `watch` auto-joins it before starting.

### Verify No Duplicate
```bash
$ agentbus watch room-k2m9p3x7q --background

Worker already running (pid: 12345)
To stop: kill 12345
```

**Expected:** Duplicate start is prevented.

### Check Status
```bash
$ agentbus status room-k2m9p3x7q

✓ Room: room-k2m9p3x7q
  Status:       OPEN
  Messages:     0
  Participants: 1

Participants:
  🟢 worker-x7k2m9p3q (worker) cursor=0
```

**Expected:** Green dot indicates running background worker.

## Test 3: Ask and Resolve

### Terminal A - Broadcast Question
```bash
$ agentbus ask room-k2m9p3x7q "What is the capital of France?"

✓ Broadcasted message #1
  Message ID:  msg-uuid-here
  To:          *
  Question:    What is the capital of France?
```

**Expected:** Message broadcast, worker processes it.

### Terminal B - Check Worker Log (if foreground)
If running in foreground, you should see:
```
[10:23:45] #1 broadcast from orch-xxx
```

### Terminal A - Resolve with Consensus
First, let's add more workers for consensus:

```bash
# Terminal C
$ agentbus join room-k2m9p3x7q --alias worker-2
$ agentbus watch room-k2m9p3x7q --background

# Terminal D
$ agentbus join room-k2m9p3x7q --alias worker-3
$ agentbus watch room-k2m9p3x7q --background
```

Now resolve:
```bash
$ agentbus resolve room-k2m9p3x7q "What is 2+2?"

Resolving: "What is 2+2?"
Room: room-k2m9p3x7q

✓ Resolved in 1 round(s)
  Answer:     "Worker worker-x7k2m9p3q processed: What is 2+2?"

Individual answers:
  • worker-x7k2m9p3q: "Worker worker-x7k2m9p3q processed: What is 2+2?"
  • worker-2: "Worker worker-2 processed: What is 2+2?"
  • worker-3: "Worker worker-3 processed: What is 2+2?"
```

**Expected:** Consensus reached, room closed.

## Test 4: Room Closure and Worker Exit

### Verify Room Closed
```bash
$ agentbus status room-k2m9p3x7q

✓ Room: room-k2m9p3x7q
  Status:       CLOSED
  Messages:     3
  Participants: 3
```

**Expected:** Status is CLOSED.

### Verify Workers Exited
```bash
$ agentbus status room-k2m9p3x7q

Participants:
  ⚪ worker-x7k2m9p3q (worker) cursor=3
  ⚪ worker-2 (worker) cursor=3
  ⚪ worker-3 (worker) cursor=3
```

**Expected:** White circles indicate workers are no longer running.

### Verify PID Files Cleaned
```bash
$ ls /Users/xin/.agentbus/pids/
# (should be empty or not contain room-k2m9p3x7q files)
```

**Expected:** PID files cleaned up on exit.

## Test 5: Identity Persistence

### Verify Identity Reuse
```bash
# Join a new room
$ agentbus join another-room

✓ Joined room: another-room
  Participant: worker-x7k2m9p3q  # Same ID!
  Alias:       alice-macbook
```

**Expected:** Same participant_id reused from identity file.

### List Identities
```bash
$ ls /Users/xin/.agentbus/identities/
alice-macbook.json
```

**Expected:** Identity file persisted.

## Test 6: Stop Command

### Start and Stop Background Worker
```bash
# Start
$ agentbus watch test-room --background
Started background worker (pid: 23456)

# Stop specific worker
$ agentbus stop test-room --participant worker-xxx
✓ Stopped worker worker-xxx (pid: 23456)

# Or stop all workers for room
$ agentbus stop test-room
✓ Stopped 3 worker(s) for room test-room
```

**Expected:** Workers stopped, PID files cleaned.

## Test 7: Cleanup Stale Locks

```bash
# If a worker crashed without cleanup
$ agentbus cleanup test-room
✓ Cleaned 2 stale locks
```

**Expected:** Stale locks removed.

## Test 8: List Rooms

```bash
$ agentbus list

✓ Found 3 room(s):
  🔴 room-k2m9p3x7q (3 participants)
  🟢 another-room (1 participant)
  ⚪ broken-room (unreadable)
```

**Expected:** All rooms listed with status indicators.

## Full Smoke Test Script

```bash
#!/bin/bash
set -e

echo "=== AgentBus MVP Smoke Test ==="

# Test 1: Create
echo "Creating room..."
OUTPUT=$(agentbus create "Smoke test question?")
echo "$OUTPUT"
ROOM_ID=$(echo "$OUTPUT" | grep "Created room:" | awk '{print $3}')
echo "Room ID: $ROOM_ID"

# Test 2: Join
echo "Joining room..."
agentbus join "$ROOM_ID" --alias smoke-worker

# Test 3: Background watch
echo "Starting background worker..."
agentbus watch "$ROOM_ID" --background

# Test 4: Status
echo "Checking status..."
agentbus status "$ROOM_ID"

# Test 5: Ask
echo "Broadcasting question..."
agentbus ask "$ROOM_ID" "Can you hear me?"

# Test 6: Resolve
echo "Resolving..."
agentbus resolve "$ROOM_ID" "What is 1+1?"

# Test 7: Verify closed
echo "Checking room closed..."
STATUS=$(agentbus status "$ROOM_ID" | grep "Status:" | awk '{print $2}')
if [ "$STATUS" != "CLOSED" ]; then
  echo "ERROR: Room not closed"
  exit 1
fi

# Test 8: List
echo "Listing rooms..."
agentbus list

echo "=== All tests passed ==="
```

## Expected Timeline

| Step | Action | Expected Time |
|------|--------|---------------|
| 1 | Create room | < 1s |
| 2 | Join room | < 1s |
| 3 | Start background worker | < 1s |
| 4 | Resolve with 3 workers | 2-5s |
| 5 | Room closure | Immediate |
| 6 | Worker exit | < 2s after closure |

## Troubleshooting

### Worker not processing messages
```bash
# Check if running
agentbus status <room-id>

# Check logs (if foreground)
# Foreground mode shows real-time logs

# Cleanup and restart
agentbus cleanup <room-id>
agentbus watch <room-id> --background
```

### Resolve timeout
```bash
# Ensure workers are running
agentbus status <room-id>

# Check for stale locks
agentbus cleanup <room-id>
```

### Duplicate participant errors
```bash
# Identity is reused automatically
# To force new identity, delete identity file:
rm ~/.agentbus/identities/<alias>.json
```
