# Hive Terminology Glossary / Hive 术语表

> Key technical terms used across changelog and migration guide documents.

## Core Architecture / 核心架构

| English | 中文 | Definition |
|---------|------|------------|
| **4-Tier Cascade** | 四级级联 | The pipeline architecture: Translate → Plan → Execute → Review → Report. Each tier uses a potentially different model optimized for that stage. 将目标翻译为英文后，依次经过规划、执行、评审、报告四个阶段，各阶段可使用不同模型。 |
| **Orchestrator** | 编排器 | The top-level loop that drives plan → dispatch → review → verify → repair/replan. Coordinates workers, review stages, and budget tracking. 负责驱动规划→派发→评审→验证→修复循环的顶层控制器。 |
| **Tier** | 层级 / 级 | A named stage in the cascade pipeline (translator, planner, discuss, executor, reviewer, reporter). Each has its own model config. 级联流水线中的命名阶段，各自拥有独立的模型配置。 |

## Model & Provider / 模型与供应商

| English | 中文 | Definition |
|---------|------|------------|
| **Model Registry** | 模型注册表 | Config-driven registry (`config/providers.json`) mapping model IDs to providers, capabilities, and scoring data. Replaces hardcoded credential scripts. 基于配置的模型注册表，将模型 ID 映射到供应商、能力和评分数据，替代硬编码凭证脚本。 |
| **Provider Entry** | 供应商条目 | A record in the providers config containing `id`, `display_name`, `base_url`, `api_key_env`, and `protocol`. 供应商配置中的记录，包含 ID、显示名称、API 地址、密钥环境变量和协议类型。 |
| **Domestic Model** | 国产模型 | Models from Chinese providers (e.g., Qwen, GLM) that may have lower cost but different capability profiles. 来自中国供应商的模型（如通义千问、智谱），成本较低但能力特征不同。 |
| **Pass Rate** | 通过率 | Dynamic score (0–1) tracking how often a model passes review, updated after each task completion. 模型通过评审的动态评分（0–1），每次任务完成后更新。 |

## Planning & Execution / 规划与执行

| English | 中文 | Definition |
|---------|------|------------|
| **TaskPlan** | 任务计划 | The output of the planner tier: a set of `SubTask` items with execution order, context flow, and model assignments. 规划层的输出：包含子任务集合��执行顺序、上下文流转和模型分配的计划。 |
| **SubTask** | 子任务 | A self-contained unit of work within a TaskPlan, with complexity, category, assigned model, and acceptance criteria. 任务计划中的自包含工作单元，具有复杂度、类别、分配模型和验收标准。 |
| **Execution Order** | 执行顺序 | Parallel groups of task IDs (e.g., `[["A","B"], ["C"]]`) defining which tasks can run concurrently. 并行任务组（如 `[["A","B"], ["C"]]`），定义哪些任务可以并发执行。 |
| **Worktree** | 工作树 | An isolated git worktree where each worker operates, preventing cross-task file conflicts. 每个工作器独立操作的隔离 git 工作树，防止跨任务文件冲突。 |
| **Context Packet** | 上下文数据包 | Structured output from a completed task (`from_task`, `summary`, `key_outputs`, `decisions_made`) passed as input to dependent tasks. 已完成任务的结构化输出，传递给依赖任务作为输入。 |

## Collaboration / 协作机制

| English | 中文 | Definition |
|---------|------|------------|
| **AgentBus** | AgentBus / 智能体总线 | The inter-agent communication transport. Supports room-based discussion for plan and worker discuss phases. 智能体间通信传输层，支持基于房间的规划讨论和工作器讨论。 |
| **Plan Discuss** | 规划讨论 | Cross-model review of the plan before execution. Partners critique task gaps, redundancies, and model assignments. 执行前跨模型评审计划，合作方审视任务缺口、冗余和模型分配。 |
| **Worker Discuss** | 工作器讨论 | Triggered when a worker's confidence falls below its threshold. The worker publishes a `DiscussTrigger` to solicit advice. 工作器置信度低于阈值时触发，发布讨论触发器以征求建议。 |
| **Collab Card** | 协作卡片 | A real-time status object (`CollabCard`) tracking room state: `open → collecting → synthesizing → closed/fallback`. 实时状态对象，跟踪房间生命周期：开启→收集→综合→关闭/回退。 |
| **Transport** | 传输方式 | The discuss mechanism: `local` (in-process) or `agentbus` (room-based via AgentBus). 讨论机制：`local`（进程内）或 `agentbus`（基于 AgentBus 房间）。 |
| **Fallback** | 回退 | Graceful degradation from AgentBus to local discuss when room creation or reply collection fails. 当房间创建或回复收集失败时，从 AgentBus 优雅降级到本地讨论。 |
| **Synthesis** | 综合 | Converting collected AgentBus replies into a structured `PlanDiscussResult` or `DiscussResult` via a summarization pass. 通过汇总过程将收集到的 AgentBus 回复转换为结构化的讨论结果。 |

## Review Cascade / 评审级联

| English | 中文 | Definition |
|---------|------|------------|
| **Review Cascade** | 评审级联 | Multi-stage review: cross-review → a2a-lenses → Sonnet arbitration → Opus final review. Escalates on red findings. 多阶段评审：交叉评审→A2A 透镜→Sonnet 仲裁→Opus 终审。红色发现触发升级。 |
| **Cross-Review** | 交叉评审 | Initial peer review by another model, flagging issues with severity levels (red/yellow/green). 由另一个模型进行的初步同行评审，按严重程度标记问题。 |
| **A2A Review** | A2A 评审 | Agent-to-agent review using specialized lenses: `challenger`, `architect`, `subtractor`. Produces a verdict: PASS/CONTESTED/REJECT/BLOCKED. 使用专业透镜（质疑者、架构师、减法者）的智能体间评审，产出判定结果。 |
| **A2A Lens** | A2A 透镜 | A review perspective: `challenger` (adversarial), `architect` (structural), `subtractor` (simplification). 评审视角：质疑者（对抗性）、架构师（结构性）、减法者（简化）。 |
| **Verdict** | 判定 | The outcome of an A2A review: `PASS`, `CONTESTED`, `REJECT`, or `BLOCKED`. A2A 评审的结论：通过、有争议、拒绝或阻塞。 |

## Verification & Repair / 验证与修复

| English | 中文 | Definition |
|---------|------|------------|
| **Done Condition** | 完成条件 | A verification gate (`test`, `build`, `lint`, `command`, `file_exists`, `review_pass`) that must pass for a task to be considered complete. 验证关卡（测试、构建、lint、命令、文件存在、评审通过），任务必须通过才能视为完成。 |
| **Verification Result** | 验证结果 | Outcome of a done condition check: `passed`, `exit_code`, `stdout/stderr_tail`, `failure_class`. 完成条件检查的结果：是否通过、退出码、输出摘要、失败分类。 |
| **Repair** | 修复 | Fixing a task that failed verification or review, guided by review findings. 修复验证或评审失败的任务，由评审发现引导。 |
| **Replan** | 重新规划 | Generating a new plan when repair fails or too many tasks need rework. 当修复失败或太多任务需要返工时，生成新的计划。 |
| **Next Action** | 下一步动作 | The orchestrator's decision after each round: `execute`, `retry_task`, `repair_task`, `replan`, `request_human`, `finalize`. 编排器每轮后的决策：执行、重试、修复、重新规划、请求人工、完成。 |

## Budget & Scoring / 预算与评分

| English | 中文 | Definition |
|---------|------|------------|
| **Token Breakdown** | Token 明细 | Per-stage token usage tracking (`StageTokenUsage`) with actual cost vs. Claude equivalent cost and savings. 按阶段的 token 用量追踪，包含实际成本与 Claude 等价成本及节省金额。 |
| **Budget Status** | 预算状态 | Monthly spending tracking with `warn_at` threshold and `block` enforcement. 月度支出追踪，包含预警阈值和阻止执行的机制。 |
| **Score History** | 评分历史 | `RunScoreHistory` tracking per-round scores, signals, and deltas for long-term model performance analysis. 跟踪每轮评分、信号和增量的长期模型性能分析数据。 |

## Configuration / 配置

| English | 中文 | Definition |
|---------|------|------------|
| **TiersConfig** | 层级配置 | Per-tier model selection config: `translator`, `planner`, `discuss`, `executor`, `reviewer`, `reporter`. 每个层级的模型选择配置。 |
| **HiveConfig** | Hive 配置 | Top-level config combining legacy fields, budget, provider registry, tier config, and collaboration settings. 顶层配置，组合遗留字段、预算、供应商注册表、层级配置和协作设置。 |
| **Planning Brief** | 规划摘要 | Compact summary of a plan (`PlanningBrief`) shared to AgentBus rooms for cross-model discussion. 共享到 AgentBus 房间的计划精简摘要，用于跨模型讨论。 |
| **RunHook** | 运行钩子 | Lifecycle hooks (`beforePlan`, `afterPlan`, `afterExecution`, etc.) for customizing run behavior. 生命周期钩子，用于自定义运行行为。 |
