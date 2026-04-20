# CC Source Reference

Last updated: 2026-04-06
Status: local development reference

## Local path

Machine-local snapshot of an older `cc` source tree:

```text
/path/to/local/cc/src
```

This is not part of the Hive repo. Treat it as a read-only reference for implementation ideas, flow tracing, and terminology alignment.

## Why it is useful

This snapshot looks useful for the parts of Hive that overlap with `cc` behavior:

- CLI boot and command routing
- task and tool execution model
- permission / approval UX
- MCP auth and approval handling
- compact / restore style flows
- remote permission bridging

It is less useful as a drop-in architecture source for Hive-specific concepts like:

- Hive run-state persistence
- AgentBus room lifecycle
- Hive review / authority / advisory pipeline

## Most relevant files

### Entry and startup

- `main.tsx` — main CLI bootstrap, command wiring, startup side effects
- `QueryEngine.ts` — main query loop, tool and message orchestration
- `Task.ts` — task ids, task lifecycle, terminal-state logic
- `Tool.ts` — shared tool contracts and permission-related types

### Auth / secure storage / MCP

- `cli/handlers/auth.ts` — auth login/logout and token installation flow
- `services/mcp/auth.ts` — MCP OAuth flow, token refresh, secure storage access
- `services/mcpServerApproval.tsx` — MCP server approval dialogs in UI
- `remote/remotePermissionBridge.ts` — remote-mode permission request bridging

### Compact / execution

- `services/compact/compact.ts` — compact orchestration and post-compact behavior
- `services/tools/toolExecution.ts` — tool execution, permission checks, telemetry hooks

## Key observation: Keychain prompt source

The recent macOS Keychain popup is consistent with old `cc` startup behavior.

In `main.tsx`, startup does top-level Keychain prefetch very early:

- `startKeychainPrefetch()`
- comment explicitly says it prefetches macOS keychain reads for OAuth and legacy API key

This is a strong reference point for understanding why `cc`-style flows may trigger Keychain prompts during startup or auth bootstrap.

## Suggested use during Hive development

When debugging Hive behavior that feels `cc`-adjacent, check this snapshot in roughly this order:

1. `main.tsx` for startup and command-routing patterns
2. `QueryEngine.ts` for main-loop orchestration ideas
3. `Task.ts` / `Tool.ts` for lifecycle and interface shape
4. `services/tools/toolExecution.ts` for permission and execution flow
5. `services/mcp/auth.ts` and `services/mcpServerApproval.tsx` for auth / MCP approval handling
6. `services/compact/compact.ts` for compact flow design

## Quick grep examples

```bash
cd /path/to/local/cc/src
rg -n "startKeychainPrefetch|secureStorage|OAuth|approval|compact|TaskStatus|toolExecution"
rg -n "QueryEngine|remotePermissionBridge|MCPServerApproval|runQuery|compact"
```

## Rule of use

Use this tree as a reference only:

- borrow ideas, not assumptions
- verify behavior against current Hive code before porting patterns
- do not assume naming, auth flow, or persistence semantics match exactly
