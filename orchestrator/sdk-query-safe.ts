// orchestrator/sdk-query-safe.ts — Unified model query layer
// All worker models go through Claude Code SDK for full agent capabilities
// (tool use, file I/O, multi-turn). No model-name prefix needed —
// Claude Code CLI accepts any model name.

import { query } from '@anthropic-ai/claude-code';
import type { SDKMessage } from '@anthropic-ai/claude-code';
import {
  ensureModelProxy,
  getModelProxyPort,
  registerModelProxyRoute,
} from './model-proxy.js';

const DEFAULT_WORKER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface SafeQueryOptions {
  prompt: string;
  options: {
    cwd: string;
    env: Record<string, string>;
    model?: string;
    maxTurns?: number;
    resume?: string;
  };
  onMessage?: (message: SDKMessage) => void | Promise<void>;
  timeoutMs?: number;
}

export interface SafeQueryResult {
  messages: SDKMessage[];
  exitError: Error | null;
}

/**
 * All workers go through Claude Code SDK agent loop.
 * Claude Code CLI does NOT validate model names (Ug() returns true).
 */
export async function safeQuery(opts: SafeQueryOptions): Promise<SafeQueryResult> {
  if (!opts.options.model) {
    throw new Error('safeQuery requires explicit options.model to avoid implicit Claude fallback');
  }
  opts.options.env = await prepareSdkEnvForQuery(opts.options.model, opts.options.env);
  assertClaudeManualOnlyGuard(opts.options.model, opts.options.env);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Worker timeout after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
    timeoutHandle.unref?.();
  });
  try {
    return await Promise.race([claudeCodeQuery(opts), timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function prepareSdkEnvForQuery(modelId: string, env: Record<string, string>): Promise<Record<string, string>> {
  const proxyMode = env.HIVE_MODEL_PROXY_MODE?.trim();
  if (proxyMode !== 'openai-chat' && proxyMode !== 'direct') {
    return env;
  }

  const baseUrl = env.HIVE_MODEL_PROXY_BASE_URL?.trim();
  const apiKey = env.HIVE_MODEL_PROXY_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    throw new Error(`Model proxy bridge is missing route config for "${modelId}"`);
  }

  const port = await ensureModelProxy();
  if (!port) {
    throw new Error(`Model proxy is unavailable for "${modelId}"`);
  }

  registerModelProxyRoute(modelId, baseUrl, apiKey, proxyMode);
  const nextEnv = { ...env };
  nextEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${getModelProxyPort()}`;
  nextEnv.ANTHROPIC_AUTH_TOKEN = 'proxy-managed';
  delete nextEnv.HIVE_MODEL_PROXY_MODE;
  delete nextEnv.HIVE_MODEL_PROXY_BASE_URL;
  delete nextEnv.HIVE_MODEL_PROXY_API_KEY;
  return nextEnv;
}

function assertClaudeManualOnlyGuard(modelId: string, env: Record<string, string>): void {
  if (!modelId.startsWith('claude-')) return;

  const baseUrl = env.ANTHROPIC_BASE_URL?.trim();
  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim();
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR?.trim();
  const homeDir = env.HOME?.trim();

  if (!baseUrl || !authToken) {
    throw new Error(
      `Blocked automatic Claude launch for "${modelId}": explicit ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN are required because OAuth Claude is manual-only.`,
    );
  }
  if (!claudeConfigDir || !homeDir) {
    throw new Error(
      `Blocked automatic Claude launch for "${modelId}": isolated HOME and CLAUDE_CONFIG_DIR are required because OAuth Claude is manual-only.`,
    );
  }
}

// ── Claude Code SDK path (for claude-* models) ──

async function claudeCodeQuery(opts: SafeQueryOptions): Promise<SafeQueryResult> {
  const modelId = opts.options.model!;

  // Claude Code CLI --model flag lowercases model names internally,
  // breaking case-sensitive proxies (e.g. "MiniMax-M2.7" → "minimax-m2.7").
  // For non-Claude models, we rely on ANTHROPIC_MODEL env var (set by buildSdkEnv)
  // which is sent as-is in the API request body, preserving original casing.
  // Only pass --model for Claude models where the CLI knows the name natively.
  const passModelFlag = modelId.startsWith('claude-');

  const stream = query({
    prompt: opts.prompt,
    options: {
      ...opts.options,
      // Workers run autonomously — bypass interactive permission prompts
      permissionMode: 'bypassPermissions',
      model: passModelFlag ? modelId : undefined,
    },
  });

  const messages: SDKMessage[] = [];
  let exitError: Error | null = null;

  try {
    for await (const msg of stream) {
      messages.push(msg);
      await opts.onMessage?.(msg);
    }
  } catch (err: any) {
    const isExitCode1 = err.message?.includes('exited with code 1');
    if (isExitCode1 && messages.length > 0) {
      exitError = err;
    } else {
      throw err;
    }
  }

  return { messages, exitError };
}

/**
 * Extract token usage from collected SDK messages.
 */
export function extractTokenUsage(messages: SDKMessage[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const msg of messages) {
    if (msg.type === 'result' && (msg as any).usage) {
      input += (msg as any).usage.input_tokens || 0;
      output += (msg as any).usage.output_tokens || 0;
    }
  }
  return { input, output };
}

/**
 * Extract assistant text from collected SDK messages.
 */
export function extractTextFromMessages(messages: SDKMessage[]): string {
  let text = '';
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        text += content.map((b: any) => b.type === 'text' ? b.text : '').join('');
      } else if (typeof content === 'string') {
        text += content;
      }
    }
  }
  return text.trim();
}
