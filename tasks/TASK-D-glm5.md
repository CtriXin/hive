# TASK D: Infrastructure — GLM5 Turbo

> 你是 CLI2CLI 项目的实现者。你负责 4 个基础设施模块。
> **本项目完全自包含，不依赖 MMS 运行时。**
> provider-resolver 替代原来的 mms-bridge-resolver，自带 provider 配置。
> protocol-adapter 替代 MMS 的 ccs_bridge.py，做轻量协议翻译。

## 你的职责

创建以下文件（共 4 个）：

1. `orchestrator/model-registry.ts` — 模型能力表 + 评分 + 分配
2. `orchestrator/provider-resolver.ts` — **RENAMED**: 自包含 provider 解析
3. `orchestrator/protocol-adapter.ts` — **NEW**: 轻量 Anthropic ↔ OpenAI 翻译
4. `orchestrator/context-recycler.ts` — worker 间上下文传递

## 项目根目录

`/Users/xin/auto-skills/CtriXin-repo/cli2cli`

先阅读 `CLI_BRIDGE_IMPLEMENTATION_PLAN.md` 和 `SELF_CONTAINED_ADDENDUM.md`。

## 依赖说明

- `./types` — 接口（TASK-A），包括新增的 `ProviderEntry`, `ProvidersConfig`, `AdaptedRequest`
- `./worktree-manager` — `getWorktreeDiff`（TASK-E）

---

## 文件 1: `orchestrator/model-registry.ts`

和 Plan §4.1 完全一致，不变。参考 Plan 完整实现。

核心：`ModelRegistry` 类，10 个方法：
- `reload()`, `getAll()`, `get(id)`, `getClaudeTier(tier)`
- `assignModel(task)` — 评分算法分配模型
- `selectCrossReviewer(workerModelId)` — 不同 vendor
- `selectDiscussPartner(workerModelId)` — 高 reasoning
- `selectA2aLensModels(workerModelId)` — 3 lens 3 模型
- `updateScore(modelId, passed, iterations)` — EMA 动态评分
- `save()` — 持久化

评分算法、EMA、clamp 等全部按 Plan §4.1。

---

## 文件 2: `orchestrator/provider-resolver.ts` ⭐ 重写

替代原来的 `mms-bridge-resolver.ts`。**不再依赖 MMS 的 credentials.sh，改为自包含。**

```typescript
import fs from 'fs';
import path from 'path';
import { ProvidersConfig, ProviderEntry } from './types';
import { adaptAnthropicToOpenAI } from './protocol-adapter';

// 加载 config/providers.json（TASK-E 负责创建）
const PROVIDERS_PATH = path.resolve(__dirname, '../config/providers.json');

let providersCache: ProvidersConfig | null = null;

function loadProviders(): ProvidersConfig {
  if (!providersCache) {
    providersCache = JSON.parse(fs.readFileSync(PROVIDERS_PATH, 'utf-8'));
  }
  return providersCache!;
}

export function resolveProvider(providerId: string): { baseUrl: string; apiKey: string } {
  const config = loadProviders();
  const provider = config.providers[providerId];

  if (!provider) {
    const known = Object.keys(config.providers).join(', ');
    throw new Error(`Unknown provider: ${providerId}. Known: ${known}`);
  }

  // 读取 API key（从环境变量）
  const apiKey = process.env[provider.api_key_env] || '';
  if (!apiKey) {
    console.warn(`⚠️ API key not set: export ${provider.api_key_env}="your-key"`);
  }

  // 优先 Anthropic 端点（Claude Code SDK 说 Anthropic Messages API）
  if (provider.protocol === 'anthropic_native' || provider.protocol === 'both') {
    return { baseUrl: provider.anthropic_base_url!, apiKey };
  }

  // OpenAI-only provider → 需要 protocol-adapter
  // 返回 OpenAI base URL，dispatcher 在 env 注入时需要配合 protocol-adapter
  if (provider.protocol === 'openai_only') {
    // 对于 openai_only 的 provider，我们启动一个本地 adapter
    // 但 MVP 阶段先 throw 一个有用的错误
    return startLocalAdapter(provider);
  }

  throw new Error(`Provider ${providerId}: no usable endpoint configured`);
}

function startLocalAdapter(provider: ProviderEntry): { baseUrl: string; apiKey: string } {
  // 检查是否已有 adapter 在运行
  const adapterPort = process.env[`CLI2CLI_ADAPTER_PORT_${provider.id.toUpperCase().replace(/-/g, '_')}`];
  if (adapterPort) {
    return {
      baseUrl: `http://127.0.0.1:${adapterPort}`,
      apiKey: process.env[provider.api_key_env] || '',
    };
  }

  // MVP：提示用户手动启动 adapter
  throw new Error(
    `Provider "${provider.id}" only supports OpenAI protocol.\n` +
    `Start the protocol adapter first:\n` +
    `  CLI2CLI_ADAPTER_PORT_${provider.id.toUpperCase().replace(/-/g, '_')}=8901 ` +
    `node dist/orchestrator/protocol-adapter.js --provider ${provider.id} --port 8901\n` +
    `Or set the port env var if already running.`
  );
}

// Health check
export async function checkProviderHealth(providerId: string): Promise<boolean> {
  try {
    const { baseUrl, apiKey } = resolveProvider(providerId);
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'x-api-key': apiKey },
      signal: AbortSignal.timeout(5000),
    });
    // 任何非网络错误都说明 server 可达
    return response.status < 500;
  } catch {
    return false;
  }
}

// 刷新 provider 缓存
export function reloadProviders(): void {
  providersCache = null;
}
```

### 关键区别（vs 原 mms-bridge-resolver.ts）

| 旧 | 新 |
|----|-----|
| 硬编码 URL map | 从 `config/providers.json` 加载 |
| 读 `~/.config/mms/credentials.sh` | 读环境变量（`provider.api_key_env`） |
| `resolveProviderUrl` | `resolveProvider` |
| 依赖 MMS bridge 进程 | 自带 protocol-adapter |

---

## 文件 3: `orchestrator/protocol-adapter.ts` ⭐ 新文件

轻量级 Anthropic Messages API → OpenAI Chat Completions 翻译。
只取 MMS `ccs_bridge.py` 的核心能力，不做反向翻译、不支持 Gemini、不支持 Responses API。

```typescript
import http from 'http';
import { AdaptedRequest } from './types';

// ── Anthropic → OpenAI 消息格式转换 ──

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; id?: string; name?: string; input?: any }>;
}

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export function convertMessages(anthropicMessages: AnthropicMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Array content — may contain text + tool_use + tool_result
    const textParts: string[] = [];
    const toolCalls: OpenAIMessage['tool_calls'] = [];

    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id!,
          type: 'function',
          function: { name: block.name!, arguments: JSON.stringify(block.input) },
        });
      } else if (block.type === 'tool_result') {
        // tool_result → separate message with role=tool
        result.push({
          role: 'tool',
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          tool_call_id: block.tool_use_id as string,
        });
        continue;
      }
    }

    if (textParts.length > 0 || toolCalls.length > 0) {
      const openaiMsg: OpenAIMessage = { role: msg.role };
      if (textParts.length > 0) openaiMsg.content = textParts.join('\n');
      if (toolCalls.length > 0) openaiMsg.tool_calls = toolCalls;
      result.push(openaiMsg);
    }
  }

  return result;
}

// ── Anthropic tools → OpenAI functions ──

export function convertTools(anthropicTools: any[]): any[] {
  return anthropicTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || {},
    },
  }));
}

// ── 翻译完整请求 ──

export function adaptAnthropicToOpenAI(
  anthropicBody: any,
  openaiBaseUrl: string,
  apiKey: string,
): AdaptedRequest {
  const openaiBody: any = {
    model: anthropicBody.model,
    messages: convertMessages(anthropicBody.messages || []),
    max_tokens: anthropicBody.max_tokens,
    temperature: anthropicBody.temperature,
    stream: anthropicBody.stream || false,
  };

  // System prompt
  if (anthropicBody.system) {
    openaiBody.messages.unshift({
      role: 'system',
      content: typeof anthropicBody.system === 'string'
        ? anthropicBody.system
        : anthropicBody.system.map((s: any) => s.text).join('\n'),
    });
  }

  // Tools
  if (anthropicBody.tools?.length > 0) {
    openaiBody.tools = convertTools(anthropicBody.tools);
  }

  return {
    url: `${openaiBaseUrl}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(openaiBody),
  };
}

// ── OpenAI response → Anthropic response 格式 ──

export function convertResponseToAnthropic(openaiResponse: any): any {
  const choice = openaiResponse.choices?.[0];
  if (!choice) return { content: [{ type: 'text', text: '' }], stop_reason: 'end_turn' };

  const content: any[] = [];

  if (choice.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }

  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      });
    }
  }

  return {
    content,
    model: openaiResponse.model,
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
    },
  };
}

// ── 可选：本地 HTTP adapter server ──
// 用于 openai_only provider（如 DeepSeek）
// 启动方式：node protocol-adapter.js --provider deepseek --port 8901

export function startAdapterServer(
  openaiBaseUrl: string,
  apiKey: string,
  port: number = 8901,
): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const anthropicBody = JSON.parse(body);
      const adapted = adaptAnthropicToOpenAI(anthropicBody, openaiBaseUrl, apiKey);

      const response = await fetch(adapted.url, {
        method: 'POST',
        headers: adapted.headers,
        body: adapted.body,
      });

      const openaiResult = await response.json();
      const anthropicResult = convertResponseToAnthropic(openaiResult);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(anthropicResult));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.error(`Protocol adapter running on http://127.0.0.1:${port}`);
    console.error(`Translating Anthropic → OpenAI → ${openaiBaseUrl}`);
  });

  return server;
}

// CLI entry (when run directly)
if (process.argv[1]?.includes('protocol-adapter')) {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? parseInt(args[portIdx + 1]) : 8901;

  // 从 providers.json 读取 provider 配置
  const providerIdx = args.indexOf('--provider');
  const providerId = providerIdx >= 0 ? args[providerIdx + 1] : 'deepseek';

  import('fs').then(fs => {
    import('path').then(pathMod => {
      const config = JSON.parse(fs.readFileSync(
        pathMod.resolve(__dirname, '../config/providers.json'), 'utf-8'
      ));
      const provider = config.providers[providerId];
      if (!provider?.openai_base_url) {
        console.error(`Provider ${providerId} has no openai_base_url`);
        process.exit(1);
      }
      const apiKey = process.env[provider.api_key_env] || '';
      startAdapterServer(provider.openai_base_url, apiKey, port);
    });
  });
}
```

---

## 文件 4: `orchestrator/context-recycler.ts`

和 Plan §4.4 一致，不变。参考 Plan 完整实现。

import 变更：`./worktree-manager`（不变）。

---

## 执行步骤

1. 确认 `orchestrator/` 存在
2. 先写 `protocol-adapter.ts`（最独立）
3. 再写 `provider-resolver.ts`（依赖 protocol-adapter 的 type）
4. 写 `model-registry.ts`（按 Plan §4.1）
5. 写 `context-recycler.ts`（按 Plan §4.4）
6. `npx tsc --noEmit` 检查

## 验证标准

- [ ] `ModelRegistry` 包含 10 个方法
- [ ] `provider-resolver.ts` 从 `config/providers.json` 加载（不读 MMS credentials.sh）
- [ ] `provider-resolver.ts` 导出 `resolveProvider`（不是 `resolveProviderUrl`）
- [ ] `protocol-adapter.ts` 导出 `convertMessages`, `convertTools`, `adaptAnthropicToOpenAI`, `convertResponseToAnthropic`, `startAdapterServer`
- [ ] `protocol-adapter.ts` 支持 `tool_use` ↔ `tool_calls` 双向转换
- [ ] `protocol-adapter.ts` 可作为独立 HTTP server 运行
- [ ] 没有任何 `/Users/xin/...` 或 `~/.config/mms/` 路径
- [ ] API key 通过 `process.env[provider.api_key_env]` 读取

## 禁止事项

- 不要 import 外部项目路径
- 不要读 MMS 的 credentials.sh
- 不要创建其他人负责的文件
- protocol-adapter 不需要支持 SSE streaming（MVP 先做 non-streaming）
- protocol-adapter 不需要支持 Gemini 或 Responses API
