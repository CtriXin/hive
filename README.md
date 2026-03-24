# Hive

**Multi-model AI orchestration — Claude thinks, domestic models execute, everyone reviews.**

> Claude 是蜂后，国产模型是工蜂，成本降 85%，质量不打折。

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## What is Hive?

Hive is a self-contained orchestration system that turns expensive AI coding into a cost-effective assembly line:

```
You (Chinese) → Kimi translates → Claude Opus plans → 5 domestic models execute in parallel → 4-stage review cascade → Chinese report back to you
```

Instead of burning $5+ per session on Claude Opus for everything, Hive routes ~85% of the work to domestic models (Qwen, Kimi, GLM, MiniMax, DeepSeek) at ~¥0.50, while Claude handles only planning and final decisions.

### The 4-Tier Cascade

```
┌─────────────────────────────────────────────────────────────┐
│  Tier 0: Translator (Kimi)                                   │
│  Chinese natural language → clean English prompt              │
│  Cost: ~¥0.001/request                                       │
└──────────────────┬──────────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────────┐
│  Tier 1: Planner (Claude Opus)                               │
│  Decomposes goal → sub-tasks → assigns optimal models        │
│  Used sparingly: 1-2 calls per session                       │
└──────────────────┬──────────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────────┐
│  Tier 3: Workers (Domestic models via Claude Code SDK)       │
│  Full Claude Code instances with swapped LLM backend         │
│  Each worker: isolated git worktree, full tool access        │
│  Triggers cross-model discussion when uncertain              │
│                                                              │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐          │
│  │  Qwen   │ │  Kimi   │ │DeepSeek │ │  GLM    │          │
│  │ schema  │ │  utils  │ │  tests  │ │  docs   │          │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘          │
└──────────────────┬──────────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────────┐
│  Tier 2: Review Pipeline (4-stage cascade)                   │
│                                                              │
│  Stage 1: Cross-review (Model A reviews Model B's code)     │
│  Stage 2: a2a 3-lens (Challenger + Architect + Subtractor)  │
│  Stage 3: Claude Sonnet arbitrates disputed findings         │
│  Stage 4: Claude Opus final verdict (rare, ~2%)             │
│                                                              │
│  Cost: mostly domestic models, Claude only on disputes       │
└─────────────────────────────────────────────────────────────┘
```

### Cost Comparison

| Approach | Per session | Monthly (100 sessions) |
|----------|-----------|----------------------|
| Pure Claude Opus | ~$5.00 | ~$500 |
| **Hive** | ~$0.77 | ~$77 |
| Savings | **85%** | **$423/month** |

## Quick Start

### 1. Install

```bash
git clone https://github.com/CtriXin/hive.git
cd hive
npm install && npm run build
```

### 2. Configure API Keys

```bash
# Set your provider API keys
export BAILIAN_API_KEY="sk-sp-xxx"       # Qwen (百炼 CodingPlan)
export KIMI_CODING_API_KEY="sk-kimi-xxx" # Kimi CodingPlan
export GLM_CN_API_KEY="xxx"              # GLM (智谱)
export MINIMAX_CN_API_KEY="xxx"          # MiniMax
export DEEPSEEK_API_KEY="xxx"            # DeepSeek (optional)
```

### 3. Register MCP Server

```bash
bash scripts/setup-mcp.sh
# Follow the prompts to register with Claude
```

### 4. Use

```bash
# Restart Claude, then just talk naturally:
claude

> 帮我给这个项目加上用户认证，支持 OAuth 和邮箱登录
# Hive automatically: translates → plans → dispatches → reviews → reports
```

### CLI Mode

```bash
# Direct CLI usage
hive --goal "Build a REST API with auth" --cwd /path/to/project
hive --goal "构建用户认证" --cwd /path --translate
hive --plan plan.json --cwd /path
```

## Features

### Self-Contained
Zero external runtime dependencies. Everything is built-in:
- Protocol adapter (Anthropic ↔ OpenAI translation)
- Provider registry with 9 pre-configured providers
- Cross-model discussion engine
- 3-lens adversarial code review (Challenger, Architect, Subtractor)
- Agent collaboration rules

### Dynamic Model Scoring
Models earn trust through performance. Hive tracks pass rates using exponential moving average and routes tasks to the best-performing model for each category:

```
qwen3.5-plus:  coding=0.85  pass_rate=0.80  sweet_spot=[schema, API, CRUD]
kimi-k2.5:     coding=0.82  pass_rate=0.75  sweet_spot=[utils, tests, docs]
deepseek-v3:   coding=0.88  pass_rate=0.78  sweet_spot=[algorithms, math]
```

### Worker Uncertainty Protocol
When a worker's confidence drops below threshold, it triggers a structured cross-model discussion instead of guessing:

```
Worker (Qwen): "I'm uncertain about the auth strategy..."
  → Hive selects discussion partner (Kimi, highest reasoning score)
  → Partner provides structured pushback (mandatory)
  → Decision is injected back into worker's session
```

### 4-Stage Review Cascade
Every piece of code goes through progressively expensive review — 70%+ of reviews complete at Stage 1-2 using only domestic models:

1. **Cross-review** (free): Different vendor reviews the code
2. **a2a 3-lens** (free): Challenger finds bugs, Architect checks design, Subtractor removes bloat
3. **Sonnet** ($): Only sees disputed RED findings
4. **Opus** ($$): Final verdict, ~2% of cases

## Architecture

```
hive/
├── orchestrator/
│   ├── translator.ts        # Tier 0: Chinese → English
│   ├── planner.ts           # Tier 1: Task decomposition
│   ├── dispatcher.ts        # Tier 3: Worker lifecycle
│   ├── reviewer.ts          # Tier 2: 4-stage cascade
│   ├── a2a-bridge.ts        # 3-lens adversarial review
│   ├── discuss-bridge.ts    # Cross-model discussion
│   ├── model-registry.ts    # Dynamic scoring + assignment
│   ├── provider-resolver.ts # Self-contained provider config
│   ├── protocol-adapter.ts  # Anthropic ↔ OpenAI translation
│   ├── context-recycler.ts  # Worker → Worker context transfer
│   ├── worktree-manager.ts  # Git worktree isolation
│   ├── reporter.ts          # Results → Chinese summary
│   ├── types.ts             # All shared interfaces
│   └── index.ts             # Main entry + CLI
├── mcp-server/
│   └── index.ts             # 7 MCP tools for Claude
├── config/
│   ├── model-capabilities.json
│   ├── review-policy.json
│   ├── a2a-lens-config.json
│   └── providers.json       # Provider registry (URLs + env var names)
├── rules/                    # Agent collaboration rules
├── scripts/                  # Smoke tests + setup
└── .ai/                      # State management
```

## Supported Providers

| Provider | Models | Protocol | Endpoint |
|----------|--------|----------|----------|
| 百炼 CodingPlan | Qwen 3.5, Qwen-Coder, GLM, Kimi, MiniMax | Anthropic + OpenAI | coding.dashscope.aliyuncs.com |
| Kimi CodingPlan | Kimi K2.5 | Anthropic + OpenAI | api.kimi.com |
| 智谱 BigModel | GLM 4.7, GLM 5 | Anthropic + OpenAI | open.bigmodel.cn |
| Z.ai | GLM (international) | Anthropic + OpenAI | api.z.ai |
| MiniMax | M2.5, M2.7 | Anthropic + OpenAI | api.minimaxi.com |
| DeepSeek | V3 | OpenAI only (needs adapter) | api.deepseek.com |

## MCP Tools

When registered as MCP server, Hive exposes 7 tools to Claude:

| Tool | Description |
|------|-------------|
| `translate` | Chinese → English prompt translation |
| `plan_tasks` | Decompose goal into sub-tasks with model assignments |
| `execute_plan` | Execute plan: dispatch workers → review cascade → score update |
| `dispatch_single` | Send a single task to a specific model |
| `health_check` | Check all provider connectivity |
| `model_scores` | View current model capability scores |
| `report` | Generate Chinese summary from results |

## License

MIT

---

<a id="中文"></a>

## 中文文档

### Hive 是什么？

Hive（蜂巢）是一个多模型 AI 编程协作系统。核心思路：

**Claude 是蜂后下达指令，国产模型是工蜂并行执行。**

- Claude Opus 只做规划和最终决策（占 15% 的 token）
- 国产模型（Qwen、Kimi、GLM、MiniMax、DeepSeek）做具体编码（占 85%）
- 4 阶段级联 review 保证质量不打折
- 成本从 ~$5/session 降到 ~$0.77/session

### 完整流程

```
你说中文
  → Kimi 翻译成英文（Tier 0, ¥0.001）
  → Claude Opus 拆解任务、分配模型（Tier 1, $0.50）
  → 5 个国产模型并行执行，各自在独立 worktree 里干活（Tier 3, ¥0.50）
      └→ 不确定时自动触发跨模型讨论
  → 4 阶段 review：交叉审查 → 3 镜头对抗 → Sonnet 仲裁 → Opus 终审（Tier 2, ¥0.40 + $0.10）
  → Kimi 生成中文报告回传给你
```

### 快速上手

```bash
# 1. 安装
git clone https://github.com/CtriXin/hive.git
cd hive && npm install && npm run build

# 2. 配置 API key
export BAILIAN_API_KEY="sk-sp-xxx"
export KIMI_CODING_API_KEY="sk-kimi-xxx"
# ... 其他 provider 的 key

# 3. 注册到 Claude
bash scripts/setup-mcp.sh

# 4. 重启 Claude，直接用中文
claude
> 帮我搭一个 TODO API，TypeScript + Express，要增删改查
# Hive 自动接管：翻译 → 规划 → 5 路并行执行 → review → 中文报告
```

### 核心特性

#### 完全自包含
不依赖任何外部运行时。协议翻译、provider 管理、讨论引擎、对抗 review 全部内置。

#### 动态模型评分
模型通过表现赚取信任。Hive 用 EMA 追踪每个模型的通过率，自动把任务分给最适合的模型：
- Qwen 3.5 擅长 schema 和 API → 分配 CRUD 任务
- DeepSeek V3 擅长算法 → 分配复杂逻辑
- Kimi K2.5 擅长工具调用 → 分配测试和文档

#### 不确定时讨论，不瞎猜
Worker 信心不足时自动触发跨模型讨论。讨论协议要求 **必须有反对意见**（防止互相吹捧），讨论不出结果就升级到 Sonnet。

#### 4 阶段 review 级联
70%+ 的代码在 Stage 1-2 就通过了（全用国产模型，几乎免费）：
1. **交叉审查**：Qwen 写的代码让 Kimi 审，反之亦然
2. **3 镜头对抗**：挑战者找 bug + 架构师审设计 + 删减者去冗余
3. **Sonnet 仲裁**：只看有争议的 RED 发现
4. **Opus 终审**：极少触发，约 2% 的情况

### 支持的 Provider

| 来源 | 模型 | 协议 |
|------|------|------|
| 百炼 CodingPlan | Qwen 3.5, GLM, Kimi, MiniMax | Anthropic + OpenAI |
| Kimi CodingPlan | Kimi K2.5 | Anthropic + OpenAI |
| 智谱 BigModel | GLM 4.7 / 5 | Anthropic + OpenAI |
| MiniMax | M2.5 / M2.7 | Anthropic + OpenAI |
| DeepSeek | V3 | OpenAI（需 adapter） |

### 项目结构

```
hive/
├── orchestrator/    # 14 个 TypeScript 模块
├── mcp-server/      # 7 个 MCP 工具
├── config/          # 模型能力表 + review 策略 + provider 配置
├── rules/           # 6 个协作规则文档（规划/执行/review/交接/质量）
├── scripts/         # 测试 + MCP 注册脚本
└── .ai/             # 状态管理
```

### 为什么开源？

1. **成本问题是普遍的** — 每个用 AI 编程的人都在烧钱
2. **国产模型被低估了** — 它们做执行完全够用，缺的是好的编排
3. **没有现成方案** — 多模型协作、级联 review、动态评分，目前开源社区没有
4. **可复现** — 有 API key + Claude 就能跑，不绑定任何 vendor

### 参与贡献

欢迎 PR。重点方向：
- 新 provider 支持（字节豆包、百川等）
- Review lens 扩展（安全专项、性能专项）
- 更多 CLI 后端适配（Gemini CLI、Qwen CLI）
- 成本追踪和可视化

### License

MIT
