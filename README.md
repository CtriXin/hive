# Hive

**Multi-model orchestration for real coding loops — plan, dispatch, review, verify, merge.**

> Hive keeps the control loop. Different models can plan, execute, review, and report through one runtime.

[English](#english) | [中文](#中文)

<p align="center">
  <img src="docs/images/architecture-en.png" alt="Hive v2.1.0 architecture" width="900" />
</p>

## Install

Current stable release: `v3.1.0`

Stable install/upgrade (default = latest tag, currently `v3.1.0`):

```bash
curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash
```

Pin an exact release:

```bash
HIVE_INSTALL_REF=v3.1.0 curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash
```

Bleeding edge from `main`:

```bash
HIVE_CHANNEL=main curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash
```

Dry-run full cleanup first, including global config and current project's `.hive` / `.ai`:

```bash
curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/clean-install.sh | env HIVE_DRY_RUN=1 HIVE_PURGE_CONFIG=1 HIVE_PURGE_RUNS=1 HIVE_PURGE_PROJECT=1 HIVE_PROJECT_ROOT="$PWD" bash
```

Real full cleanup:

```bash
curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/clean-install.sh | env HIVE_PURGE_CONFIG=1 HIVE_PURGE_RUNS=1 HIVE_PURGE_PROJECT=1 HIVE_PROJECT_ROOT="$PWD" bash
```

Fresh reinstall in one command:

```bash
curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/clean-install.sh | env HIVE_PURGE_CONFIG=1 HIVE_PURGE_RUNS=1 HIVE_PURGE_PROJECT=1 HIVE_PROJECT_ROOT="$PWD" bash && curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash
```

> Installs to `~/.hive-orchestrator`. Custom location: `HIVE_HOME=/your/path curl -fsSL ... | bash`
> Run the same install command again to upgrade.
> 安装后会注册全局命令 `hive` / `hive-config`；首次安装如果当前 shell 还没刷新，重开终端或执行 `source ~/.zshrc`。
> 清理命令请在目标项目根目录执行；否则请显式设置 `HIVE_PROJECT_ROOT=/your/repo`。
> `hive web` / `hive-config setup` 不带 `--port` 时会自动选一个可用的本地端口。
> `~/.hive/config.json` is human-reviewed only. Hive Web / CLI do not auto-write it.

After install, configure and verify once:

```bash
hive-config setup
hive-config test
```

`hive-config setup` exports a reviewed JSON template for `~/.hive/config.json`; apply it manually after review. `hive-config test` prints `tier -> model -> channel -> route` and runs a minimal runtime smoke check for the active config. OpenAI-compatible MMS routes keep their exported provider identity; Hive now adapts transport through the model proxy instead of silently rewriting them onto a different fallback channel.

## For AI Agents

> Copy the prompt below into Claude Code, Cursor, or another coding agent if you want the agent to install and wire Hive for you.

```text
Install Hive from https://github.com/CtriXin/hive using the setup below.
Run commands, fix errors, and report results when done.

INSTALL:
  curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash

UPGRADE:
  same command (defaults to latest stable tag)

PIN:
  HIVE_INSTALL_REF=v3.1.0 curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash

DRY-RUN CLEAN:
  curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/clean-install.sh | env HIVE_DRY_RUN=1 HIVE_PURGE_CONFIG=1 HIVE_PURGE_RUNS=1 HIVE_PURGE_PROJECT=1 HIVE_PROJECT_ROOT="$PWD" bash

FULL CLEAN:
  curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/clean-install.sh | env HIVE_PURGE_CONFIG=1 HIVE_PURGE_RUNS=1 HIVE_PURGE_PROJECT=1 HIVE_PROJECT_ROOT="$PWD" bash

FRESH REINSTALL:
  curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/clean-install.sh | env HIVE_PURGE_CONFIG=1 HIVE_PURGE_RUNS=1 HIVE_PURGE_PROJECT=1 HIVE_PROJECT_ROOT="$PWD" bash && curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash

DIR:
  ~/.hive-orchestrator
  override with: HIVE_HOME=/path

REQUIRES:
- node >= 18
- ~/.config/mms/model-routes.json
  override with: export MMS_ROUTES_PATH=/path/to/model-routes.json

ENV KEYS (fallback when MMS routes are unavailable; at least one required):
  QWEN_API_KEY
  KIMI_API_KEY
  KIMI_CODING_API_KEY
  GLM_CN_API_KEY
  GLM_EN_API_KEY
  MINIMAX_CN_API_KEY
  MINIMAX_EN_API_KEY
  BAILIAN_API_KEY

CONFIG LAYERS:
- built-in defaults
- ~/.hive/config.json
- <repo>/.hive/config.json
- run-scoped overrides: .ai/runs/<run-id>/model-overrides.json

GLOBAL CONFIG RULE:
- ~/.hive/config.json is human-reviewed only
- do not auto-modify it from agents/tools
- use project config for automated edits
- use hive-config setup to export JSON, then review and apply manually

CLI QUICK CHECK:
- hive-config setup
- hive-config test
- hive run "<goal>"
- hive status
- hive watch --once
- hive compact
- hive shell
- hive web

MCP SETUP:
  claude mcp add hive -- node ~/.hive-orchestrator/dist/mcp-server/index.js

MCP TOOLS:
  capture_goal
  plan_tasks
  execute_plan
  dispatch_single
  diagnostics
  compact_run
  report
  run_goal
  resume_run
  run_status
  submit_steering

VERIFY:
  cd ~/.hive-orchestrator && npm run build
  cd ~/.hive-orchestrator && npm test

COMMON FAILURES:
- "No MMS route found"     -> check ~/.config/mms/model-routes.json
- "API key not configured" -> export the required provider key
- "Unknown provider"       -> check config/providers.json
```

---

<a id="english"></a>

## What Hive Is Now

Hive is a self-contained orchestration runtime for multi-model coding work. It is no longer just a planner-plus-workers sketch; the released mainline includes:

- a real run loop with planning, execution, review, verification, repair, and merge
- CLI operator surfaces such as `status`, `watch`, `compact`, `shell`, and `runs`
- a local browser decision surface via `hive web`
- layered model policy controls spanning Run, Project, Global, and Default
- persistent run artifacts under `.ai/runs/<run-id>/`

## v2.1.0 Reality

- **Released mainline** — `v2.1.0` is shipped and tagged.
- **Browser Web surface** — `hive web` serves a local decision-first dashboard, not just raw artifacts.
- **Model policy center** — inspect effective policy and edit Run / Project layers from Web.
- **Operator loop** — steering, watch, compact/restore, and HiveShell surfaces are part of the runtime.
- **Resilience path** — capability routing, provider fallback, bounded retries, and state tracking are wired into execution.

## Quick Start

**One-line install or upgrade**

```bash
curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash
```

**Manual install**

```bash
git clone https://github.com/CtriXin/hive.git
cd hive
npm install
npm run build
```

**Run a goal**

```bash
hive run "Implement the auth callback flow and keep tests green"
```

**Observe the latest run**

```bash
hive status
hive watch --once
hive compact
hive shell
```

`hive status`, `hive watch --once`, and `hive web` now surface thin progress/handoff states such as `queued_retry`, `fallback`, and `request_human` without opening raw transcripts.

**Open the local Web surface**

```bash
hive web
```

If you need a fixed port:

```bash
hive web --port 3100
```

**Open the config UI**

```bash
hive-config setup
```

**Start the MCP server**

```bash
npm run start:mcp
```

See `docs/MCP_USAGE.md` for MCP setup and examples.

## Key Commands

```bash
hive run "<goal>"
hive resume --execute
hive status
hive steer
hive workers
hive score
hive watch --once
hive compact
hive restore
hive shell
hive runs
hive web [--port <port>]
hive-config setup [--port <port>] [--no-open]
hive-config test
```

## Configuration and Policy Layers

Hive merges model policy in this order:

1. built-in defaults
2. `~/.hive/config.json`
3. `<repo>/.hive/config.json`
4. `.ai/runs/<run-id>/model-overrides.json`

The Web policy center presents this as `Run > Project > Global > Default`, while the runtime keeps safe-point semantics for run-level changes.

Common configuration areas:

- tier model selection via `tiers.*`
- provider resolution and gateway settings
- discuss / collaboration transport under `collab`
- run-scoped overrides for next-stage changes

## Repository Layout

- `orchestrator/` — planner, driver loop, routing, review, Web adapter/server
- `mcp-server/` — MCP entrypoints and tools
- `config/` — provider registry, capabilities, scoring inputs, review policy
- `web/` — local browser UI for `hive web`
- `docs/` — architecture notes, phase docs, changelog, current-state reference

## Status

`v3.1.0` is released. The current mainline includes the local Web decision surface, layered model policy controls, doctor/install improvements, MMS route bridging fixes, and a dedicated local Config UI. Richer product features such as auth, websocket push, and broader multi-project workflow are still future work.

## Contributing

We welcome PRs. Open an issue before large changes so the direction is clear.

Useful areas:

- provider integrations and route quality
- review and authority improvements
- operator ergonomics in CLI / Web
- documentation and reproducible examples

## License

MIT

---

<a id="中文"></a>

## 中文说明

<p align="center">
  <img src="docs/images/architecture-cn.png" alt="Hive v2.1.0 架构图" width="900" />
</p>

### Hive 现在是什么

Hive 现在不是一个只有“Claude 规划、别的模型执行”的概念图了，而是一套已经落地的多模型编排 runtime。当前主线已经包含：

- 真正的 run loop：`plan -> execute -> review -> verify -> repair -> merge`
- CLI 观察/恢复面：`status`、`watch`、`compact`、`shell`、`runs`
- 本地 browser Web 决策面：`hive web`
- 分层模型策略：`Run > Project > Global > Default`
- 持久化运行产物：`.ai/runs/<run-id>/`

### 当前版本重点

- **`v2.1.0` 已发布**，不是预发布草稿
- **`hive web` 已落地**，首屏是 decision surface，不再只是堆 artifact
- **模型策略中心已落地**，可以查看 effective policy，并编辑 Run / Project 层
- **主循环能力已收口**，包括 steering、watch、compact/restore、HiveShell
- **执行韧性已接入主路径**，包括 capability routing、provider resilience、bounded retry、状态机

### 快速开始

**安装 / 升级**

```bash
curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash
```

当前稳定版：`v3.1.0`

**固定稳定版本**

```bash
HIVE_INSTALL_REF=v3.1.0 curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash
```

**Dry-run 全量清理**

```bash
curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/clean-install.sh | env HIVE_DRY_RUN=1 HIVE_PURGE_CONFIG=1 HIVE_PURGE_RUNS=1 HIVE_PURGE_PROJECT=1 HIVE_PROJECT_ROOT="$PWD" bash
```

**真实全量清理**

```bash
curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/clean-install.sh | env HIVE_PURGE_CONFIG=1 HIVE_PURGE_RUNS=1 HIVE_PURGE_PROJECT=1 HIVE_PROJECT_ROOT="$PWD" bash
```

**一键彻底清理后重装**

```bash
curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/clean-install.sh | env HIVE_PURGE_CONFIG=1 HIVE_PURGE_RUNS=1 HIVE_PURGE_PROJECT=1 HIVE_PROJECT_ROOT="$PWD" bash && curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash
```

> 清理命令请在目标项目根目录执行；否则请显式设置 `HIVE_PROJECT_ROOT=/your/repo`。
> `~/.hive/config.json` 现已改为人工复核模式：Hive Web / CLI 不直接自动写入。

**手动安装**

```bash
git clone https://github.com/CtriXin/hive.git
cd hive
npm install
npm run build
```

**执行一个目标**

```bash
hive run "实现 auth callback 流程，并保持测试通过"
```

**查看当前 run**

```bash
hive status
hive watch --once
hive compact
hive shell
```

**打开本地 Web 界面**

```bash
hive web
```

如果你要固定端口：

```bash
hive web --port 3100
```

**打开配置界面**

```bash
hive-config setup
```

**配置完成后自检**

```bash
hive-config test
```

`hive-config setup` 会导出一份待审 JSON；人工确认后再手动更新 `~/.hive/config.json`。`hive-config test` 会显示当前 effective 配置对应的 `tier -> model -> channel -> route`，并补一轮最小 smoke check，避免先真实跑 Hive 才发现路由问题。对于 OpenAI-compatible 的 MMS route，Hive 现在会保留 MMS 导出的 provider identity，并通过 model proxy 做 transport adaptation，不再静默改写到别的 fallback channel。

**启动 MCP server**

```bash
npm run start:mcp
```

### 常用命令

```bash
hive run "<goal>"
hive resume --execute
hive status
hive steer
hive workers
hive score
hive watch --once
hive compact
hive restore
hive shell
hive runs
hive web [--port <port>]
hive-config setup [--port <port>] [--no-open]
hive-config test
```

### 配置与策略优先级

Hive 的配置层级是：

1. 内置默认值
2. `~/.hive/config.json`
3. `<repo>/.hive/config.json`
4. `.ai/runs/<run-id>/model-overrides.json`

Web 里展示的是 `Run > Project > Global > Default`，运行时对 run 级改动保持 safe-point 生效语义，不会粗暴打断正在执行的 worker。

其中 `~/.hive/config.json` 是人工复核层：不允许 agent / Web / CLI 直接自动写入；自动化改动只落到 `<repo>/.hive/config.json` 或 run 级覆盖。

常见配置点包括：

- `tiers.*` 的模型选择
- provider / gateway 路由
- `collab` 下的讨论与协作 transport
- run 级下一阶段 override

### 仓库结构

- `orchestrator/`：planner、driver loop、routing、review、Web adapter/server
- `mcp-server/`：MCP tools 入口
- `config/`：provider、capability、评分输入、review policy
- `web/`：`hive web` 的本地前端
- `docs/`：变更文档、phase 文档、当前状态说明

### 当前状态

`v3.1.0` 已正式发布。当前已经有本地 Web decision surface、分层模型策略控制、doctor / installer 改进、MMS route bridging 修复，以及独立本地 Config UI；更完整的 auth、websocket push、广义 multi-project 产品化流程还属于后续工作。

### 参与贡献

欢迎 PR。较大的改动建议先开 issue 对齐方向。

优先方向：

- provider 接入与 route 质量
- review / authority 路径增强
- CLI / Web 操作体验
- 文档与可复现实例

### License

MIT
