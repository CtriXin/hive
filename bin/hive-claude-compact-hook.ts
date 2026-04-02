#!/usr/bin/env node

import fs from 'fs';
import {
  renderClaudeCompactHookOutput,
  syncClaudeCompactHookState,
  type ClaudeCompactHookInput,
} from '../orchestrator/claude-compact-hook.js';

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function isCompactHookInput(value: unknown): value is ClaudeCompactHookInput {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  return input.hook_event_name === 'PreCompact' || input.hook_event_name === 'PostCompact';
}

function main(): void {
  const raw = readStdin().trim();
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isCompactHookInput(parsed)) return;
    syncClaudeCompactHookState(process.cwd(), parsed);
    const output = renderClaudeCompactHookOutput(process.cwd(), parsed);
    if (output.trim()) {
      process.stdout.write(output);
    }
  } catch {
    // Hooks should fail open.
  }
}

main();
