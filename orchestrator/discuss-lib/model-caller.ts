// ═══════════════════════════════════════════════════════════════════
// discuss-lib/model-caller.ts — ModelCaller interface + default impl
// ═══════════════════════════════════════════════════════════════════
// Core abstraction: callers inject their own model-calling strategy.
// Default implementation uses @anthropic-ai/claude-code SDK query().

import { query } from '@anthropic-ai/claude-code';
import { normalizeModelId } from '../model-defaults.js';

// ── Interface ──

export interface ModelCallOptions {
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
  cwd?: string;
  maxTurns?: number;
  timeoutMs?: number;
}

export interface ModelCaller {
  queryText(prompt: string, options: ModelCallOptions): Promise<string>;
}

// ── Default implementation ──

async function collectAssistantText(
  messages: AsyncIterable<any>,
  timeoutMs: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      (async () => {
        let output = '';
        for await (const msg of messages) {
          if (msg.type === 'assistant') {
            const content = msg.message?.content;
            if (Array.isArray(content)) {
              output += content
                .map((block: any) => (block.type === 'text' ? block.text : ''))
                .join('');
            } else if (typeof content === 'string') {
              output += content;
            }
          }
        }
        return output;
      })(),
      new Promise<string>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Model timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Create the default ModelCaller backed by @anthropic-ai/claude-code SDK.
 *
 * Routes to any model via env vars:
 *   ANTHROPIC_MODEL    ← modelId
 *   ANTHROPIC_BASE_URL ← baseUrl (from model-routes.json or provider config)
 *   ANTHROPIC_AUTH_TOKEN ← apiKey
 */
export function createDefaultCaller(): ModelCaller {
  return {
    async queryText(prompt: string, options: ModelCallOptions): Promise<string> {
      const {
        modelId,
        baseUrl,
        apiKey,
        cwd = process.cwd(),
        maxTurns = 3,
        timeoutMs = 180_000,
      } = options;
      const canonicalModelId = normalizeModelId(modelId);
      if (canonicalModelId.startsWith('claude-')) {
        throw new Error(`Claude model "${canonicalModelId}" is globally disabled in Hive runtime.`);
      }

      const env: Record<string, string> = {
        ANTHROPIC_MODEL: canonicalModelId,
        PATH: process.env['PATH'] || '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env['HOME'] || '',
      };
      if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl.replace(/\/v1\/?$/, '');
      if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;

      const messages = query({
        prompt,
        options: { cwd, env, maxTurns },
      });

      return collectAssistantText(messages, timeoutMs);
    },
  };
}
