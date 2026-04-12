// orchestrator/handoff-summary.ts — Phase 10A: Handoff Surface
// Concise handoff packet for "someone else taking over this run".
// Short, actionable — not a long dump.

import type {
  ProviderHealthStoreData,
  RunSpec,
  RunState,
  SteeringAction,
  ReviewResult,
} from './types.js';
import { generateCollaborationSummary, type CollaborationSummary } from './collab-summary.js';
import { cueIcon, cueLabel, type TaskCollabCue } from './collab-cues.js';
import {
  extractLatestProviderRoute,
  formatProviderDecision,
  formatProviderRoute,
  latestProviderDecision,
  summarizeProviderHealth,
} from './provider-surface.js';

export interface HandoffSummary {
  run_id: string;
  current_truth: string; // one-line: status + round + mode
  provider_summary?: string;
  latest_route?: string;
  latest_resilience?: string;
  top_blockers: Array<{ task_id?: string; reason: string }>;
  top_attention: TaskCollabCue[];
  suggested_commands: Array<{ command: string; label: string }>;
  handoff_ready: boolean;
  collab_summary: CollaborationSummary;
}

export function generateHandoffSummary(args: {
  runId: string;
  state: RunState | null;
  spec: RunSpec | null;
  steeringActions?: SteeringAction[];
  reviewResults?: ReviewResult[];
  providerHealth?: ProviderHealthStoreData | null;
}): HandoffSummary {
  const { runId, state, spec, reviewResults, providerHealth } = args;

  const collabSummary = generateCollaborationSummary(args);
  const providerSummary = summarizeProviderHealth(providerHealth);
  const latestRoute = formatProviderRoute(
    extractLatestProviderRoute({ reviewResults, providerHealth }),
  );
  const latestResilience = formatProviderDecision(latestProviderDecision(providerHealth));

  // Current truth: one-line status
  const currentTruth = state
    ? `${state.status} | round ${state.round}${spec ? `/${spec.max_rounds}` : ''} | mode: ${state.runtime_mode_override ?? spec?.execution_mode ?? 'auto'}`
    : 'unknown — no run artifacts found';

  // Top blockers from collaboration summary
  const topBlockers = collabSummary.blocker_categories.flatMap((b) =>
    b.tasks.map((taskId) => ({
      task_id: taskId,
      reason: b.category,
    })),
  );

  // Top attention items (max 3 for handoff brevity)
  const topAttention = collabSummary.top_attention_items.slice(0, 3);

  // Suggested commands based on current state
  const suggestedCommands = buildSuggestedCommands(state, collabSummary, runId);

  return {
    run_id: runId,
    current_truth: currentTruth,
    provider_summary: providerSummary,
    latest_route: latestRoute,
    latest_resilience: latestResilience,
    top_blockers: topBlockers,
    top_attention: topAttention,
    suggested_commands: suggestedCommands,
    handoff_ready: collabSummary.handoff_ready,
    collab_summary: collabSummary,
  };
}

function buildSuggestedCommands(
  state: RunState | null,
  collabSummary: CollaborationSummary,
  runId: string,
): Array<{ command: string; label: string }> {
  const cmds: Array<{ command: string; label: string }> = [];
  const runFlag = ` --run-id ${runId}`;

  // Always include status
  cmds.push({ command: `hive status${runFlag}`, label: 'See full run status' });

  // State-specific
  if (state?.steering?.paused) {
    cmds.push({ command: `hive steer${runFlag}`, label: 'View pending steering actions' });
    cmds.push({ command: `hive resume${runFlag} --execute`, label: 'Resume execution' });
  }

  if (collabSummary.blocker_categories.some((b) => b.category === 'needs_human')) {
    cmds.push({ command: `hive steer${runFlag}`, label: 'Review human intervention needs' });
  }

  if (collabSummary.active_cues > 0) {
    cmds.push({ command: `hive watch${runFlag} --once`, label: 'Single snapshot of current state' });
    cmds.push({ command: `hive workers${runFlag}`, label: 'Inspect task-level details' });
  }

  // Limit to 4
  return cmds.slice(0, 4);
}

/** Format handoff summary as compact CLI output */
export function formatHandoffSummary(handoff: HandoffSummary): string {
  const lines: string[] = [];

  lines.push(`== Handoff [${handoff.run_id}] ==`);
  lines.push('');

  // Current truth
  lines.push(`Truth: ${handoff.current_truth}`);

  if (handoff.latest_route) {
    lines.push(`Latest Route: ${handoff.latest_route}`);
  }
  if (handoff.provider_summary) {
    lines.push(`Provider Health: ${handoff.provider_summary}`);
  }
  if (handoff.latest_resilience) {
    lines.push(`Latest Resilience: ${handoff.latest_resilience}`);
  }

  // Top blockers
  if (handoff.top_blockers.length > 0) {
    lines.push('');
    lines.push('Blockers:');
    for (const b of handoff.top_blockers) {
      lines.push(`  - ${b.task_id || 'run'}: ${b.reason}`);
    }
  }

  // Top attention
  if (handoff.top_attention.length > 0) {
    lines.push('');
    lines.push('Attention:');
    for (const item of handoff.top_attention) {
      lines.push(`  ${cueIcon(item.cue)} ${item.task_id}: ${item.reason}`);
    }
  }

  // Suggested commands
  if (handoff.suggested_commands.length > 0) {
    lines.push('');
    lines.push('Next Commands:');
    for (const cmd of handoff.suggested_commands) {
      lines.push(`  ${cmd.command}  # ${cmd.label}`);
    }
  }

  // Handoff readiness
  lines.push('');
  lines.push(`Handoff Ready: ${handoff.handoff_ready ? 'yes' : 'no'}`);
  for (const note of handoff.collab_summary.handoff_notes) {
    lines.push(`  - ${note}`);
  }

  return lines.join('\n');
}
