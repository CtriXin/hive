// orchestrator/model-proxy.ts — Model name case-restoration + thinking adaptation proxy
// 1. Claude Code CLI lowercases model names → proxy restores correct casing
// 2. Some models (MiniMax-M2.7) return "thinking" content blocks → proxy converts to "text"

import http from 'http';
import https from 'https';
import { Transform } from 'stream';
import { URL } from 'url';
import { loadMmsRoutes } from './mms-routes-loader.js';

interface ModelMapping {
  correctName: string;
  baseUrl: string;
  apiKey: string;
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

export function resolveProxyTargetUrl(baseUrl: string, requestPath: string): string {
  const normalizedBase = baseUrl.replace(/\/$/, '');
  const normalizedPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  const url = new URL(normalizedBase);
  const basePath = url.pathname.replace(/\/$/, '');

  let finalPath = normalizedPath;
  if (basePath && basePath !== '/') {
    finalPath = basePath.endsWith('/v1') && normalizedPath.startsWith('/v1/')
      ? `${basePath}${normalizedPath.slice(3)}`
      : `${basePath}${normalizedPath}`;
  }

  url.pathname = finalPath;
  url.search = '';
  return url.toString().replace(/\/$/, finalPath === '/' ? '/' : '');
}

function buildCaseMap(): void {
  caseMap.clear();
  const table = loadMmsRoutes();
  if (!table) return;

  for (const [modelId, route] of Object.entries(table.routes)) {
    if (modelId.startsWith('claude-')) continue;
    caseMap.set(modelId.toLowerCase(), {
      correctName: modelId,
      baseUrl: route.anthropic_base_url,
      apiKey: route.api_key,
    });
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
      req.on('end', () => {
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
        const isStreaming = !!parsed.stream;

        const targetUrl = resolveProxyTargetUrl(
          mapping.baseUrl,
          req.url || '/v1/messages',
        );

        forwardRequest(
          targetUrl,
          mapping.apiKey,
          JSON.stringify(parsed),
          req.headers,
          isStreaming,
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
