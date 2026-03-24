# TASK E: DevOps + Config + Rules — MiniMax 2.7

> 你是 CLI2CLI 项目的实现者。你负责所有配置、规则、状态管理、Git worktree、和测试脚本。
> **本项目完全自包含。** 你需要创建自包含的 provider 配置和内化的 agent-rules。

## 你的职责

创建以下文件（共 16 个）：

### Config（4 个）
1. `config/model-capabilities.json` — 模型能力表
2. `config/review-policy.json` — review 策略
3. `config/a2a-lens-config.json` — a2a lens 配置
4. `config/providers.json` — **NEW**: 自包含 provider 注册表

### Orchestrator（1 个）
5. `orchestrator/worktree-manager.ts` — Git worktree 管理

### Scripts（3 个）
6. `scripts/smoke-test.sh` — 完整测试套件
7. `scripts/test-bridge-health.sh` — provider 连通性测试
8. `scripts/test-worker-spawn.sh` — worker 启动测试

### Rules（6 个，从 agent-rules 内化并适配）
9. `rules/AGENT_RULES.md` — 合并版规则
10. `rules/planning.md` — Tier 1 规划约束
11. `rules/execution.md` — Tier 3 执行约束
12. `rules/review.md` — Tier 2 review 约束
13. `rules/handoff.md` — 多模型交接
14. `rules/code-quality.md` — 代码红线

### State（1 个）+ Project Rules（1 个）
15. `CLAUDE.md` — 项目级规则入口
16. `.ai/manifest.json` — 项目状态

## 项目根目录

`/Users/xin/auto-skills/CtriXin-repo/cli2cli`

先阅读 `CLI_BRIDGE_IMPLEMENTATION_PLAN.md`、`SELF_CONTAINED_ADDENDUM.md`。
规则参考源：`/Users/xin/auto-skills/CtriXin-repo/agent-rules/AGENT_RULES.md`（复制内化，不运行时依赖）。

---

## 文件 1-3: Config（同 Plan §5.1-5.3）

按 Plan 原样创建，数值不变。

## 文件 4: `config/providers.json` ⭐ 新文件

自包含 provider 注册表，替代 MMS 的 credentials.sh + adapter_registry.py。

```json
{
  "_doc": "CLI2CLI self-contained provider registry. API keys via env vars, not stored here.",
  "providers": {
    "bailian-codingplan": {
      "id": "bailian-codingplan",
      "display_name": "百炼 CodingPlan",
      "anthropic_base_url": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
      "openai_base_url": "https://coding.dashscope.aliyuncs.com/v1",
      "api_key_env": "BAILIAN_API_KEY",
      "protocol": "both",
      "note": "阿里百炼 CodingPlan，sk-sp-* key，同时支持 Anthropic 和 OpenAI"
    },
    "qwen": {
      "id": "qwen",
      "display_name": "Qwen",
      "anthropic_base_url": "https://dashscope.aliyuncs.com/apps/anthropic",
      "openai_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "api_key_env": "QWEN_API_KEY",
      "protocol": "both",
      "note": "通义千问标准端点"
    },
    "kimi": {
      "id": "kimi",
      "display_name": "Kimi",
      "anthropic_base_url": "https://api.moonshot.ai/anthropic/",
      "openai_base_url": "https://api.moonshot.cn/v1",
      "api_key_env": "KIMI_API_KEY",
      "protocol": "both",
      "note": "Moonshot Kimi"
    },
    "kimi-codingplan": {
      "id": "kimi-codingplan",
      "display_name": "Kimi CodingPlan",
      "anthropic_base_url": "https://api.kimi.com/coding/",
      "openai_base_url": "https://api.kimi.com/coding/v1",
      "api_key_env": "KIMI_CODING_API_KEY",
      "protocol": "both",
      "note": "Kimi CodingPlan 套餐 (sk-kimi-*)"
    },
    "glm-cn": {
      "id": "glm-cn",
      "display_name": "GLM CN (BigModel)",
      "anthropic_base_url": "https://open.bigmodel.cn/api/anthropic",
      "openai_base_url": "https://open.bigmodel.cn/api/paas/v4/",
      "api_key_env": "GLM_CN_API_KEY",
      "protocol": "both",
      "note": "智谱 BigModel"
    },
    "glm-en": {
      "id": "glm-en",
      "display_name": "GLM EN (Z.ai)",
      "anthropic_base_url": "https://api.z.ai/api/anthropic",
      "openai_base_url": "https://api.z.ai/api/paas/v4/",
      "api_key_env": "GLM_EN_API_KEY",
      "protocol": "both",
      "note": "Z.ai 国际站"
    },
    "minimax-cn": {
      "id": "minimax-cn",
      "display_name": "MiniMax CN",
      "anthropic_base_url": "https://api.minimaxi.com/anthropic",
      "openai_base_url": "https://api.minimaxi.com/v1",
      "api_key_env": "MINIMAX_CN_API_KEY",
      "protocol": "both",
      "note": "MiniMax 国内"
    },
    "minimax-en": {
      "id": "minimax-en",
      "display_name": "MiniMax EN",
      "anthropic_base_url": "https://api.minimax.io/anthropic",
      "openai_base_url": "https://api.minimax.io/v1",
      "api_key_env": "MINIMAX_EN_API_KEY",
      "protocol": "both",
      "note": "MiniMax 国际"
    },
    "deepseek": {
      "id": "deepseek",
      "display_name": "DeepSeek",
      "openai_base_url": "https://api.deepseek.com/v1",
      "api_key_env": "DEEPSEEK_API_KEY",
      "protocol": "openai_only",
      "note": "仅 OpenAI 协议，需要 protocol-adapter"
    }
  }
}
```

---

## 文件 5: `orchestrator/worktree-manager.ts`

和 Plan §4.3 一致，7 个导出函数。不变。

---

## 文件 6-8: Scripts

### `scripts/smoke-test.sh`

基于 Plan §6.1，**修改以下测试**：
- Phase 2 测试改为 `provider-resolver`（不是 mms-bridge-resolver）
- Phase 7 改为测试 `discuss-bridge`（不是外部 discuss.sh）
- 新增 Phase 9: Rules 文件存在性检查
- 新增 Phase 10: providers.json 完整性检查
- 移除所有外部路径引用

新增测试段：
```bash
# ── Phase 9: Rules ──
echo "Phase 9: Rules"
check "AGENT_RULES.md exists" "test -f rules/AGENT_RULES.md && echo ok" "ok"
check "planning.md exists" "test -f rules/planning.md && echo ok" "ok"
check "execution.md exists" "test -f rules/execution.md && echo ok" "ok"
check "review.md exists" "test -f rules/review.md && echo ok" "ok"
check "CLAUDE.md exists" "test -f CLAUDE.md && echo ok" "ok"
echo ""

# ── Phase 10: Provider Config ──
echo "Phase 10: Provider Config"
check "providers.json exists" "test -f config/providers.json && echo ok" "ok"
check "providers.json has 9 providers" "node -e 'const c=JSON.parse(require(\"fs\").readFileSync(\"config/providers.json\",\"utf-8\")); console.log(Object.keys(c.providers).length >= 9 ? \"ok\" : \"too few\")'" "ok"
```

### `scripts/test-bridge-health.sh`

修改为从 `config/providers.json` 读取 URL（不硬编码）：
```bash
# 从 providers.json 动态读取
URL=$(node -e "const c=JSON.parse(require('fs').readFileSync('config/providers.json','utf-8')); const p=c.providers['$PROVIDER']; console.log(p?.anthropic_base_url || p?.openai_base_url || '')")
```

### `scripts/test-worker-spawn.sh`

`import` 路径改为 `./dist/orchestrator/dispatcher.js`（不变），但移除外部路径引用。

---

## 文件 9-14: Rules（从 agent-rules 内化）

从 `/Users/xin/auto-skills/CtriXin-repo/agent-rules/` 复制并**适配为 CLI2CLI 的 4 阶段约束**。

### `rules/AGENT_RULES.md`

从 `agent-rules/AGENT_RULES.md` 复制，做以下适配：
- 标题改为 `CLI2CLI Agent Collaboration Rules`
- 删除不相关的段落（如 TODO 四象限的详细格式、Lessons Learned）
- §12 Responsibility Chain 改为 CLI2CLI 的 4 Tier 描述
- §13 Cross-Agent Review 改为引用 `a2a-bridge.ts` 的内置逻辑
- 添加 CLI2CLI 特有的规则：
  - Provider 配置必须通过 `config/providers.json`
  - 不允许硬编码外部路径
  - worker 不确定时必须写 `[DISCUSS_TRIGGER]`

### `rules/planning.md` — Tier 1 约束

```markdown
# Planning Phase Rules (Tier 1)

> Applies to: Claude Opus running planner.ts

## 5-Dimension Preflight
Every plan must pass before execution:
1. Writable — target files exist and are modifiable
2. Dependencies — all prerequisites met
3. Rollback — can revert if it fails
4. Verification — explicit pass/fail criteria
5. Scope — no scope creep

## Task Decomposition Rules
- Each sub-task must be self-contained (executable without additional context)
- Max 10 tasks per plan
- Security-critical tasks: complexity = "high" → handled by Opus
- Different files → parallel tasks
- Same file → sequential with context flow

## Model Assignment Rules
- Use ModelRegistry.assignModel() — don't manually pick
- Check model avoid list before assignment
- When pass_rate < 0.50 → avoid assigning complex tasks
```

### `rules/execution.md` — Tier 3 约束

```markdown
# Execution Phase Rules (Tier 3)

> Applies to: Domestic models running as workers via dispatcher.ts

## Code Red Lines
| Metric | Limit |
|--------|-------|
| File lines | ≤ 800 |
| Function lines | ≤ 30 |
| Nesting depth | ≤ 3 |
| Function params | ≤ 5 |

Violation: split/extract. Exception: add `// REDLINE_EXCEPTION: {reason}`

## Security Prohibitions
- No eval() / new Function()
- No innerHTML =
- No hardcoded secrets
- No unencapsulated process.env (use config)

## Uncertainty Protocol
When confidence drops below discuss_threshold:
1. Create .ai/discuss-trigger.json
2. Output [DISCUSS_TRIGGER]
3. STOP and wait for discussion result

## Error Handling
- Attempt 1: chain-of-thought fix
- Attempt 2: provide 3 alternatives with pros/cons
- Never retry same error > 2 times
```

### `rules/review.md` — Tier 2 约束

```markdown
# Review Phase Rules (Tier 2)

> Applies to: reviewer.ts, a2a-bridge.ts, discuss-bridge.ts

## Cross-Review (Stage 1)
- Reviewer must be DIFFERENT vendor than worker
- Confidence >= 0.85 + low complexity → can skip a2a

## a2a 3-Lens (Stage 2)
- Lenses run IN PARALLEL (must not see each other's output)
- Scale determines lens count: light=1, medium=2, heavy+=3
- Max 10 findings per lens, 300 chars per finding
- Output must be valid JSON

## Verdict Rules
- No findings → PASS
- No RED → PASS
- RED but lenses disagree → CONTESTED → Stage 3
- Multiple RED on same file → REJECT → send back to worker

## Sonnet Arbitration (Stage 3)
- Only receives RED findings + cross-review flags (not full diff)
- Decisions: ACCEPT / DISMISS / FLAG
- If fix needed → one worker retry → one Sonnet recheck

## Opus Final (Stage 4)
- Triggered only when Sonnet cannot resolve (~2%)
- Receives full diff + all prior review context
```

### `rules/handoff.md` — 模型交接

```markdown
# Multi-Model Handoff Protocol

> Applies to: all tier transitions and model switches

## Breakpoint Recording
When switching models mid-task, record in .ai/plan/current.md:
- Step completed: N of M
- Current state: what's done, what's pending
- Files modified: list
- Blockers: if any
- Next action: exact next step

## Ownership
- Each task has ONE owner at a time
- Don't silently take over another model's work
- Record who did what in context_flow

## Context Transfer
- Use context-recycler.ts for worker→worker handoff
- Keep context packets < 500 words
- Include: summary, key_outputs, decisions_made
```

### `rules/code-quality.md` — 代码质量

```markdown
# Code Quality Standards

## TypeScript Specific
- Strict mode: all files must compile with strict: true
- No any unless absolutely necessary (mark with // ANY_EXCEPTION: reason)
- All exported functions must have return types
- Use type imports: import type { ... } from ...

## Error Handling
- All async functions must have try-catch or propagate errors
- JSON.parse must be wrapped in try-catch
- External calls (fetch, execSync) must have timeouts
- Never swallow errors silently

## Naming
- Files: kebab-case (model-registry.ts)
- Classes: PascalCase (ModelRegistry)
- Functions: camelCase (assignModel)
- Constants: UPPER_SNAKE (SCORE_CEILING)
- Types/Interfaces: PascalCase (WorkerConfig)
```

---

## 文件 15: `CLAUDE.md`

项目级规则入口：

```markdown
# CLI2CLI Project Rules

> Multi-model orchestration system. Read this before doing anything.

## Architecture
- 4-Tier cascade: Translate → Plan → Execute → Review → Report
- Self-contained: no external runtime dependencies
- Config-driven: all provider URLs in config/providers.json

## Quick Start
1. Read `.ai/manifest.json` for project state
2. Read `.ai/plan/current.md` for current task
3. Read `rules/AGENT_RULES.md` for collaboration rules

## Rules
- All rules in `rules/` directory
- Code quality: `rules/code-quality.md`
- Planning: `rules/planning.md`
- Execution: `rules/execution.md`
- Review: `rules/review.md`
- Handoff: `rules/handoff.md`

## Key Constraints
- No hardcoded external paths (must use config)
- API keys via env vars only (never in code/config files)
- All workers run in isolated git worktrees
- Worker uncertainty → [DISCUSS_TRIGGER] → cross-model discussion
- Review cascade: cross-review → a2a → Sonnet → Opus
```

---

## 文件 16: `.ai/manifest.json`

```json
{
  "project": "cli2cli",
  "version": "2.0.0",
  "status": "implementing",
  "architecture": "4-tier-cascade",
  "tiers": {
    "0": { "name": "Translator", "module": "translator.ts", "role": "Chinese → English" },
    "1": { "name": "Planner", "module": "planner.ts", "role": "Task decomposition + model assignment" },
    "2": { "name": "Reviewer", "module": "reviewer.ts", "role": "4-stage review cascade" },
    "3": { "name": "Executor", "module": "dispatcher.ts", "role": "Worker spawning + management" }
  },
  "self_contained": true,
  "external_dependencies": "none",
  "last_updated": "2026-03-24",
  "updated_by": "minimax-2.7"
}
```

---

## 文件 17: `config/mcp-registration.json`

供用户复制到 `~/.claude/settings.json` 的 MCP 注册模板：

```json
{
  "_doc": "复制 mcpServers 段到 ~/.claude/settings.json 完成注册",
  "mcpServers": {
    "cli2cli": {
      "command": "node",
      "args": ["REPLACE_WITH_ABSOLUTE_PATH/cli2cli/dist/mcp-server/index.js"],
      "env": {
        "BAILIAN_API_KEY": "",
        "KIMI_CODING_API_KEY": "",
        "GLM_CN_API_KEY": "",
        "MINIMAX_CN_API_KEY": "",
        "DEEPSEEK_API_KEY": "",
        "QWEN_API_KEY": "",
        "KIMI_API_KEY": "",
        "GLM_EN_API_KEY": "",
        "MINIMAX_EN_API_KEY": ""
      }
    }
  }
}
```

## 文件 18: `scripts/setup-mcp.sh`

一键注册 MCP 的脚本：

```bash
#!/bin/bash
# CLI2CLI MCP Registration Helper
# Usage: bash scripts/setup-mcp.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MCP_SERVER="$PROJECT_DIR/dist/mcp-server/index.js"
SETTINGS_FILE="$HOME/.claude/settings.json"

echo "═══════════════════════════════════════"
echo "  CLI2CLI MCP Setup"
echo "═══════════════════════════════════════"
echo ""

# 1. Check build
if [ ! -f "$MCP_SERVER" ]; then
    echo "❌ MCP server not built. Run: npm run build"
    exit 1
fi
echo "✅ MCP server found: $MCP_SERVER"

# 2. Check settings file
if [ ! -f "$SETTINGS_FILE" ]; then
    mkdir -p "$(dirname "$SETTINGS_FILE")"
    echo '{}' > "$SETTINGS_FILE"
    echo "📝 Created $SETTINGS_FILE"
fi

# 3. Check if already registered
if grep -q "cli2cli" "$SETTINGS_FILE" 2>/dev/null; then
    echo "⚠️  cli2cli already in settings.json. Remove it first if you want to re-register."
    echo ""
    echo "Current registration:"
    node -e "const s=JSON.parse(require('fs').readFileSync('$SETTINGS_FILE','utf-8')); console.log(JSON.stringify(s.mcpServers?.['cli2cli']||'not found',null,2))"
    exit 0
fi

# 4. Prompt for API keys
echo ""
echo "Enter API keys (leave blank to skip, you can set env vars later):"
echo ""

read -p "  BAILIAN_API_KEY (sk-sp-*): " BAILIAN_KEY
read -p "  KIMI_CODING_API_KEY (sk-kimi-*): " KIMI_KEY
read -p "  GLM_CN_API_KEY: " GLM_KEY
read -p "  MINIMAX_CN_API_KEY: " MINIMAX_KEY
read -p "  DEEPSEEK_API_KEY: " DEEPSEEK_KEY

# 5. Register
node -e "
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf-8'));
if (!settings.mcpServers) settings.mcpServers = {};
settings.mcpServers['cli2cli'] = {
  command: 'node',
  args: ['$MCP_SERVER'],
  env: {
    BAILIAN_API_KEY: '${BAILIAN_KEY}',
    KIMI_CODING_API_KEY: '${KIMI_KEY}',
    GLM_CN_API_KEY: '${GLM_KEY}',
    MINIMAX_CN_API_KEY: '${MINIMAX_KEY}',
    DEEPSEEK_API_KEY: '${DEEPSEEK_KEY}',
  }
};
fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2));
console.log('✅ Registered cli2cli in ' + '$SETTINGS_FILE');
"

echo ""
echo "═══════════════════════════════════════"
echo "  Done! Restart Claude to load CLI2CLI."
echo ""
echo "  Available tools:"
echo "    - translate    (中→英翻译)"
echo "    - plan_tasks   (任务规划)"
echo "    - execute_plan (执行计划)"
echo "    - dispatch_single (单任务调度)"
echo "    - health_check (检查 provider)"
echo "    - model_scores (查看模型评分)"
echo "    - report       (生成中文报告)"
echo "═══════════════════════════════════════"
```

---

## 执行步骤

1. `mkdir -p config scripts orchestrator rules .ai/plan`
2. 先写 4 个 config JSON + `config/mcp-registration.json`（被其他模块依赖）
3. 写 `worktree-manager.ts`
4. 写 6 个 rules 文件
5. 写 `CLAUDE.md` + `.ai/manifest.json`
6. 写 3 个 shell 脚本 + `scripts/setup-mcp.sh`（`chmod +x scripts/*.sh`）
7. `npx tsc --noEmit` 检查 worktree-manager.ts

## 验证标准

- [ ] `providers.json` 包含 9 个 provider，每个有 `api_key_env`（不存储实际 key）
- [ ] `model-capabilities.json` 5 模型 + 3 Claude 层级（数值不变）
- [ ] `rules/` 有 6 个 .md 文件
- [ ] `rules/execution.md` 包含代码红线和 [DISCUSS_TRIGGER] 协议
- [ ] `rules/review.md` 包含完整的 4 阶段 verdict 规则
- [ ] `CLAUDE.md` 存在且引用 rules/ 下的文件
- [ ] `.ai/manifest.json` 存在
- [ ] `smoke-test.sh` 有 10 个测试阶段（原 8 + Rules + Provider Config）
- [ ] 所有文件无外部路径硬编码（除了 agent-rules 源文件作为内化参考）
- [ ] 所有 shell 脚本有执行权限

## 禁止事项

- providers.json 不存储 API key（只存环境变量名）
- rules 文件从 agent-rules 内化，但不要运行时依赖它
- smoke-test.sh 不引用任何外部路径（不再测 discuss.sh 或 a2a SKILL.md）
- 不要创建其他人负责的文件
