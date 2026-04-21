// orchestrator/openai-bridge.ts — Shared Anthropic ↔ OpenAI bridge helpers

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    content?: unknown;
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

export interface AdaptedOpenAIRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export function resolveOpenAIChatTargetUrl(baseUrl: string): string {
  const normalizedBase = baseUrl.replace(/\/$/, '');
  const url = new URL(normalizedBase);
  const normalizedPath = '/v1/chat/completions';
  const basePath = url.pathname.replace(/\/$/, '');

  let finalPath = normalizedPath;
  if (basePath && basePath !== '/') {
    finalPath = basePath.endsWith('/v1') && normalizedPath.startsWith('/v1/')
      ? `${basePath}${normalizedPath.slice(3)}`
      : `${basePath}${normalizedPath}`;
  }

  url.pathname = finalPath;
  url.search = '';
  return url.toString();
}

export function convertMessages(anthropicMessages: AnthropicMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

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
        result.push({
          role: 'tool',
          content: typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content),
          tool_call_id: block.tool_use_id as string,
        });
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

export function convertTools(anthropicTools: any[]): any[] {
  return anthropicTools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || {},
    },
  }));
}

export function adaptAnthropicToOpenAI(
  anthropicBody: any,
  openaiBaseUrl: string,
  apiKey: string,
): AdaptedOpenAIRequest {
  const normalizedBaseUrl = openaiBaseUrl.replace(/\/$/, '');
  const openaiBody: any = {
    model: anthropicBody.model,
    messages: convertMessages(anthropicBody.messages || []),
    max_tokens: anthropicBody.max_tokens,
    temperature: anthropicBody.temperature,
    stream: anthropicBody.stream || false,
  };

  if (anthropicBody.system) {
    const systemContent = typeof anthropicBody.system === 'string'
      ? anthropicBody.system
      : (anthropicBody.system as any[]).map((s: any) => s.text).join('\n');
    openaiBody.messages.unshift({
      role: 'system',
      content: systemContent,
    });
  }

  if (anthropicBody.tools?.length > 0) {
    openaiBody.tools = convertTools(anthropicBody.tools);
  }

  return {
    url: resolveOpenAIChatTargetUrl(normalizedBaseUrl),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'x-api-key': apiKey,
    },
    body: JSON.stringify(openaiBody),
  };
}

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
