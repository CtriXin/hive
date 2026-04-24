// orchestrator/watch-format.ts — Phase 8C/9A/9B: Watch output formatter
// Renders WatchData into clean, single-glance CLI output with operator hints and command suggestions.

import type { WatchData } from './watch-loader.js';
import type { OverallRunState } from './operator-summary.js';
import { suggestNextCommands } from './operator-commands.js';
import { cueIcon, cueLabel, type TaskCollabCue } from './collab-cues.js';
import type { ReviewResult } from './types.js';
import { extractAuthorityDegradation, formatAuthorityDegradation } from './authority-surface.js';

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

function renderProgressLabel(data: WatchData): string {
  return data.progress_status || data.status || 'unknown';
}

/** Format a full watch snapshot — conclusion-first, operator-briefing style */
export function formatWatch(data: WatchData, now?: string, opts?: { reviewResults?: ReviewResult[] }): string {
  const timestamp = now || new Date().toISOString();
  const blocks: string[] = [];
  const overallState = mapStatusToOverallState(data.status, data.steering);

  // ── Header (always present) ──
  blocks.push(`== Hive Watch [${timestamp}] ==`);

  // ── 1. CONCLUSION: state, human attention, next action, blocker ──
  const conclusionLines: string[] = [];
  conclusionLines.push(`${stateIcon(overallState)} run: ${data.run_id} | ${overallState}`);
  conclusionLines.push(`progress: ${renderProgressLabel(data)}`);
  conclusionLines.push(`round: ${data.round}${data.max_rounds ? `/${data.max_rounds}` : ''}`);
  conclusionLines.push(`${modeIcon(data.mode.current_mode)} mode: ${data.mode.current_mode}${data.mode.escalated ? ' [ESCALATED]' : ''}`);

  // Next action / current blocker — first screen priority
  if (overallState === 'paused') {
    conclusionLines.push('\u23F8\uFE0F PAUSED — resume or apply steering actions');
  } else if (overallState === 'blocked') {
    conclusionLines.push('\uD83D\uDD34 BLOCKED — requires intervention');
    if (data.latest_reason) conclusionLines.push(`blocker: ${truncate(data.latest_reason, 100)}`);
  } else if (overallState === 'partial') {
    conclusionLines.push('\uD83D\uDFE1 PARTIAL — some tasks completed, some failed');
  } else if (overallState === 'done') {
    conclusionLines.push('\u2705 DONE — all tasks completed');
  } else {
    if (data.focus_task) {
      conclusionLines.push(`focus: ${data.focus_task}${data.focus_agent ? ` (${data.focus_agent})` : ''}${data.focus_summary ? ` | ${truncate(data.focus_summary, 60)}` : ''}`);
    }
  }

  // Phase / latest reason (only if useful)
  if (data.phase && overallState === 'running') {
    conclusionLines.push(`phase: ${data.phase}${data.phase_reason ? ` | ${truncate(data.phase_reason, 80)}` : ''}`);
  }
  if (data.progress_why) {
    conclusionLines.push(`why: ${truncate(data.progress_why, 100)}`);
  }
  if (data.progress_next_action && data.progress_next_action !== '-') {
    conclusionLines.push(`next: ${truncate(data.progress_next_action, 90)}`);
  }
  if (data.handoff?.task_id || data.handoff?.owner || data.handoff?.model) {
    const handoffParts = [
      data.handoff.task_id || '-',
      data.handoff.owner || '-',
      data.handoff.model || '-',
    ];
    conclusionLines.push(`handoff: ${handoffParts.join(' | ')}`);
  }

  conclusionLines.push(`updated: ${data.updated_at}`);
  blocks.push(section('Run', conclusionLines));

  // ── 2. AUTHORITY DEGRADATION (if present — high visibility) ──
  const authority = extractAuthorityDegradation(opts?.reviewResults);
  if (authority.degradation) {
    blocks.push(section('Authority', formatAuthorityDegradation(authority.degradation)));
  }

  // ── 3. PROVIDER HEALTH (visible but not noisy) ──
  const hasProviderIssue = data.provider.total > 0 && data.provider.any_unhealthy;
  const provLines: string[] = [];

  if (data.provider.total === 0) {
    // Skip provider section entirely when no data — less noise
  } else if (!hasProviderIssue) {
    // Normal: just show counts, skip detail lines
    provLines.push(`${data.provider.total} tracked, ${data.provider.healthy} healthy`);
  } else {
    // Degraded/open: show full detail
    const summary = data.provider.summary_text || [
      `${data.provider.total} total`,
      `${data.provider.healthy} healthy`,
      data.provider.degraded > 0 ? `${data.provider.degraded} degraded` : '',
      data.provider.open > 0 ? `${data.provider.open} open` : '',
      data.provider.probing > 0 ? `${data.provider.probing} probing` : '',
    ].filter(Boolean).join(' | ');
    provLines.push(`\u26A0\uFE0F ${summary}`);

    const unhealthy = data.provider.details.filter((d) => d.breaker !== 'healthy');
    for (const d of unhealthy) {
      provLines.push(`${breakerIcon(d.breaker)} ${d.provider}: ${d.breaker}${d.subtype ? ` (${d.subtype})` : ''}`);
    }
  }

  if (data.provider.latest_decision) {
    provLines.push(`resilience: ${data.provider.latest_decision}`);
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
    provLines.push(`route: ${route.task_id} | ${requested} -> ${actual}${route.fallback_used ? ' [fallback]' : ''}${suffix}`);
  }
  if (provLines.length > 0) {
    blocks.push(section('Provider', provLines));
  }

  // ── 4. STEERING (only if relevant) ──
  const steerLines: string[] = [];
  if (data.steering.is_paused) steerLines.push('\u23F8\ufe0f PAUSED');
  if (data.steering.pending_count > 0) steerLines.push(`pending: ${data.steering.pending_count} action(s)`);
  if (data.steering.last_applied) steerLines.push(`applied: ${data.steering.last_applied.action_type} | ${truncate(data.steering.last_applied.outcome, 80)}`);
  if (data.steering.last_rejected) steerLines.push(`rejected: ${data.steering.last_rejected.action_type} | ${truncate(data.steering.last_rejected.reason, 80)}`);
  if (steerLines.length > 0) {
    blocks.push(section('Steering', steerLines));
  }

  // ── 5. NEXT ACTIONS (hints + commands) ──
  const hints = generateOperatorHintsFromWatchData(data, authority);
  let topHintAction: string | undefined;
  if (hints.length > 0) {
    topHintAction = hints[0].action;
    const hintLines = hints.slice(0, 3).map((hint) => {
      const icon = hint.priority === 'high' ? '‼️' : hint.priority === 'medium' ? '\u25B6\uFE0F' : '\uD83D\uDCA1';
      let line = `${icon} ${hint.description}`;
      if (hint.rationale) line += ` | ${truncate(hint.rationale, 70)}`;
      return line;
    });
    blocks.push(section('Next Actions', hintLines));
  }

  // Suggested commands (only when not running)
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

  // ── 6. COLLABORATION CUES (only active) ──
  const activeCues = data.taskCues.filter((c) => c.cue !== 'ready' && c.cue !== 'passive');
  if (activeCues.length > 0) {
    const cueLines = activeCues.slice(0, 5).map((c) => `${cueIcon(c.cue)} ${c.task_id}: ${truncate(c.reason, 70)}`);
    blocks.push(section('Collaboration Cues', cueLines));
  }

  // ── 7. MODE ESCALATION (only if happened) ──
  if (data.mode.escalated && data.mode.escalation_history.length > 0) {
    const escLines = data.mode.escalation_history.map(
      (e) => `r${e.round}: ${e.from} \u2192 ${e.to} | ${truncate(e.reason, 90)}`,
    );
    blocks.push(section('Mode Escalation', escLines));
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
  const progress = renderProgressLabel(data);

  return `[${data.run_id}] ${progress}${phase} r${data.round} | ${data.mode.current_mode}${focus}${paused}${provider}${escalated}`;
}

import type { AuthoritySurfaceResult } from './authority-surface.js';

/** Generate operator hints from watch data (simplified version for watch output) */
function generateOperatorHintsFromWatchData(data: WatchData, authority?: AuthoritySurfaceResult): Array<{
  action: string;
  priority: 'high' | 'medium' | 'low';
  description: string;
  rationale?: string;
}> {
  const hints: Array<{ action: string; priority: 'high' | 'medium' | 'low'; description: string; rationale?: string }> = [];

  // Authority degradation — highest priority
  if (authority?.degradation) {
    const d = authority.degradation;
    hints.push({
      action: 'request_human_input',
      priority: d.severity === 'high' ? 'high' : 'medium',
      description: d.description,
      rationale: `review mode: ${d.actual_mode}`,
    });
  }

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
