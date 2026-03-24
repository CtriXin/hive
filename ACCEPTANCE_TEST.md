# CLI2CLI 人工验收测试手册

> 按顺序执行，每步有明确的 ✅/❌ 判断标准。
> 预计总耗时：30-45 分钟。

---

## Phase 0: 环境确认（2 分钟）

```bash
cd /Users/xin/auto-skills/CtriXin-repo/cli2cli

# 检查 Node.js
node --version    # 期望: v20+ 或 v22+
npm --version     # 期望: 有输出即可
```

✅ Node.js >= 20 安装完毕

---

## Phase 1: 文件完整性检查（3 分钟）

一次性检查所有文件是否到位：

```bash
echo "=== Orchestrator ==="
for f in types.ts index.ts dispatcher.ts planner.ts reviewer.ts \
         a2a-bridge.ts discuss-bridge.ts model-registry.ts \
         provider-resolver.ts protocol-adapter.ts context-recycler.ts \
         worktree-manager.ts translator.ts reporter.ts; do
  [ -f "orchestrator/$f" ] && echo "  ✅ $f" || echo "  ❌ $f MISSING"
done

echo "=== MCP Server ==="
[ -f "mcp-server/index.ts" ] && echo "  ✅ index.ts" || echo "  ❌ index.ts MISSING"

echo "=== Config ==="
for f in model-capabilities.json review-policy.json a2a-lens-config.json providers.json mcp-registration.json; do
  [ -f "config/$f" ] && echo "  ✅ $f" || echo "  ❌ $f MISSING"
done

echo "=== Scripts ==="
for f in smoke-test.sh test-bridge-health.sh test-worker-spawn.sh setup-mcp.sh; do
  [ -f "scripts/$f" ] && echo "  ✅ $f" || echo "  ❌ $f MISSING"
done

echo "=== Rules ==="
for f in AGENT_RULES.md planning.md execution.md review.md handoff.md code-quality.md; do
  [ -f "rules/$f" ] && echo "  ✅ $f" || echo "  ❌ $f MISSING"
done

echo "=== Project Files ==="
[ -f "package.json" ] && echo "  ✅ package.json" || echo "  ❌ package.json MISSING"
[ -f "tsconfig.json" ] && echo "  ✅ tsconfig.json" || echo "  ❌ tsconfig.json MISSING"
[ -f "CLAUDE.md" ] && echo "  ✅ CLAUDE.md" || echo "  ❌ CLAUDE.md MISSING"
[ -f ".ai/manifest.json" ] && echo "  ✅ .ai/manifest.json" || echo "  ❌ .ai/manifest.json MISSING"
[ -x "bin/cli2cli" ] && echo "  ✅ bin/cli2cli (executable)" || echo "  ❌ bin/cli2cli MISSING or not executable"
```

✅ 期望：27 个 ✅，0 个 ❌

---

## Phase 2: 编译测试（3 分钟）

```bash
# 安装依赖
npm install

# 编译
npm run build

# 期望：无 error（warning 可以有）
echo $?   # 期望: 0
```

✅ `npm run build` 退出码 0，`dist/` 目录生成

如果有编译错误，记录哪些文件报错——这直接反映对应模型的 TypeScript 能力。

---

## Phase 3: 单元级验证（5 分钟）

### 3.1 Model Registry

```bash
node -e "
import('./dist/orchestrator/model-registry.js').then(m => {
  const r = new m.ModelRegistry();
  console.log('Models:', r.getAll().length);
  console.log('Assign medium task:', r.assignModel({complexity:'medium', category:'tests', estimated_files:['test.ts']}));
  console.log('Security task:', r.assignModel({complexity:'high', category:'security', estimated_files:[]}));
  console.log('Cross reviewer (not qwen):', r.selectCrossReviewer('qwen3.5-plus').id);
  console.log('Discuss partner:', r.selectDiscussPartner('qwen3.5-plus').id);
  console.log('A2a lens models:', JSON.stringify(Object.fromEntries(
    Object.entries(r.selectA2aLensModels('qwen3.5-plus')).map(([k,v]) => [k, v.id])
  )));
});
"
```

✅ 期望输出：
- Models: 5
- Security task: claude-opus
- Cross reviewer: 不是 qwen3.5-plus
- A2a lens models: 3 个不同 ID

### 3.2 Provider Resolver

```bash
node -e "
import('./dist/orchestrator/provider-resolver.js').then(m => {
  try {
    const r = m.resolveProvider('bailian-codingplan');
    console.log('Bailian URL:', r.baseUrl.includes('dashscope') ? '✅' : '❌');
  } catch(e) { console.log('Bailian:', e.message); }

  try {
    const r = m.resolveProvider('kimi-codingplan');
    console.log('Kimi URL:', r.baseUrl.includes('kimi') ? '✅' : '❌');
  } catch(e) { console.log('Kimi:', e.message); }

  try {
    m.resolveProvider('nonexistent');
    console.log('Unknown: ❌ should have thrown');
  } catch { console.log('Unknown provider throws: ✅'); }
});
"
```

✅ Bailian ✅, Kimi ✅, Unknown throws ✅

### 3.3 Protocol Adapter

```bash
node -e "
import('./dist/orchestrator/protocol-adapter.js').then(m => {
  // 测试消息转换
  const result = m.convertMessages([
    {role: 'user', content: 'hello'},
    {role: 'assistant', content: [{type: 'text', text: 'hi'}, {type: 'tool_use', id: 'tc1', name: 'read_file', input: {path: 'test.ts'}}]}
  ]);
  console.log('Messages converted:', result.length);
  console.log('Has tool_calls:', result.some(m => m.tool_calls?.length > 0) ? '✅' : '❌');

  // 测试工具转换
  const tools = m.convertTools([{name: 'read', description: 'Read file', input_schema: {type: 'object'}}]);
  console.log('Tools converted:', tools[0].type === 'function' ? '✅' : '❌');
});
"
```

✅ Messages converted >= 2, tool_calls ✅, Tools ✅

### 3.4 Worktree Manager

```bash
TMPDIR=$(mktemp -d)
git -C "$TMPDIR" init -q && git -C "$TMPDIR" commit --allow-empty -m "init" -q

node -e "
import('./dist/orchestrator/worktree-manager.js').then(m => {
  const p = m.createWorktree('$TMPDIR', 'test-wt');
  console.log('Created:', require('fs').existsSync(p) ? '✅' : '❌');
  console.log('Listed:', m.listWorktrees('$TMPDIR').length > 0 ? '✅' : '❌');
  m.removeWorktree('$TMPDIR', 'test-wt');
  console.log('Removed: ✅');
});
"

rm -rf "$TMPDIR"
```

✅ Created ✅, Listed ✅, Removed ✅

### 3.5 Context Recycler

```bash
node -e "
import('./dist/orchestrator/context-recycler.js').then(m => {
  const out = m.formatContextForWorker([{
    from_task: 'task-a',
    summary: 'Created user model',
    key_outputs: [{file: 'user.ts', purpose: 'User model', key_exports: ['User', 'createUser']}],
    decisions_made: ['Using UUID for IDs']
  }]);
  console.log('Has Context header:', out.includes('Context') ? '✅' : '❌');
  console.log('Has file info:', out.includes('user.ts') ? '✅' : '❌');
});
"
```

✅ 输出包含 Context 和 file 信息

---

## Phase 4: MCP Server 启动测试（3 分钟）

```bash
# 启动 MCP server（3 秒超时，正常会挂起等待 stdio）
timeout 3 node dist/mcp-server/index.js 2>&1; echo "Exit: $?"
```

✅ 期望：stderr 输出 `cli2cli MCP server running`，exit code 124（timeout 正常杀掉）

---

## Phase 5: Provider 连通性（5 分钟）

需要先设置 API key：

```bash
# 设置你的 key（替换为真实值）
export BAILIAN_API_KEY="sk-sp-xxx"
export KIMI_CODING_API_KEY="sk-kimi-xxx"
export GLM_CN_API_KEY="xxx"
export MINIMAX_CN_API_KEY="xxx"

# 逐个测试
bash scripts/test-bridge-health.sh bailian-codingplan
bash scripts/test-bridge-health.sh kimi-codingplan
bash scripts/test-bridge-health.sh glm-cn
bash scripts/test-bridge-health.sh minimax-cn
```

✅ 每个输出 `ok (HTTP xxx)`。401/403 = key 错但 server 可达，也算通过。

---

## Phase 6: 翻译器测试（3 分钟）

```bash
export KIMI_CODING_API_KEY="sk-kimi-xxx"  # 需要真实 key

node -e "
import('./dist/orchestrator/translator.js').then(async m => {
  // 测试中文翻译
  const r = await m.translateToEnglish('给这个项目加上用户认证，支持 OAuth 和邮箱登录', 'kimi-k2.5', 'kimi-codingplan');
  console.log('Original:', r.original);
  console.log('English:', r.english);
  console.log('Confidence:', r.confidence);
  console.log('Duration:', r.duration_ms + 'ms');
});
"
```

✅ 期望：`english` 字段包含合理的英文翻译（如 "authentication", "OAuth", "email login"）

```bash
# 测试英文 passthrough
node -e "
import('./dist/orchestrator/translator.js').then(async m => {
  const r = await m.translateToEnglish('Build a REST API with auth', 'kimi-k2.5', 'kimi-codingplan');
  console.log('Passthrough:', r.translator_model === 'passthrough' ? '✅' : '❌');
});
"
```

✅ 英文输入直接 passthrough，不调 LLM

---

## Phase 7: 完整 Smoke Test（5 分钟）

```bash
bash scripts/smoke-test.sh
```

✅ 期望：大部分 PASS，0 FAIL（可以有 SKIP）

---

## Phase 8: MCP 注册（3 分钟）

```bash
bash scripts/setup-mcp.sh
```

按提示输入 API key。完成后验证：

```bash
cat ~/.claude/settings.json | node -e "
const s=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
console.log('cli2cli registered:', s.mcpServers?.['cli2cli'] ? '✅' : '❌');
console.log('Server path:', s.mcpServers?.['cli2cli']?.args?.[0]);
"
```

✅ cli2cli registered ✅

---

## Phase 9: 端到端真实测试（10 分钟）

**这是最终验收。** 重启 Claude，用中文下达一个真实编码任务。

```bash
# 重启 Claude（加载新的 MCP）
claude

# 在 Claude 中输入：
```

### 测试 1: Health Check

```
帮我检查一下 CLI2CLI 所有 provider 的连通性
```

Claude 应该调用 `health_check` tool，返回每个 provider 的状态。

✅ 看到 provider 列表 + ✅/❌ 状态

### 测试 2: 翻译

```
帮我把这段话翻译成英文：给这个项目加一个 WebSocket 实时通知系统，支持断线重连
```

Claude 应该调用 `translate` tool。

✅ 返回合理的英文翻译

### 测试 3: 模型评分

```
看一下现在各个模型的能力评分
```

Claude 应该调用 `model_scores` tool，返回表格。

✅ 看到 5 个模型的 coding/reasoning/pass_rate 等评分

### 测试 4: 单任务调度（真正的 E2E）

```
用 qwen3.5-plus 在 /tmp/cli2cli-test 创建一个 hello world 的 Express 服务器
```

Claude 应该调用 `dispatch_single` tool：
1. 创建 worktree
2. Spawn worker（通过百炼 API 调 Qwen-3.5）
3. Worker 创建文件
4. 可选：运行 review

✅ 看到 worker 执行日志 + 创建的文件列表

### 测试 5: 完整 Plan + Execute（终极测试）

```
在 /tmp/cli2cli-e2e 给我创建一个简单的 TODO API，要有增删改查，用 TypeScript + Express
```

Claude 应该：
1. 调用 `plan_tasks` → 自己生成任务拆解
2. 展示 plan 给你确认
3. 调用 `execute_plan` → 多个国产模型并行执行
4. Review cascade 运行
5. 调用 `report` → 中文报告

✅ 看到：
- 任务拆解（多个 sub-task，分配给不同模型）
- Worker 执行日志
- Review 结果（PASS/FAIL + findings 数量）
- 中文报告（任务概览 + 执行情况 + 成本估算）

---

## 验收评分卡

| Phase | 测试项 | 通过标准 | 结果 |
|-------|--------|---------|------|
| 1 | 文件完整性 | 27/27 文件到位 | ☐ |
| 2 | 编译 | `npm run build` 零 error | ☐ |
| 3.1 | Model Registry | 5 个方法返回正确 | ☐ |
| 3.2 | Provider Resolver | 3 个测试全 ✅ | ☐ |
| 3.3 | Protocol Adapter | 消息+工具转换正确 | ☐ |
| 3.4 | Worktree Manager | 创建/列出/删除正确 | ☐ |
| 3.5 | Context Recycler | 输出格式正确 | ☐ |
| 4 | MCP Server | 启动输出正确 | ☐ |
| 5 | Provider 连通性 | 至少 2 个 provider 可达 | ☐ |
| 6 | 翻译器 | 中文翻译 + 英文 passthrough | ☐ |
| 7 | Smoke Test | 0 FAIL | ☐ |
| 8 | MCP 注册 | settings.json 写入成功 | ☐ |
| 9.1 | Health Check | MCP tool 返回结果 | ☐ |
| 9.2 | 翻译 | MCP tool 返回翻译 | ☐ |
| 9.3 | 模型评分 | MCP tool 返回表格 | ☐ |
| 9.4 | 单任务调度 | Worker 创建文件 | ☐ |
| 9.5 | 完整 E2E | Plan → Execute → Review → Report | ☐ |

**及格线**：Phase 1-8 全通过（基础功能完整）
**满分线**：Phase 9 全通过（端到端流程跑通）

---

## 出问题时的排查

| 症状 | 可能原因 | 排查命令 |
|------|---------|---------|
| 编译失败 | 类型不匹配 | `npx tsc --noEmit 2>&1 | head -20` |
| Provider 不可达 | API key 未设置 | `echo $BAILIAN_API_KEY` |
| Worker 无输出 | Claude Code SDK 版本 | `npm ls @anthropic-ai/claude-code` |
| MCP tool 不显示 | settings.json 路径错 | `cat ~/.claude/settings.json` |
| 翻译返回空 | Provider 超时 | 检查网络 + API key |
| Review 全 FAIL | 模型能力不足 | 换个模型重试 |

---

## 各模型表现记录（测试后填写）

| 模型 | 负责文件 | 编译通过? | 功能正确? | 代码质量 | 备注 |
|------|---------|----------|----------|---------|------|
| Codex | types.ts + pkg + tsconfig | ☐ | ☐ | /5 | |
| Qwen-3.5 | dispatcher + index + cli | ☐ | ☐ | /5 | |
| Kimi-Coding | reviewer + a2a + discuss | ☐ | ☐ | /5 | |
| Qwen-Max | planner + MCP + translator + reporter | ☐ | ☐ | /5 | |
| GLM5-Turbo | registry + resolver + adapter + recycler | ☐ | ☐ | /5 | |
| MiniMax-2.7 | configs + rules + scripts | ☐ | ☐ | /5 | |
