// orchestrator/operator-hints.ts — Phase 9A: Operator Experience Pack
// Generates explainable next-action hints based on run state and failure patterns.

import type {
  RunSpec,
  RunState,
  TaskRunRecord,
  FailureClass,
  ProviderFailureSubtype,
} from './types.js';
import type { ProviderHealthStoreData } from './types.js';

export type HintAction =
  | 'retry_later'
  | 'request_human_input'
  | 'inspect_forensics'
  | 'replan'
  | 'rerun_stronger_mode'
  | 'steering_recommended'
  | 'provider_wait_fallback'
  | 'resume_run'
  | 'merge_changes'
  | 'review_findings'
  | 'check_budget';

export interface OperatorHint {
  action: HintAction;
  priority: 'high' | 'medium' | 'low';
  description: string;
  rationale: string;
  evidence: string[];
  task_id?: string;
  provider?: string;
}

export interface HintsResult {
  hints: OperatorHint[];
  top_hint?: OperatorHint;
  generated_at: string;
}

function truncate(text: string | undefined, limit: number): string {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '-';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

interface HintContext {
  state: RunState;
  spec: RunSpec;
  providerHealth?: ProviderHealthStoreData | null;
}

function generatePausedHint(ctx: HintContext): OperatorHint | null {
  if (!ctx.state.steering?.paused) return null;

  const pendingCount = ctx.state.steering.pending_actions?.length || 0;

  return {
    action: 'resume_run',
    priority: 'high',
    description: 'Resume the paused run',
    rationale: 'Run is paused via steering action',
    evidence: pendingCount > 0
      ? [`${pendingCount} pending steering action(s) queued`]
      : ['No pending steering actions — safe to resume'],
  };
}

function generateHumanInputHint(ctx: HintContext): OperatorHint | null {
  const nextAction = ctx.state.next_action;
  if (nextAction?.kind !== 'request_human') return null;

  const taskIds = nextAction.task_ids?.join(', ') || 'unknown';
  const why = nextAction.reason;

  return {
    action: 'request_human_input',
    priority: 'high',
    description: truncate(why, 80),
    rationale: `Tasks ${taskIds} require human intervention`,
    evidence: [
      `why_blocked: ${truncate(why, 100)}`,
      `affected tasks: ${taskIds}`,
      nextAction.instructions ? `instructions: ${truncate(nextAction.instructions, 80)}` : '',
    ].filter(Boolean),
    task_id: nextAction.task_ids?.[0],
  };
}

function generateProviderHint(ctx: HintContext): OperatorHint | null {
  const healthData = ctx.providerHealth;
  if (!healthData) return null;

  const entries = Object.entries(healthData.providers);
  const openProviders = entries.filter(([, s]) => s.breaker === 'open');
  const degradedProviders = entries.filter(([, s]) => s.breaker === 'degraded');

  if (openProviders.length > 0) {
    const provider = openProviders[0][0];
    const state = openProviders[0][1];
    return {
      action: 'provider_wait_fallback',
      priority: 'high',
      description: `Provider ${provider} circuit breaker open — wait or fallback`,
      rationale: `Provider ${provider} entered open state after ${state.consecutive_failures} consecutive failure(s)`,
      evidence: [
        `state: open`,
        `consecutive failures: ${state.consecutive_failures}`,
        state.last_failure_subtype ? `last failure: ${state.last_failure_subtype}` : '',
        state.opened_at ? `opened at: ${new Date(state.opened_at).toISOString()}` : '',
      ].filter(Boolean),
      provider,
    };
  }

  if (degradedProviders.length > 0) {
    const provider = degradedProviders[0][0];
    const state = degradedProviders[0][1];
    return {
      action: 'provider_wait_fallback',
      priority: 'medium',
      description: `Provider ${provider} degraded — monitor closely`,
      rationale: `Provider ${provider} showing signs of instability`,
      evidence: [
        `state: degraded`,
        `consecutive failures: ${state.consecutive_failures}`,
        state.last_failure_subtype ? `last failure: ${state.last_failure_subtype}` : '',
      ].filter(Boolean),
      provider,
    };
  }

  return null;
}

function generateTaskFailureHint(ctx: HintContext): OperatorHint | null {
  const taskStates = ctx.state.task_states;
  if (!taskStates) return null;

  const failedTasks = Object.values(taskStates).filter(
    (t) =>
      t.status === 'worker_failed' ||
      t.status === 'review_failed' ||
      t.status === 'verification_failed',
  );

  if (failedTasks.length === 0) return null;

  const worstTask = failedTasks.sort((a, b) => b.retry_count - a.retry_count)[0];
  if (!worstTask) return null;

  const evidence: string[] = [
    `status: ${worstTask.status}`,
    `retry count: ${worstTask.retry_count}`,
    worstTask.failure_class ? `failure class: ${worstTask.failure_class}` : '',
    worstTask.last_error ? `error: ${truncate(worstTask.last_error, 60)}` : '',
  ].filter(Boolean);

  if (worstTask.retry_count >= 2) {
    return {
      action: 'replan',
      priority: 'high',
      description: `Replan after ${worstTask.task_id} failed ${worstTask.retry_count} times`,
      rationale: `Task ${worstTask.task_id} repeatedly failed — consider replanning with failure context`,
      evidence,
      task_id: worstTask.task_id,
    };
  }

  if (worstTask.retry_count === 1) {
    return {
      action: 'rerun_stronger_mode',
      priority: 'medium',
      description: `Retry ${worstTask.task_id} in stronger execution mode`,
      rationale: `Task ${worstTask.task_id} failed once — escalate mode for better reliability`,
      evidence,
      task_id: worstTask.task_id,
    };
  }

  return {
    action: 'inspect_forensics',
    priority: 'medium',
    description: `Inspect forensics for ${worstTask.task_id}`,
    rationale: `Review failure details before taking action`,
    evidence,
    task_id: worstTask.task_id,
  };
}

function generateBudgetHint(ctx: HintContext): OperatorHint | null {
  const budgetStatus = ctx.state.budget_status;
  if (!budgetStatus) return null;

  if (budgetStatus.blocked) {
    return {
      action: 'check_budget',
      priority: 'high',
      description: 'Budget exhausted — run cannot continue',
      rationale: ctx.state.budget_warning || 'All budget limits reached',
      evidence: [
        `status: blocked`,
        `spent: $${budgetStatus.current_spent_usd.toFixed(2)} / $${budgetStatus.monthly_limit_usd.toFixed(2)}`,
        ctx.state.budget_warning ? `warning: ${truncate(ctx.state.budget_warning, 80)}` : '',
      ].filter(Boolean),
    };
  }

  if (!budgetStatus.warning && budgetStatus.remaining_ratio < 0.2) {
    return {
      action: 'check_budget',
      priority: 'medium',
      description: 'Budget warning — approaching limits',
      rationale: `Only ${(budgetStatus.remaining_ratio * 100).toFixed(0)}% of budget remaining`,
      evidence: [
        `remaining: $${budgetStatus.remaining_usd.toFixed(2)} / $${budgetStatus.monthly_limit_usd.toFixed(2)}`,
      ],
    };
  }

  return null;
}

function generateMergeHint(ctx: HintContext): OperatorHint | null {
  const mergedCount = ctx.state.merged_task_ids?.length || 0;
  const failedCount = ctx.state.failed_task_ids?.length || 0;

  if (mergedCount > 0 && failedCount === 0 && ctx.state.status === 'done') {
    return {
      action: 'merge_changes',
      priority: 'low',
      description: `${mergedCount} task(s) merged — review changes`,
      rationale: 'All tasks completed successfully',
      evidence: [`${mergedCount} task(s) merged to main branch`],
    };
  }

  if (mergedCount > 0 && failedCount > 0) {
    return {
      action: 'merge_changes',
      priority: 'low',
      description: `${mergedCount} task(s) merged, ${failedCount} failed — partial progress`,
      rationale: 'Some tasks merged successfully while others failed',
      evidence: [
        `${mergedCount} merged`,
        `${failedCount} failed`,
      ],
    };
  }

  return null;
}

function generateSteeringHint(ctx: HintContext): OperatorHint | null {
  const steering = ctx.state.steering;
  if (!steering) return null;

  const pendingCount = steering.pending_actions?.length || 0;
  if (pendingCount === 0) return null;

  return {
    action: 'steering_recommended',
    priority: 'low',
    description: `Review ${pendingCount} pending steering action(s)`,
    rationale: 'Steering actions are waiting to be processed',
    evidence: [
      `${pendingCount} pending action(s)`,
      steering.last_applied ? `last applied: ${steering.last_applied.action_type}` : '',
      steering.last_rejected ? `last rejected: ${steering.last_rejected.action_type}` : '',
    ].filter(Boolean),
  };
}

function generateRepairHint(ctx: HintContext): OperatorHint | null {
  const nextAction = ctx.state.next_action;
  if (nextAction?.kind !== 'repair_task' && nextAction?.kind !== 'retry_task') return null;

  const taskIds = nextAction.task_ids || [];

  return {
    action: 'retry_later',
    priority: 'medium',
    description: `Continue repair round for ${taskIds.length} task(s)`,
    rationale: nextAction.reason,
    evidence: taskIds.map((id) => `- ${id}`),
    task_id: taskIds[0],
  };
}

function generateReplanHint(ctx: HintContext): OperatorHint | null {
  const nextAction = ctx.state.next_action;
  if (nextAction?.kind !== 'replan') return null;

  return {
    action: 'replan',
    priority: 'high',
    description: 'Replan with failure context',
    rationale: nextAction.reason,
    evidence: [nextAction.reason],
  };
}

function generateReviewHint(ctx: HintContext): OperatorHint | null {
  const reviewFailedIds = ctx.state.review_failed_task_ids || [];
  if (reviewFailedIds.length === 0) return null;

  return {
    action: 'review_findings',
    priority: 'high',
    description: `${reviewFailedIds.length} task(s) failed review`,
    rationale: 'Review findings need to be addressed',
    evidence: reviewFailedIds.map((id) => `- ${id}`),
    task_id: reviewFailedIds[0],
  };
}

export function generateOperatorHints(args: {
  spec: RunSpec;
  state: RunState;
  providerHealth?: ProviderHealthStoreData | null;
}): HintsResult {
  const { spec, state, providerHealth } = args;

  const ctx: HintContext = { state, spec, providerHealth };

  const hints: OperatorHint[] = [];

  const generators = [
    generatePausedHint,
    generateHumanInputHint,
    generateProviderHint,
    generateBudgetHint,
    generateReviewHint,
    generateTaskFailureHint,
    generateRepairHint,
    generateReplanHint,
    generateSteeringHint,
    generateMergeHint,
  ];

  for (const gen of generators) {
    const hint = gen(ctx);
    if (hint) hints.push(hint);
  }

  const sortedHints = hints.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });

  return {
    hints: sortedHints.slice(0, 5),
    top_hint: sortedHints[0],
    generated_at: new Date().toISOString(),
  };
}
