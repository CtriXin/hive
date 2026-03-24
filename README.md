# Hive

**Multi-model AI orchestration — Claude thinks, domestic models execute, everyone reviews.**

> Claude 是蜂后，国产模型是工蜂，成本降 85%，质量不打折。

[English](#english) | [中文](#中文)

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
- **Dynamic Model Scoring** — Models earn trust through performance. EMA-based pass rate tracking routes tasks to the best model for each category.
- **Worker Uncertainty Protocol** — When a worker's confidence drops below threshold, it triggers a structured cross-model discussion instead of guessing. Mandatory pushback prevents echo chambers.
- **4-Stage Review Cascade** — Progressively expensive review. 70%+ complete at Stage 1-2 using only domestic models (near-free).

## Status

🚧 **Under active development.** Core orchestrator modules are being implemented.

Want to contribute? See [Contributing](#contributing).

## Quick Start

```bash
git clone https://github.com/CtriXin/hive.git
cd hive
npm install && npm run build
```

Configuration and usage docs will be available once core modules are ready.

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
模型通过表现赚取信任。Hive 用 EMA 追踪每个模型的通过率，自动把任务分给最适合的模型。

#### 不确定时讨论，不瞎猜
Worker 信心不足时自动触发跨模型讨论。讨论协议要求 **必须有反对意见**（防止互相吹捧），讨论不出结果就升级。

#### 4 阶段 review 级联
70%+ 的代码在前两个阶段就通过了（全用国产模型，几乎免费）：
1. **交叉审查**：A 模型写的代码让 B 模型审
2. **对抗审查**：多维度挑战（找 bug + 审设计 + 去冗余）
3. **仲裁**：只看有争议的严重发现
4. **终审**：极少触发

### 状态

🚧 **积极开发中。** 核心模块正在实现。

### 参与贡献

欢迎 PR。请先开 issue 讨论方案，再提交代码。

重点方向：
- 新 provider 支持（字节豆包、百川等）
- Review lens 扩展（安全专项、性能专项）
- 更多 CLI 后端适配（Gemini CLI、Qwen CLI）
- 成本追踪和可视化

### License

MIT
