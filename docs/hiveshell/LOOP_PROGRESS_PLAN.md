# Loop Progress Plan

日期：2026-04-03  
作者：Codex

## 问题

当前 loop 启动后，用户体感像盲盒：

- 长时间没反馈
- 不知道活着还是卡死
- 不知道当前卡在 planning / executing / review / verify 哪一步
- 中途 human interrupt 很多，因为用户看不到进度

## 方针

不要先堆重 UI。  
先补一层 Claude-style `live progress surface`。

目标：

- 启动后 1 秒内有反馈
- 持续显示当前 phase
- 持续显示当前 focus worker
- compact / restore 能恢复“运行态”，不是只恢复历史总结

## 参考 Claude 源码的对应能力

我们对齐的是这几个原生概念：

- `task-summary`
- `agentId`
- `SubagentStart`
- transcript / sidechain
- tool output replacement / update

所以 Hive 不该只加 `console.log`，而要补统一 progress surface。

## 方案

### 1. 新增统一 progress artifact

新增文件建议：

- `orchestrator/loop-progress-store.ts`

运行产物：

- `.ai/runs/<run-id>/loop-progress.json`

最小字段：

```json
{
  "run_id": "run-xxx",
  "round": 2,
  "phase": "planning|executing|reviewing|verifying|repairing|replanning|done|blocked",
  "reason": "Generating plan...",
  "focus_task_id": "task-a",
  "focus_agent_id": "task-a@run-xxx",
  "focus_summary": "Editing README",
  "transcript_path": ".ai/runs/run-xxx/workers/task-a.transcript.jsonl",
  "updated_at": "..."
}
```

### 2. driver loop 每次阶段切换都刷新

改：

- `orchestrator/driver.ts`

最少覆盖阶段：

- planning
- executing
- reviewing
- verifying
- repairing
- replanning
- done
- blocked

要求：

- 每次切 phase 写 `loop-progress.json`
- 同时 stdout 打短句

建议短句：

- `⏳ planning: Generating plan...`
- `⏳ executing: Dispatching 3 task(s)...`
- `⏳ reviewing: Reviewing 3 worker result(s)...`
- `⏳ verifying: Running merged-code verification...`

### 3. focus worker 统一从 worker-status 取

改：

- `orchestrator/worker-status-store.ts`
- `orchestrator/dispatcher.ts`
- `orchestrator/driver.ts`

选择规则：

1. `running`
2. `starting`
3. `discussing`
4. 最近更新的 completed worker

只放一个 focus worker，不要全塞。

### 4. CLI 默认先展示 progress

改：

- `orchestrator/index.ts`

要求：

- `hive status` 先显示 phase + reason + focus worker
- `hive watch` 默认轮询 `loop-progress.json`
- 没 progress 再回退旧 dashboard

### 5. compact / restore 带上 progress

改：

- `orchestrator/compact-packet.ts`

要求：

- compact packet 带上当前 phase
- restore prompt 带上：
  - phase
  - focus worker
  - transcript pointer
  - next step

### 6. MCP 输出接 progress

改：

- `mcp-server/index.ts`
- `orchestrator/mcp-surface.ts`

要求：

- `execute_plan`
- `dispatch_single`

除了现有 `focus / agent / transcript / restore`，再给：

- `progress: .ai/runs/<run-id>/loop-progress.json`

## 文件分工建议

### Agent A

- `orchestrator/loop-progress-store.ts`
- `orchestrator/driver.ts`

### Agent B

- `orchestrator/index.ts`
- `orchestrator/compact-packet.ts`

### Agent C

- `mcp-server/index.ts`
- `orchestrator/mcp-surface.ts`

## 验收

最小验收 5 条：

1. loop 启动后 1 秒内有反馈
2. phase 切换时能看到变化
3. `hive status` 能直接看到当前 phase + focus worker
4. `hive watch` 不再像卡死
5. `compact / restore` 后能恢复当前运行态

## 你现在最该让 agent 接的

优先顺序：

1. `driver.ts` 的 progress 写入
2. `index.ts` 的 status/watch 展示
3. `compact-packet.ts` 的 progress carry-over
4. `mcp-server/index.ts` 的 progress pointer
