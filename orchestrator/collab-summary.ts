// orchestrator/collab-summary.ts — Phase 10A: Run-Level Collaboration Summary
// Aggregates task-level collaboration cues into a run-level summary.
// Derives everything from existing artifacts — no new state source.

import type {
  ProviderHealthStoreData,
  RunSpec,
  RunState,
  ReviewResult,
  SteeringAction,
} from './types.js';
import {
  deriveTaskCues,
  groupCuesByCategory,
  cueIcon,
  cueLabel,
  type CollaborationCue,
  type TaskCollabCue,
} from './collab-cues.js';

export interface CollaborationSummary {
  run_id: string;
  cue_distribution: Record<CollaborationCue, number>;
  top_attention_items: TaskCollabCue[]; // cues needing action, sorted by urgency
  handoff_ready: boolean;
  handoff_notes: string[];
  blocker_categories: Array<{ category: string; tasks: string[] }>;
  total_tasks: number;
  active_cues: number; // non-passive, non-ready
}

const CUE_URGENCY: Record<CollaborationCue, number> = {
  needs_human: 0,
  blocked: 1,
  needs_review: 2,
  watch: 3,
  ready: 4,
  passive: 5,
};

export function generateCollaborationSummary(args: {
  runId: string;
  state: RunState | null;
  spec: RunSpec | null;
  steeringActions?: SteeringAction[];
  reviewResults?: ReviewResult[];
  providerHealth?: ProviderHealthStoreData | null;
}): CollaborationSummary {
  const { runId, state, spec, steeringActions = [], reviewResults = [], providerHealth } = args;

  const taskStates = state?.task_states || {};
  const totalTasks = Object.keys(taskStates).length;

  // Derive task-level cues
  const cues = deriveTaskCues({
    taskStates,
    steeringActions,
    nextAction: state?.next_action,
    providerHealth,
  });

  // Group by category
  const groups = groupCuesByCategory(cues);

  // Top attention items: everything except ready/passive, sorted by urgency
  const topAttentionItems = cues
    .filter((c) => c.cue !== 'ready' && c.cue !== 'passive')
    .sort((a, b) => CUE_URGENCY[a.cue] - CUE_URGENCY[b.cue])
    .slice(0, 5);

  // Blocker categories
  const blockerCategories: Array<{ category: string; tasks: string[] }> = [];

  const humanBlockers = groups.needs_human.map((c) => c.task_id);
  if (humanBlockers.length > 0) {
    blockerCategories.push({ category: 'needs_human', tasks: humanBlockers });
  }

  const providerBlockers = groups.blocked
    .filter((c) => c.evidence.includes('provider:open'))
    .map((c) => c.task_id);
  if (providerBlockers.length > 0) {
    blockerCategories.push({ category: 'blocked_by_provider', tasks: providerBlockers });
  }

  const scopeBlockers = groups.blocked
    .filter((c) => !c.evidence.includes('provider:open'))
    .map((c) => c.task_id);
  if (scopeBlockers.length > 0) {
    blockerCategories.push({ category: 'blocked', tasks: scopeBlockers });
  }

  const reviewBlockers = groups.needs_review.map((c) => c.task_id);
  if (reviewBlockers.length > 0) {
    blockerCategories.push({ category: 'needs_review', tasks: reviewBlockers });
  }

  // Handoff readiness
  const handoffReady = computeHandoffReadiness(state, groups, topAttentionItems);
  const handoffNotes = computeHandoffNotes(state, groups, topAttentionItems);

  const cueDistribution: Record<CollaborationCue, number> = {
    needs_review: groups.needs_review.length,
    needs_human: groups.needs_human.length,
    blocked: groups.blocked.length,
    watch: groups.watch.length,
    ready: groups.ready.length,
    passive: groups.passive.length,
  };

  const activeCues = cueDistribution.needs_human +
    cueDistribution.blocked +
    cueDistribution.needs_review +
    cueDistribution.watch;

  return {
    run_id: runId,
    cue_distribution: cueDistribution,
    top_attention_items: topAttentionItems,
    handoff_ready: handoffReady,
    handoff_notes: handoffNotes,
    blocker_categories: blockerCategories,
    total_tasks: totalTasks,
    active_cues: activeCues,
  };
}

function computeHandoffReadiness(
  state: RunState | null,
  groups: ReturnType<typeof groupCuesByCategory>,
  attentionItems: TaskCollabCue[],
): boolean {
  if (!state) return false;

  // Paused with pending steering: good handoff candidate
  if (state.steering?.paused) return true;

  // No active cues: nothing to hand off, but still "ready" in the sense that someone can pick it up
  if (attentionItems.length === 0) return true;

  // Only watch items: low-risk handoff
  if (attentionItems.every((c) => c.cue === 'watch')) return true;

  // Has human/block items: needs handoff
  if (groups.needs_human.length > 0 || groups.blocked.length > 0) return true;

  return true; // default: handoff is always possible, just need to communicate
}

function computeHandoffNotes(
  state: RunState | null,
  groups: ReturnType<typeof groupCuesByCategory>,
  attentionItems: TaskCollabCue[],
): string[] {
  const notes: string[] = [];

  if (state?.steering?.paused) {
    notes.push('Run is paused — apply steering actions or resume');
  }

  if (groups.needs_human.length > 0) {
    notes.push(`${groups.needs_human.length} task(s) need human input: ${groups.needs_human.map((c) => c.task_id).join(', ')}`);
  }

  if (groups.blocked.length > 0) {
    notes.push(`${groups.blocked.length} task(s) blocked: ${groups.blocked.map((c) => c.task_id).join(', ')}`);
  }

  if (groups.needs_review.length > 0) {
    notes.push(`${groups.needs_review.length} task(s) need review attention: ${groups.needs_review.map((c) => c.task_id).join(', ')}`);
  }

  if (attentionItems.length === 0 && state && state.status !== 'done' && state.status !== 'blocked') {
    notes.push('No active collaboration signals — run is progressing normally');
  }

  if (groups.ready.length > 0) {
    notes.push(`${groups.ready.length} task(s) completed and ready for review`);
  }

  return notes;
}

/** Format collaboration summary as CLI output */
export function formatCollabSummary(summary: CollaborationSummary): string {
  const lines: string[] = [];

  lines.push(`== Collaboration Summary [${summary.run_id}] ==`);
  lines.push('');

  // Cue distribution
  const distLines: string[] = [];
  for (const cue of ['needs_human', 'blocked', 'needs_review', 'watch', 'ready', 'passive'] as CollaborationCue[]) {
    const count = summary.cue_distribution[cue];
    if (count > 0) {
      distLines.push(`${cueIcon(cue)} ${cueLabel(cue)}: ${count}`);
    }
  }
  if (distLines.length > 0) {
    lines.push(`Distribution: ${distLines.join(' | ')}`);
  }

  // Top attention items
  if (summary.top_attention_items.length > 0) {
    lines.push('');
    lines.push('Attention Items:');
    for (const item of summary.top_attention_items) {
      lines.push(`  ${cueIcon(item.cue)} ${item.task_id}: ${item.reason}`);
    }
  }

  // Blocker categories
  if (summary.blocker_categories.length > 0) {
    lines.push('');
    lines.push('Blockers:');
    for (const b of summary.blocker_categories) {
      lines.push(`  ${b.category}: ${b.tasks.join(', ')}`);
    }
  }

  // Handoff readiness
  lines.push('');
  lines.push(`Handoff: ${summary.handoff_ready ? 'ready' : 'not_ready'}`);
  for (const note of summary.handoff_notes) {
    lines.push(`  - ${note}`);
  }

  return lines.join('\n');
}
