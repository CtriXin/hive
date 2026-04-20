# Phase 1A: Fresh Session + Context Pack

## 概述

本设计文档描述 Hive Phase 1A 的实现：**Execution Isolation and Context Discipline**。

核心目标：
1. 为每个 task dispatch 生成显式的 context pack artifact
2. 强化 fresh session / worktree ownership
3. 禁止静默复用被污染的旧 session 状态
4. 使注入给 worker 的上下文可检查、可测试、可复现

## 为什么现在做

这是当前最立竿见影的健壮性提升点，直接影响：
- 首轮任务命中率
- Repair 质量
- 多 task 场景下的边界稳定性

## 设计原则

### 1. Explicit Context Injection
Worker 不再依赖模糊的"自己去找上下文"。Dispatcher 在派发前决定注入内容，同一输入下 context pack 输出尽量稳定。

### 2. Fresh Session by Default
每个 task 默认 fresh worker context。Repair round 也沿用 fresh context 规则。

### 3. Machine-Readable Artifacts
每个 task dispatch 生成一个 context pack JSON，挂到现有 run/task artifact 体系下。

### 4. Minimal Blast Radius
保持 Hive 作为 control plane，不做大规模 CLI 改造或 runtime 替代。

## Context Pack 结构

### TaskContextPack

```typescript
interface TaskContextPack {
  generated_at: string;           // 生成时间戳 (ISO 8601)
  run_id: string;                 // 所属 run ID
  plan_id: string;                // 所属 plan ID
  task_id: string;                // Task ID
  task_objective: string;         // Task 描述/目标 (≤500 字)
  round: number;                  // Round 编号 (0=首轮，>0=repair)
  is_repair: boolean;             // 是否为 repair round
  selected_files: string[];       // 选中的文件列表 (task-scoped)
  verification_profile?: string;  // 选中的规则/verification profile
  prompt_fragments?: PromptPolicyFragmentId[];
  prompt_policy_version?: string;
  goal_snippets?: string[];       // 相关 goal snippets (≤400 字/条)
  repair_context?: RepairContext; // Repair context (仅 is_repair=true)
  upstream_context: ContextPacket[]; // 上游依赖任务的上下文
  assigned_model?: string;
  assigned_provider?: string;
}
```

### RepairContext

```typescript
interface RepairContext {
  previous_error?: string;           // 上一轮的失败原因
  previous_changed_files?: string[]; // 上一轮变更的文件
  review_findings?: Array<{          // Review findings
    severity: 'red' | 'yellow' | 'green';
    file: string;
    line?: number;
    issue: string;
  }>;
  verification_failures?: Array<{    // Verification failures
    type: string;
    message: string;
    command?: string;
  }>;
  repair_guidance?: string[];        // 修复建议
}
```

## 什么可以进 Pack

### ✅ 应该包含
- Task objective / description
- Selected files (来自 `task.estimated_files`)
- Verification profile (如果有)
- Prompt policy fragments
- Upstream context packets (来自依赖任务的输出)
- Repair context (仅 repair round)
- Assigned model / provider 信息

### ❌ 不应该包含
- 整个 repo 的文件内容
- 与当前 task 无关的 goal snippets
- 完整的 worker transcript
- 过大的 diff 内容
- 模糊的"可能有用"的上下文

## 实现架构

### 文件范围
```
orchestrator/
  ├── types.ts                  # 类型定义
  ├── task-context-pack.ts      # Context Pack 构建/序列化/持久化
  └── dispatcher.ts             # 集成 context pack 到 dispatch flow
  └── worktree-manager.ts       # Fresh worktree enforcement

tests/
  └── task-context-pack.test.ts # 单元测试
```

### 关键接口

```typescript
// 构建 TaskContextPack
function buildTaskContextPack(
  task: SubTask,
  options: ContextPackBuilderOptions,
  upstreamContexts: ContextPacket[] = [],
  repairOptions?: BuildRepairContextOptions,
): TaskContextPack;

// 序列化为 prompt 片段
function serializeContextPack(pack: TaskContextPack): string;

// 持久化到 artifact 文件
function persistContextPack(
  cwd: string,
  runId: string,
  pack: TaskContextPack,
): string;

// Fresh session guard
function shouldUseFreshSession(options: {
  taskId: string;
  round: number;
  isRepair: boolean;
}): boolean;

function generateFreshSessionId(taskId: string, round: number): string;
```

## Dispatch Flow 变更

### Before
```
dispatcher.ts:
  1. 从 contextCache 读取 upstream context
  2. 直接传给 worker
  3. Worker 自己决定如何使用
```

### After (Phase 1A)
```
dispatcher.ts:
  1. 从 completed worker results 构建 upstream context packets
  2. 调用 buildTaskContextPack() 生成显式 context pack
  3. 调用 persistContextPack() 持久化到 .ai/runs/<runId>/context-packs/
  4. 调用 recorder.record() 记录 dispatch 上下文
  5. 调用 serializeContextPack() 生成注入 prompt
  6. 调用 shouldUseFreshSession() + generateFreshSessionId() 生成 fresh session ID
  7. 调用 createWorktree({ forceFresh: true }) 创建唯一 worktree
  8. 将完整 prompt 注入 worker
```

## Fresh Session Enforcement

### Worktree 隔离
```typescript
// dispatcher.ts:spawnWorker()
const wt = await createWorktree({
  name: `worker-${config.taskId}`,
  cwd: config.cwd,
  fromBranch: config.fromBranch,
  forceFresh: true, // 总是创建唯一 worktree
});
```

### Session ID 隔离
```typescript
// dispatcher.ts:dispatchBatch()
const useFreshSession = shouldUseFreshSession({
  taskId: task.id,
  round,
  isRepair: round > 0,
});
const sessionId = useFreshSession
  ? generateFreshSessionId(task.id, round)
  : undefined;
```

## Artifact 持久化

### 文件路径
```
.ai/runs/<runId>/context-packs/
  ├── context-pack-task-a-r0.json
  ├── context-pack-task-b-r0.json
  └── context-pack-task-a-r1.json  // repair round
```

### Dispatch Context Record
```typescript
interface DispatchContextRecord {
  recorded_at: string;
  run_id: string;
  plan_id: string;
  task_id: string;
  round: number;
  context_pack: TaskContextPack;
  session_id?: string;
  worktree_path?: string;
  assigned_model?: string;
  assigned_provider?: string;
  artifact_path?: string;
}
```

## 测试覆盖

至少覆盖：
1. **多 task 隔离**: 两个 task 的 context pack 不应互相污染
2. **Repair task**: 生成带 repair context 的 fresh pack
3. **稳定性**: 相同输入下 pack 输出稳定
4. **Dispatch 追踪**: 记录了实际注入上下文
5. **Fresh session**: worktree/session 不会被旧 task 静默复用

## 验收标准

- [x] 每个 task dispatch 都有 machine-readable context pack
- [x] repair dispatch 不复用旧污染 session
- [x] 多 task 情况下 context 不串味
- [x] 至少有 3-5 个针对性测试
- [x] `npm run build` 通过
- [x] 相关测试通过
- [x] 设计文档说明什么可以进/不该进 pack

## 未决风险

1. **上下文大小增长**: 如果 upstream context 过多，可能导致 prompt 过长。当前限制 `MAX_UPSTREAM_CONTEXTS = 5`。

2. **持久化性能**: 每次 dispatch 都写文件，高并发场景可能有 I/O 压力。当前为最佳实践，非关键路径。

3. **现有 artifact 结构**: 如果 `.ai/runs/<runId>/` 不存在，`persistContextPack` 会自动创建目录。

## 对 Phase 2A 的建议

Phase 1A 完成后，下一步可以考虑：

1. **Phase 2A: Capability Routing** - 基于 context pack 的内容做更智能的 model 选择
2. **Phase 2B: Discuss Gate** - 基于 context pack 的不确定性指标触发讨论
3. **Phase 2C: Forensics Pack** - 为失败 task 生成更详细的诊断包

但 Phase 1A 本身是独立完整的，不需要等待后续 phase。

## 变更文件列表

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `orchestrator/types.ts` | 新增类型 | TaskContextPack, RepairContext, DispatchContextRecord 等 |
| `orchestrator/task-context-pack.ts` | 新增模块 | Context Pack 构建/序列化/持久化逻辑 |
| `orchestrator/dispatcher.ts` | 修改 | 集成 context pack 构建、注入、追踪 |
| `orchestrator/worktree-manager.ts` | 修改 | 新增 `forceFresh` 选项 |
| `tests/task-context-pack.test.ts` | 新增测试 | 完整的单元测试覆盖 |

## Closeout

### 验证结果
- 核心 isolation 逻辑已实现
- 测试覆盖 5+ 场景
- 无大面积重构，blast radius 中等

### 建议
进入 Phase 2A 前，建议先观察 Phase 1A 在真实 run 中的表现，特别是：
- Context pack 大小是否合理
- Fresh session 是否显著降低污染
- Dispatch 记录是否便于调试
