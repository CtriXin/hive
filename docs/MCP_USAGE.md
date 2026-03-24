# Hive MCP 使用指南

## 已配置位置

全局 MCP 配置在 `~/.claude.json` 的 `mcpServers.hive`，新 Claude Code session 自动加载。

```json
"hive": {
  "type": "stdio",
  "command": "/Users/xin/auto-skills/CtriXin-repo/hive/bin/mcp-server.sh",
  "args": [],
  "env": { "HOME": "/Users/xin" }
}
```

> **注意**：使用 shell wrapper（`bin/mcp-server.sh`）而非直接调 `node`，因为 wrapper 会自动 `source nvm.sh` 解析 node 路径。nvm 切版本不影响 MCP。

## 可用工具（7 个）

| 工具 | 说明 |
|------|------|
| `plan_tasks` | 拆解目标为可执行任务（支持中文输入，自动翻译） |
| `execute_plan` | 执行任务计划，自动分配模型 + review |
| `dispatch_single` | 单任务派发到指定模型 |
| `health_check` | 检查所有 provider 健康状态 |
| `model_scores` | 查看模型能力评分表 |
| `translate` | 中文 → 英文 prompt 翻译 |
| `report` | 生成中文编排结果报告 |

## 常用命令

```bash
# 重新编译（改了 TS 源码后必须执行）
cd /Users/xin/auto-skills/CtriXin-repo/hive && npm run build

# 结构 smoke test
cd /Users/xin/auto-skills/CtriXin-repo/hive && npm run test:smoke

# E2E smoke test（核心链路：模型选择、排名、provider、翻译）
cd /Users/xin/auto-skills/CtriXin-repo/hive && npx tsx scripts/smoke-e2e.ts

# Speed-stats 匹配验证（检查 mms 测速数据是否正确映射到 Hive 模型）
cd /Users/xin/auto-skills/CtriXin-repo/hive && npx tsx scripts/smoke-speed-match.ts
```

## 更新流程

1. 改 `hive/orchestrator/` 或 `hive/mcp-server/` 下的 TS 源码
2. 执行 `npm run build`
3. **新开 Claude Code session 即生效**（MCP 配置指向 dist/，不需要重新配）

## MCP 管理命令

```bash
# 查看当前 MCP 状态
claude mcp list

# 删除 hive MCP
# 需要手动编辑 ~/.claude.json，删除 mcpServers.hive

# 重新添加（如果路径变了）
# 同上，编辑 ~/.claude.json 修改 args 里的路径
```

## Gateway 模式（推荐）

所有模型调用统一走 mms 网关，不需要为每个 provider 配单独的 API key。

### 配置方式

`~/.hive/config.json`：
```json
{
  "gateway": {
    "url": "http://82.156.121.141:4001",
    "auth_token_env": "ANTHROPIC_AUTH_TOKEN"
  }
}
```

或通过环境变量：
```bash
export HIVE_GATEWAY_URL="http://82.156.121.141:4001"
export HIVE_GATEWAY_TOKEN="your-token"
```

### 工作原理

- Gateway 模式下，`resolveProvider()` 对所有 provider 返回网关地址 + token
- 模型路由由网关内部处理，Hive 只需传 `ANTHROPIC_MODEL` 即可
- 不再需要 `BAILIAN_API_KEY`、`DEEPSEEK_API_KEY` 等单独的 key
- `openai_only` 的 provider（如 deepseek）也能正常工作，不需要 protocol adapter

### 直连模式

不配 gateway 时自动回退到直连模式：每个 provider 从 `providers.json` 读端点，API key 从环境变量注入。

## Q&A

**Q: 改了代码要重新配 MCP 吗？**
A: 不需要。`npm run build` 后新 session 自动用最新的 `dist/`。

**Q: speed-stats 从哪来？**
A: mms 自动写入 `~/.config/mms/speed-stats.json`，Hive 自动读取并 fuzzy 匹配模型名（provider + 版本号 token）。mms 改名/加模型不需要手动同步。

**Q: 怎么加新模型？**
A: 只改 `hive/config/model-capabilities.json`，加 provider/scores/speed_tier。不需要改代码，不需要 build。

**Q: model-capabilities.json 改了要 build 吗？**
A: 不需要，JSON 是运行时读取的。只有改了 TS 代码才需要 build。

**Q: 为什么 smoke test 里 translate 失败？**
A: sandbox 环境 PATH 缺 node，Claude Code 子进程无法启动。实际 MCP 运行时正常。

**Q: plan_tasks 报 "Provider 'deepseek' only supports OpenAI protocol"？**
A: 没有配 gateway 模式。在 `~/.hive/config.json` 里加 `gateway` 字段，或设置 `HIVE_GATEWAY_URL` 环境变量。

**Q: 新 session 看不到 hive tools？**
A: 检查 `~/.claude.json` 是否有 `mcpServers.hive` 配置。确认 `dist/mcp-server/index.js` 存在。

## 关键文件

| 文件 | 说明 |
|------|------|
| `hive/mcp-server/index.ts` | MCP 入口，定义 7 个工具 |
| `hive/orchestrator/model-registry.ts` | 模型选择核心（排名、速度分级、翻译选择） |
| `hive/config/model-capabilities.json` | 模型能力评分表（运行时读取） |
| `hive/config/providers.json` | Provider 列表和连接信息 |
| `~/.config/mms/speed-stats.json` | mms 测速数据（Hive 只读） |
| `~/.hive/config.json` | Hive 全局配置（gateway、worker 等） |
| `~/.claude.json` | MCP 配置所在文件 |
