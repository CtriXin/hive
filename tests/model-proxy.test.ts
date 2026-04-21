import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureModelProxy,
  getModelProxyPort,
  inferProxyBridgeMode,
  registerModelProxyRoute,
  resolveProxyTargetUrl,
  stopModelProxy,
} from '../orchestrator/model-proxy.js';

const originalRoutesPath = process.env.MMS_ROUTES_PATH;

afterEach(() => {
  stopModelProxy();
  if (originalRoutesPath === undefined) {
    delete process.env.MMS_ROUTES_PATH;
  } else {
    process.env.MMS_ROUTES_PATH = originalRoutesPath;
  }
});

describe('model-proxy target URL normalization', () => {
  it('avoids duplicating /v1 for bridge routes that already end with /v1', () => {
    expect(
      resolveProxyTargetUrl('https://chat.example.test/openapi/v1', '/v1/messages'),
    ).toBe('https://chat.example.test/openapi/v1/messages');
  });

  it('preserves provider prefixes such as /openai', () => {
    expect(
      resolveProxyTargetUrl('https://bridge.example.test/openai', '/v1/messages'),
    ).toBe('https://bridge.example.test/openai/v1/messages');
  });

  it('appends the request path for plain host routes', () => {
    expect(
      resolveProxyTargetUrl('http://127.0.0.1:4001', '/v1/messages'),
    ).toBe('http://127.0.0.1:4001/v1/messages');
  });

  it('preserves query params for messages requests', () => {
    expect(
      resolveProxyTargetUrl('https://api.z.ai/api/anthropic', '/v1/messages?beta=true'),
    ).toBe('https://api.z.ai/api/anthropic/v1/messages?beta=true');
  });

  it('preserves query params for count_tokens requests', () => {
    expect(
      resolveProxyTargetUrl('https://api.z.ai/api/anthropic', '/v1/messages/count_tokens?beta=true'),
    ).toBe('https://api.z.ai/api/anthropic/v1/messages/count_tokens?beta=true');
  });

  it('detects gateway-family /openai routes as chat bridge targets', () => {
    expect(inferProxyBridgeMode('gpt-5.4', 'http://127.0.0.1:19300/openai')).toBe('openai-chat');
  });

  it('keeps direct anthropic routes in passthrough mode', () => {
    expect(inferProxyBridgeMode('gpt-5.4', 'https://relay.example.com/anthropic')).toBe('direct');
    expect(inferProxyBridgeMode('kimi-for-coding', 'https://relay.example.com/openai')).toBe('direct');
  });

  it('bridges OpenAI SSE responses into Anthropic streaming events', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-model-proxy-'));
    const routesPath = path.join(tempRoot, 'model-routes.json');
    let upstreamPath = '';
    let upstreamBody = '';
    const upstream = http.createServer((req, res) => {
      upstreamPath = req.url || '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { upstreamBody += chunk; });
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.write('data: {"id":"chunk-1","model":"gpt-5.4","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\r\n\r\n');
        res.write('data: {"id":"chunk-2","model":"gpt-5.4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":1}}\r\n\r\n');
        res.end('data: [DONE]\r\n\r\n');
      });
    });

    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as any).port;
    const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}/openai`;
    fs.writeFileSync(routesPath, JSON.stringify({
      version: 1,
      generated_at: new Date().toISOString(),
      routes: {
        'gpt-5.4': {
          primary: {
            provider_id: 'test-openai',
            anthropic_base_url: upstreamBaseUrl,
            openai_base_url: upstreamBaseUrl,
            api_key: 'bridge-key',
          },
        },
      },
    }));
    process.env.MMS_ROUTES_PATH = routesPath;

    await ensureModelProxy();
    registerModelProxyRoute('gpt-5.4', upstreamBaseUrl, 'bridge-key', 'openai-chat');

    const resp = await fetch(`http://127.0.0.1:${getModelProxyPort()}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      }),
    });

    const payload = await resp.text();
    await new Promise<void>((resolve, reject) => upstream.close((err) => err ? reject(err) : resolve()));

    expect(resp.status).toBe(200);
    expect(upstreamPath).toBe('/openai/v1/chat/completions');
    expect(JSON.parse(upstreamBody).stream).toBe(true);
    expect(payload).toContain('event: message_start');
    expect(payload).toContain('"type":"text_delta"');
    expect(payload).toContain('"text":"OK"');
    expect(payload).toContain('event: message_stop');
  });

  it('bridges non-streaming Anthropic requests through OpenAI SSE routes', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-model-proxy-'));
    const routesPath = path.join(tempRoot, 'model-routes.json');
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
        });
        res.write('data: {"id":"chunk-1","model":"gpt-5.4","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n');
        res.write('data: {"id":"chunk-2","model":"gpt-5.4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":1}}\n\n');
        res.end('data: [DONE]\n\n');
      });
    });

    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as any).port;
    const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}/openai`;
    fs.writeFileSync(routesPath, JSON.stringify({
      version: 1,
      generated_at: new Date().toISOString(),
      routes: {
        'gpt-5.4': {
          primary: {
            provider_id: 'test-openai',
            anthropic_base_url: upstreamBaseUrl,
            openai_base_url: upstreamBaseUrl,
            api_key: 'bridge-key',
          },
        },
      },
    }));
    process.env.MMS_ROUTES_PATH = routesPath;

    await ensureModelProxy();
    const resp = await fetch(`http://127.0.0.1:${getModelProxyPort()}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        max_tokens: 16,
        stream: false,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      }),
    });

    const payload = await resp.json();
    await new Promise<void>((resolve, reject) => upstream.close((err) => err ? reject(err) : resolve()));

    expect(resp.status).toBe(200);
    expect(payload).toMatchObject({
      content: [{ type: 'text', text: 'OK' }],
      model: 'gpt-5.4',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 9,
        output_tokens: 1,
      },
    });
  });
});
