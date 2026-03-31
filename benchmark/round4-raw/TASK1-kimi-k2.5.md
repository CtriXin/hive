[Read: /Users/xin/auto-skills/CtriXin-repo/hive/.ai/manifest.json]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/rules/AGENT_RULES.md]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/orchestrator/task-scheduler.ts]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/tests/task-scheduler.test.ts]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/orchestrator/types.ts]

TaskScheduler 实现和测试用例已经存在。让我运行测试验证实现是否正确。

$ npm test -- tests/task-scheduler.test.ts 2>&1

TaskScheduler 模块已实现并通过所有测试。实现位于 `orchestrator/task-scheduler.ts:46-157`，包含：

- **优先级排序**：critical > high > normal > low，同优先级按 createdAt 排序
- **延迟调度**：检查 scheduledAt，只有当前时间 >= 目标时间才调度
- **依赖检查**：所有依赖必须为 'done' 状态才可调度
- **并发限制**：不超过 executor.getMaxConcurrency()
- **调度循环**：start() 后每 1000ms 自动 tick

测试文件 `tests/task-scheduler.test.ts` 包含 13 个测试用例，覆盖所有调度规则和生命周期方法。