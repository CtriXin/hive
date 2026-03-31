# Hive

**Multi-model AI orchestration — Claude thinks, domestic models execute, everyone reviews.**

> Claude 是蜂后，国产模型是工蜂，成本降 85%，质量不打折。

[English](#english) | [中文](#中文)

---

<!-- AGENT_SETUP_START — Copy the block below into your AI coding assistant (Claude Code, Cursor, etc.) -->

<details>
<summary><strong>Agent Setup Prompt (click to expand / 复制给 AI 助手)</strong></summary>

```
I need you to install and configure Hive — a multi-model AI orchestration system.

## Step 1: Install (or Upgrade)

curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash

This clones to ~/.hive-orchestrator, installs deps, builds, and runs checks.
If already installed, it pulls latest and rebuilds.
Custom path: HIVE_HOME=/your/path curl -fsSL ... | bash

If the script reports issues, fix them before proceeding.

## Step 2: MMS Model Routes (Required)

Hive resolves models via ~/.config/mms/model-routes.json.
Check if it exists:  ls ~/.config/mms/model-routes.json
If missing, you need MMS installed first, or set MMS_ROUTES_PATH env var
to point to your model-routes.json file.

Without model-routes.json, you'll get "No MMS route found" errors.
Fallback: Hive can still use config/providers.json directly if you
specify providerId explicitly when dispatching tasks.

## Step 3: API Keys

Set at least one provider API key in your environment:
- QWEN_API_KEY        (Qwen / 通义千问)
- KIMI_API_KEY        (Kimi / Moonshot)
- KIMI_CODING_API_KEY (Kimi CodingPlan)
- GLM_CN_API_KEY      (GLM / 智谱)
- GLM_EN_API_KEY      (GLM Z.ai international)
- MINIMAX_CN_API_KEY  (MiniMax CN)
- MINIMAX_EN_API_KEY  (MiniMax EN)
- BAILIAN_API_KEY     (百炼 CodingPlan)

## Step 4: MCP Server (Optional)

Add to your Claude Code settings (~/.claude.json or settings.json):

{
  "mcpServers": {
    "hive": {
      "type": "stdio",
      "command": "node",
      "args": ["<hive-path>/dist/mcp-server/index.js"],
      "env": { "HOME": "<your-real-home>" }
    }
  }
}

Replace <hive-path> with the absolute path to the hive directory.
Replace <your-real-home> with your actual home directory (important in sandboxed environments).

## Step 5: Verify

npm run test:smoke   # structure check
npm run build        # ensure TypeScript compiles

## Available MCP Tools (after Step 4)

- plan_tasks     — decompose a goal into executable sub-tasks
- execute_plan   — run a task plan with auto model assignment + review
- dispatch_single — send one task to a specific model
- diagnostics    — health check, scores, translate, ping
- report         — generate Chinese summary of results

## Troubleshooting

- "No MMS route found": model-routes.json missing or model ID not in routes
- "Unknown provider": provider not in config/providers.json
- "Failed to load providers.json": check that config/providers.json exists
- Build errors: run `npm run build` and check TypeScript errors
- Symlink issues: hive-discuss is fetched from GitHub, not local symlink
```

</details>

<!-- AGENT_SETUP_END -->

---

<a id="english"></a>

## What is Hive?

Hive is a self-contained orchestration system that turns expensive AI coding into a cost-effective assembly line:

```
You → Translate → Claude plans → Domestic models execute in parallel → 4-stage review cascade → Report back
```

Instead of burning $5+ per session on Claude Opus for everything, Hive routes ~85% of the work to domestic models at a fraction of the cost, while Claude handles only planning and final decisions.

### The 4-Tier Cascade

```
┌─────────────────────────────────────────────────────────────┐
│  Tier 0: Translator                                          │
│  Natural language → clean English prompt                     │
└──────────────────┬──────────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────────┐
│  Tier 1: Planner (Claude)                                    │
│  Decomposes goal → sub-tasks → assigns optimal models        │
└──────────────────┬──────────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────────┐
│  Tier 3: Workers (Domestic models via Claude Code SDK)       │
│  Full Claude Code instances with swapped LLM backend         │
│  Each worker: isolated git worktree, full tool access        │
│  Triggers cross-model discussion when uncertain              │
└──────────────────┬──────────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────────┐
│  Tier 2: Review Pipeline (4-stage cascade)                   │
│  Cross-review → Adversarial lenses → Arbitration → Verdict  │
└─────────────────────────────────────────────────────────────┘
```

### Cost Comparison

| Approach | Per session | Monthly (100 sessions) |
|----------|-----------|----------------------|
| Pure Claude Opus | ~$5.00 | ~$500 |
| **Hive** | ~$0.77 | ~$77 |
| Savings | **85%** | **$423/month** |

## Features

- **Self-Contained** — Zero external runtime dependencies. Protocol adapter, provider registry, discussion engine, adversarial review all built-in.
- **Profile-Based Model Routing** — Task fingerprints, benchmark profiles, speed tiers, and observed scores are combined to pick the best worker for each sub-task.
- **Dynamic Model Scoring** — Models earn trust through performance. Complexity-aware EMA, weighted samples, confidence factors, and exploration bonus keep routing fairer across easy vs hard tasks.
- **Worker Uncertainty Protocol** — When a worker's confidence drops below threshold, it triggers a structured cross-model discussion instead of guessing. Mandatory pushback prevents echo chambers.
- **4-Stage Review Cascade** — Progressively expensive review. 70%+ complete at Stage 1-2 using only domestic models (near-free).
- **Two-Layer Config System** — Global config in `~/.hive/config.json` and per-project overrides in `<repo>/.hive/config.json`.
- **Gateway / Direct Provider Modes** — Run everything through a unified gateway, or resolve each provider directly from `config/providers.json`.
- **MCP Server Included** — Hive exposes planning, execution, translation, health-check, and reporting tools over MCP.

## Status

🚧 **Under active development.** Core orchestrator, MCP server, review pipeline, and config system are now in place; docs and workflow polish are still ongoing.

Want to contribute? See [Contributing](#contributing).

## Quick Start

**One-line install (or upgrade):**

```bash
curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash
```

Installs to `~/.hive-orchestrator`. Custom location: `HIVE_HOME=/your/path curl -fsSL ... | bash`

**Manual install:**

```bash
git clone https://github.com/CtriXin/hive.git
cd hive
npm install && npm run build
```

### CLI

```bash
hive
hive-config
```

### Validate

```bash
npm run test:smoke
npm run build
```

### Optional: Start MCP server

```bash
npm run start:mcp
```

See `docs/MCP_USAGE.md` for MCP setup and tool details.

### Configuration

Hive merges configuration in this order:

1. Built-in defaults
2. `~/.hive/config.json`
3. `<project>/.hive/config.json`

Common settings include:

- `high_tier`, `review_tier`, `default_worker`, `fallback_worker`
- `translator_model`
- `gateway.url` / `gateway.auth_token_env`
- `providers_path`
- per-task `overrides`

### Runtime Layout

- `orchestrator/` — planning, dispatch, review, model registry, profiling
- `mcp-server/` — MCP entry and tools
- `config/` — provider registry, model capabilities, benchmark policy, review policy
- `bin/` — `hive` and `hive-config` launchers
- `scripts/` — smoke tests and bridge checks

## Contributing

We welcome PRs! Priority areas:

- New provider support (ByteDance Doubao, Baichuan, etc.)
- Review lens extensions (security-focused, performance-focused)
- Additional CLI backend adapters (Gemini CLI, Qwen CLI)
- Cost tracking and visualization
- Documentation and examples

Please open an issue first to discuss your approach before submitting large PRs.

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
你的需求
  → 翻译为 clean English prompt（Tier 0）
  → Claude 拆解任务、分配模型（Tier 1）
  → 国产模型并行执行，各自在独立 worktree 里干活（Tier 3）
      └→ 不确定时自动触发跨模型讨论
  → 4 阶段 review：交叉审查 → 对抗审查 → 仲裁 → 终审（Tier 2）
  → 生成中文报告回传给你
```

### 核心特性

#### 完全自包含
不依赖任何外部运行时。协议翻译、provider 管理、讨论引擎、对抗 review 全部内置。

#### 动态模型评分
模型通过表现赚取信任。Hive 现在会结合 task fingerprint、benchmark profile、测速结果、复杂度归一化 EMA、weighted samples 和 confidence factor 自动选模，而不是只看静态分数。

#### 不确定时讨论，不瞎猜
Worker 信心不足时自动触发跨模型讨论。讨论协议要求 **必须有反对意见**（防止互相吹捧），讨论不出结果就升级。

#### 4 阶段 review 级联
70%+ 的代码在前两个阶段就通过了（全用国产模型，几乎免费）：
1. **交叉审查**：A 模型写的代码让 B 模型审
2. **对抗审查**：多维度挑战（找 bug + 审设计 + 去冗余）
3. **仲裁**：只看有争议的严重发现
4. **终审**：极少触发

#### 双层配置系统
配置按以下优先级合并：
1. 内置默认值
2. `~/.hive/config.json`
3. `<project>/.hive/config.json`

支持 worker tier、gateway、provider 路径覆盖、translator、任务级 override 等配置。

#### MCP 已可用
Hive 已内置 MCP server，提供：
- `plan_tasks`
- `execute_plan`
- `dispatch_single`
- `health_check`
- `model_scores`
- `translate`
- `report`

### 状态

🚧 **积极开发中。** 当前核心 orchestrator、MCP、review pipeline、config system 已经落地，后续重点是体验、文档和更多 provider/benchmark。

### 快速开始

**一键安装/升级：**

```bash
curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash
```

安装到 `~/.hive-orchestrator`。自定义路径：`HIVE_HOME=/your/path curl -fsSL ... | bash`

**手动安装：**

```bash
git clone https://github.com/CtriXin/hive.git
cd hive
npm install
npm run build
```

常用命令：

```bash
# 结构 smoke test
npm run test:smoke

# 启动 MCP server
npm run start:mcp
```

更多 MCP 使用方式见 `docs/MCP_USAGE.md`。

### 配置方式

推荐两层配置：

- 全局：`~/.hive/config.json`
- 项目：`<repo>/.hive/config.json`

常用字段：
- `high_tier` / `review_tier`
- `default_worker` / `fallback_worker`
- `translator_model`
- `gateway`
- `providers_path`
- `overrides`

### 参与贡献

欢迎 PR。请先开 issue 讨论方案，再提交代码。

重点方向：
- 新 provider 支持（字节豆包、百川等）
- Review lens 扩展（安全专项、性能专项）
- 更多 CLI 后端适配（Gemini CLI、Qwen CLI）
- 成本追踪和可视化

### License

MIT
