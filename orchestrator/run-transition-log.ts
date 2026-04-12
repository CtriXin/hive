// ═══════════════════════════════════════════════════════════════════
// orchestrator/run-transition-log.ts — Phase 2A: Transition Logging
// ═══════════════════════════════════════════════════════════════════
/**
 * Persisted record of state transitions for post-mortem analysis.
 * Enables answering "what happened and why" without replaying execution.
 */

import fs from 'fs';
import path from 'path';
import type {
  RunTransitionRecord,
  RunStatus,
  TaskRunStatus,
  FailureClass,
  RunState,
} from './types.js';

/**
 * Generate unique transition ID
 */
function generateTransitionId(): string {
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Get transition log path for a run
 */
export function getTransitionLogPath(cwd: string, runId: string): string {
  const logDir = path.join(cwd, '.ai', 'runs', runId);
  return path.join(logDir, 'transitions.json');
}

/**
 * Load transition log from disk
 */
export function loadTransitionLog(cwd: string, runId: string): RunTransitionRecord[] {
  const logPath = getTransitionLogPath(cwd, runId);
  try {
    if (!fs.existsSync(logPath)) return [];
    const content = fs.readFileSync(logPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

/**
 * Persist transition log to disk
 */
export function saveTransitionLog(
  cwd: string,
  runId: string,
  transitions: RunTransitionRecord[],
): void {
  const logDir = path.join(cwd, '.ai', 'runs', runId);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const logPath = getTransitionLogPath(cwd, runId);
  fs.writeFileSync(logPath, JSON.stringify(transitions, null, 2), 'utf-8');
}

/**
 * Append a transition record to the log
 */
export function appendTransition(
  cwd: string,
  runId: string,
  transition: RunTransitionRecord,
): void {
  const transitions = loadTransitionLog(cwd, runId);
  transitions.push(transition);
  saveTransitionLog(cwd, runId, transitions);
}

/**
 * Create a run-level transition record
 */
export function createRunTransition(
  runId: string,
  fromState: RunStatus,
  toState: RunStatus,
  reason: string,
  round: number,
  options?: {
    failureClass?: FailureClass;
    retryCount?: number;
    replanCount?: number;
  },
): RunTransitionRecord {
  return {
    id: generateTransitionId(),
    timestamp: new Date().toISOString(),
    run_id: runId,
    from_state: fromState,
    to_state: toState,
    reason,
    failure_class: options?.failureClass,
    retry_count: options?.retryCount,
    replan_count: options?.replanCount,
    round,
  };
}

/**
 * Create a task-level transition record
 */
export function createTaskTransition(
  runId: string,
  taskId: string,
  fromState: TaskRunStatus,
  toState: TaskRunStatus,
  reason: string,
  round: number,
  options?: {
    failureClass?: FailureClass;
    retryCount?: number;
    replanCount?: number;
  },
): RunTransitionRecord {
  return {
    id: generateTransitionId(),
    timestamp: new Date().toISOString(),
    run_id: runId,
    task_id: taskId,
    from_state: fromState,
    to_state: toState,
    reason,
    failure_class: options?.failureClass,
    retry_count: options?.retryCount,
    replan_count: options?.replanCount,
    round,
  };
}

/**
 * Get transitions for a specific task
 */
export function getTaskTransitions(
  transitions: RunTransitionRecord[],
  taskId: string,
): RunTransitionRecord[] {
  return transitions.filter((t) => t.task_id === taskId);
}

/**
 * Get the latest transition for a task
 */
export function getLatestTaskTransition(
  transitions: RunTransitionRecord[],
  taskId: string,
): RunTransitionRecord | null {
  const taskTransitions = getTaskTransitions(transitions, taskId);
  if (taskTransitions.length === 0) return null;
  return taskTransitions.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  )[0];
}

/**
 * Get all transitions with a specific failure class
 */
export function getTransitionsByFailureClass(
  transitions: RunTransitionRecord[],
  failureClass: FailureClass,
): RunTransitionRecord[] {
  return transitions.filter(
    (t) => t.failure_class === failureClass && t.to_state !== t.from_state,
  );
}

/**
 * Summarize transition log for quick inspection
 */
export function summarizeTransitionLog(
  transitions: RunTransitionRecord[],
): string {
  if (transitions.length === 0) return 'No transitions recorded';

  const byRound = new Map<number, RunTransitionRecord[]>();
  for (const t of transitions) {
    const existing = byRound.get(t.round) || [];
    existing.push(t);
    byRound.set(t.round, existing);
  }

  const lines: string[] = [];
  for (const [round, roundTransitions] of byRound.entries()) {
    lines.push(`Round ${round}:`);
    for (const t of roundTransitions) {
      const taskPrefix = t.task_id ? `[${t.task_id}] ` : '';
      const failureSuffix = t.failure_class ? ` (${t.failure_class})` : '';
      lines.push(`  ${taskPrefix}${t.from_state} → ${t.to_state}: ${t.reason}${failureSuffix}`);
    }
  }

  return lines.join('\n');
}

/**
 * Sync transition log to RunState (in-memory)
 */
export function syncTransitionLogToState(
  state: RunState,
  cwd: string,
): void {
  const transitions = loadTransitionLog(cwd, state.run_id);
  state.transition_log = transitions;
}

/**
 * Record a run-level state transition and persist to disk
 */
export function recordRunTransition(
  cwd: string,
  state: RunState,
  toState: RunStatus,
  reason: string,
  options?: {
    failureClass?: FailureClass;
  },
): void {
  const fromState = state.status;
  const transition = createRunTransition(
    state.run_id,
    fromState,
    toState,
    reason,
    state.round,
    {
      failureClass: options?.failureClass,
      replanCount: state.replan_count,
    },
  );
  appendTransition(cwd, state.run_id, transition);
  state.transition_log = loadTransitionLog(cwd, state.run_id);
}

/**
 * Record a task-level state transition and persist to disk
 */
export function recordTaskTransition(
  cwd: string,
  state: RunState,
  taskId: string,
  toState: TaskRunStatus,
  reason: string,
  options?: {
    failureClass?: FailureClass;
  },
): void {
  const taskRecord = state.task_states[taskId];
  const fromState = taskRecord?.status || 'pending';
  const transition = createTaskTransition(
    state.run_id,
    taskId,
    fromState,
    toState,
    reason,
    state.round,
    {
      failureClass: options?.failureClass,
      retryCount: taskRecord?.retry_count,
    },
  );
  appendTransition(cwd, state.run_id, transition);
  state.transition_log = loadTransitionLog(cwd, state.run_id);
}
