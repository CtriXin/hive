import type { CompactPacket, WorkspaceCompactPacket } from './compact-packet.js';
import { loadCompactPacket, loadWorkspaceCompactPacket } from './compact-packet.js';
import {
  buildConversationContextFromCompactSummary,
  buildConversationContextFromRecentSession,
  saveConversationContext,
} from './claude-session-context.js';

export interface ClaudeCompactHookInput {
  hook_event_name: 'PreCompact' | 'PostCompact';
  trigger: 'manual' | 'auto';
  compact_summary?: string;
  custom_instructions?: string | null;
}

function buildRunPreCompactInstructions(packet: CompactPacket): string {
  void packet;
  return 'Keep Hive restore: .ai/restore/latest-compact-restore-prompt.md';
}

function buildWorkspacePreCompactInstructions(packet: WorkspaceCompactPacket): string {
  void packet;
  return 'Keep Hive restore: .ai/restore/latest-compact-restore-prompt.md';
}

function buildPostCompactMessage(restorePromptPath: string): string {
  void restorePromptPath;
  return 'Hive restore: .ai/restore/latest-compact-restore-prompt.md';
}

function refreshLatestRestore(cwd: string): void {
  const compact = loadCompactPacket(cwd);
  if (compact) return;
  loadWorkspaceCompactPacket(cwd);
}

export function syncClaudeCompactHookState(
  cwd: string,
  input: ClaudeCompactHookInput,
): void {
  const context = input.hook_event_name === 'PostCompact'
    ? buildConversationContextFromCompactSummary(input.compact_summary || '', undefined, cwd)
      || buildConversationContextFromRecentSession(cwd)
    : buildConversationContextFromRecentSession(cwd);

  if (!context) return;
  saveConversationContext(cwd, context);
  refreshLatestRestore(cwd);
}

export function renderClaudeCompactHookOutput(
  cwd: string,
  input: ClaudeCompactHookInput,
): string {
  const compact = loadCompactPacket(cwd);
  const workspaceCompact = compact ? null : loadWorkspaceCompactPacket(cwd);
  if (!compact && !workspaceCompact) return '';

  if (input.hook_event_name === 'PreCompact') {
    return compact
      ? buildRunPreCompactInstructions(compact.packet)
      : buildWorkspacePreCompactInstructions(workspaceCompact!.packet);
  }

  return buildPostCompactMessage(
    compact?.restorePromptPath || workspaceCompact!.restorePromptPath,
  );
}
