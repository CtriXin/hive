// orchestrator/watch-loader.ts — Phase 8C: Live watch data aggregation
// Read-only surface that aggregates existing artifacts into a unified watch view.

import fs from 'fs';
import path from 'path';
import type {
  ExecutionMode,
  ProviderHealthStoreData,
  RunSpec,
  RunState,
  SteeringAction,
} from './types.js';
import type { HumanProgressStatus } from './handoff-surfaces.js';
import { loadHandoffSurfaceBundle } from './handoff-surfaces.js';
import { normalizeExecutionMode } from './mode-policy.js';
import type { LoopProgress } from './loop-progress-store.js';
import { readLoopProgress } from './loop-progress-store.js';
import { loadRunResult, loadRunSpec, loadRunState } from './run-store.js';
import { loadSteeringStore, type SteeringStore } from './steering-store.js';
import { deriveTaskCues, type TaskCollabCue } from './collab-cues.js';
import {
  extractLatestProviderRoute,
  formatProviderDecision,
  latestProviderDecision,
  summarizeProviderHealth as summarizeProviderHealthText,
} from './provider-surface.js';

export interface WatchProviderSummary {
  total: number;
  healthy: number;
  degraded: number;
  open: number;
  probing: number;
  any_unhealthy: boolean;
  details: Array<{ provider: string; breaker: string; subtype?: string }>;
  summary_text?: string;
  latest_decision?: string;
  latest_task_route?: {
    task_id: string;
    requested_model?: string;
    requested_provider?: string;
    actual_model?: string;
    actual_provider?: string;
    failure_subtype?: string;
    fallback_used: boolean;
  };
}

export interface WatchSteeringSummary {
  is_paused: boolean;
  pending_count: number;
  last_applied?: { action_type: string; outcome: string; applied_at: number };
  last_rejected?: { action_type: string; reason: string; applied_at: number };
  recent_actions: Array<{ type: string; status: string; task_id?: string }>;
}

export interface WatchModeSummary {
  current_mode: ExecutionMode;
  escalated: boolean;
  escalation_history: Array<{ from: ExecutionMode; to: ExecutionMode; reason: string; round: number }>;
}

export interface WatchData {
  run_id: string;
  status: string;
  progress_status?: HumanProgressStatus;
  progress_next_action?: string;
  progress_why?: string;
  round: number;
  max_rounds?: number;
  phase?: string;
  phase_reason?: string;
  mode: WatchModeSummary;
  focus_task?: string;
  focus_agent?: string;
  focus_summary?: string;
  latest_reason?: string;
  steering: WatchSteeringSummary;
  provider: WatchProviderSummary;
  updated_at: string;
  artifacts_available: string[];
  artifacts_missing: string[];
  handoff?: {
    task_id?: string;
    owner?: string;
    model?: string;
    refs: string[];
  };
  // Phase 10A: collaboration cues for task-level signals
  taskCues: TaskCollabCue[];
}

function runDir(cwd: string, runId: string): string {
  return path.join(cwd, '.ai', 'runs', runId);
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function loadProviderHealth(cwd: string, runId: string): ProviderHealthStoreData | null {
  return readJson<ProviderHealthStoreData>(path.join(runDir(cwd, runId), 'provider-health.json'));
}

export { loadProviderHealth };

function latestTaskRoute(cwd: string, runId: string): WatchProviderSummary['latest_task_route'] {
  const result = loadRunResult(cwd, runId);
  const latest = extractLatestProviderRoute({ reviewResults: result?.review_results });
  if (!latest) {
    return undefined;
  }
  return {
    task_id: latest.task_id || 'task',
    requested_model: latest.requested_model,
    requested_provider: latest.requested_provider,
    actual_model: latest.actual_model,
    actual_provider: latest.actual_provider,
    failure_subtype: latest.failure_subtype,
    fallback_used: latest.fallback_used,
  };
}

function buildProviderSummary(data: ProviderHealthStoreData | null, latestRoute?: WatchProviderSummary['latest_task_route']): WatchProviderSummary {
  if (!data || Object.keys(data.providers).length === 0) {
    return {
      total: 0,
      healthy: 0,
      degraded: 0,
      open: 0,
      probing: 0,
      any_unhealthy: false,
      details: [],
      summary_text: undefined,
      latest_decision: undefined,
      latest_task_route: latestRoute,
    };
  }

  const entries = Object.entries(data.providers);
  const details = entries.map(([provider, state]) => ({
    provider,
    breaker: state.breaker,
    subtype: state.last_failure_subtype,
  }));

  const counts = entries.reduce(
    (acc, [, state]) => {
      acc[state.breaker] = (acc[state.breaker] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return {
    total: entries.length,
    healthy: counts.healthy || 0,
    degraded: counts.degraded || 0,
    open: counts.open || 0,
    probing: counts.probing || 0,
    any_unhealthy: (counts.degraded || 0) + (counts.open || 0) + (counts.probing || 0) > 0,
    details,
    summary_text: summarizeProviderHealthText(data),
    latest_decision: formatProviderDecision(latestProviderDecision(data)),
    latest_task_route: latestRoute,
  };
}

function summarizeSteering(store: SteeringStore | null, statePaused?: boolean): WatchSteeringSummary {
  if (!store || store.actions.length === 0) {
    return {
      is_paused: statePaused ?? false,
      pending_count: 0,
      recent_actions: [],
    };
  }

  const applied = store.actions.filter((a) => a.status === 'applied').reverse();
  const rejected = store.actions.filter((a) => a.status === 'rejected').reverse();
  const pending = store.actions.filter((a) => a.status === 'pending');

  // Use authoritative state.steering.paused if available; fall back to heuristic
  const isPaused = statePaused !== undefined
    ? statePaused
    : pending.some((a) => a.action_type === 'pause_run')
      || applied.filter((a) => a.action_type === 'pause_run').length
        > applied.filter((a) => a.action_type === 'resume_run').length;

  return {
    is_paused: isPaused,
    pending_count: pending.length,
    last_applied: applied[0]
      ? { action_type: applied[0].action_type, outcome: applied[0].outcome ?? '', applied_at: applied[0].applied_at ?? 0 }
      : undefined,
    last_rejected: rejected[0]
      ? { action_type: rejected[0].action_type, reason: rejected[0].outcome ?? '', applied_at: rejected[0].applied_at ?? 0 }
      : undefined,
    recent_actions: store.actions
      .slice(-5)
      .map((a) => ({ type: a.action_type, status: a.status, task_id: a.task_id })),
  };
}

function summarizeMode(spec: RunSpec | null, state: RunState | null): WatchModeSummary {
  const rawMode = (state?.runtime_mode_override ?? spec?.execution_mode ?? 'auto') as ExecutionMode;
  const escalationHistory = state?.mode_escalation_history ?? [];

  return {
    current_mode: normalizeExecutionMode(rawMode),
    escalated: escalationHistory.length > 0,
    escalation_history: escalationHistory.map((entry) => ({
      ...entry,
      from: normalizeExecutionMode(entry.from),
      to: normalizeExecutionMode(entry.to),
    })),
  };
}

/**
 * Load a unified watch data snapshot for a given run.
 * Gracefully degrades when artifacts are missing.
 */
export function loadWatchData(cwd: string, runId: string): WatchData | null {
  const spec = loadRunSpec(cwd, runId);
  const state = loadRunState(cwd, runId);
  const progress = readLoopProgress(cwd, runId);
  const healthData = loadProviderHealth(cwd, runId);
  const steeringStore = loadSteeringStore(cwd, runId);
  const latestRoute = latestTaskRoute(cwd, runId);
  const handoffBundle = loadHandoffSurfaceBundle(cwd, runId);

  if (!spec && !state && !progress) return null;

  const artifactsAvailable: string[] = [];
  const artifactsMissing: string[] = [];

  const check = (name: string, present: boolean) => {
    if (present) artifactsAvailable.push(name);
    else artifactsMissing.push(name);
  };

  check('spec', !!spec);
  check('state', !!state);
  check('progress', !!progress);
  check('provider-health', !!healthData);
  check('steering', !!steeringStore);

  const effectiveRunId = state?.run_id ?? progress?.run_id ?? runId;

  // Phase 10A: derive task-level collaboration cues
  const steeringActions = steeringStore?.actions || [];
  const taskCues = deriveTaskCues({
    taskStates: state?.task_states,
    steeringActions,
    nextAction: state?.next_action,
    providerHealth: healthData,
  });

  return {
    run_id: effectiveRunId,
    status: state?.status ?? 'unknown',
    progress_status: handoffBundle?.human_progress.status,
    progress_next_action: handoffBundle?.human_progress.next_action,
    progress_why: handoffBundle?.human_progress.why_not_moving,
    round: state?.round ?? progress?.round ?? 0,
    max_rounds: spec?.max_rounds,
    phase: progress?.phase,
    phase_reason: progress?.reason,
    mode: summarizeMode(spec, state),
    focus_task: progress?.focus_task_id,
    focus_agent: progress?.focus_agent_id,
    focus_summary: progress?.focus_summary,
    latest_reason: state?.next_action
      ? `${state.next_action.kind}: ${state.next_action.reason}`
      : undefined,
    steering: summarizeSteering(steeringStore, state?.steering?.paused),
    provider: buildProviderSummary(healthData, latestRoute),
    updated_at: progress?.updated_at ?? state?.updated_at ?? new Date().toISOString(),
    artifacts_available: artifactsAvailable,
    artifacts_missing: artifactsMissing,
    handoff: handoffBundle
      ? {
        task_id: handoffBundle.packet.task_id,
        owner: handoffBundle.packet.owner,
        model: handoffBundle.packet.model,
        refs: handoffBundle.packet.refs.slice(0, 4),
      }
      : undefined,
    taskCues,
  };
}
