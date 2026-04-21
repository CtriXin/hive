// orchestrator/model-proxy.ts — Model name case-restoration + thinking adaptation proxy
// 1. Claude Code CLI lowercases model names → proxy restores correct casing
// 2. Some models (MiniMax-M2.7) return "thinking" content blocks → proxy converts to "text"
// 3. GPT/Gemini/O-series OpenAI-style routes can bridge to chat/completions locally

import http from 'http';
import https from 'https';
import { Transform } from 'stream';
import { URL } from 'url';
import { loadMmsRoutes } from './mms-routes-loader.js';
import {
  adaptAnthropicToOpenAI,
  convertResponseToAnthropic,
} from './openai-bridge.js';

type BridgeMode = 'direct' | 'openai-chat';

interface ModelMapping {
  correctName: string;
  baseUrl: string;
  apiKey: string;
  bridgeMode: BridgeMode;
}

let proxyServer: http.Server | null = null;
let proxyPort = 0;
const caseMap = new Map<string, ModelMapping>();

export function getModelProxyPort(): number {
  return proxyPort;
}

export function isModelProxyRunning(): boolean {
  return proxyServer !== null && proxyPort > 0;
}

function isGatewayFamilyModel(modelId: string): boolean {
  return /^(gpt-|gemini-|o[134]-)/i.test(modelId);
}

export function inferProxyBridgeMode(modelId: string, baseUrl: string): BridgeMode {
  if (!isGatewayFamilyModel(modelId)) return 'direct';
  try {
    const pathname = new URL(baseUrl).pathname.replace(/\/+$/, '').toLowerCase();
    if (!pathname || pathname === '/') return 'direct';
    if (pathname.endsWith('/anthropic')) return 'direct';
    return 'openai-chat';
  } catch {
    return /\/anthropic\/?$/i.test(baseUrl) ? 'direct' : 'openai-chat';
  }
}

export function resolveProxyTargetUrl(baseUrl: string, requestPath: string): string {
  const normalizedBase = baseUrl.replace(/\/$/, '');
  const url = new URL(normalizedBase);
  const requestUrl = new URL(
    requestPath.startsWith('/') ? requestPath : `/${requestPath}`,
    'http://model-proxy.local',
  );
  const normalizedPath = requestUrl.pathname;
  const basePath = url.pathname.replace(/\/$/, '');

  let finalPath = normalizedPath;
  if (basePath && basePath !== '/') {
    finalPath = basePath.endsWith('/v1') && normalizedPath.startsWith('/v1/')
      ? `${basePath}${normalizedPath.slice(3)}`
      : `${basePath}${normalizedPath}`;
  }

  url.pathname = finalPath;
  url.search = requestUrl.search;
  return url.toString();
}

export function registerModelProxyRoute(
  modelId: string,
  baseUrl: string,
  apiKey: string,
  bridgeMode: BridgeMode = inferProxyBridgeMode(modelId, baseUrl),
): void {
  caseMap.set(modelId.toLowerCase(), {
    correctName: modelId,
    baseUrl,
    apiKey,
    bridgeMode,
  });
}

function buildCaseMap(): void {
  caseMap.clear();
  const table = loadMmsRoutes();
  if (!table) return;

  for (const [modelId, route] of Object.entries(table.routes)) {
    if (modelId.startsWith('claude-')) continue;
    registerModelProxyRoute(modelId, route.openai_base_url || route.anthropic_base_url, route.api_key);
  }
}

// ── Thinking → Text adaptation ──
// Converts "thinking" content blocks to "text" so Claude Code SDK can parse them.
// Works on both streaming (SSE line-by-line) and non-streaming (full JSON) responses.

function adaptThinkingLine(line: string): string {
  if (!line.includes('thinking')) return line;

  // SSE content_block_start: {"type":"thinking"} → {"type":"text"}
  // Also handle "thinking":"..." → "text":"..."
  return line
    .replace(/"type"\s*:\s*"thinking_delta"/g, '"type":"text_delta"')
    .replace(/"type"\s*:\s*"thinking"/g, '"type":"text"')
    .replace(/"thinking"\s*:\s*"/g, '"text":"')
    .replace(/"signature"\s*:\s*"[^"]*"\s*,?\s*/g, '');
}

function createThinkingTransform(): Transform {
  let buffer = '';
  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      // Keep last incomplete line in buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        this.push(adaptThinkingLine(line) + '\n');
      }
      callback();
    },
    flush(callback) {
      if (buffer) {
        this.push(adaptThinkingLine(buffer));
      }
      callback();
    },
  });
}

function adaptNonStreamingResponse(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (!parsed.content || !Array.isArray(parsed.content)) return body;

    let changed = false;
    for (const block of parsed.content) {
      if (block.type === 'thinking') {
        block.type = 'text';
        if (block.thinking !== undefined) {
          block.text = block.thinking;
          delete block.thinking;
        }
        delete block.signature;
        changed = true;
      }
    }
    return changed ? JSON.stringify(parsed) : body;
  } catch {
    return body;
  }
}

function estimateAnthropicInputTokens(body: any): number {
  const raw = JSON.stringify({
    system: body?.system || '',
    messages: body?.messages || [],
    tools: body?.tools || [],
  });
  return Math.max(1, Math.ceil(raw.length / 4));
}

function writeAnthropicStream(res: http.ServerResponse, payload: any): void {
  const chunks: string[] = [];
  chunks.push('event: message_start\n');
  chunks.push(`data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: `msg_proxy_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: payload.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: payload.usage?.input_tokens || 0,
        output_tokens: 0,
      },
    },
  })}\n\n`);

  const blocks = Array.isArray(payload.content) ? payload.content : [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'text') {
      chunks.push('event: content_block_start\n');
      chunks.push(`data: ${JSON.stringify({
        type: 'content_block_start',
        index,
        content_block: {
          type: 'text',
          text: '',
        },
      })}\n\n`);
      chunks.push('event: content_block_delta\n');
      chunks.push(`data: ${JSON.stringify({
        type: 'content_block_delta',
        index,
        delta: {
          type: 'text_delta',
          text: block.text || '',
        },
      })}\n\n`);
      chunks.push('event: content_block_stop\n');
      chunks.push(`data: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`);
      continue;
    }

    if (block.type === 'tool_use') {
      chunks.push('event: content_block_start\n');
      chunks.push(`data: ${JSON.stringify({
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input || {},
        },
      })}\n\n`);
      chunks.push('event: content_block_stop\n');
      chunks.push(`data: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`);
    }
  }

  chunks.push('event: message_delta\n');
  chunks.push(`data: ${JSON.stringify({
    type: 'message_delta',
    delta: {
      stop_reason: payload.stop_reason || 'end_turn',
      stop_sequence: null,
    },
    usage: {
      output_tokens: payload.usage?.output_tokens || 0,
    },
  })}\n\n`);
  chunks.push('event: message_stop\n');
  chunks.push('data: {"type":"message_stop"}\n\n');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.end(chunks.join(''));
}

function emitSseEvent(res: http.ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function mapOpenAiFinishReason(reason: string | null | undefined): string {
  return reason === 'tool_calls'
    ? 'tool_use'
    : reason === 'stop' || !reason
      ? 'end_turn'
      : reason;
}

interface ToolBridgeState {
  anthropicIndex: number;
  id: string;
  name: string;
  started: boolean;
  inputChunks: string[];
}

interface OpenAiBridgeState {
  model: string;
  nextIndex: number;
  textIndex: number | null;
  content: any[];
  toolCalls: Map<number, ToolBridgeState>;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

function createOpenAiBridgeState(modelId: string, inputTokens = 0): OpenAiBridgeState {
  return {
    model: modelId,
    nextIndex: 0,
    textIndex: null,
    content: [],
    toolCalls: new Map(),
    inputTokens,
    outputTokens: 0,
    stopReason: 'end_turn',
  };
}

function ensureTextBlock(state: OpenAiBridgeState, res?: http.ServerResponse): number {
  if (state.textIndex !== null) return state.textIndex;
  const index = state.nextIndex++;
  state.textIndex = index;
  state.content[index] = { type: 'text', text: '' };
  if (res) {
    emitSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'text',
        text: '',
      },
    });
  }
  return index;
}

function closeTextBlock(state: OpenAiBridgeState, res?: http.ServerResponse): void {
  if (state.textIndex === null) return;
  if (res) {
    emitSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: state.textIndex,
    });
  }
  state.textIndex = null;
}

function appendTextDelta(
  state: OpenAiBridgeState,
  text: string,
  res?: http.ServerResponse,
): void {
  if (!text) return;
  const index = ensureTextBlock(state, res);
  state.content[index].text += text;
  if (res) {
    emitSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: {
        type: 'text_delta',
        text,
      },
    });
  }
}

function getOrCreateToolCall(
  state: OpenAiBridgeState,
  openAiIndex: number,
): ToolBridgeState {
  let entry = state.toolCalls.get(openAiIndex);
  if (!entry) {
    entry = {
      anthropicIndex: state.nextIndex++,
      id: `toolu_proxy_${Date.now()}_${openAiIndex}`,
      name: '',
      started: false,
      inputChunks: [],
    };
    state.toolCalls.set(openAiIndex, entry);
  }
  return entry;
}

function maybeStartToolCall(
  state: OpenAiBridgeState,
  entry: ToolBridgeState,
  res?: http.ServerResponse,
): void {
  if (entry.started || !entry.name) return;
  closeTextBlock(state, res);
  state.content[entry.anthropicIndex] = {
    type: 'tool_use',
    id: entry.id,
    name: entry.name,
    input: {},
  };
  entry.started = true;
  if (res) {
    emitSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: entry.anthropicIndex,
      content_block: {
        type: 'tool_use',
        id: entry.id,
        name: entry.name,
        input: {},
      },
    });
  }
}

function appendToolDelta(
  state: OpenAiBridgeState,
  openAiIndex: number,
  toolCallDelta: any,
  res?: http.ServerResponse,
): void {
  const entry = getOrCreateToolCall(state, openAiIndex);
  if (typeof toolCallDelta.id === 'string' && toolCallDelta.id) {
    entry.id = toolCallDelta.id;
  }
  if (typeof toolCallDelta.function?.name === 'string' && toolCallDelta.function.name) {
    entry.name = toolCallDelta.function.name;
  }
  maybeStartToolCall(state, entry, res);

  const argsChunk = typeof toolCallDelta.function?.arguments === 'string'
    ? toolCallDelta.function.arguments
    : '';
  if (!argsChunk) return;

  entry.inputChunks.push(argsChunk);
  if (res && entry.started) {
    emitSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: entry.anthropicIndex,
      delta: {
        type: 'input_json_delta',
        partial_json: argsChunk,
      },
    });
  }
}

function finalizeToolCalls(state: OpenAiBridgeState, res?: http.ServerResponse): void {
  for (const entry of state.toolCalls.values()) {
    maybeStartToolCall(state, entry, res);
    const rawInput = entry.inputChunks.join('');
    if (state.content[entry.anthropicIndex]) {
      try {
        state.content[entry.anthropicIndex].input = rawInput ? JSON.parse(rawInput) : {};
      } catch {
        state.content[entry.anthropicIndex].input = rawInput ? { raw: rawInput } : {};
      }
    }
    if (res && entry.started) {
      emitSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: entry.anthropicIndex,
      });
    }
  }
}

async function* iterateOpenAiSse(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const splitMatch = buffer.match(/\r?\n\r?\n/);
      const splitIndex = splitMatch ? splitMatch.index ?? -1 : -1;
      if (splitIndex < 0) break;
      const eventChunk = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + splitMatch![0].length);
      const dataLines = eventChunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      for (const dataLine of dataLines) {
        if (!dataLine) continue;
        if (dataLine === '[DONE]') {
          return;
        }
        yield JSON.parse(dataLine);
      }
    }
  }
}

async function bridgeOpenAIRequest(
  mapping: ModelMapping,
  parsedBody: any,
  requestPath: string,
  res: http.ServerResponse,
): Promise<void> {
  if (requestPath.includes('/count_tokens')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: estimateAnthropicInputTokens(parsedBody) }));
    return;
  }

  const isStreaming = !!parsedBody.stream;
  const adapted = adaptAnthropicToOpenAI(
    { ...parsedBody, stream: true },
    mapping.baseUrl,
    mapping.apiKey,
  );

  const response = await fetch(adapted.url, {
    method: 'POST',
    headers: adapted.headers,
    body: adapted.body,
  });

  const rawText = !response.ok || !response.body || !(response.headers.get('content-type') || '').includes('text/event-stream')
    ? await response.text()
    : '';
  if (!response.ok) {
    res.writeHead(response.status, { 'Content-Type': 'application/json' });
    res.end(rawText);
    return;
  }

  if (!response.body || rawText) {
    const anthropicResult = convertResponseToAnthropic(JSON.parse(rawText));
    if (isStreaming) {
      writeAnthropicStream(res, anthropicResult);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(anthropicResult));
    return;
  }

  const state = createOpenAiBridgeState(parsedBody.model, estimateAnthropicInputTokens(parsedBody));
  if (isStreaming) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    emitSseEvent(res, 'message_start', {
      type: 'message_start',
      message: {
        id: `msg_proxy_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: state.inputTokens,
          output_tokens: 0,
        },
      },
    });
  }

  for await (const chunk of iterateOpenAiSse(response.body)) {
    if (typeof chunk.model === 'string' && chunk.model) {
      state.model = chunk.model;
    }
    if (chunk.usage?.prompt_tokens) {
      state.inputTokens = chunk.usage.prompt_tokens;
    }
    if (chunk.usage?.completion_tokens) {
      state.outputTokens = chunk.usage.completion_tokens;
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};

    if (typeof delta.content === 'string' && delta.content) {
      appendTextDelta(state, delta.content, isStreaming ? res : undefined);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const toolCallDelta of delta.tool_calls) {
        appendToolDelta(
          state,
          typeof toolCallDelta.index === 'number' ? toolCallDelta.index : 0,
          toolCallDelta,
          isStreaming ? res : undefined,
        );
      }
    }

    if (choice.finish_reason) {
      state.stopReason = mapOpenAiFinishReason(choice.finish_reason);
    }
  }

  closeTextBlock(state, isStreaming ? res : undefined);
  finalizeToolCalls(state, isStreaming ? res : undefined);

  const anthropicResult = {
    content: state.content.filter(Boolean),
    model: state.model,
    stop_reason: state.stopReason,
    usage: {
      input_tokens: state.inputTokens,
      output_tokens: state.outputTokens,
    },
  };

  if (isStreaming) {
    emitSseEvent(res, 'message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: anthropicResult.stop_reason,
        stop_sequence: null,
      },
      usage: {
        output_tokens: anthropicResult.usage.output_tokens,
      },
    });
    emitSseEvent(res, 'message_stop', { type: 'message_stop' });
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(anthropicResult));
}

function forwardRequest(
  targetUrl: string,
  apiKey: string,
  body: string,
  reqHeaders: http.IncomingHttpHeaders,
  isStreaming: boolean,
  res: http.ServerResponse,
): void {
  const url = new URL(targetUrl);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;

  const fwdReq = mod.request(
    {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'Authorization': `Bearer ${apiKey}`,
        'anthropic-version':
          (reqHeaders['anthropic-version'] as string) || '2023-06-01',
        'Accept': reqHeaders['accept'] || '*/*',
      },
    },
    (fwdRes) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(fwdRes.headers)) {
        if (v) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      }

      if (isStreaming) {
        // Streaming: pipe through thinking transform
        res.writeHead(fwdRes.statusCode || 502, headers);
        fwdRes.pipe(createThinkingTransform()).pipe(res);
      } else {
        // Non-streaming: buffer, transform, send
        let responseBody = '';
        fwdRes.on('data', (chunk) => { responseBody += chunk; });
        fwdRes.on('end', () => {
          const adapted = adaptNonStreamingResponse(responseBody);
          // Fix content-length since body may have changed
          delete headers['content-length'];
          res.writeHead(fwdRes.statusCode || 502, headers);
          res.end(adapted);
        });
      }
    },
  );

  fwdReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: { message: err.message } }));
  });

  fwdReq.write(body);
  fwdReq.end();
}

export async function ensureModelProxy(): Promise<number> {
  if (proxyServer) return proxyPort;

  buildCaseMap();
  if (caseMap.size === 0) {
    console.error('  ⚠️ Model proxy: no MMS routes found, proxy not started');
    return 0;
  }

  return new Promise<number>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method Not Allowed');
        return;
      }

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        let parsed: any;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400);
          res.end('Invalid JSON');
          return;
        }

        const requestModel = (parsed.model || '').toLowerCase();
        const mapping = caseMap.get(requestModel);

        if (!mapping) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: `Model proxy: unknown model "${parsed.model}"`,
              type: 'model_not_found',
            },
          }));
          return;
        }

        // Restore correct model name casing
        parsed.model = mapping.correctName;
        if (mapping.bridgeMode === 'openai-chat') {
          try {
            await bridgeOpenAIRequest(mapping, parsed, req.url || '/v1/messages', res);
          } catch (err: any) {
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
            }
            res.end(JSON.stringify({ error: { message: err.message } }));
          }
          return;
        }

        const targetUrl = resolveProxyTargetUrl(mapping.baseUrl, req.url || '/v1/messages');
        forwardRequest(
          targetUrl,
          mapping.apiKey,
          JSON.stringify(parsed),
          req.headers,
          !!parsed.stream,
          res,
        );
      });
    });

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      proxyPort = typeof addr === 'object' && addr ? addr.port : 0;
      proxyServer = server;
      console.error(
        `  🔀 Model proxy on :${proxyPort}`
        + ` (${caseMap.size} models, case + thinking adaptation)`,
      );
      resolve(proxyPort);
    });
  });
}

export function stopModelProxy(): void {
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
    proxyPort = 0;
  }
}
