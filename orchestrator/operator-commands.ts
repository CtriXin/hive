// orchestrator/operator-commands.ts — Phase 9B: Operator Workflow Polishing
// Maps hint actions and run states to real, executable CLI commands.

export interface CommandSuggestion {
  command: string;
  label: string;
}

/** Map a hint action to 1-2 concrete CLI commands */
export function commandsForHintAction(
  action: string,
  context: { runId?: string; taskId?: string; provider?: string },
): CommandSuggestion[] {
  const runFlag = context.runId ? ` --run-id ${context.runId}` : '';
  const cmds: CommandSuggestion[] = [];

  switch (action) {
    case 'resume_run':
      cmds.push({ command: `hive resume${runFlag} --execute`, label: 'Resume run and re-enter loop' });
      break;

    case 'request_human_input':
      cmds.push({ command: `hive status${runFlag}`, label: 'See what human input is needed' });
      if (context.taskId) {
        cmds.push({ command: `hive workers${runFlag} --worker ${context.taskId}`, label: 'Inspect failed task details' });
      }
      break;

    case 'inspect_forensics':
      cmds.push({ command: `hive workers${runFlag}${context.taskId ? ` --worker ${context.taskId}` : ''}`, label: 'Inspect task details and transcript' });
      cmds.push({ command: `hive watch${runFlag} --once`, label: 'Single snapshot of current state' });
      break;

    case 'replan':
      cmds.push({ command: `hive status${runFlag}`, label: 'Review current state before replanning' });
      if (context.taskId) {
        cmds.push({ command: `hive steer${runFlag} --action request_replan --reason "${context.taskId} failed repeatedly"`, label: 'Submit replan steering' });
      }
      break;

    case 'rerun_stronger_mode':
      if (context.taskId) {
        cmds.push({ command: `hive steer${runFlag} --action escalate_mode --task-id ${context.taskId} --reason "Retry failed task"`, label: 'Escalate mode for retry' });
      }
      cmds.push({ command: `hive status${runFlag}`, label: 'Review current state' });
      break;

    case 'steering_recommended':
      cmds.push({ command: `hive steer${runFlag}`, label: 'List pending steering actions' });
      break;

    case 'provider_wait_fallback':
      cmds.push({ command: `hive status${runFlag}`, label: 'Check provider health details' });
      cmds.push({ command: `hive watch${runFlag} --once`, label: 'Live watch for recovery' });
      break;

    case 'retry_later':
      cmds.push({ command: `hive status${runFlag}`, label: 'Monitor repair progress' });
      cmds.push({ command: `hive watch${runFlag} --once`, label: 'Single snapshot' });
      break;

    case 'merge_changes':
      cmds.push({ command: `hive compact${runFlag}`, label: 'Build compact/restore card for review' });
      cmds.push({ command: `hive status${runFlag}`, label: 'Review final state' });
      break;

    case 'check_budget':
      cmds.push({ command: `hive status${runFlag}`, label: 'Review budget status' });
      break;

    case 'review_findings':
      if (context.taskId) {
        cmds.push({ command: `hive workers${runFlag} --worker ${context.taskId}`, label: 'Inspect review failure details' });
      }
      cmds.push({ command: `hive status${runFlag}`, label: 'Review overall state' });
      break;

    default:
      cmds.push({ command: `hive status${runFlag}`, label: 'Check current status' });
  }

  return cmds;
}

/** Lifecycle-aware command suggestions based on run state */
export function commandsForRunState(
  state: 'done' | 'partial' | 'blocked' | 'paused' | 'running',
  context: { runId?: string; hasSteering?: boolean; hasFailures?: boolean },
): CommandSuggestion[] {
  const runFlag = context.runId ? ` --run-id ${context.runId}` : '';
  const cmds: CommandSuggestion[] = [];

  switch (state) {
    case 'running':
      cmds.push({ command: `hive watch${runFlag}`, label: 'Watch live progress' });
      cmds.push({ command: `hive workers${runFlag}`, label: 'Inspect workers' });
      if (context.hasSteering) {
        cmds.push({ command: `hive steer${runFlag}`, label: 'Manage steering' });
      }
      break;

    case 'paused':
      cmds.push({ command: `hive resume${runFlag} --execute`, label: 'Resume execution' });
      cmds.push({ command: `hive steer${runFlag}`, label: 'View pending steering' });
      cmds.push({ command: `hive status${runFlag}`, label: 'See why it paused' });
      break;

    case 'partial':
      cmds.push({ command: `hive status${runFlag}`, label: 'See failures and blockers' });
      cmds.push({ command: `hive workers${runFlag}`, label: 'Inspect failed workers' });
      cmds.push({ command: `hive steer${runFlag} --action request_replan`, label: 'Request replan' });
      break;

    case 'blocked':
      cmds.push({ command: `hive status${runFlag}`, label: 'See blocker details' });
      cmds.push({ command: `hive steer${runFlag}`, label: 'Apply steering to unblock' });
      cmds.push({ command: `hive steer${runFlag} --action escalate_mode`, label: 'Escalate to stronger mode' });
      break;

    case 'done':
      cmds.push({ command: `hive compact${runFlag}`, label: 'View compact restore card' });
      cmds.push({ command: `hive status${runFlag}`, label: 'Review final state' });
      cmds.push({ command: `hive restore`, label: 'See latest restore prompt' });
      break;
  }

  return cmds;
}

/** Combine hint-based and lifecycle-based commands, deduplicate, limit to top 4 */
export function suggestNextCommands(
  state: 'done' | 'partial' | 'blocked' | 'paused' | 'running',
  args: {
    runId?: string;
    topHintAction?: string;
    taskId?: string;
    provider?: string;
    hasSteering?: boolean;
    hasFailures?: boolean;
  },
): CommandSuggestion[] {
  const context = {
    runId: args.runId,
    taskId: args.taskId,
    provider: args.provider,
  };

  const seen = new Set<string>();
  const result: CommandSuggestion[] = [];

  // Priority 1: hint-specific commands (most relevant to immediate need)
  if (args.topHintAction) {
    const hintCmds = commandsForHintAction(args.topHintAction, context);
    for (const cmd of hintCmds) {
      if (!seen.has(cmd.command) && result.length < 4) {
        seen.add(cmd.command);
        result.push(cmd);
      }
    }
  }

  // Priority 2: lifecycle commands (broader context)
  const lifecycleCmds = commandsForRunState(state, {
    runId: args.runId,
    hasSteering: args.hasSteering,
    hasFailures: args.hasFailures,
  });
  for (const cmd of lifecycleCmds) {
    if (!seen.has(cmd.command) && result.length < 4) {
      seen.add(cmd.command);
      result.push(cmd);
    }
  }

  return result;
}
