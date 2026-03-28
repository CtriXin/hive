// ═══════════════════════════════════════════════════════════════════
// orchestrator/protocol-adapter.ts — Anthropic ↔ OpenAI 协议翻译
// ═══════════════════════════════════════════════════════════════════
// 轻量级翻译层：Anthropic Messages API → OpenAI Chat Completions
// 不支持：反向翻译、Gemini、Responses API、SSE streaming（MVP）
// ═══════════════════════════════════════════════════════════════════

import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AdaptedRequest } from './types.js';
import { resolveProjectPath } from './project-paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 类型定义 ──

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: any;
    content?: any;
    tool_use_id?: string;
  }>;
}

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

// ── 消息格式转换：Anthropic → OpenAI ──

export function convertMessages(anthropicMessages: AnthropicMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of anthropicMessages) {
    // 简单情况：string content
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // 复杂情况：array content — 可能包含 text + tool_use + tool_result
    const textParts: string[] = [];
    const toolCalls: OpenAIMessage['tool_calls'] = [];

    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id!,
          type: 'function',
          function: { name: block.name!, arguments: JSON.stringify(block.input || {}) },
        });
      } else if (block.type === 'tool_result') {
        // tool_result → 独立的 tool 角色消息
        result.push({
          role: 'tool',
          content: typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content),
          tool_call_id: block.tool_use_id as string,
        });
        continue;
      }
    }

    if (textParts.length > 0 || toolCalls.length > 0) {
      const openaiMsg: OpenAIMessage = { role: msg.role };
      if (textParts.length > 0) {
        openaiMsg.content = textParts.join('\n');
      }
      if (toolCalls.length > 0) {
        openaiMsg.tool_calls = toolCalls;
      }
      result.push(openaiMsg);
    }
  }

  return result;
}

// ── 工具格式转换：Anthropic tools → OpenAI functions ──

export function convertTools(anthropicTools: any[]): any[] {
  return anthropicTools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || {},
    },
  }));
}

// ── 完整请求翻译：Anthropic body → OpenAI request ──

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

  // System prompt 处理
  if (anthropicBody.system) {
    const systemContent = typeof anthropicBody.system === 'string'
      ? anthropicBody.system
      : (anthropicBody.system as any[]).map((s: any) => s.text).join('\n');
    openaiBody.messages.unshift({
      role: 'system',
      content: systemContent,
    });
  }

  // Tools 处理
  if (anthropicBody.tools?.length > 0) {
    openaiBody.tools = convertTools(anthropicBody.tools);
  }

  return {
    url: `${openaiBaseUrl}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'x-api-key': apiKey,
    },
    body: JSON.stringify(openaiBody),
  };
}

// ── 响应格式转换：OpenAI → Anthropic ──

export function convertResponseToAnthropic(openaiResponse: any): any {
  const choice = openaiResponse.choices?.[0];
  if (!choice) {
    return {
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const content: any[] = [];

  // 文本内容
  if (choice.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }

  // Tool calls 转换
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

  // 映射 finish_reason
  const stopReason = choice.finish_reason === 'tool_calls'
    ? 'tool_use'
    : choice.finish_reason === 'stop'
    ? 'end_turn'
    : choice.finish_reason || 'end_turn';

  return {
    content,
    model: openaiResponse.model,
    stop_reason: stopReason,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
    },
  };
}

// ── HTTP Adapter Server ──
// 用于需要协议转换的 provider
// 启动方式：node protocol-adapter.js --provider kimi --port 8901

export function startAdapterServer(
  openaiBaseUrl: string,
  apiKey: string,
  port: number = 8901,
): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

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
      res.end(JSON.stringify({ error: err.message, stack: err.stack }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.error(`Protocol adapter running on http://127.0.0.1:${port}`);
    console.error(`Translating Anthropic → OpenAI → ${openaiBaseUrl}`);
  });

  return server;
}

// ── CLI Entry Point ──
// 当直接运行时：node protocol-adapter.js --provider <id> --port <port>

if (typeof process !== 'undefined' && process.argv?.[1]?.includes('protocol-adapter')) {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 8901;
  const providerIdx = args.indexOf('--provider');
  const providerId = providerIdx >= 0 ? args[providerIdx + 1] : 'kimi';

  // 动态 import 避免循环依赖
  import('fs').then(fs => {
    import('path').then(pathMod => {
      const configPath = resolveProjectPath('config', 'providers.json');
      let config: any;
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (e) {
        console.error(`Failed to read providers.json: ${e}`);
        process.exit(1);
      }

      const provider = config.providers?.[providerId];
      if (!provider?.openai_base_url) {
        console.error(`Provider "${providerId}" not found or missing openai_base_url`);
        console.error(`Available providers: ${Object.keys(config.providers || {}).join(', ')}`);
        process.exit(1);
      }

      const apiKey = process.env[provider.api_key_env] || '';
      if (!apiKey) {
        console.error(`⚠️ API key not set: export ${provider.api_key_env}="your-key"`);
      }

      startAdapterServer(provider.openai_base_url, apiKey, port);
    });
  }).catch(err => {
    console.error(`Failed to start adapter: ${err}`);
    process.exit(1);
  });
}
