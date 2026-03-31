我来实现 TaskScheduler 模块。首先让我查看现有的相关文件结构，确保实现与现有代码保持一致。



[Read: /Users/xin/auto-skills/CtriXin-repo/hive/orchestrator/task-scheduler.ts]

我看到 `task-scheduler.ts` 文件已经存在并包含了 `Scheduler` 类的实现。现在让我检查测试文件，看看现有的测试用例情况：



[Read: /Users/xin/auto-skills/CtriXin-repo/hive/tests/task-scheduler.test.ts]

我看到任务已经完成了。`orchestrator/task-scheduler.ts` 已经实现了 `Scheduler` 类，`tests/task-scheduler.test.ts` 也包含了完整的测试用例。

让我运行测试验证实现是否正确：



$ npx vitest run tests/task-scheduler.test.ts

测试失败是因为统计逻辑有重复计数问题。`onStatusChange` 回调和 `executeTask` 方法都在增加 `completed` 和 `failed` 计数。需要修复这个重复计数的问题。



[Edit: /Users/xin/auto-skills/CtriXin-repo/hive/orchestrator/task-scheduler.ts]

[Edit: /Users/xin/auto-skills/CtriXin-repo/hive/orchestrator/task-scheduler.ts]

$ npx vitest run tests/task-scheduler.test.ts

TaskScheduler 已实现完成，13 个测试全部通过。

实现要点：
- **优先级排序**：使用 `PRIORITY_WEIGHT` 权重映射（critical=4, high=3, normal=2, low=1），同优先级按 `createdAt` 排序
- **延迟调度**：`isEligible()` 检查 `scheduledAt` 时间
- **依赖检查**：遍历 `dependencies` 数组，确保所有依赖状态为 `done`
- **并发限制**：`executor.getMaxConcurrency() - executor.getRunningCount()` 计算可用槽位
- **统计计数**：通过 `onStatusChange` 监听状态变更，从 `running` → `done/failed` 时计数