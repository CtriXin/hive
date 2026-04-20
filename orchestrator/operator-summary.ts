// orchestrator/operator-summary.ts — Phase 9A: Operator Experience Pack
// Generates concise, action-oriented run summaries from existing artifacts.

import type {
  RunSpec,
  RunState,
  TaskRunRecord,
  VerificationResult,
  FailureClass,
  ReviewResult,
} from './types.js';
import type { LoopProgress } from './loop-progress-store.js';
import type { SteeringStore } from './steering-store.js';
import type { ProviderHealthStoreData } from './types.js';
import {
  extractLatestProviderRoute,
  formatProviderDecision,
  formatProviderRoute,
  latestProviderDecision,
  summarizeProviderHealth,
} from './provider-surface.js';
import {
  extractAuthorityDegradation,
  formatAuthorityDegradation,
  type AuthorityDegradationSignal,
} from './authority-surface.js';

export type OverallRunState =
  | 'done'
  | 'partial'
  | 'blocked'
  | 'paused'
  | 'running';

export interface SuccessItem {
  task_id: string;
  description: string;
  merged: boolean;
  rule_selection_basis?: string;
}

export interface FailureItem {
  task_id: string;
  description: string;
  failure_class: FailureClass | 'unknown';
  last_error: string;
  retry_count: number;
  rule_selection_basis?: string;
}

export interface BlockerItem {
  type: 'task_failure' | 'provider_issue' | 'budget_exhausted' | 'human_input' | 'review_deadlock';
  severity: 'high' | 'medium' | 'low';
  description: string;
  task_id?: string;
  provider?: string;
}

export interface NextActionHint {
  action:
    | 'retry_later'
    | 'request_human_input'
    | 'inspect_forensics'
    | 'replan'
    | 'rerun_stronger_mode'
    | 'steering_recommended'
    | 'provider_wait_fallback'
    | 'resume_run'
    | 'merge_changes';
  priority: 'high' | 'medium' | 'low';
  description: string;
  rationale: string;
  task_id?: string;
}

export interface RunSummary {
  run_id: string;
  overall_state: OverallRunState;
  round: number;
  max_rounds?: number;
  mode?: string;
  primary_blocker?: BlockerItem;
  authority_degradation?: AuthorityDegradationSignal;
  provider_summary?: string;
  latest_route?: string;
  latest_resilience?: string;
  top_successes: SuccessItem[];
  top_failures: FailureItem[];
  next_action_hints: NextActionHint[];
  summary_text: string;
  generated_at: string;
}

function truncate(text: string | undefined, limit: number): string {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '-';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function classifyFailureFromTask(
  task: TaskRunRecord,
  verificationResults?: VerificationResult[],
): FailureClass {
  if (task.failure_class) return task.failure_class;
  if (task.last_error) {
    const err = task.last_error.toLowerCase();
    if (err.includes('build')) return 'build';
    if (err.includes('test')) return 'test';
    if (err.includes('provider')) return 'provider';
    if (err.includes('review')) return 'review';
    if (err.includes('merge')) return 'merge';
  }
  return 'unknown';
}

function determineOverallState(state: RunState | null, spec: RunSpec | null): OverallRunState {
  if (!state) return 'blocked';

  if (state.steering?.paused) return 'paused';
  if (state.status === 'done') return 'done';
  if (state.status === 'blocked') return 'blocked';
  if (state.status === 'partial') return 'partial';

  if (state.status === 'init' || state.status === 'planning' || state.status === 'executing' || state.status === 'verifying' || state.status === 'repairing' || state.status === 'replanning') {
    return 'running';
  }

  return 'partial';
}

function extractTopSuccesses(
  taskStates: Record<string, TaskRunRecord> | undefined,
  planTasks?: Array<{ id: string; description: string }>,
  max = 3,
): SuccessItem[] {
  if (!taskStates) return [];

  const taskMap = new Map(planTasks?.map((t) => [t.id, t.description]) || []);

  const successes = Object.values(taskStates)
    .filter((task) => task.status === 'merged' || task.status === 'verified')
    .map((task) => ({
      task_id: task.task_id,
      description: taskMap.get(task.task_id) || `Task ${task.task_id}`,
      merged: task.merged || task.status === 'merged',
      rule_selection_basis: task.rule_selection?.basis,
    }))
    .sort((a, b) => (b.merged ? 1 : 0) - (a.merged ? 1 : 0));

  return successes.slice(0, max);
}

function extractTopFailures(
  taskStates: Record<string, TaskRunRecord> | undefined,
  planTasks?: Array<{ id: string; description: string }>,
  verificationResultsByTask?: Record<string, VerificationResult[]>,
  max = 3,
): FailureItem[] {
  if (!taskStates) return [];

  const taskMap = new Map(planTasks?.map((t) => [t.id, t.description]) || []);

  const failures = Object.values(taskStates)
    .filter(
      (task) =>
        task.status === 'worker_failed' ||
        task.status === 'review_failed' ||
        task.status === 'verification_failed' ||
        task.status === 'merge_blocked',
    )
    .map((task) => ({
      task_id: task.task_id,
      description: taskMap.get(task.task_id) || `Task ${task.task_id}`,
      failure_class: classifyFailureFromTask(task, verificationResultsByTask?.[task.task_id]),
      last_error: task.last_error || 'Unknown error',
      retry_count: task.retry_count || 0,
      rule_selection_basis: task.rule_selection?.basis,
    }))
    .sort((a, b) => b.retry_count - a.retry_count);

  return failures.slice(0, max);
}

function identifyPrimaryBlocker(
  state: RunState,
  providerHealth?: ProviderHealthStoreData | null,
): BlockerItem | undefined {
  if (state.steering?.paused) {
    return {
      type: 'human_input',
      severity: 'high',
      description: 'Run is paused — resume or apply steering actions',
    };
  }

  if (state.budget_status?.blocked) {
    return {
      type: 'budget_exhausted',
      severity: 'high',
      description: 'Budget exhausted — run cannot continue without intervention',
    };
  }

  if (state.next_action?.kind === 'request_human') {
    return {
      type: 'human_input',
      severity: 'high',
      description: truncate(state.next_action.reason, 120),
      task_id: state.next_action.task_ids?.[0],
    };
  }

  const failedTasks = Object.values(state.task_states || {}).filter(
    (t) => t.status === 'worker_failed' || t.status === 'review_failed' || t.status === 'verification_failed',
  );

  if (failedTasks.length > 0) {
    const mostFailed = failedTasks.sort((a, b) => b.retry_count - a.retry_count)[0];
    if (mostFailed) {
      return {
        type: 'task_failure',
        severity: mostFailed.retry_count >= 2 ? 'high' : 'medium',
        description: `Task ${mostFailed.task_id} failed (${mostFailed.retry_count} retries)`,
        task_id: mostFailed.task_id,
      };
    }
  }

  if (providerHealth) {
    const unhealthy = Object.entries(providerHealth.providers).filter(
      ([, s]) => s.breaker !== 'healthy',
    );
    if (unhealthy.length > 0) {
      const worst = unhealthy.find(([, s]) => s.breaker === 'open') || unhealthy[0];
      if (worst) {
        return {
          type: 'provider_issue',
          severity: worst[1].breaker === 'open' ? 'high' : 'medium',
          description: `Provider ${worst[0]} is ${worst[1].breaker}${worst[1].last_failure_subtype ? ` (${worst[1].last_failure_subtype})` : ''}`,
          provider: worst[0],
        };
      }
    }
  }

  return undefined;
}

export function generateRunSummary(args: {
  runId: string;
  spec: RunSpec | null;
  state: RunState | null;
  progress?: LoopProgress | null;
  plan?: { tasks: Array<{ id: string; description: string }> } | null;
  reviewResults?: ReviewResult[];
  providerHealth?: ProviderHealthStoreData | null;
  steeringStore?: SteeringStore | null;
}): RunSummary {
  const { runId, spec, state, progress, plan, reviewResults, providerHealth, steeringStore } = args;

  const overallState = determineOverallState(state, spec);
  const taskStates = state?.task_states || {};

  const topSuccesses = extractTopSuccesses(taskStates, plan?.tasks);
  const topFailures = extractTopFailures(taskStates, plan?.tasks);

  const primaryBlocker = state
    ? identifyPrimaryBlocker(state, providerHealth)
    : undefined;
  const authorityDegradation = extractAuthorityDegradation(reviewResults);
  const providerSummary = summarizeProviderHealth(providerHealth);
  const latestRoute = formatProviderRoute(
    extractLatestProviderRoute({ reviewResults, providerHealth }),
  );
  const latestResilience = formatProviderDecision(latestProviderDecision(providerHealth));

  const nextActionHints: NextActionHint[] = [];

  // Authority degradation hint (high visibility)
  if (authorityDegradation.degradation) {
    const d = authorityDegradation.degradation;
    nextActionHints.push({
      action: 'request_human_input',
      priority: d.severity === 'high' ? 'high' : 'medium',
      description: d.description,
      rationale: `Authority review mode: ${d.actual_mode}. Failed: ${d.failed_reviewers.map((f) => f.model).join(', ')}.`,
    });
  }

  if (overallState === 'paused') {
    nextActionHints.push({
      action: 'resume_run',
      priority: 'high',
      description: 'Resume the paused run',
      rationale: 'Run is paused via steering — resume to continue execution',
    });
  }

  if (primaryBlocker?.type === 'provider_issue') {
    nextActionHints.push({
      action: 'provider_wait_fallback',
      priority: 'high',
      description: `Wait for provider ${primaryBlocker.provider} to recover or fallback`,
      rationale: `Provider ${primaryBlocker.provider} is ${primaryBlocker.severity} — cooldown or retry after delay`,
    });
  }

  if (primaryBlocker?.type === 'human_input') {
    nextActionHints.push({
      action: 'request_human_input',
      priority: 'high',
      description: 'Address human input request',
      rationale: state?.next_action?.reason || 'Run requires human intervention',
    });
  }

  if (topFailures.length > 0 && overallState !== 'done') {
    const worstFailure = topFailures[0];
    if (worstFailure.retry_count >= 2) {
      nextActionHints.push({
        action: 'replan',
        priority: 'high',
        description: `Replan after ${worstFailure.task_id} failed ${worstFailure.retry_count} times`,
        rationale: `Task ${worstFailure.task_id} repeatedly failed — replan with failure context`,
        task_id: worstFailure.task_id,
      });
    } else if (worstFailure.retry_count === 1) {
      nextActionHints.push({
        action: 'rerun_stronger_mode',
        priority: 'medium',
        description: 'Retry failed task in stronger execution mode',
        rationale: 'Task failed once — escalate mode for deeper analysis',
        task_id: worstFailure.task_id,
      });
    } else {
      nextActionHints.push({
        action: 'inspect_forensics',
        priority: 'medium',
        description: 'Inspect forensics for failed task',
        rationale: 'Review failure details before next action',
        task_id: worstFailure.task_id,
      });
    }
  }

  if (state?.next_action?.kind === 'repair_task' || state?.next_action?.kind === 'retry_task') {
    nextActionHints.push({
      action: 'retry_later',
      priority: 'medium',
      description: 'Continue with repair round',
      rationale: state.next_action.reason,
    });
  }

  if (steeringStore && steeringStore.actions.some((a) => a.status === 'pending')) {
    nextActionHints.push({
      action: 'steering_recommended',
      priority: 'low',
      description: 'Review pending steering actions',
      rationale: `${steeringStore.actions.filter((a) => a.status === 'pending').length} pending steering action(s)`,
    });
  }

  const summaryParts: string[] = [];

  summaryParts.push(`Run ${runId}: ${overallState}`);

  if (topSuccesses.length > 0) {
    summaryParts.push(`${topSuccesses.length} task(s) completed`);
  }

  if (topFailures.length > 0) {
    summaryParts.push(`${topFailures.length} task(s) failed`);
  }

  if (primaryBlocker) {
    summaryParts.push(`blocked by: ${primaryBlocker.description}`);
  }

  if (authorityDegradation.degradation) {
    summaryParts.push(`authority: ${authorityDegradation.degradation.description}`);
  }

  if (providerSummary) {
    summaryParts.push(`providers: ${providerSummary}`);
  }
  if (latestRoute) {
    summaryParts.push(`latest route: ${latestRoute}`);
  }
  if (latestResilience) {
    summaryParts.push(`latest resilience: ${latestResilience}`);
  }

  const summaryText = summaryParts.join(' | ');

  return {
    run_id: runId,
    overall_state: overallState,
    round: state?.round || 0,
    max_rounds: spec?.max_rounds,
    mode: spec?.execution_mode,
    primary_blocker: primaryBlocker,
    authority_degradation: authorityDegradation.degradation,
    provider_summary: providerSummary,
    latest_route: latestRoute,
    latest_resilience: latestResilience,
    top_successes: topSuccesses,
    top_failures: topFailures,
    next_action_hints: nextActionHints.slice(0, 3),
    summary_text: summaryText,
    generated_at: new Date().toISOString(),
  };
}
