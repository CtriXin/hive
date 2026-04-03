# Migration Guide — vNEXT

This guide covers the breaking and additive changes introduced in the vNEXT
release. Each section shows a **before** (old API) and **after** (new API)
code snippet so you can adapt your code with confidence.

---

## Table of Contents

1. [Router: `handle()` signature change](#1-router-handle-signature-change)
2. [CollabConfig: new worker discuss fields](#2-collabconfig-new-worker-discuss-fields)
3. [CollabRoomKind: `task_discuss` variant](#3-collabroomkind-task_discuss-variant)
4. [WorkerConfig: discuss snapshot callback](#4-workerconfig-discuss-snapshot-callback)
5. [WorkerDiscussBrief: new brief type](#5-workerdiscussbrief-new-brief-type)

---

## 1. Router: `handle()` signature change

**Severity:** Breaking

The `Router.handle()` method changed from accepting a single object parameter
to positional parameters. The `headers` and `body` arguments also swapped
order.

### Before (old)

```ts
import { Router } from './router.js';

const router = new Router();
router.get('/users/:id', (ctx) => {
  ctx.responseBody = { id: ctx.params.id };
});

const result = await router.handle({
  method: 'GET',
  path: '/users/42',
  headers: { authorization: 'Bearer token' },
  body: { name: 'Alice' },
});
```

### After (new)

```ts
import { Router } from './src/router.js';

const router = new Router();
router.get('/users/:id', (ctx) => {
  ctx.responseBody = { id: ctx.params.id };
});

const result = await router.handle(
  'GET',
  '/users/42',
  { authorization: 'Bearer token' },
  { name: 'Alice' },
);
```

### Key differences

| Aspect             | Old                            | New                                    |
|--------------------|--------------------------------|----------------------------------------|
| Parameter style    | Single object `{ method, path, ... }` | Positional `(method, path, headers?, body?)` |
| Headers position   | Inside request object          | Third argument                         |
| Body position      | Inside request object          | Fourth argument                        |
| Method chaining    | Not supported (void returns)   | Supported — all methods return `Router` |
| Wildcard patterns  | Not supported                  | Supported via `*` in pattern           |
| `createRouter()`   | Exported factory               | Removed — use `new Router()` directly  |
| Default `body`     | `null`                         | `undefined`                            |

### Additional changes to `Router`

Route registration methods (`get`, `post`, `put`, `delete`, `patch`) now return
`Router` for chaining. The `use()` method also returns `Router` and throws if a
prefix string is given without a middleware function.

Wildcard `*` in patterns is now supported:

```ts
router.get('/static/*', (ctx) => {
  ctx.responseBody = { file: ctx.params[0] };
});
```

### Migration checklist

- [ ] Replace all `router.handle({ ... })` calls with positional arguments
- [ ] If you used `createRouter()`, replace with `new Router()`
- [ ] If you relied on `body` defaulting to `null`, update to handle `undefined`
- [ ] Remove any type imports for `createRouter`

---

## 2. CollabConfig: new worker discuss fields

**Severity:** Additive (backward compatible)

`CollabConfig` now includes three new fields for controlling worker-level
discussion transport, mirroring the existing plan-level fields.

### Before (old)

```ts
const collab: CollabConfig = {
  plan_discuss_transport: 'local',
  plan_discuss_timeout_ms: 15000,
  plan_discuss_min_replies: 2,
};
```

### After (new)

```ts
const collab: CollabConfig = {
  plan_discuss_transport: 'local',
  plan_discuss_timeout_ms: 15000,
  plan_discuss_min_replies: 2,
  worker_discuss_transport: 'agentbus',
  worker_discuss_timeout_ms: 10000,
  worker_discuss_min_replies: 0,
};
```

### What each field does

| Field                        | Type                  | Default | Description                                |
|------------------------------|-----------------------|---------|--------------------------------------------|
| `worker_discuss_transport`   | `'local' \| 'agentbus'` | `'local'` | Transport for worker `[DISCUSS_TRIGGER]`   |
| `worker_discuss_timeout_ms`  | `number`              | `10000` | Max wait for AgentBus replies (ms)         |
| `worker_discuss_min_replies` | `number`              | `0`     | Minimum replies before synthesis           |

### Reading the new fields

```ts
import { loadConfig } from './orchestrator/hive-config.js';

const config = loadConfig('/path/to/project');
const collab = config.collab;

if (collab?.worker_discuss_transport === 'agentbus') {
  const timeout = collab.worker_discuss_timeout_ms ?? 10000;
  console.log(`Worker discuss via AgentBus, timeout ${timeout}ms`);
}
```

---

## 3. CollabRoomKind: `task_discuss` variant

**Severity:** Additive

The `CollabRoomKind` union now includes `'task_discuss'` alongside `'plan'`.

### Before (old)

```ts
type CollabRoomKind = 'plan';
```

### After (new)

```ts
type CollabRoomKind = 'plan' | 'task_discuss';
```

### Impact on switch statements

If your code has exhaustive checks on `CollabRoomKind`, add the new variant:

```ts
function handleRoom(kind: CollabRoomKind): void {
  switch (kind) {
    case 'plan':
      // existing plan room logic
      break;
    case 'task_discuss':
      // new: worker discussion room
      break;
  }
}
```

The new variant is used automatically by `worker-discuss-handler.ts` when
spawning AgentBus rooms for worker uncertainty discussions.

---

## 4. WorkerConfig: discuss snapshot callback

**Severity:** Additive

`WorkerConfig` now supports an optional `onWorkerDiscussSnapshot` callback that
fires each time the collaboration snapshot updates during a worker discussion.

### Before (old)

```ts
const workerConfig: WorkerConfig = {
  taskId: 'task-a',
  model: 'qwen3.5-plus',
  provider: 'bailian-codingplan',
  prompt: 'Implement feature X',
  cwd: '/project',
  worktree: true,
  contextInputs: [],
  discussThreshold: 0.6,
  maxTurns: 25,
};
```

### After (new)

```ts
import type { CollabStatusSnapshot } from './orchestrator/types.js';

const workerConfig: WorkerConfig = {
  taskId: 'task-a',
  model: 'qwen3.5-plus',
  provider: 'bailian-codingplan',
  prompt: 'Implement feature X',
  cwd: '/project',
  worktree: true,
  contextInputs: [],
  discussThreshold: 0.6,
  maxTurns: 25,
  onWorkerDiscussSnapshot: async (snapshot: CollabStatusSnapshot) => {
    console.log(
      `Discuss room ${snapshot.card.room_id}: ${snapshot.card.status}`,
      `(${snapshot.card.replies} replies)`,
    );
  },
};
```

### Use cases

- **Dashboard updates**: Push real-time discuss status to a hiveshell dashboard
- **Logging**: Persist collaboration lifecycle events for audit
- **Timeout extension**: Dynamically adjust timeouts based on reply flow

---

## 5. WorkerDiscussBrief: new brief type

**Severity:** Additive

A new `WorkerDiscussBrief` type represents the structured payload sent to
AgentBus when a worker triggers `[DISCUSS_TRIGGER]`.

### Type definition

```ts
export interface WorkerDiscussBrief {
  type: 'worker-discuss-brief';
  version: 1;
  created_at: string;
  task_id: string;
  worker_model: string;
  cwd_hint: string;
  uncertain_about: string;
  options: string[];
  leaning: string;
  why: string;
  task_description: string;
}
```

### Building a brief programmatically

```ts
import { buildWorkerDiscussBrief } from './orchestrator/worker-discuss-handler.js';
import type { DiscussTrigger, WorkerConfig } from './orchestrator/types.js';

const trigger: DiscussTrigger = {
  uncertain_about: 'Which ORM to use',
  options: ['Prisma', 'Drizzle', 'Raw SQL'],
  leaning: 'Drizzle',
  why: 'Smaller bundle, better edge runtime support',
  task_id: 'task-a',
  worker_model: 'qwen3.5-plus',
};

const brief = buildWorkerDiscussBrief(trigger, workerConfig, '/project');

console.log(brief.type);          // 'worker-discuss-brief'
console.log(brief.task_id);       // 'task-a'
console.log(brief.options);       // ['Prisma', 'Drizzle', 'Raw SQL']
```

---

## Quick reference: all changes at a glance

| Area                | Change type   | Action required |
|---------------------|---------------|-----------------|
| `Router.handle()`   | Breaking      | Migrate to positional args |
| `createRouter()`    | Removed       | Replace with `new Router()` |
| Router chaining     | Additive      | Optional — adopt if desired |
| Wildcard `*` routes | Additive      | Optional — adopt if desired |
| `CollabConfig`      | Additive      | Set new fields if using worker discuss |
| `CollabRoomKind`    | Additive      | Handle `'task_discuss'` in exhaustive checks |
| `WorkerConfig`      | Additive      | Wire `onWorkerDiscussSnapshot` if needed |
| `WorkerDiscussBrief`| Additive      | Use via `buildWorkerDiscussBrief()` |
