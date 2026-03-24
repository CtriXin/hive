# TASK B: Review Pipeline — Kimi Coding

> 你是 CLI2CLI 项目的实现者。你负责整个 review 子系统 + 讨论模块。
> **本项目完全自包含，不依赖外部 agent-discuss 或 a2a。**
> discuss-bridge.ts 是用 SDK 重写的讨论模块，不再 shell out 到 discuss.sh。

## 你的职责

创建以下文件（共 3 个）：

1. `orchestrator/reviewer.ts` — 4 阶段 review 级联
2. `orchestrator/a2a-bridge.ts` — a2a 3-lens 集成（已自包含）
3. `orchestrator/discuss-bridge.ts` — 跨模型讨论（SDK 重写，替代 discuss.sh）

## 项目根目录

`/Users/xin/auto-skills/CtriXin-repo/cli2cli`

先阅读 `CLI_BRIDGE_IMPLEMENTATION_PLAN.md` 和 `SELF_CONTAINED_ADDENDUM.md` 了解全貌。

## 依赖说明

你的文件 import 以下模块（由其他模型实现，你只需要写对 import 路径）：
- `./types` — 所有接口（TASK-A）
- `./model-registry` — `ModelRegistry` 类（TASK-D）
- `./provider-resolver` — `resolveProvider` 函数（TASK-D，注意是 provider-resolver 不是 mms-bridge-resolver）
- `./worktree-manager` — worktree 操作函数（TASK-E）
- `./dispatcher` — `spawnWorker` 函数（TASK-A）

---

## 文件 1: `orchestrator/reviewer.ts`

基于 Plan §4.8，4 阶段 review 级联。

### 核心流程

```
Stage 1: Cross-review (国产模型 A 审 B 的代码)
    → passed + confidence >= 0.85 + (低复杂度 或 模型 pass_rate >= 0.90) → 跳过后续
Stage 2: a2a 3-lens (Challenger + Architect + Subtractor)
    → PASS → 完成
    → REJECT → 送回 worker 修，重跑 a2a 一次
    → CONTESTED → 进 Stage 3
Stage 3: Sonnet 仲裁 (只看 disputed RED findings)
    → pass → 完成
    → fail + fix_instructions → 送回 worker 修，Sonnet 再验一次
Stage 4: Opus 终审 (极少触发)
```

### 关键函数

- `reviewCascade(workerResult, task, plan, registry)` → `ReviewResult`
- `runCrossReview(workerResult, task, reviewerModel)` → `CrossReviewResult`
- `callClaudeModel(prompt, tier)` → `string` — 调用真正的 Claude

### `callClaudeModel` 实现

**重要变更**：不再依赖 `claude --print`。使用 Claude Code SDK，确保清除 MMS 相关 env：

```typescript
async function callClaudeModel(prompt: string, tier: 'opus' | 'sonnet' | 'haiku'): Promise<string> {
  // 用 SDK 调用真正的 Claude（不走 MMS）
  const messages = claude(prompt, {
    sessionId: `review-${tier}-${Date.now()}`,
    cwd: process.cwd(),
    // 不设置 ANTHROPIC_BASE_URL → 走默认 Anthropic API
    // 不设置 ANTHROPIC_MODEL → 用 claude 默认
    maxTurns: 1,
  });

  let output = '';
  for await (const msg of messages) {
    if (msg.type === 'assistant' || msg.role === 'assistant') {
      output += typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    }
  }
  return output;
}
```

注意：env 中**不传** `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL`，让 SDK 走原生 Anthropic API。

### 其余逻辑

参考 Plan §4.8 完整实现。注意：
- review policy 从 `config/review-policy.json` 加载
- auto-pass 规则：docs/comments/formatting/i18n
- 每次 review 后 `registry.updateScore()`
- cross-review 用 SDK + MMS bridge env（和 worker 一样的模式）

---

## 文件 2: `orchestrator/a2a-bridge.ts`

基于 Plan §4.7，**已经是自包含的**（不依赖外部 a2a 项目）。

直接按 Plan §4.7 完整实现。3 个 lens prompt、scale 判断、verdict 规则、JSON 解析全部内置。

关键点：
- 3 个 lens prompt 完整内嵌（Challenger/Architect/Subtractor）
- `determineScale` 按 diff 行数：<50 light, 50-200 medium, 200+ heavy/heavy+
- `lensesForScale`：light=1 lens, medium/heavy=2, heavy+=3
- `parseLensOutput` 有 try-catch，JSON 解析失败返回空数组
- `runLens` 用 Claude Code SDK + provider env
- `runA2aReview` 并行运行所有 lens（`Promise.all`）
- import 用 `./provider-resolver` 不是 `./mms-bridge-resolver`

---

## 文件 3: `orchestrator/discuss-bridge.ts` ⭐ 重写

**这是关键变更**。原来的 `discuss-trigger.ts` shell out 到外部 `discuss.sh`，现在用 TypeScript + Claude Code SDK 完全重写。

### 讨论协议（从 agent-discuss 内化）

讨论的核心是：当 worker 不确定时，让另一个模型做结构化 pushback。

```typescript
import { claude } from '@anthropic-ai/claude-code';
import {
  DiscussTrigger, DiscussResult, DiscussionReply,
  WorkerConfig,
} from './types';
import { ModelRegistry } from './model-registry';
import { resolveProvider } from './provider-resolver';

const MAX_DISCUSS_ROUNDS = 2;

// 讨论 prompt 模板（从 agent-discuss 的 reply contract 内化）
const DISCUSS_PROMPT = `You are a senior engineer participating in a technical discussion.
A colleague is uncertain about a decision and needs your structured pushback.

## Context
{understanding}

## Direction under discussion
{direction}

## Constraints
{constraints}

## Specific question
{question}

## Your response MUST be valid JSON with this exact structure:
{
  "agreement": "What you agree with in their approach (1-2 sentences)",
  "pushback": "REQUIRED: At least one concrete objection or concern (2-3 sentences). You MUST push back on something.",
  "risks": ["risk 1", "risk 2"],
  "better_options": ["alternative 1 if any"],
  "recommended_next_step": "What they should do next (1 sentence)",
  "questions_back": ["clarifying question if needed"],
  "one_paragraph_synthesis": "Your overall assessment in one paragraph"
}

RULES:
- pushback is MANDATORY. Even if you mostly agree, find something to challenge.
- Be specific and actionable, not generic.
- Output ONLY the JSON, no explanatory text.`;

export async function triggerDiscussion(
  trigger: DiscussTrigger,
  workerConfig: WorkerConfig,
  workDir: string,
): Promise<DiscussResult> {
  const registry = new ModelRegistry();

  // 1. 选讨论伙伴（不同模型，高 reasoning）
  const partner = registry.selectDiscussPartner(workerConfig.model);
  const { baseUrl, apiKey } = resolveProvider(partner.provider);

  // 2. 构建讨论 prompt
  const prompt = DISCUSS_PROMPT
    .replace('{understanding}', `Worker (${workerConfig.model}) is implementing: ${workerConfig.prompt.slice(0, 300)}`)
    .replace('{direction}', `Leaning toward: ${trigger.leaning} because: ${trigger.why}`)
    .replace('{constraints}', `Options: ${trigger.options.join(', ')}`)
    .replace('{question}', `${trigger.uncertain_about}\nPressure-test this direction. Which option and why?`);

  const threadId = `discuss-${trigger.task_id}-${Date.now()}`;

  console.log(`    💬 Discussion: ${trigger.uncertain_about}`);
  console.log(`    💬 Partner: ${partner.id} (reasoning: ${partner.reasoning})`);

  try {
    // 3. 用 SDK 调用讨论伙伴
    const messages = claude(prompt, {
      sessionId: threadId,
      cwd: workDir,
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_MODEL: partner.id,
      },
      maxTurns: 3,
    });

    let rawOutput = '';
    for await (const msg of messages) {
      if (msg.type === 'assistant' || msg.role === 'assistant') {
        rawOutput += typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      }
    }

    // 4. 解析结构化回复
    const reply = parseDiscussionReply(rawOutput);

    if (!reply) {
      console.log('    ⚠️ Could not parse discussion reply, escalating');
      return escalateToSonnet(trigger);
    }

    // 5. Quality gate
    const quality = assessQuality(reply);

    if (quality === 'fail') {
      console.log('    ⚠️ Discussion quality: fail, escalating');
      return escalateToSonnet(trigger);
    }

    console.log(`    ✅ Discussion resolved: ${reply.recommended_next_step.slice(0, 80)}`);

    return {
      decision: reply.recommended_next_step || trigger.leaning,
      reasoning: reply.one_paragraph_synthesis || '',
      escalated: false,
      thread_id: threadId,
      quality_gate: quality,
    };

  } catch (err: any) {
    console.log(`    ❌ Discussion failed: ${err.message?.slice(0, 100)}`);
    return escalateToSonnet(trigger);
  }
}

function parseDiscussionReply(output: string): DiscussionReply | null {
  try {
    const jsonMatch = output.match(/\{[\s\S]*"pushback"[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    // 必须有 pushback
    if (!parsed.pushback || parsed.pushback.trim().length < 10) return null;
    return parsed as DiscussionReply;
  } catch {
    return null;
  }
}

function assessQuality(reply: DiscussionReply): 'pass' | 'warn' | 'fail' {
  // pushback 太短 = fail
  if (!reply.pushback || reply.pushback.length < 20) return 'fail';
  // 没有 synthesis = warn
  if (!reply.one_paragraph_synthesis) return 'warn';
  // 没有 recommended_next_step = warn
  if (!reply.recommended_next_step) return 'warn';
  return 'pass';
}

function escalateToSonnet(trigger: DiscussTrigger): DiscussResult {
  return {
    decision: trigger.leaning,
    reasoning: 'Discussion inconclusive, escalating to Sonnet.',
    escalated: true,
    escalated_to: 'sonnet',
    thread_id: '',
    quality_gate: 'fail',
  };
}
```

### 关键区别（vs 原 discuss-trigger.ts）

| 旧 | 新 |
|----|-----|
| `execSync("bash discuss.sh ...")` | Claude Code SDK `claude()` |
| 读 `.ai/threads/.../reply.json` | 直接 `for await` 收集 + JSON 解析 |
| 依赖外部 discuss.sh 786 行脚本 | 全部 TypeScript ~120 行 |
| 需要 `AGENT_DISCUSS_PATH` env | 不需要任何外部路径 |

---

## 执行步骤

1. 确认 `orchestrator/` 目录存在
2. 先写 `discuss-bridge.ts`（上面已给完整代码，直接创建）
3. 再写 `a2a-bridge.ts`（按 Plan §4.7）
4. 最后写 `reviewer.ts`（按 Plan §4.8，改 import 路径）
5. `npx tsc --noEmit` 检查

## 验证标准

- [ ] `reviewer.ts` 导出 `reviewCascade`，import `./provider-resolver`（不是 mms-bridge-resolver）
- [ ] `a2a-bridge.ts` 导出 `runA2aReview`，import `./provider-resolver`
- [ ] `discuss-bridge.ts` 导出 `triggerDiscussion`，**不 import 任何外部路径**
- [ ] `discuss-bridge.ts` 不使用 `execSync("bash ...")`
- [ ] DISCUSS_PROMPT 包含必须 pushback 的要求
- [ ] `parseDiscussionReply` 有 try-catch 容错
- [ ] `callClaudeModel` 不传 `ANTHROPIC_BASE_URL`（走真 Claude）
- [ ] 没有任何 `/Users/xin/...` 硬编码路径

## 禁止事项

- 不要 import 或引用任何外部项目路径
- 不要使用 `execSync("bash discuss.sh ...")`
- 不要创建其他人负责的文件
- 不要修改 Plan 或 Addendum
