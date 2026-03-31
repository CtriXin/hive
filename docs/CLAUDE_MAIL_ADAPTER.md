# Claude `/mail` Adapter MVP

This adapter exposes AgentBus through a thin Claude skill wrapper.
The skill delegates to the `agentbus` CLI. It does not reimplement room logic.

## Prerequisites

1. Build and link the CLI:

```bash
cd /Users/xin/auto-skills/CtriXin-repo/hive
npm install
npm run build
npm link
```

2. Confirm the shared data root is available:

```bash
agentbus list
```

Default shared root:

```text
/Users/xin/.agentbus
```

## Supported Commands

- `/mail create <question>`
- `/mail join <room-id>`
- `/mail watch <room-id>`
- `/mail status <room-id>`
- `/mail list`
- `/mail ask <room-id> <question>`
- `/mail resolve <room-id> <question>`
- `/mail stop <room-id> [--participant <id>]`
- `/mail cleanup <room-id>`

## Smart Shorthand

The wrapper can also use AgentBus smart mode:

- `/mail <question...>`: create a room
- `/mail <room-id>`: join + watch in background, or show status if already active/closed
- `/mail <room-id> <question...>`: resolve the room with that question

## Skill File

Claude in this environment uses `SKILL.md`, not `mail.json`.

Create:

```text
~/.claude/skills/mail/SKILL.md
```

You can copy the example file from:

```text
/Users/xin/auto-skills/CtriXin-repo/hive/docs/examples/claude-mail-skill/SKILL.md
```

## Example Wrapper Behavior

The wrapper should map:

```text
/mail create What is 2+2?
```

to:

```bash
agentbus create "What is 2+2?"
```

and:

```text
/mail watch room-abc123
```

to:

```bash
agentbus watch room-abc123 --background
```

Smart examples:

```text
/mail What is 2+2?
/mail room-abc123
/mail room-abc123 What is 2+2?
```

## Dual-Terminal Workflow

Terminal A:

```bash
agentbus create "What is the best caching strategy?"
agentbus resolve room-abc123 "What is the best caching strategy?"
```

Terminal B:

```bash
agentbus join room-abc123 --alias claude-local
agentbus watch room-abc123 --background
agentbus status room-abc123
```

## Notes

- `agentbus watch <room-id>` now auto-joins the current identity if needed.
- `agentbus stop <room-id>` stops all workers for a room.
- `agentbus stop <room-id> --participant <id>` stops one worker.
- Identity files live under `/Users/xin/.agentbus/identities/`.
- PID files live under `/Users/xin/.agentbus/pids/`.
