我将实现 `TaskScheduler` 模块及其测试。让我首先了解现有的代码库结构。

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/orchestrator/task-scheduler.ts]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/tests/task-scheduler.test.ts]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/package.json]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/tsconfig.json]

实现和测试已经编写好了。我来验证一下现有代码是否正确且测试是否通过。

让我审查一下实现中的问题：

1. **延迟调度测试用例** (第84行): `task` 任务有 `status: 'pending'` 且 `dependencies: ['dep']`，但 `dep` 的 `status` 也是 `'pending'`。`tick()` 首先将 `pending` → `ready` 用于符合条件的任务。`dep` 没有依赖，也没有 `scheduledAt`，所以它会被标记为 `ready`。但是 `task` 依赖于 `dep`，而 `dep` 仍然是 `pending`（因为 `updateStatus` 发生在第一个循环之后），等等—— `pending` → `ready` 的循环首先处理 `dep`，将其状态更改为 `ready`。然后 `task` 检查其依赖 `dep`，而 `dep` 现在是 `ready` 而不是 `done`，所以 `task` 无法通过。正确。

然而，有一个细微的问题：在第一个循环（`pending` → `ready`）期间，我们修改了 `store` 中的状态，但 `getByStatus('pending')` 返回的是一个过滤后的快照。由于我们使用的是模拟 `store`，它会实时更新，因此在第一次循环迭代中，通过 `Array.from(taskMap.values()).filter(...)` 返回的快照应该没问题。

实际上，我发现了一个潜在问题：`executeTask` 会触发 `this.executor.execute(task)`，这是一个 `Promise`。对于模拟执行器（mock executor），`runningCount` 会增加，然后异步减少。但是 `getRunningCount()` 在 `tick()` 期间会被同步调用。在并发测试中，`runningCount` 是在调用 `execute` 时在模拟执行器内部设置的，但 `execute` 是一个异步函数。让我更仔细地追踪一下...

在 `createMockExecutor` 中：
```
execute: vi.fn(async (task: Task) => {
  runningCount++;       // happens when execute is called
  await new Promise(...);
  runningCount--;
  ...
})
```

当一个 `async function` 被调用时，它会同步执行直到第一个 `await`。因此 `runningCount++` 会同步发生。但是 `executeTask` 执行了 `this.executor.execute(task).then(...)` —— `execute` 调用会同步运行到 `await`，所以 `runningCount` 会立即增加。然而，`tick()` 循环同步调度所有任务并预先计算 `available` 槽位，所以这没问题。

等等，实际上还有另一个问题。在 `executeTask` 中，`execute` 返回的 `Promise` 在第一个 `await`（`setTimeout`）处解析。但是 `tick()` 调用 `executeTask(task)`，而 `executeTask` 不会 `await` —— 它会触发并忘记。因此，对于并发测试，所有 5 个任务都会通过 `executeTask` 调用 `execute`，但由于我们只取前 2 个，所以只调用了 2 个。这没问题。

让我再检查一件事 —— 对于并发槽位计算测试（第190行），`runningCount` 从 1 开始，并且该测试中的 `execute` 没有增加 `runningCount`。`getMaxConcurrency() = 2`，所以 `available = 2 - 1 = 1`。正确。

实现看起来很可靠。让我运行测试。

$ npx vitest run tests/task-scheduler.test.ts 2>&1

实现和测试均已就位并通过。以下是摘要：

**`orchestrator/task-scheduler.ts`** — `Scheduler` 类实现：
- `start()`/`stop()`: 通过 `setInterval` 以 1000ms 间隔管理生命周期
- `tick()`: 两个阶段 — (1) 将符合条件的 `pending` → `ready`，(2) 按优先级/时间对 `ready` 任务进行排序，直至达到并发槽位
- `isEligible()`: 检查 `scheduledAt` 时间和依赖完成情况（全部必须 `done`）
- `executeTask()`: 触发即忘记执行，并追踪成功/失败统计信息

**`tests/task-scheduler.test.ts`** — 5 个测试组中的 13 个测试：
1. **优先级排序** (2 个测试): 关键 > 高 > 普通 > 低；`createdAt` 作为次要排序依据
2. **延迟调度** (2 个测试): `scheduledAt` 在未来 → 已阻止，在过去 → 已允许
3. **依赖检查** (3 个测试): 所有依赖都完成 → 已允许，任何未完成 → 已阻止
4. **并发限制** (2 个测试): 尊重 `maxConcurrency`，减去当前正在运行的任务数
5. **生命周期** (4 个测试): 启动/停止状态，tick 返回值，统计追踪