// ═══════════════════════════════════════════════════════════════════
// orchestrator/steering-actions.ts — Phase 8B: Steering Validator + Applier
// ═══════════════════════════════════════════════════════════════════

import type {
  ExecutionMode,
  RunSpec,
  RunState,
  SteeringAction,
  SteeringActionType,
} from './types.js';
import { getModeContract, normalizeExecutionMode } from './mode-policy.js';

const TERMINAL_STATUSES = new Set(['done', 'blocked']);

interface ValidationResult {
  allowed: boolean;
  reason?: string;
}

function terminalGuard(state: RunState, actionType: SteeringActionType): ValidationResult {
  if (TERMINAL_STATUSES.has(state.status)) {
    return { allowed: false, reason: `Cannot ${actionType} on terminal run (${state.status})` };
  }
  return { allowed: true };
}

function taskExistsGuard(state: RunState, taskId: string | undefined, actionType: SteeringActionType): ValidationResult {
  if (taskId && !state.task_states[taskId]) {
    return { allowed: false, reason: `Task "${taskId}" does not exist in this run` };
  }
  return { allowed: true };
}

/** Validate whether a steering action can be applied given current run state */
export function validateSteeringAction(
  action: SteeringAction,
  spec: RunSpec,
  state: RunState,
): ValidationResult {
  // Always allow inject_steering_note — it's advisory
  if (action.action_type === 'inject_steering_note') {
    return { allowed: true };
  }

  const terminal = terminalGuard(state, action.action_type);
  if (!terminal.allowed) return terminal;

  const task = taskExistsGuard(state, action.task_id, action.action_type);
  if (!task.allowed) return task;

  switch (action.action_type) {
    case 'pause_run':
      if (state.steering?.paused) {
        return { allowed: false, reason: 'Run is already paused' };
      }
      return { allowed: true };

    case 'resume_run':
      if (!state.steering?.paused) {
        return { allowed: false, reason: 'Run is not currently paused' };
      }
      return { allowed: true };

    case 'retry_task': {
      const taskId = action.task_id;
      if (!taskId) {
        return { allowed: false, reason: 'retry_task requires a task_id in payload' };
      }
      const taskState = state.task_states[taskId];
      if (!taskState) {
        return { allowed: false, reason: `Task "${taskId}" not found` };
      }
      if (taskState.status === 'merged' || taskState.status === 'verified') {
        return { allowed: false, reason: `Task "${taskId}" is already ${taskState.status}, cannot retry` };
      }
      return { allowed: true };
    }

    case 'skip_task': {
      const taskId = action.task_id;
      if (!taskId) {
        return { allowed: false, reason: 'skip_task requires a task_id in payload' };
      }
      const taskState = state.task_states[taskId];
      if (!taskState) {
        return { allowed: false, reason: `Task "${taskId}" not found` };
      }
      if (taskState.status === 'merged') {
        return { allowed: false, reason: `Task "${taskId}" is already merged, cannot skip` };
      }
      return { allowed: true };
    }

    case 'escalate_mode': {
      const targetMode = action.payload.target_mode;
      if (!targetMode) {
        return { allowed: false, reason: 'escalate_mode requires target_mode in payload' };
      }
      const currentMode = state.runtime_mode_override || spec.execution_mode || 'auto';
      const normalizedTarget = normalizeExecutionMode(targetMode);
      const currentContract = getModeContract(normalizeExecutionMode(currentMode));
      const targetContract = getModeContract(normalizedTarget);
      // Escalation must increase or maintain review intensity
      const intensityOrder = { skip: 0, light: 1, standard: 2, 'full-cascade': 3 };
      const currentLevel = intensityOrder[currentContract.review_intensity] ?? 0;
      const targetLevel = intensityOrder[targetContract.review_intensity] ?? 0;
      if (targetLevel <= currentLevel) {
        return { allowed: false, reason: `Target mode "${targetMode}" (${normalizedTarget}) does not escalate from current "${currentMode}"` };
      }
      return { allowed: true };
    }

    case 'downgrade_mode': {
      const targetMode = action.payload.target_mode;
      if (!targetMode) {
        return { allowed: false, reason: 'downgrade_mode requires target_mode in payload' };
      }
      // Downgrade is allowed but logged — no mechanical block, just validation
      return { allowed: true };
    }

    case 'request_replan':
      // Allowed if there's a plan and we're not in terminal state
      return { allowed: true };

    case 'force_discuss':
      // Always allowed — affects next task dispatch
      return { allowed: true };

    case 'mark_requires_human':
      // Always allowed — it's a state flag
      return { allowed: true };

    default:
      return { allowed: false, reason: `Unknown action type: ${action.action_type}` };
  }
}

/**
 * Apply a validated steering action to the run state.
 * Returns { applied: boolean, effect: string }.
 */
export function applySteeringAction(
  action: SteeringAction,
  state: RunState,
  spec: RunSpec,
): { applied: boolean; effect: string; nextActionKind?: string } {
  if (!state.steering) {
    state.steering = { paused: false, pending_actions: [] };
  }

  switch (action.action_type) {
    case 'pause_run':
      state.steering.paused = true;
      state.steering.last_applied = {
        action_id: action.action_id,
        action_type: action.action_type,
        outcome: 'Run paused at safe point',
        applied_at: Date.now(),
      };
      return { applied: true, effect: 'Run paused at safe point' };

    case 'resume_run':
      state.steering.paused = false;
      state.steering.last_applied = {
        action_id: action.action_id,
        action_type: action.action_type,
        outcome: 'Run resumed from pause',
        applied_at: Date.now(),
      };
      return { applied: true, effect: 'Run resumed from pause' };

    case 'retry_task': {
      const taskId = action.task_id!;
      state.steering.last_applied = {
        action_id: action.action_id,
        action_type: action.action_type,
        outcome: `Task "${taskId}" queued for retry`,
        applied_at: Date.now(),
      };
      return {
        applied: true,
        effect: `Task "${taskId}" queued for retry`,
        nextActionKind: 'retry_task',
      };
    }

    case 'skip_task': {
      const taskId = action.task_id!;
      const taskState = state.task_states[taskId];
      if (taskState) {
        taskState.status = 'superseded';
        taskState.last_error = 'Skipped by human steering';
      }
      state.steering.last_applied = {
        action_id: action.action_id,
        action_type: action.action_type,
        outcome: `Task "${taskId}" skipped`,
        applied_at: Date.now(),
      };
      return { applied: true, effect: `Task "${taskId}" marked as superseded (skipped)` };
    }

    case 'escalate_mode': {
      const targetMode = action.payload.target_mode!;
      const fromMode = state.runtime_mode_override || spec.execution_mode || 'auto';
      state.runtime_mode_override = targetMode;
      if (!state.mode_escalation_history) state.mode_escalation_history = [];
      state.mode_escalation_history.push({
        from: normalizeExecutionMode(fromMode),
        to: normalizeExecutionMode(targetMode),
        reason: `Steering: ${action.action_type}`,
        round: state.round,
      });
      state.steering.last_applied = {
        action_id: action.action_id,
        action_type: action.action_type,
        outcome: `Mode escalated to ${targetMode}`,
        applied_at: Date.now(),
      };
      return { applied: true, effect: `Mode escalated to ${targetMode}` };
    }

    case 'downgrade_mode': {
      const targetMode = action.payload.target_mode!;
      const fromMode = state.runtime_mode_override || spec.execution_mode || 'auto';
      state.runtime_mode_override = targetMode;
      if (!state.mode_escalation_history) state.mode_escalation_history = [];
      state.mode_escalation_history.push({
        from: normalizeExecutionMode(fromMode),
        to: normalizeExecutionMode(targetMode),
        reason: `Steering: ${action.action_type}`,
        round: state.round,
      });
      state.steering.last_applied = {
        action_id: action.action_id,
        action_type: action.action_type,
        outcome: `Mode downgraded to ${targetMode}`,
        applied_at: Date.now(),
      };
      return { applied: true, effect: `Mode downgraded to ${targetMode} (caution: reduces safeguards)` };
    }

    case 'request_replan':
      state.steering.last_applied = {
        action_id: action.action_id,
        action_type: action.action_type,
        outcome: 'Replan requested',
        applied_at: Date.now(),
      };
      return { applied: true, effect: 'Replan requested', nextActionKind: 'replan' };

    case 'force_discuss':
      state.steering.last_applied = {
        action_id: action.action_id,
        action_type: action.action_type,
        outcome: 'Discuss gate forced on next task',
        applied_at: Date.now(),
      };
      return { applied: true, effect: 'Discuss gate will be forced on next task dispatch' };

    case 'mark_requires_human':
      state.steering.last_applied = {
        action_id: action.action_id,
        action_type: action.action_type,
        outcome: 'Human intervention required flag set',
        applied_at: Date.now(),
      };
      return { applied: true, effect: 'Human intervention flag set on run' };

    case 'inject_steering_note':
      state.steering.last_applied = {
        action_id: action.action_id,
        action_type: action.action_type,
        outcome: `Note injected: ${action.payload.note?.slice(0, 80) || '(empty)'}`,
        applied_at: Date.now(),
      };
      return { applied: true, effect: `Steering note recorded: ${action.payload.note || '(empty)'}` };

    default:
      return { applied: false, effect: `Unknown action: ${action.action_type}` };
  }
}
