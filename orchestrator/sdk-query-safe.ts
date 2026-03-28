// orchestrator/sdk-query-safe.ts — Unified model query layer
// All worker models go through Claude Code SDK for full agent capabilities
// (tool use, file I/O, multi-turn). No model-name prefix needed —
// Claude Code CLI accepts any model name.

import { query } from '@anthropic-ai/claude-code';
import type { SDKMessage } from '@anthropic-ai/claude-code';

export interface SafeQueryOptions {
  prompt: string;
  options: {
    cwd: string;
    env: Record<string, string>;
    maxTurns?: number;
    resume?: string;
  };
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
  return claudeCodeQuery(opts);
}

// ── Claude Code SDK path (for claude-* models) ──

async function claudeCodeQuery(opts: SafeQueryOptions): Promise<SafeQueryResult> {
  const stream = query({
    prompt: opts.prompt,
    options: {
      ...opts.options,
      // Workers run autonomously — bypass interactive permission prompts
      permissionMode: 'bypassPermissions',
    },
  });

  const messages: SDKMessage[] = [];
  let exitError: Error | null = null;

  try {
    for await (const msg of stream) {
      messages.push(msg);
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
