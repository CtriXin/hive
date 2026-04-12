// orchestrator/collab-cues.ts — Phase 10A: Task-Level Collaboration Cues
// Derives lightweight collaboration signals from existing task artifacts.

import type {
  FailureClass,
  ProviderHealthStoreData,
  RunState,
  SteeringAction,
  TaskRunRecord,
} from './types.js';

/** Canonical collaboration cue labels — used across all surfaces */
export type CollaborationCue =
  | 'needs_review'    // review failed or review findings need attention
  | 'needs_human'     // human input requested or steering pending on this task
  | 'blocked'         // provider down or external dependency
  | 'watch'           // in progress or recently failed, retry in progress
  | 'ready'           // verified/merged, no action needed
  | 'passive';        // completed, zero collaboration need

export interface TaskCollabCue {
  task_id: string;
  cue: CollaborationCue;
  reason: string; // explainable: why this cue
  evidence: string[]; // source signals
}

/** Derive a collaboration cue for a single task from its state and context */
export function deriveCueForTask(
  task: TaskRunRecord,
  options: {
    pendingSteeringForTask?: string[]; // steering action_ids targeting this task
    hasPendingHumanRequest?: boolean;
    hasOpenProvider?: boolean;
    reviewFindingsCount?: number;
  } = {},
): TaskCollabCue {
  const {
    pendingSteeringForTask = [],
    hasPendingHumanRequest,
    hasOpenProvider,
    reviewFindingsCount = 0,
  } = options;

  // Ready: merged or verified
  if (task.status === 'merged' || task.status === 'verified') {
    return {
      task_id: task.task_id,
      cue: 'ready',
      reason: task.status === 'merged' ? 'Task merged to main branch' : 'Task passed verification',
      evidence: [`status:${task.status}`],
    };
  }

  // Superseded: skip
  if (task.status === 'superseded') {
    return {
      task_id: task.task_id,
      cue: 'passive',
      reason: 'Task superseded',
      evidence: ['status:superseded'],
    };
  }

  // Needs human: explicit human request or steering targeting this task
  if (hasPendingHumanRequest || pendingSteeringForTask.length > 0) {
    return {
      task_id: task.task_id,
      cue: 'needs_human',
      reason: hasPendingHumanRequest
        ? 'Task requires human input'
        : `${pendingSteeringForTask.length} pending steering action(s)`,
      evidence: hasPendingHumanRequest
        ? ['next_action:request_human']
        : pendingSteeringForTask.map((id) => `steering:${id}`),
    };
  }

  // Needs review: review_failed or review findings
  if (task.status === 'review_failed' || reviewFindingsCount > 0) {
    return {
      task_id: task.task_id,
      cue: 'needs_review',
      reason: reviewFindingsCount > 0
        ? `Review found ${reviewFindingsCount} issue(s)`
        : 'Task review failed',
      evidence: [`status:${task.status}`, reviewFindingsCount > 0 ? `review_findings:${reviewFindingsCount}` : ''].filter(Boolean),
    };
  }

  // Blocked: provider open + task not completed
  if (hasOpenProvider && (task.status === 'pending' || task.status === 'worker_failed')) {
    return {
      task_id: task.task_id,
      cue: 'blocked',
      reason: `Provider circuit open — task cannot proceed`,
      evidence: [`status:${task.status}`, 'provider:open'],
    };
  }

  // Blocked: merge_blocked
  if (task.status === 'merge_blocked') {
    return {
      task_id: task.task_id,
      cue: 'blocked',
      reason: `Merge blocked: ${task.last_error || 'unknown'}`,
      evidence: ['status:merge_blocked'],
    };
  }

  // Blocked: verification_failed with budget/retry exhaustion
  if (task.status === 'verification_failed' && task.retry_count >= 2) {
    return {
      task_id: task.task_id,
      cue: 'blocked',
      reason: `Verification failed after ${task.retry_count} retries`,
      evidence: [`status:${task.status}`, `retries:${task.retry_count}`],
    };
  }

  // Watch: worker_failed with retries remaining
  if (task.status === 'worker_failed' && task.retry_count < 2) {
    return {
      task_id: task.task_id,
      cue: 'watch',
      reason: `Task failed, ${task.retry_count} retry attempt recorded — repair in progress`,
      evidence: [`status:${task.status}`, `retries:${task.retry_count}`],
    };
  }

  // Watch: pending task (waiting for dispatch)
  if (task.status === 'pending') {
    return {
      task_id: task.task_id,
      cue: 'watch',
      reason: 'Task pending dispatch',
      evidence: ['status:pending'],
    };
  }

  // Default: derive from failure class
  if (task.status === 'worker_failed' || task.status === 'verification_failed') {
    const failureClass = task.failure_class || 'unknown';
    return {
      task_id: task.task_id,
      cue: 'watch',
      reason: `${failureClass} failure — ${task.retry_count} retries`,
      evidence: [`status:${task.status}`, `failure_class:${failureClass}`],
    };
  }

  // Fallback
  return {
    task_id: task.task_id,
    cue: 'passive',
    reason: `No collaboration signal — status: ${task.status}`,
    evidence: [`status:${task.status}`],
  };
}

/** Derive cues for all tasks in a run */
export function deriveTaskCues(args: {
  taskStates: Record<string, TaskRunRecord> | undefined;
  steeringActions?: SteeringAction[];
  nextAction?: RunState['next_action'];
  providerHealth?: ProviderHealthStoreData | null;
}): TaskCollabCue[] {
  const { taskStates, steeringActions = [], nextAction, providerHealth } = args;
  if (!taskStates) return [];

  const hasOpenProvider = providerHealth
    ? Object.values(providerHealth.providers).some((s) => s.breaker === 'open')
    : false;

  const pendingHumanForTask = new Map<string, string[]>();
  for (const a of steeringActions) {
    if (a.status === 'pending' && a.task_id) {
      const existing = pendingHumanForTask.get(a.task_id) || [];
      existing.push(a.action_id);
      pendingHumanForTask.set(a.task_id, existing);
    }
  }

  const hasGlobalHumanRequest = nextAction?.kind === 'request_human';
  const humanTargetTasks = nextAction?.task_ids || [];

  return Object.values(taskStates).map((task) => {
    const hasPendingHuman = hasGlobalHumanRequest && humanTargetTasks.includes(task.task_id);
    const taskSteering = pendingHumanForTask.get(task.task_id) || [];

    return deriveCueForTask(task, {
      pendingSteeringForTask: taskSteering,
      hasPendingHumanRequest: hasPendingHuman,
      hasOpenProvider,
    });
  });
}

/** Group cues by category for summary aggregation */
export function groupCuesByCategory(
  cues: TaskCollabCue[],
): Record<CollaborationCue, TaskCollabCue[]> {
  const groups: Record<CollaborationCue, TaskCollabCue[]> = {
    needs_review: [],
    needs_human: [],
    blocked: [],
    watch: [],
    ready: [],
    passive: [],
  };

  for (const cue of cues) {
    groups[cue.cue].push(cue);
  }

  return groups;
}

/** CLI-friendly cue label */
export function cueIcon(cue: CollaborationCue): string {
  switch (cue) {
    case 'needs_review': return '[review]';
    case 'needs_human': return '[human]';
    case 'blocked': return '[blocked]';
    case 'watch': return '[watch]';
    case 'ready': return '[ready]';
    case 'passive': return '[ok]';
  }
}

/** Human-readable cue description for collaboration surfaces */
export function cueLabel(cue: CollaborationCue): string {
  switch (cue) {
    case 'needs_review': return 'Needs Review';
    case 'needs_human': return 'Needs Human';
    case 'blocked': return 'Blocked';
    case 'watch': return 'Watch';
    case 'ready': return 'Ready';
    case 'passive': return 'OK';
  }
}
