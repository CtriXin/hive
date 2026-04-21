// ═══════════════════════════════════════════════════════════════════
// orchestrator/protocol-adapter.ts — Anthropic ↔ OpenAI 协议翻译
// ═══════════════════════════════════════════════════════════════════
// 轻量级翻译层：Anthropic Messages API → OpenAI Chat Completions
// 不支持：反向翻译、Gemini、Responses API、SSE streaming（MVP）
// ═══════════════════════════════════════════════════════════════════

import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  adaptAnthropicToOpenAI,
  convertResponseToAnthropic,
} from './openai-bridge.js';
import { resolveProjectPath } from './project-paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
