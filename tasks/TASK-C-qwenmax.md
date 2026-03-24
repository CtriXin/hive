# TASK C: Planning + MCP + Translator + Reporter — Qwen Max

> 你是 CLI2CLI 项目的实现者。你负责任务规划、MCP Server、以及两个新模块：翻译器和汇报器。
> 翻译器 = Tier 0（中文→英文），汇报器 = 最后一环（结果→中文摘要）。
> **本项目完全自包含，不依赖外部运行时。**

## 你的职责

创建以下文件（共 4 个）：

1. `orchestrator/planner.ts` — 任务分解 + 模型分配
2. `mcp-server/index.ts` — MCP 工具暴露给 Claude
3. `orchestrator/translator.ts` — **NEW**: Tier 0 中→英翻译
4. `orchestrator/reporter.ts` — **NEW**: 结果汇报（英→中摘要）

## 项目根目录

`/Users/xin/auto-skills/CtriXin-repo/cli2cli`

先阅读 `CLI_BRIDGE_IMPLEMENTATION_PLAN.md` 和 `SELF_CONTAINED_ADDENDUM.md`。

## 依赖说明

你 import 的模块（其他模型实现）：
- `./types` — 接口（TASK-A），包括新增的 `TranslationResult`, `ReportOptions`, `OrchestratorResult`
- `./model-registry` — `ModelRegistry`（TASK-D）
- `./dispatcher` — `spawnWorker`, `dispatchBatch`（TASK-A）
- `./reviewer` — `reviewCascade`（TASK-B）
- `./provider-resolver` — `resolveProvider`, `checkProviderHealth`（TASK-D）

---

## 文件 1: `orchestrator/planner.ts`

基于 Plan §4.9，不变。

导出：
- `buildPlanFromClaudeOutput(claudeOutput)` → `TaskPlan`
- `PLAN_PROMPT_TEMPLATE` — Claude Opus 的 prompt 模板

核心逻辑：
1. 接收 Claude Opus 的 tasks JSON
2. `registry.assignModel()` 分配模型
3. `discuss_threshold`：低 0.5, 中 0.6, 高 0.7
4. `buildExecutionOrder()` 拓扑排序
5. 构建 `context_flow`

`PLAN_PROMPT_TEMPLATE` 内容参考 Plan §4.9，包含：
- 任务结构定义（id, description, complexity, category, estimated_files, acceptance_criteria, depends_on）
- category 列表：schema, utils, api, tests, security, docs, config, algorithms, CRUD, i18n, refactor
- 规则：最多 10 个 task，安全→high，不同文件并行

---

## 文件 2: `mcp-server/index.ts`

基于 Plan §4.10，**新增 2 个 tool**（translate + report）。

### 原有 5 个 tool（Plan §4.10）

1. `plan_tasks` — goal + cwd → prompt 模板 + 模型列表
2. `execute_plan` — plan JSON → dispatch + review + score update
3. `dispatch_single` — 单任务到指定模型
4. `health_check` — 检查所有 provider
5. `model_scores` — 展示能力分数表

### 新增 2 个 tool

6. **`translate`** — 中文输入 → English prompt

```typescript
server.tool(
  'translate',
  'Translate Chinese natural language input to a clean English prompt for Claude.',
  {
    input: z.string().describe('Chinese natural language input from user'),
    model: z.string().describe('Translator model ID (e.g., kimi-k2.5)').optional(),
  },
  async ({ input, model }) => {
    const registry = new ModelRegistry();
    const translatorModel = model || registry.getAll()
      .sort((a, b) => b.chinese - a.chinese)[0]?.id || 'kimi-k2.5';
    const modelInfo = registry.get(translatorModel);
    if (!modelInfo) {
      return { content: [{ type: 'text', text: `Unknown model: ${translatorModel}` }] };
    }

    const result = await translateToEnglish(input, translatorModel, modelInfo.provider);
    return {
      content: [{
        type: 'text',
        text: `## Translation (${result.translator_model}, confidence: ${result.confidence.toFixed(2)})\n\n${result.english}\n\n_Duration: ${result.duration_ms}ms_`,
      }],
    };
  }
);
```

7. **`report`** — OrchestratorResult → 中文摘要

```typescript
server.tool(
  'report',
  'Generate a Chinese summary report from orchestration results.',
  {
    result_json: z.string().describe('OrchestratorResult JSON'),
    format: z.enum(['summary', 'detailed']).default('summary'),
  },
  async ({ result_json, format }) => {
    const result = JSON.parse(result_json);
    const report = await reportResults(result, 'kimi-k2.5', 'kimi-codingplan', {
      language: 'zh', format, target: 'stdout',
    });
    return { content: [{ type: 'text', text: report }] };
  }
);
```

### import 变更

```typescript
// 新增 import
import { translateToEnglish } from '../orchestrator/translator';
import { reportResults } from '../orchestrator/reporter';
```

---

## 文件 3: `orchestrator/translator.ts` ⭐ 新文件

Tier 0：用国产模型做中→英翻译。

```typescript
import { claude } from '@anthropic-ai/claude-code';
import { TranslationResult } from './types';
import { resolveProvider } from './provider-resolver';

const TRANSLATE_PROMPT = `You are a precise technical translator.
Translate the following Chinese input into clean, natural English suitable as a prompt for an AI coding assistant.

RULES:
- Preserve all technical terms in their original English form
- Do NOT add information that isn't in the original
- Do NOT remove or simplify anything
- Output ONLY the English translation, no explanations
- If the input is already in English, output it as-is
- Keep code snippets, file paths, and variable names unchanged

Chinese input:
`;

export async function translateToEnglish(
  chineseInput: string,
  translatorModel: string,
  translatorProvider: string,
): Promise<TranslationResult> {
  const startTime = Date.now();

  // 如果输入已经是英文（ASCII > 70%），直接返回
  const asciiRatio = chineseInput.split('').filter(c => c.charCodeAt(0) < 128).length / chineseInput.length;
  if (asciiRatio > 0.7) {
    return {
      original: chineseInput,
      english: chineseInput,
      confidence: 1.0,
      translator_model: 'passthrough',
      duration_ms: 0,
    };
  }

  const { baseUrl, apiKey } = resolveProvider(translatorProvider);

  const messages = claude(TRANSLATE_PROMPT + chineseInput, {
    sessionId: `translate-${Date.now()}`,
    cwd: process.cwd(),
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: translatorModel,
    },
    maxTurns: 1,
  });

  let english = '';
  for await (const msg of messages) {
    if (msg.type === 'assistant' || msg.role === 'assistant') {
      english += typeof msg.content === 'string' ? msg.content : '';
    }
  }

  english = english.trim();

  // 简单 confidence 评估
  const confidence = english.length > 0 && english.length >= chineseInput.length * 0.3 ? 0.9 : 0.5;

  return {
    original: chineseInput,
    english,
    confidence,
    translator_model: translatorModel,
    duration_ms: Date.now() - startTime,
  };
}
```

---

## 文件 4: `orchestrator/reporter.ts` ⭐ 新文件

把 OrchestratorResult 翻译为中文结构化摘要。

```typescript
import { claude } from '@anthropic-ai/claude-code';
import { OrchestratorResult, ReportOptions } from './types';
import { resolveProvider } from './provider-resolver';

const REPORT_PROMPT = `You are a technical project reporter. Generate a structured Chinese summary of the following orchestration results.

## Format requirements:
1. **任务概览** — 做了什么（1-2 句）
2. **执行情况** — 表格：任务ID | 模型 | 耗时 | 状态(✅/❌)
3. **Review 结果** — 红/黄/绿 findings 数量 + 关键问题摘要
4. **成本估算** — Claude token + 国产 token + 总成本
5. **下一步建议** — 需要人工关注的点

Output in Chinese. Keep it concise.

## Results data:
`;

export async function reportResults(
  result: OrchestratorResult,
  reporterModel: string,
  reporterProvider: string,
  options: ReportOptions = { language: 'zh', format: 'summary', target: 'stdout' },
): Promise<string> {
  // 构建简洁的数据摘要（不把整个 result 扔进去）
  const summary = {
    goal: result.plan.goal,
    task_count: result.plan.tasks.length,
    workers: result.worker_results.map(w => ({
      task: w.taskId,
      model: w.model,
      success: w.success,
      duration_s: (w.duration_ms / 1000).toFixed(1),
      files_changed: w.changedFiles.length,
      discuss_triggered: w.discuss_triggered,
    })),
    reviews: result.review_results.map(r => ({
      task: r.taskId,
      passed: r.passed,
      stage: r.final_stage,
      findings_red: r.findings.filter(f => f.severity === 'red').length,
      findings_yellow: r.findings.filter(f => f.severity === 'yellow').length,
    })),
    cost: result.cost_estimate,
    score_updates: result.score_updates,
    total_duration_s: (result.total_duration_ms / 1000).toFixed(1),
  };

  if (options.format === 'summary') {
    // 简洁模式：直接格式化，不调 LLM
    return formatLocalReport(summary);
  }

  // detailed 模式：用国产模型生成自然语言报告
  const { baseUrl, apiKey } = resolveProvider(reporterProvider);

  const messages = claude(REPORT_PROMPT + JSON.stringify(summary, null, 2), {
    sessionId: `report-${Date.now()}`,
    cwd: process.cwd(),
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: reporterModel,
    },
    maxTurns: 1,
  });

  let report = '';
  for await (const msg of messages) {
    if (msg.type === 'assistant' || msg.role === 'assistant') {
      report += typeof msg.content === 'string' ? msg.content : '';
    }
  }

  return report.trim() || formatLocalReport(summary);
}

// 本地格式化（不需要 LLM，用于 summary 模式）
function formatLocalReport(summary: any): string {
  let report = `## 📋 任务报告\n\n`;
  report += `**目标**: ${summary.goal}\n`;
  report += `**总耗时**: ${summary.total_duration_s}s\n\n`;

  report += `### 执行情况\n\n`;
  report += `| 任务 | 模型 | 耗时 | 状态 | 文件数 |\n`;
  report += `|------|------|------|------|--------|\n`;
  for (const w of summary.workers) {
    report += `| ${w.task} | ${w.model} | ${w.duration_s}s | ${w.success ? '✅' : '❌'} | ${w.files_changed} |\n`;
  }

  report += `\n### Review 结果\n\n`;
  for (const r of summary.reviews) {
    const emoji = r.passed ? '✅' : '❌';
    report += `- ${emoji} **${r.task}**: stage=${r.stage}, ${r.findings_red}🔴 ${r.findings_yellow}🟡\n`;
  }

  if (summary.cost) {
    report += `\n### 成本估算\n\n`;
    report += `- Claude tokens: ${summary.cost.opus_tokens + summary.cost.sonnet_tokens + summary.cost.haiku_tokens}\n`;
    report += `- 国产 tokens: ${summary.cost.domestic_tokens}\n`;
    report += `- 预估成本: $${summary.cost.estimated_cost_usd.toFixed(2)}\n`;
  }

  return report;
}
```

---

## 执行步骤

1. `mkdir -p mcp-server orchestrator`
2. 先写 `translator.ts`（独立，最简单）
3. 再写 `reporter.ts`（独立）
4. 写 `planner.ts`（按 Plan §4.9）
5. 最后写 `mcp-server/index.ts`（依赖上面 3 个 + 其他模块）
6. `npx tsc --noEmit` 检查

## 验证标准

- [ ] `planner.ts` 导出 `buildPlanFromClaudeOutput` + `PLAN_PROMPT_TEMPLATE`
- [ ] `translator.ts` 导出 `translateToEnglish`，有英文 passthrough 逻辑
- [ ] `reporter.ts` 导出 `reportResults`，有 `formatLocalReport` 本地格式化
- [ ] `mcp-server/index.ts` 注册了 **7** 个 tool（原 5 + translate + report）
- [ ] 所有 import 用 `./provider-resolver`（不是 mms-bridge-resolver）
- [ ] 没有任何外部路径硬编码
- [ ] reporter 的 summary 模式不需要 LLM（纯本地格式化）

## 禁止事项

- 不要 import 外部项目路径
- 不要修改 Plan 或 Addendum
- 不要创建其他人负责的文件
- translator 不要 over-engineer（不需要回译验证、术语表等）
