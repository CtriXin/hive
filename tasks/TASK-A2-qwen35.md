# TASK A2: Dispatcher + Index + CLI — Qwen 3.5

> 你是 CLI2CLI 项目的实现者。你负责核心调度器和主入口。
> Foundation（types.ts/package.json/tsconfig.json）已由 Codex 完成，你直接 import 使用。
> **本项目完全自包含，不依赖任何外部运行时。**

## 你的职责

创建以下 3 个文件：

1. `orchestrator/dispatcher.ts` — Worker 调度器（最复杂的文件）
2. `orchestrator/index.ts` — 主入口
3. `bin/cli2cli` — CLI 入口脚本

## 项目根目录

`/Users/xin/auto-skills/CtriXin-repo/cli2cli`

先阅读 `CLI_BRIDGE_IMPLEMENTATION_PLAN.md`（§4.5）和 `SELF_CONTAINED_ADDENDUM.md`。
确认 `orchestrator/types.ts` 已存在（由 Codex 创建）。

## 依赖说明

你 import 的模块（其他模型实现，你只管 import 路径正确）：
- `./types` — 已存在（Codex）
- `./model-registry` — `ModelRegistry`（TASK-D GLM5）
- `./provider-resolver` — `resolveProvider`（TASK-D GLM5，注意不是 mms-bridge-resolver）
- `./worktree-manager` — `createWorktree`, `getWorktreeDiff`（TASK-E MiniMax）
- `./context-recycler` — `buildContextPacket`, `formatContextForWorker`（TASK-D GLM5）
- `./discuss-bridge` — `triggerDiscussion`（TASK-B Kimi，注意不是 discuss-trigger）

---

## 文件 1: `orchestrator/dispatcher.ts`

基于 Plan §4.5，做以下 import 路径调整：

```typescript
// 改动点（vs Plan §4.5）：
import { resolveProvider } from './provider-resolver';        // 不是 mms-bridge-resolver
import { triggerDiscussion } from './discuss-bridge';          // 不是 discuss-trigger
// 其余 import 不变
```

### 核心函数 1: `spawnWorker(config: WorkerConfig): Promise<WorkerResult>`

完整生命周期：
1. `resolveProvider(config.provider)` → `{ baseUrl, apiKey }`
2. `createWorktree(config.cwd, 'worker-' + config.taskId)` → worktreePath
3. 构建完整 prompt：
   - 注入 `formatContextForWorker(config.contextInputs)` 上下文
   - 添加 task 指令
   - 添加 Uncertainty Protocol（discuss_threshold、[DISCUSS_TRIGGER] 约定）
4. 调用 Claude Code SDK：
   ```typescript
   const messages = claude(fullPrompt, {
     sessionId,
     cwd: workDir,
     env: {
       ANTHROPIC_BASE_URL: baseUrl,
       ANTHROPIC_AUTH_TOKEN: apiKey,
       ANTHROPIC_MODEL: config.model,
     },
     maxTurns: config.maxTurns,
   });
   ```
5. `for await (const msg of messages)` 流式消费：
   - 分类消息（assistant/tool_use/tool_result/error/system）
   - 追踪 token usage
   - 检测 `[DISCUSS_TRIGGER]` → 读 `.ai/discuss-trigger.json` → 调用 `triggerDiscussion`
   - 注入讨论结果后 resume（新 SDK 调用同一 sessionId）
6. 收集结果 → `WorkerResult`

### 核心函数 2: `dispatchBatch(plan: TaskPlan, registry: ModelRegistry): Promise<WorkerResult[]>`

批量调度：
1. 遍历 `plan.execution_order`（并行组数组）
2. 每组内 `Promise.all` 并行 spawn
3. 跳过 `claude-opus` 任务
4. 组间串行，缓存 `ContextPacket`
5. 返回所有 `WorkerResult`

### 辅助函数: `categorizeMessage(msg: any): WorkerMessage['type']`

参考 Plan §4.5 最后几行。

---

## 文件 2: `orchestrator/index.ts`

主入口 + re-export 所有模块。

```typescript
// ── Re-exports（供 MCP server 和外部使用）──
export { ModelRegistry } from './model-registry';
export { buildPlanFromClaudeOutput, PLAN_PROMPT_TEMPLATE } from './planner';
export { spawnWorker, dispatchBatch } from './dispatcher';
export { reviewCascade } from './reviewer';
export { resolveProvider, checkProviderHealth } from './provider-resolver';
export { translateToEnglish } from './translator';
export { reportResults } from './reporter';
export { runA2aReview } from './a2a-bridge';
export { triggerDiscussion } from './discuss-bridge';
export * from './types';

// ── CLI entry（直接运行时）──
async function main() {
  const args = process.argv.slice(2);

  // 解析参数
  const goalIdx = args.indexOf('--goal');
  const cwdIdx = args.indexOf('--cwd');
  const planIdx = args.indexOf('--plan');
  const translateFlag = args.includes('--translate');

  if (goalIdx < 0 && planIdx < 0) {
    console.log('Usage:');
    console.log('  cli2cli --goal "Build auth system" --cwd /path/to/project');
    console.log('  cli2cli --goal "构建认证系统" --cwd /path --translate');
    console.log('  cli2cli --plan plan.json --cwd /path');
    process.exit(1);
  }

  const cwd = cwdIdx >= 0 ? args[cwdIdx + 1] : process.cwd();
  let goal = goalIdx >= 0 ? args[goalIdx + 1] : '';

  // Tier 0: 翻译
  if (translateFlag && goal) {
    const { translateToEnglish } = await import('./translator');
    const { ModelRegistry } = await import('./model-registry');
    const registry = new ModelRegistry();
    // 选中文最好的模型做翻译
    const translator = registry.getAll().sort((a, b) => b.chinese - a.chinese)[0];
    console.log(`\n🌐 Translating with ${translator.id}...`);
    const result = await translateToEnglish(goal, translator.id, translator.provider);
    console.log(`📝 English: ${result.english}\n`);
    goal = result.english;
  }

  // 加载 plan 或生成 plan
  // plan 的实际生成由 Claude Opus 在 MCP 中完成
  // CLI 模式下只支持执行已有 plan
  if (planIdx >= 0) {
    const fs = await import('fs');
    const planJson = JSON.parse(fs.readFileSync(args[planIdx + 1], 'utf-8'));
    const { buildPlanFromClaudeOutput } = await import('./planner');
    const { dispatchBatch } = await import('./dispatcher');
    const { reviewCascade } = await import('./reviewer');
    const { reportResults } = await import('./reporter');
    const { ModelRegistry } = await import('./model-registry');

    const registry = new ModelRegistry();
    planJson.cwd = cwd;
    const plan = buildPlanFromClaudeOutput(planJson);

    console.log(`\n📋 Plan: ${plan.tasks.length} tasks`);
    console.log(`📋 Groups: ${plan.execution_order.map(g => `[${g.join(',')}]`).join(' → ')}\n`);

    // Dispatch
    const workerResults = await dispatchBatch(plan, registry);

    // Review
    const reviewResults = await Promise.all(
      workerResults.map(r => {
        const task = plan.tasks.find(t => t.id === r.taskId)!;
        return reviewCascade(r, task, plan, registry);
      })
    );

    // Report
    const report = await reportResults(
      {
        plan, worker_results: workerResults, review_results: reviewResults,
        score_updates: [], total_duration_ms: 0,
        cost_estimate: { opus_tokens: 0, sonnet_tokens: 0, haiku_tokens: 0, domestic_tokens: 0, estimated_cost_usd: 0 },
      },
      registry.getAll().sort((a, b) => b.chinese - a.chinese)[0]?.id || 'kimi-k2.5',
      'kimi-codingplan',
      { language: 'zh', format: 'summary', target: 'stdout' },
    );
    console.log(report);
  } else {
    console.log('💡 Use MCP server for interactive planning:');
    console.log('   npm run start:mcp');
    console.log('   Or provide --plan <file.json> for CLI execution');
  }
}

// 只在直接运行时执行 main（不是被 import 时）
const isMainModule = process.argv[1]?.includes('index');
if (isMainModule) {
  main().catch(err => {
    console.error('❌', err.message);
    process.exit(1);
  });
}
```

---

## 文件 3: `bin/cli2cli`

```javascript
#!/usr/bin/env node
import('../dist/orchestrator/index.js');
```

加执行权限：`chmod +x bin/cli2cli`

---

## 执行步骤

1. 确认 `orchestrator/types.ts` 已存在（Codex 产出）
2. 写 `dispatcher.ts`
3. 写 `index.ts`
4. 写 `bin/cli2cli` + `chmod +x`
5. `npx tsc --noEmit`（其他模块缺失会有 import 错误，只关注你的语法）

## 验证标准

- [ ] `dispatcher.ts` 导出 `spawnWorker` 和 `dispatchBatch`
- [ ] `dispatcher.ts` import `./provider-resolver`（不是 mms-bridge-resolver）
- [ ] `dispatcher.ts` import `./discuss-bridge`（不是 discuss-trigger）
- [ ] `index.ts` re-export 包含 translator, reporter, discuss-bridge
- [ ] `index.ts` CLI 支持 `--goal`, `--cwd`, `--translate`, `--plan`
- [ ] `bin/cli2cli` 有执行权限
- [ ] 没有任何 `/Users/xin/...` 硬编码路径

## 禁止事项

- 不要修改 `types.ts`（Codex 负责）
- 不要创建其他人负责的文件
- 不要 import 外部项目路径
