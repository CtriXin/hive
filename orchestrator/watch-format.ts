// orchestrator/watch-format.ts — Phase 8C/9A/9B: Watch output formatter
// Renders WatchData into clean, single-glance CLI output with operator hints and command suggestions.

import type { WatchData } from './watch-loader.js';
import type { OverallRunState } from './operator-summary.js';
import { suggestNextCommands } from './operator-commands.js';
import { cueIcon, cueLabel, type TaskCollabCue } from './collab-cues.js';

function truncate(text: string | undefined, limit: number): string {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '-';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function section(label: string, lines: string[]): string {
  if (lines.length === 0) return '';
  return [`== ${label} ==`, ...lines].join('\n');
}

function modeIcon(mode: string): string {
  switch (mode) {
    case 'auto':
    case 'execute-standard':
    case 'execute-parallel':
      return '\uD83D\uDFE2'; // green
    case 'think':
      return '\uD83D\uDFE1'; // yellow
    case 'quick':
    case 'auto-execute-small':
      return '\uD83D\uDD35'; // blue
    case 'record-only':
    case 'clarify-first':
      return '\u2B1C'; // white
    default:
      return '\u26AA';
  }
}

function breakerIcon(state: string): string {
  switch (state) {
    case 'healthy': return '\u2705';
    case 'degraded': return '\uD83D\uDFE1';
    case 'open': return '\uD83D\uDD34';
    case 'probing': return '\uD83D\uDFE0';
    default: return '\u2753';
  }
}

function stateIcon(state: OverallRunState): string {
  switch (state) {
    case 'done': return '\u2705';
    case 'partial': return '\uD83D\uDFE1';
    case 'blocked': return '\uD83D\uDD34';
    case 'paused': return '\u23F8\uFE0F';
    case 'running': return '\uD83D\uDFE2';
    default: return '\u2753';
  }
}

function mapStatusToOverallState(status: string, steering?: { is_paused: boolean }): OverallRunState {
  if (steering?.is_paused) return 'paused';
  if (status === 'done') return 'done';
  if (status === 'blocked') return 'blocked';
  if (status === 'partial') return 'partial';
  return 'running';
}

/** Format a full watch snapshot */
export function formatWatch(data: WatchData, now?: string): string {
  const timestamp = now || new Date().toISOString();
  const blocks: string[] = [];

  // Header
  blocks.push(`== Hive Watch [${timestamp}] ==`);

  // Core status with operator summary
  const coreLines: string[] = [];
  const overallState = mapStatusToOverallState(data.status, data.steering);
  coreLines.push(`${stateIcon(overallState)} run: ${data.run_id} | ${overallState}`);
  coreLines.push(`round: ${data.round}${data.max_rounds ? `/${data.max_rounds}` : ''}`);

  if (data.phase) {
    coreLines.push(`phase: ${data.phase}${data.phase_reason ? ` | ${truncate(data.phase_reason, 80)}` : ''}`);
  }

  coreLines.push(`${modeIcon(data.mode.current_mode)} mode: ${data.mode.current_mode}${data.mode.escalated ? ' [ESCALATED]' : ''}`);

  if (data.focus_task) {
    coreLines.push(`focus: ${data.focus_task}${data.focus_agent ? ` (${data.focus_agent})` : ''}${data.focus_summary ? ` | ${truncate(data.focus_summary, 60)}` : ''}`);
  }

  if (data.latest_reason) {
    coreLines.push(`next: ${truncate(data.latest_reason, 100)}`);
  }

  coreLines.push(`updated: ${data.updated_at}`);
  blocks.push(section('Run', coreLines));

  // Operator Summary — conclusion first
  const summaryLines: string[] = [];
  const hasProviderIssue = data.provider.total > 0 && data.provider.any_unhealthy;
  const hasSteering = data.steering.pending_count > 0 || data.steering.last_applied || data.steering.last_rejected;

  if (overallState === 'paused') {
    summaryLines.push('\u23F8\uFE0F PAUSED — resume run or apply steering actions');
  } else if (overallState === 'blocked') {
    summaryLines.push('\uD83D\uDD34 BLOCKED — requires intervention');
  } else if (overallState === 'partial') {
    summaryLines.push('\uD83D\uDFE1 PARTIAL — some tasks completed, some failed');
  } else if (overallState === 'done') {
    summaryLines.push('\u2705 DONE — all tasks completed');
  } else {
    summaryLines.push('\uD83D\uDFE2 RUNNING — execution in progress');
  }

  if (hasProviderIssue) {
    const unhealthy = data.provider.details.filter((d) => d.breaker !== 'healthy')[0];
    if (unhealthy) {
      summaryLines.push(`\u26A0\uFE0F Provider ${unhealthy.provider} ${unhealthy.breaker}${unhealthy.subtype ? ` (${unhealthy.subtype})` : ''}`);
    }
  }

  if (hasSteering && data.steering.pending_count! > 0) {
    summaryLines.push(`\uD83D\uDCCC ${data.steering.pending_count} pending steering action(s)`);
  }

  if (summaryLines.length > 0) {
    blocks.push(section('Summary', summaryLines));
  }

  // Next Action Hints — top 3 actionable items
  const hintLines: string[] = [];
  const hints = generateOperatorHintsFromWatchData(data);
  let topHintAction: string | undefined;
  if (hints.length > 0) {
    topHintAction = hints[0].action;
    for (const hint of hints.slice(0, 3)) {
      const icon = hint.priority === 'high' ? '‼️' : hint.priority === 'medium' ? '\u25B6\uFE0F' : '\uD83D\uDCA1';
      hintLines.push(`${icon} ${hint.description}`);
      hintLines.push(`   action: ${hint.action}`);
      if (hint.rationale) {
        hintLines.push(`   why: ${truncate(hint.rationale, 70)}`);
      }
    }
  } else {
    hintLines.push('- no specific actions recommended');
  }
  blocks.push(section('Next Actions', hintLines));

  // Suggested Commands — lifecycle-aware, 2-4 quick commands
  const stateForCmds = mapStatusToOverallState(data.status, data.steering);
  if (stateForCmds !== 'running') {
    const cmds = suggestNextCommands(stateForCmds, {
      runId: data.run_id,
      topHintAction,
      hasSteering: data.steering.pending_count > 0,
    });
    if (cmds.length > 0) {
      const cmdLines = cmds.map((c) => `  ${c.command}  # ${c.label}`);
      blocks.push(section('Suggested Commands', cmdLines));
    }
  }

  // Phase 10A: Collaboration Cues — task-level signals for handoff
  const activeCues = data.taskCues.filter((c) => c.cue !== 'ready' && c.cue !== 'passive');
  if (activeCues.length > 0) {
    const cueLines = activeCues.slice(0, 5).map((c) => `${cueIcon(c.cue)} ${c.task_id}: ${truncate(c.reason, 70)}`);
    blocks.push(section('Collaboration Cues', cueLines));
  }

  // Steering
  const steerLines: string[] = [];
  if (data.steering.is_paused) {
    steerLines.push('\u23F8\ufe0f  PAUSED');
  }
  if (data.steering.pending_count > 0) {
    steerLines.push(`pending: ${data.steering.pending_count} action(s)`);
  }
  if (data.steering.last_applied) {
    steerLines.push(`applied: ${data.steering.last_applied.action_type} | ${truncate(data.steering.last_applied.outcome, 80)}`);
  }
  if (data.steering.last_rejected) {
    steerLines.push(`rejected: ${data.steering.last_rejected.action_type} | ${truncate(data.steering.last_rejected.reason, 80)}`);
  }
  if (data.steering.recent_actions.length > 0 && !data.steering.last_applied && data.steering.pending_count === 0) {
    for (const a of data.steering.recent_actions.slice(-3)) {
      const icon = a.status === 'applied' ? '\u2705' : a.status === 'rejected' ? '\u26D4' : a.status === 'suppressed' ? '\uD83D\uDD07' : '\u23F3';
      steerLines.push(`${icon} ${a.type}${a.task_id ? ` \u2192 ${a.task_id}` : ''}`);
    }
  }
  if (steerLines.length === 0) {
    steerLines.push('no steering actions');
  }
  blocks.push(section('Steering', steerLines));

  // Provider health
  const provLines: string[] = [];
  if (data.provider.total === 0) {
    provLines.push('no provider health data');
  } else {
    const summary = data.provider.summary_text || [
      `${data.provider.total} total`,
      `${data.provider.healthy} healthy`,
      data.provider.degraded > 0 ? `${data.provider.degraded} degraded` : '',
      data.provider.open > 0 ? `${data.provider.open} open` : '',
      data.provider.probing > 0 ? `${data.provider.probing} probing` : '',
    ].filter(Boolean).join(' | ');
    provLines.push(summary);

    const unhealthy = data.provider.details.filter((d) => d.breaker !== 'healthy');
    if (unhealthy.length > 0) {
      for (const d of unhealthy) {
        provLines.push(`${breakerIcon(d.breaker)} ${d.provider}: ${d.breaker}${d.subtype ? ` (${d.subtype})` : ''}`);
      }
    }
    if (data.provider.latest_decision) {
      provLines.push(`latest resilience: ${data.provider.latest_decision}`);
    }
    if (data.provider.latest_task_route) {
      const route = data.provider.latest_task_route;
      const requested = route.requested_provider
        ? `${route.requested_model || '-'}@${route.requested_provider}`
        : route.requested_model || '-';
      const actual = route.actual_provider
        ? `${route.actual_model || '-'}@${route.actual_provider}`
        : route.actual_model || '-';
      const suffix = route.failure_subtype ? ` | ${route.failure_subtype}` : '';
      provLines.push(`latest route: ${route.task_id} | ${requested} -> ${actual}${route.fallback_used ? ' [fallback]' : ''}${suffix}`);
    }
  }
  blocks.push(section('Provider', provLines));

  // Mode escalation history
  if (data.mode.escalated && data.mode.escalation_history.length > 0) {
    const escLines = data.mode.escalation_history.map(
      (e) => `round ${e.round}: ${e.from} \u2192 ${e.to} | ${truncate(e.reason, 90)}`,
    );
    blocks.push(section('Mode Escalation', escLines));
  }

  // Artifact health
  if (data.artifacts_missing.length > 0) {
    blocks.push(section('Missing Artifacts', data.artifacts_missing.map((a) => `- ${a}`)));
  }

  return blocks.join('\n\n');
}

/** Format a compact one-line status for quick polling */
export function formatWatchCompact(data: WatchData): string {
  const phase = data.phase ? ` ${data.phase}` : '';
  const paused = data.steering.is_paused ? ' \u23F8\ufe0f' : '';
  const provider = data.provider.any_unhealthy ? ' \uD83D\uDFE1 provider' : '';
  const escalated = data.mode.escalated ? ' \u26A1 escalated' : '';
  const focus = data.focus_task ? ` | ${data.focus_task}` : '';

  return `[${data.run_id}] ${data.status}${phase} r${data.round} | ${data.mode.current_mode}${focus}${paused}${provider}${escalated}`;
}

/** Generate operator hints from watch data (simplified version for watch output) */
function generateOperatorHintsFromWatchData(data: WatchData): Array<{
  action: string;
  priority: 'high' | 'medium' | 'low';
  description: string;
  rationale?: string;
}> {
  const hints: Array<{ action: string; priority: 'high' | 'medium' | 'low'; description: string; rationale?: string }> = [];

  const overallState = mapStatusToOverallState(data.status, data.steering);

  // High priority: paused, blocked, provider issues
  if (overallState === 'paused') {
    hints.push({
      action: 'resume_run',
      priority: 'high',
      description: 'Resume the paused run',
      rationale: 'Run is paused via steering — resume to continue',
    });
  }

  if (overallState === 'blocked') {
    hints.push({
      action: 'replan',
      priority: 'high',
      description: 'Address blocker to continue',
      rationale: data.latest_reason || 'Run is blocked',
    });
  }

  const unhealthyProvider = data.provider.details.filter((d) => d.breaker === 'open')[0];
  if (unhealthyProvider) {
    hints.push({
      action: 'provider_wait_fallback',
      priority: 'high',
      description: `Provider ${unhealthyProvider.provider} circuit open — wait or fallback`,
      rationale: `Provider ${unhealthyProvider.provider} is ${unhealthyProvider.breaker}${unhealthyProvider.subtype ? ` (${unhealthyProvider.subtype})` : ''}`,
    });
  }

  if (data.steering.is_paused && data.steering.pending_count > 0) {
    hints.push({
      action: 'steering_recommended',
      priority: 'high',
      description: `Review ${data.steering.pending_count} pending steering action(s)`,
      rationale: 'Pending steering actions need attention',
    });
  }

  // Medium priority: degraded providers, failures
  const degradedProvider = data.provider.details.filter((d) => d.breaker === 'degraded')[0];
  if (degradedProvider) {
    hints.push({
      action: 'provider_wait_fallback',
      priority: 'medium',
      description: `Monitor provider ${degradedProvider.provider}`,
      rationale: `Provider ${degradedProvider.provider} is degraded`,
    });
  }

  if (overallState === 'partial' || overallState === 'running') {
    if (data.latest_reason && data.latest_reason.includes('repair')) {
      hints.push({
        action: 'retry_later',
        priority: 'medium',
        description: 'Continue repair round',
        rationale: data.latest_reason,
      });
    } else if (data.latest_reason && data.latest_reason.includes('replan')) {
      hints.push({
        action: 'replan',
        priority: 'medium',
        description: 'Replan with failure context',
        rationale: data.latest_reason,
      });
    }
  }

  // Low priority: steering suggestions, merge reminders
  if (overallState === 'done') {
    hints.push({
      action: 'merge_changes',
      priority: 'low',
      description: 'Review merged changes',
      rationale: 'All tasks completed — review before next run',
    });
  }

  return hints.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.priority] - order[b.priority];
  });
}
