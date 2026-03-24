# CLI2CLI Self-Contained Addendum

> 本文档是对 `CLI_BRIDGE_IMPLEMENTATION_PLAN.md` 的补充修订。
> 核心变更：**CLI2CLI 必须是完全独立的项目，不依赖任何外部运行时**。

## 1. 依赖内化清单

| 原外部依赖 | 内化方案 | 负责 Task |
|-----------|---------|-----------|
| `agent-discuss/scripts/discuss.sh` | `discuss-bridge.ts` — 用 Claude Code SDK 重写讨论协议 | TASK-B |
| `~/.config/mms/credentials.sh` | `config/providers.json` — 自包含 provider 配置（URL + key env var 名） | TASK-E |
| `ccs_bridge.py`（DeepSeek 等 OpenAI-only） | `protocol-adapter.ts` — 轻量 Anthropic Messages → OpenAI Chat Completions 翻译 | TASK-D |
| `agent-rules/` | `rules/` — 从 agent-rules 提取并适配为 CLI2CLI 4 阶段约束 | TASK-E |
| Tier 0（Kimi 翻译） | `translator.ts` — 中文自然语言 → clean English prompt | TASK-C |
| 汇报流程 | `reporter.ts` — 执行结果 → 中文摘要回传用户/Kimi | TASK-C |

## 2. 新增文件

```
cli2cli/
├── orchestrator/
│   ├── ... (原有文件)
│   ├── translator.ts            # NEW: Tier 0 — Kimi/国产模型做中→英翻译
│   ├── reporter.ts              # NEW: 结果汇报 — 英→中 + 结构化摘要
│   ├── provider-resolver.ts     # RENAMED from mms-bridge-resolver.ts — 自包含
│   ├── protocol-adapter.ts      # NEW: 轻量 Anthropic ↔ OpenAI 协议翻译
│   └── discuss-bridge.ts        # RENAMED from discuss-trigger.ts — SDK 重写
├── config/
│   ├── ... (原有文件)
│   └── providers.json           # NEW: 自包含 provider 注册表
├── rules/                        # NEW: 从 agent-rules 内化
│   ├── AGENT_RULES.md           # 合并版规则（适配 CLI2CLI）
│   ├── planning.md              # Tier 1 规划阶段约束
│   ├── execution.md             # Tier 3 worker 执行约束
│   ├── review.md                # Tier 2 review 约束
│   ├── handoff.md               # 多模型交接协议
│   └── code-quality.md          # 代码红线
├── .ai/                          # NEW: 状态管理
│   ├── manifest.json            # 项目状态（单一事实来源）
│   └── plan/
│       └── current.md           # 当前任务 + 断点
└── CLAUDE.md                     # NEW: 项目级规则入口
```

## 3. 完整用户流程（更新后）

```
用户说中文
    ↓
[Tier 0: translator.ts]
    Kimi/国产模型 翻译为 clean English prompt
    ↓
[Tier 1: planner.ts]
    Claude Opus 拆解任务，分配模型
    ↓
[Tier 3: dispatcher.ts]
    国产模型通过 provider-resolver + protocol-adapter 执行
    不确定时 → discuss-bridge.ts 跨模型讨论
    ↓
[Tier 2: reviewer.ts]
    cross-review → a2a 3-lens → Sonnet 仲裁 → Opus 终审
    ↓
[reporter.ts]
    结果翻译为中文摘要，回传给用户/Kimi
```

## 4. 关键设计决策

### 4.1 discuss-bridge.ts（替代 discuss.sh）

核心协议不变（distill → packet → invoke → normalize），但用 TypeScript + Claude Code SDK 实现：

```typescript
// 不再 execSync("bash discuss.sh ...")
// 而是直接用 SDK 调用国产模型做讨论
const messages = claude(discussPrompt, {
  sessionId: `discuss-${threadId}`,
  cwd: workDir,
  env: { ANTHROPIC_BASE_URL: partnerUrl, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: partner.id },
  maxTurns: 3,
});
```

保留的讨论协议：
- 要求 pushback（必须反对至少一点）
- 结构化回复：`{ agreement, pushback, risks, better_options, recommended_next_step, questions_back, one_paragraph_synthesis }`
- quality gate: pass/warn/fail
- 最多 2 轮，失败升级到 Sonnet

### 4.2 protocol-adapter.ts（替代 ccs_bridge.py）

只取 MMS bridge 的核心能力：Anthropic Messages API → OpenAI Chat Completions。
不需要反向翻译、不需要 Gemini、不需要 Responses API。

核心转换：
- `messages[{role,content}]` 格式对齐
- `tool_use` → `function_call` / `tool_calls`
- `tool_result` → `function` role message
- SSE streaming: `message_start/content_block_delta/message_stop` → `data: {choices:[{delta}]}`

仅用于 DeepSeek 等只支持 OpenAI 协议的 provider。大部分国产模型已经支持 Anthropic 协议（通过 dashscope/kimi/glm/minimax 的 `/anthropic` 端点），不需要走 adapter。

### 4.3 providers.json（替代 MMS credentials.sh）

```json
{
  "providers": {
    "bailian-codingplan": {
      "anthropic_base_url": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
      "api_key_env": "BAILIAN_API_KEY",
      "protocol": "anthropic_native",
      "note": "百炼 CodingPlan，直接支持 Anthropic 协议"
    },
    "deepseek": {
      "openai_base_url": "https://api.deepseek.com/v1",
      "api_key_env": "DEEPSEEK_API_KEY",
      "protocol": "openai_only",
      "note": "需要 protocol-adapter 做 Anthropic→OpenAI 翻译"
    }
  }
}
```

API key 通过环境变量注入（`api_key_env` 字段指定变量名），不存储实际密钥。

### 4.4 translator.ts（Tier 0）

```typescript
export async function translateToEnglish(
  chineseInput: string,
  translatorModel: string,  // e.g., "kimi-k2.5"
  translatorProvider: string,
): Promise<{ english: string; confidence: number }>
```

Prompt 设计：
- 角色：技术翻译官
- 要求：保留技术术语原文，语义准确，不添加不删减
- 输出：clean English prompt（可直接喂给 Claude Opus）

### 4.5 reporter.ts（汇报）

```typescript
export async function reportResults(
  result: OrchestratorResult,
  reporterModel: string,
  reporterProvider: string,
  options?: { language?: 'zh' | 'en'; format?: 'summary' | 'detailed' },
): Promise<string>
```

生成结构化中文摘要：
- 任务概览（做了什么）
- 各 worker 执行情况（模型、耗时、是否 pass）
- review 结果（红/黄/绿 findings 摘要）
- 成本估算
- 下一步建议

### 4.6 rules/ 适配

从 agent-rules 提取以下规则，适配为 CLI2CLI 的 4 阶段：

| 规则文件 | 来源 | 适配 |
|---------|------|------|
| `AGENT_RULES.md` | agent-rules/AGENT_RULES.md | 合并裁剪，CLI2CLI 专用 |
| `planning.md` | iteration.md + plan-quality.md | Tier 1 约束：5 维自审 |
| `execution.md` | code-redlines.md + error-handling.md | Tier 3 约束：代码红线 + 错误处理 |
| `review.md` | cross-agent-review.md | Tier 2 约束：review 协议 |
| `handoff.md` | multi-ai-handoff.md | 模型交接：断点 + brief |
| `code-quality.md` | code-redlines.md | 800 行/30 行/3 层嵌套 |

## 5. Git 纪律（所有 Worker 必须遵守）

改动越大，隔离越强。三级递进：

| 改动规模 | Git 操作 | 示例 |
|---------|---------|------|
| **小 step**（单函数、修 typo、加 import） | `git add`（stage） | 改了一个函数签名 → 立刻 stage |
| **中型**（完成一个文件、一个功能模块） | `git commit` | 写完 `reviewer.ts` → commit |
| **大型**（并行任务、跨模块改动、实验性分支） | `git worktree` | 5 个 worker 并行 → 各自独立 worktree |

规则：
- 每完成一个小步骤就 `git add`，不要攒一堆再 stage
- 每完成一个完整文件/模块就 commit，commit message 用 `feat(module): 描述`
- Worker 执行时自动分配 worktree（由 `worktree-manager.ts` 管理）
- **禁止在 main 分支直接改动** — 所有 worker 工作在 worktree 分支

## 6. 更新后的 Task 分配

| Task | 模型 | 新增/变更文件 |
|------|------|-------------|
| **A** | Qwen-3.5 | `types.ts`(+新类型) `dispatcher.ts`(用 provider-resolver) `index.ts` `package.json` `tsconfig.json` `bin/cli2cli` |
| **B** | Kimi-Coding | `reviewer.ts` `a2a-bridge.ts` **`discuss-bridge.ts`**(重写) |
| **C** | Qwen-Max | `planner.ts` `mcp-server/index.ts` **`translator.ts`**(新) **`reporter.ts`**(新) |
| **D** | GLM5-Turbo | `model-registry.ts` **`provider-resolver.ts`**(改名) **`protocol-adapter.ts`**(新) `context-recycler.ts` |
| **E** | MiniMax-2.7 | configs + **`providers.json`**(新) `worktree-manager.ts` scripts + **`rules/`**(新,6文件) **`.ai/`**(新) **`CLAUDE.md`**(新) |
