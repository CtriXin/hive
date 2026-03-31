---
name: mail
description: "Thin AgentBus wrapper for room-based multi-agent collaboration."
allowed-tools: Bash
---

# `/mail` AgentBus Wrapper

Run the `agentbus` CLI directly. Do not implement room logic here.

## Commands

### `/mail create <question>`

Execute:

```bash
agentbus create "<question>"
```

### `/mail join <room-id>`

Execute:

```bash
agentbus join <room-id>
```

### `/mail watch <room-id>`

Execute:

```bash
agentbus watch <room-id> --background
```

### `/mail status <room-id>`

Execute:

```bash
agentbus status <room-id>
```

### `/mail list`

Execute:

```bash
agentbus list
```

### `/mail ask <room-id> <question>`

Execute:

```bash
agentbus ask <room-id> "<question>"
```

### `/mail resolve <room-id> <question>`

Execute:

```bash
agentbus resolve <room-id> "<question>"
```

### `/mail stop <room-id>`

Execute:

```bash
agentbus stop <room-id>
```

### `/mail cleanup <room-id>`

Execute:

```bash
agentbus cleanup <room-id>
```
