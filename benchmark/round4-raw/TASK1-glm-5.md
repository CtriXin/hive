[Read: /Users/xin/auto-skills/CtriXin-repo/hive/orchestrator/task-scheduler.ts]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/tests/task-scheduler.test.ts]

$ npm test -- tests/task-scheduler.test.ts 2>&1

TaskScheduler 已实现完成，全部 13 个测试通过：

**实现要点**：
- `orchestrator/task-scheduler.ts` — Scheduler 类实现
- `tests/task-scheduler.test.ts` — 测试用例

**测试覆盖**：
1. **优先级排序** — critical > high > normal > low，同优先级按 createdAt
2. **延迟调度** — scheduledAt 未到不调度，已到可调度
3. **依赖检查** — 所有依赖必须为 done 状态
4. **并发限制** — 尊重 getMaxConcurrency() - getRunningCount()
5. **生命周期** — start/stop/getStats 正确工作