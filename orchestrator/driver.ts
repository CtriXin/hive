import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type {
  DoneCondition,
  NextAction,
  OrchestratorResult,
  PlanDiscussResult,
  PolicyHook,
  PolicyHookResult,
  RoundCostEntry,
  ReviewFinding,
  ReviewResult,
  RunMode,
  RunSpec,
  RunState,
  StageTokenUsage,
  SubTask,
  TaskPlan,
  TaskRunRecord,
  TokenBreakdown,
  VerificationResult,
  WorkerResult,
  CollabStatusSnapshot,
  PlannerDiscussRoomRef,
} from './types.js';
import {
  loadRunPlan,
  loadRunResult,
  loadRunSpec,
  loadRunState,
  saveRunPlan,
  saveRunResult,
  saveRunSpec,
  saveRunState,
} from './run-store.js';
import { planGoal } from './planner-runner.js';
import { ModelRegistry } from './model-registry.js';
import { dispatchBatch, spawnWorker } from './dispatcher.js';
import { runReview } from './reviewer.js';
import { maybeRunRecoveryAdvisory } from './recovery-room-handler.js';
import { maybeRunExternalReviewSlot } from './review-room-handler.js';
import { allRequiredChecksPassed, runVerification, runVerificationSuite } from './verifier.js';
import { commitAndMergeWorktree } from './worktree-manager.js';
import { loadProjectVerificationPolicy, loadTaskVerificationRules, type TaskVerificationRule } from './project-policy.js';
import { getBudgetStatus, loadConfig, recordSpending } from './hive-config.js';
import { writeLoopProgress, type LoopPhase } from './loop-progress-store.js';
import { loadWorkerStatusSnapshot, updateWorkerStatus } from './worker-status-store.js';

// ── Options & Result ──

export interface CreateRunOptions {
  goal: string;
  cwd: string;
  mode?: RunMode;
  doneConditions?: DoneCondition[];
  maxRounds?: number;
  maxWorkerRetries?: number;
  maxReplans?: number;
  allowAutoMerge?: boolean;
  stopOnHighRisk?: boolean;
}

export interface RunExecutionResult {
  spec: RunSpec;
  state: RunState;
  plan: TaskPlan | null;
  result?: OrchestratorResult;
  planner_model?: string;
  plan_discuss?: PlanDiscussResult | null;
  plan_discuss_room?: PlannerDiscussRoomRef | null;
  plan_discuss_collab?: CollabStatusSnapshot | null;
  planner_diagnostics?: Record<string, unknown> | null;
}

// ── Helpers ──

function makeRunId(): string {
  return `run-${Date.now()}`;
}

function readPackageScripts(cwd: string): Record<string, string> {
  try {
    const packageJson = path.join(cwd, 'package.json');
    if (!fs.existsSync(packageJson)) return {};
    const parsed = JSON.parse(fs.readFileSync(packageJson, 'utf-8'));
    return parsed?.scripts && typeof parsed.scripts === 'object'
      ? parsed.scripts
      : {};
  } catch {
    return {};
  }
}

function makeNextAction(
  kind: NextAction['kind'],
  reason: string,
  taskIds: string[] = [],
  instructions?: string,
): NextAction {
  return { kind, reason, task_ids: taskIds, instructions };
}

function isTerminalStatus(status: RunState['status']): boolean {
  return status === 'done' || status === 'blocked';
}

function setLoopPhase(
  cwd: string,
  state: RunState,
  status: RunState['status'],
  action: NextAction['kind'],
  reason: string,
  taskIds: string[] = [],
): void {
  state.status = status;
  state.next_action = makeNextAction(action, reason, taskIds);
  saveRunState(cwd, state);
  console.log(`  ⏳ ${status}: ${reason}`);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function trimTail(text: string, limit = 4000): string {
  if (!text) return '';
  return text.length <= limit ? text : text.slice(-limit);
}

export function summarizeAuthorityReview(review: ReviewResult): string {
  const authority = review.authority;
  if (!authority) {
    return review.passed
      ? `review passed at ${review.final_stage}`
      : `review failed at ${review.final_stage}`;
  }

  const parts = [
    `${authority.source}`,
    `mode=${authority.mode}`,
  ];
  if (authority.members.length > 0) {
    parts.push(`members=${authority.members.join('+')}`);
  }
  if (authority.synthesized_by) {
    parts.push(`synth=${authority.synthesized_by}`);
  } else if (authority.synthesis_strategy === 'heuristic') {
    parts.push('synth=heuristic');
  }
  if (authority.disagreement_flags?.length) {
    parts.push(`disagreement=${authority.disagreement_flags.join(',')}`);
  }

  return `${review.passed ? 'review passed' : 'review failed'} | ${parts.join(' | ')}`;
}

export function mergeWorkerTaskSummary(existingSummary: string | undefined, authoritySummary: string): string {
  if (!existingSummary) {
    return authoritySummary;
  }
  if (existingSummary.includes(authoritySummary)) {
    return existingSummary;
  }
  return `${existingSummary} || ${authoritySummary}`;
}

function ensureTaskState(
  state: RunState,
  taskId: string,
): TaskRunRecord {
  const existing = state.task_states[taskId];
  if (existing) return existing;

  const created: TaskRunRecord = {
    task_id: taskId,
    status: 'pending',
    round: state.round,
    changed_files: [],
    merged: false,
    worker_success: false,
    review_passed: false,
  };
  state.task_states[taskId] = created;
  return created;
}

function seedTaskStatesFromPlan(state: RunState, plan: TaskPlan): void {
  for (const task of plan.tasks) {
    ensureTaskState(state, task.id);
  }
}

function updateTaskStatesFromWorkers(
  state: RunState,
  workerResults: WorkerResult[],
): void {
  for (const worker of workerResults) {
    const record = ensureTaskState(state, worker.taskId);
    record.round = state.round;
    record.changed_files = worker.changedFiles;
    record.worker_success = worker.success;
    if (!worker.success) {
      record.status = 'worker_failed';
      record.last_error = worker.output.find((msg) => msg.type === 'error')?.content;
    } else if (worker.changedFiles.length === 0) {
      record.status = 'no_op';
      record.last_error = 'Worker reported success but produced no file changes.';
    }
  }
}

function updateTaskStatesFromReviews(
  state: RunState,
  reviewResults: ReviewResult[],
): void {
  for (const review of reviewResults) {
    const record = ensureTaskState(state, review.taskId);
    record.round = state.round;
    record.review_passed = review.passed;
    if (review.passed && !record.merged) {
      record.status = 'verified';
      record.last_error = undefined;
    } else if (!review.passed) {
      if (record.worker_success && record.changed_files.length === 0) {
        record.status = 'no_op';
        record.last_error = 'No-op task: worker reported success but changed no files.';
      } else {
        record.status = 'review_failed';
        record.last_error = review.findings[0]?.issue;
      }
    }
  }
}

function countNoOpTasks(workerResults: WorkerResult[]): number {
  return workerResults.filter((worker) => worker.success && worker.changedFiles.length === 0).length;
}

function markMergedTasks(
  state: RunState,
  mergedTaskIds: string[],
): void {
  state.merged_task_ids = dedupe([...state.merged_task_ids, ...mergedTaskIds]);
  for (const taskId of mergedTaskIds) {
    const record = ensureTaskState(state, taskId);
    record.round = state.round;
    record.status = 'merged';
    record.merged = true;
    record.review_passed = true;
    record.worker_success = true;
    record.last_error = undefined;
  }
}

function buildMergedTaskContext(
  state: RunState,
  plan: TaskPlan,
): string {
  if (state.merged_task_ids.length === 0) return '';

  return state.merged_task_ids
    .map((taskId) => {
      const task = plan.tasks.find((item) => item.id === taskId);
      const record = state.task_states[taskId];
      const files = record?.changed_files?.length
        ? record.changed_files.join(', ')
        : '(files unknown)';
      return `- ${taskId}: ${task?.description || '(unknown task)'}\n  files: ${files}`;
    })
    .join('\n');
}

function conditionKey(condition: DoneCondition): string {
  return [
    condition.type,
    condition.label,
    condition.command || '',
    condition.path || '',
    condition.scope || 'both',
    condition.must_pass ? 'required' : 'optional',
  ].join('::');
}

function dedupeConditions(conditions: DoneCondition[]): DoneCondition[] {
  const seen = new Set<string>();
  const deduped: DoneCondition[] = [];
  for (const condition of conditions) {
    const key = conditionKey(condition);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(condition);
  }
  return deduped;
}

function getTaskRule(
  task: SubTask | undefined,
  taskRules: Record<string, TaskVerificationRule>,
): TaskVerificationRule | null {
  if (!task?.verification_profile) return null;
  return taskRules[task.verification_profile] || null;
}

function getTaskVerificationConditions(
  baseConditions: DoneCondition[],
  task: SubTask | undefined,
  taskRules: Record<string, TaskVerificationRule>,
): DoneCondition[] {
  const taskRule = getTaskRule(task, taskRules);
  const taskConditions = taskRule?.done_conditions || [];
  return dedupeConditions([...baseConditions, ...taskConditions]);
}

function mergeVerificationResults(
  existing: VerificationResult[],
  updates: VerificationResult[],
): VerificationResult[] {
  if (existing.length === 0) return updates;
  const next = new Map<string, VerificationResult>();
  for (const result of existing) {
    next.set(conditionKey(result.target), result);
  }
  for (const result of updates) {
    next.set(conditionKey(result.target), result);
  }
  return [...next.values()];
}

function recordTaskVerificationResults(
  state: RunState,
  taskId: string,
  results: VerificationResult[],
): void {
  state.task_verification_results[taskId] = mergeVerificationResults(
    state.task_verification_results[taskId] || [],
    results,
  );
}

function markTaskVerificationFailure(
  state: RunState,
  taskId: string,
  results: VerificationResult[],
): void {
  if (results.length === 0 || allRequiredChecksPassed(results)) return;
  const record = ensureTaskState(state, taskId);
  const failed = results.find((result) => result.target.must_pass && !result.passed)
    || results.find((result) => !result.passed);
  record.status = 'verification_failed';
  record.last_error = failed
    ? `${failed.target.label}: ${failed.failure_class || failed.stderr_tail || 'verification failed'}`
    : 'verification failed';
}

function summarizeCollabStatus(snapshot: CollabStatusSnapshot): string {
  const replyLabel = snapshot.card.replies === 1 ? 'reply' : 'replies';
  return `${snapshot.card.room_kind} ${snapshot.card.status}: ${snapshot.card.replies} ${replyLabel}`;
}

// ── Done Conditions ──

export function inferDefaultDoneConditions(cwd: string): DoneCondition[] {
  const projectPolicy = loadProjectVerificationPolicy(cwd);
  if (projectPolicy) {
    return projectPolicy.done_conditions;
  }

  const scripts = readPackageScripts(cwd);
  const conditions: DoneCondition[] = [];
  const timeout = 10 * 60 * 1000;

  if (scripts.build) {
    conditions.push({
      type: 'build', label: 'npm run build',
      command: 'npm run build', must_pass: true, timeout_ms: timeout, scope: 'both',
    });
  }
  if (scripts.test) {
    conditions.push({
      type: 'test', label: 'npm test',
      command: 'npm test', must_pass: true, timeout_ms: timeout, scope: 'suite',
    });
  }
  if (scripts.lint) {
    conditions.push({
      type: 'lint', label: 'npm run lint',
      command: 'npm run lint', must_pass: true, timeout_ms: timeout, scope: 'suite',
    });
  }
  return conditions;
}

// ── Spec & State Factories ──

export function createRunSpec(options: CreateRunOptions): RunSpec {
  return {
    id: makeRunId(),
    goal: options.goal,
    cwd: options.cwd,
    mode: options.mode || 'safe',
    done_conditions:
      options.doneConditions || inferDefaultDoneConditions(options.cwd),
    max_rounds: options.maxRounds ?? 6,
    max_worker_retries: options.maxWorkerRetries ?? 2,
    max_replans: options.maxReplans ?? 1,
    allow_auto_merge: options.allowAutoMerge ?? false,
    stop_on_high_risk: options.stopOnHighRisk ?? true,
    created_at: new Date().toISOString(),
  };
}

export function initialNextAction(): NextAction {
  return {
    kind: 'execute',
    reason: 'Generate initial plan and start the first execution round.',
    task_ids: [],
  };
}

export function createInitialRunState(spec: RunSpec): RunState {
  const budgetStatus = getBudgetStatus(loadConfig(spec.cwd));
  return {
    run_id: spec.id,
    status: 'planning',
    round: 0,
    completed_task_ids: [],
    failed_task_ids: [],
    review_failed_task_ids: [],
    merged_task_ids: [],
    retry_counts: {},
    replan_count: 0,
    task_states: {},
    task_verification_results: {},
    repair_history: [],
    round_cost_history: [],
    policy_hook_results: [],
    verification_results: [],
    budget_status: budgetStatus ?? undefined,
    budget_warning: budgetStatus?.warning ?? null,
    next_action: initialNextAction(),
    updated_at: new Date().toISOString(),
  };
}

// ── Bootstrap & Resume ──

export function bootstrapRun(
  options: CreateRunOptions,
): { spec: RunSpec; state: RunState } {
  const spec = createRunSpec(options);
  const state = createInitialRunState(spec);
  saveRunSpec(spec.cwd, spec);
  saveRunState(spec.cwd, state);
  return { spec, state };
}

/**
 * Load a saved run. By default only restores state (read-only).
 * Pass `execute: true` to re-enter the execution loop.
 */
export async function resumeRun(
  cwd: string,
  runId: string,
  options?: { execute?: boolean },
): Promise<RunExecutionResult | null> {
  const spec = loadRunSpec(cwd, runId);
  const state = loadRunState(cwd, runId);
  if (!spec || !state) return null;

  const plan = loadRunPlan(cwd, runId);
  const result = loadRunResult(cwd, runId) ?? undefined;

  // Default: read-only restore. Also return immediately if terminal.
  if (!options?.execute || isTerminalStatus(state.status)) {
    return { spec, state, plan, result };
  }

  // Re-enter the execution loop from saved state
  return executeRun(spec, state);
}

// ── Repair: build targeted repair tasks from review findings ──

function buildRepairPrompt(
  task: SubTask,
  findings: ReviewFinding[],
): string {
  const isNoOpRepair = findings.some((finding) =>
    finding.issue.toLowerCase().includes('no file changes')
    || finding.issue.toLowerCase().includes('no-op'),
  );
  const issueList = findings
    .filter((f) => f.decision !== 'dismiss')
    .map((f) => {
      const advisoryPrefix = f.lens === 'external-review'
        ? '[External Advisory] '
        : f.lens === 'recovery-advisory'
          ? '[Recovery Advisory] '
          : '';
      return `- [${f.severity}] ${advisoryPrefix}${f.file}${f.line ? `:${f.line}` : ''}: ${f.issue}`;
    })
    .join('\n');

  return [
    `## Repair Task: ${task.id}`,
    '',
    '### Original Task',
    task.description,
    '',
    '### Review Findings to Fix',
    issueList || '(no specific findings — general quality issues)',
    '',
    '### Instructions',
    'Fix all the issues listed above. Do not change unrelated code.',
    'Focus on the specific files and lines mentioned.',
    ...(isNoOpRepair
      ? [
        'Your previous attempt produced no file changes.',
        'This retry must create the required code diff for the task, not just report success.',
      ]
      : []),
    '',
    '### Acceptance Criteria',
    ...task.acceptance_criteria.map((c) => `- ${c}`),
    '- All review findings above must be resolved',
  ].join('\n');
}

/**
 * Repair round: re-dispatch failed tasks with fresh worktrees.
 * Does NOT reuse old sessionId — each repair is a clean, isolated environment.
 */
async function runRepairRound(
  spec: RunSpec,
  state: RunState,
  plan: TaskPlan,
  failedReviews: ReviewResult[],
  _previousWorkerResults: WorkerResult[],
  registry: ModelRegistry,
  hooks?: {
    onRecoverySnapshot?: (taskId: string, snapshot: CollabStatusSnapshot) => void | Promise<void>;
  },
): Promise<{
  workerResults: WorkerResult[];
  reviewResults: ReviewResult[];
}> {
  const repairWorkerResults: WorkerResult[] = [];
  const repairReviewResults: ReviewResult[] = [];

  for (const review of failedReviews) {
    const task = plan.tasks.find((t) => t.id === review.taskId);
    if (!task) continue;

    // Check retry budget
    const retryCount = state.retry_counts[task.id] || 0;
    if (retryCount >= spec.max_worker_retries) {
      console.log(
        `  ⏭️  ${task.id}: retry budget exhausted (${retryCount}/${spec.max_worker_retries})`,
      );
      state.repair_history.push({
        task_id: task.id,
        round: state.round,
        findings_count: review.findings.length,
        outcome: 'skipped',
        note: 'retry budget exhausted',
      });
      continue;
    }
    state.retry_counts[task.id] = retryCount + 1;

    const recovery = await maybeRunRecoveryAdvisory({
      cwd: spec.cwd,
      task,
      reviewResult: review,
      retryCount,
      maxRetries: spec.max_worker_retries,
      repairHistory: state.repair_history.filter((entry) => entry.task_id === task.id),
      onSnapshot: async (snapshot) => {
        await hooks?.onRecoverySnapshot?.(task.id, snapshot);
      },
    });
    const repairPrompt = buildRepairPrompt(task, recovery.findings);
    const modelCap = registry.get(task.assigned_model);

    // Fresh worktree, no sessionId — clean isolation for each repair attempt
    const workerResult = await spawnWorker({
      taskId: task.id,
      model: task.assigned_model,
      provider: modelCap?.provider || task.assigned_model,
      prompt: repairPrompt,
      cwd: plan.cwd,
      worktree: true,
      contextInputs: [],
      discussThreshold: task.discuss_threshold,
      maxTurns: 25,
    });

    repairWorkerResults.push(workerResult);

    if (workerResult.success) {
      const reviewResult = await runReview(
        workerResult,
        task,
        plan,
        registry,
      );
      repairReviewResults.push(reviewResult);
      state.repair_history.push({
        task_id: task.id,
        round: state.round,
        findings_count: review.findings.length,
        outcome: reviewResult.passed ? 'fixed' : 'failed',
        note: reviewResult.passed ? 'repair review passed' : 'repair review still failing',
      });
    } else {
      repairReviewResults.push({
        taskId: task.id,
        final_stage: 'cross-review',
        passed: false,
        findings: [],
        iterations: 0,
        duration_ms: 0,
      });
      state.repair_history.push({
        task_id: task.id,
        round: state.round,
        findings_count: review.findings.length,
        outcome: 'failed',
        note: 'worker repair execution failed',
      });
    }
  }

  return {
    workerResults: repairWorkerResults,
    reviewResults: repairReviewResults,
  };
}

// ── Task-scoped worktree verification ──

/**
 * Smoke-check a single worktree. Only runs 'build' type checks —
 * a single task worktree rarely has all dependencies to pass test/lint.
 * Full suite runs post-merge on the integrated codebase.
 */
function smokeVerifyWorktree(
  conditions: DoneCondition[],
  workerResult: WorkerResult,
): VerificationResult[] {
  if (!workerResult.worktreePath) return [];

  const smokeChecks = conditions.filter((c) =>
    c.scope === 'worktree' || c.scope === 'both',
  );
  if (smokeChecks.length === 0) return [];

  return smokeChecks.map((c) => runVerification(c, workerResult.worktreePath));
}

// ── Per-task progressive merge ──

/**
 * Merge individual tasks that passed review (and optionally smoke verification).
 * Does not wait for all tasks to pass — partial progress lands on main.
 */
function mergePassedTasks(
  spec: RunSpec,
  plan: TaskPlan,
  workerResults: WorkerResult[],
  reviewResults: ReviewResult[],
  smokeResults: Record<string, boolean>,
  preMergeHooks: PolicyHook[],
  policyHookResults: PolicyHookResult[],
  round: number,
): string[] {
  if (!spec.allow_auto_merge) return [];

  const merged: string[] = [];
  for (const review of reviewResults) {
    if (!review.passed) continue;

    // Skip if smoke verification failed for this task
    if (smokeResults[review.taskId] === false) continue;

    const worker = workerResults.find((w) => w.taskId === review.taskId);
    const task = plan.tasks.find((t) => t.id === review.taskId);
    if (!worker?.branch) continue;

    const hookResults = runPolicyHooks(preMergeHooks, worker.worktreePath, round);
    policyHookResults.push(...hookResults);
    const blockingHookFailed = hookResults.some((item) => !item.passed && preMergeHooks.find((hook) => hook.label === item.label && hook.stage === item.stage)?.must_pass);
    if (blockingHookFailed) continue;

    const mergeResult = commitAndMergeWorktree(
      worker.worktreePath,
      worker.branch,
      `task ${worker.taskId}: ${task?.description.slice(0, 80) || worker.taskId}`,
      spec.cwd,
    );
    if (mergeResult.merged) {
      merged.push(worker.taskId);
    }
  }
  return merged;
}

// ── Outcome summary ──

function summarizeOutcome(
  result: OrchestratorResult,
  suiteVerificationPassed: boolean,
  mergedTaskIds: string[],
): string {
  const passedReviews = result.review_results.filter((r) => r.passed).length;
  const failedReviews = result.review_results.length - passedReviews;
  const vText = suiteVerificationPassed
    ? 'verification passed'
    : 'verification failed';
  const mergeText = mergedTaskIds.length > 0
    ? `; merged: ${mergedTaskIds.join(', ')}`
    : '';
  const noOpCount = countNoOpTasks(result.worker_results);
  const noOpText = noOpCount > 0
    ? `; no-op tasks: ${noOpCount}`
    : '';
  const costText = result.token_breakdown
    ? `; $${result.token_breakdown.actual_cost_usd.toFixed(4)} (saved $${result.token_breakdown.savings_usd.toFixed(4)} vs Claude)`
    : '';
  const budgetText = result.budget_warning ? `; ${result.budget_warning}` : '';
  return `${passedReviews}/${result.review_results.length} reviews passed; ${failedReviews} failed; ${vText}${mergeText}${noOpText}${costText}${budgetText}.`;
}

function applyBudgetStatus(state: RunState, cwd: string): void {
  const budgetStatus = getBudgetStatus(loadConfig(cwd));
  state.budget_status = budgetStatus ?? undefined;
  state.budget_warning = budgetStatus?.warning ?? null;
}

function blockIfBudgetExhausted(
  spec: RunSpec,
  state: RunState,
): boolean {
  if (!state.budget_status?.blocked) return false;
  state.status = 'blocked';
  state.next_action = makeNextAction(
    'request_human',
    state.budget_warning || 'Budget exhausted. Human intervention needed before continuing.',
  );
  state.final_summary = state.budget_warning || 'Budget exhausted';
  saveRunState(spec.cwd, state);
  return true;
}

// ── Cost tracking ──

function buildCostEstimate(
  extraStages: StageTokenUsage[],
  workerResults: WorkerResult[],
  reviewResults: ReviewResult[],
  registry: ModelRegistry,
): {
  cost_estimate: OrchestratorResult['cost_estimate'];
  token_breakdown: TokenBreakdown;
} {
  const stages: StageTokenUsage[] = [];
  stages.push(...extraStages);

  // Worker stages
  for (const wr of workerResults) {
    stages.push({
      stage: `worker:${wr.taskId}`,
      model: wr.model,
      input_tokens: wr.token_usage.input,
      output_tokens: wr.token_usage.output,
    });
  }

  // Review stages
  for (const rr of reviewResults) {
    if (rr.token_stages) stages.push(...rr.token_stages);
  }

  // Bucket by model family
  let opusTok = 0;
  let sonnetTok = 0;
  let haikuTok = 0;
  let domesticTok = 0;
  let costUsd = 0;

  for (const st of stages) {
    const total = st.input_tokens + st.output_tokens;
    if (st.model.includes('opus')) opusTok += total;
    else if (st.model.includes('sonnet')) sonnetTok += total;
    else if (st.model.includes('haiku')) haikuTok += total;
    else domesticTok += total;

    const cap = registry.get(st.model);
    if (cap) {
      costUsd += (st.input_tokens * (cap.cost_per_mtok_input || 0)
        + st.output_tokens * (cap.cost_per_mtok_output || 0)) / 1_000_000;
    }
  }

  const totalInput = stages.reduce((s, t) => s + t.input_tokens, 0);
  const totalOutput = stages.reduce((s, t) => s + t.output_tokens, 0);

  // Claude Sonnet equivalent cost for savings comparison
  const sonnetTier = registry.getClaudeTier('sonnet');
  const sonnetCostPer1k = sonnetTier?.cost_per_1k || 0.003;
  const claudeEquivalent = (totalInput + totalOutput) * sonnetCostPer1k / 1000;

  return {
    cost_estimate: {
      opus_tokens: opusTok,
      sonnet_tokens: sonnetTok,
      haiku_tokens: haikuTok,
      domestic_tokens: domesticTok,
      estimated_cost_usd: costUsd,
    },
    token_breakdown: {
      stages,
      total_input: totalInput,
      total_output: totalOutput,
      actual_cost_usd: costUsd,
      claude_equivalent_usd: claudeEquivalent,
      savings_usd: claudeEquivalent - costUsd,
    },
  };
}

function aggregateRoundCosts(
  history: RoundCostEntry[],
): {
  cost_estimate: OrchestratorResult['cost_estimate'];
  token_breakdown: TokenBreakdown;
} {
  const stages = history.flatMap((entry) => entry.token_breakdown.stages);
  const totalInput = history.reduce((sum, entry) => sum + entry.token_breakdown.total_input, 0);
  const totalOutput = history.reduce((sum, entry) => sum + entry.token_breakdown.total_output, 0);
  const actualCost = history.reduce((sum, entry) => sum + entry.token_breakdown.actual_cost_usd, 0);
  const claudeEquivalent = history.reduce((sum, entry) => sum + entry.token_breakdown.claude_equivalent_usd, 0);

  return {
    cost_estimate: {
      opus_tokens: history.reduce((sum, entry) => sum + entry.cost_estimate.opus_tokens, 0),
      sonnet_tokens: history.reduce((sum, entry) => sum + entry.cost_estimate.sonnet_tokens, 0),
      haiku_tokens: history.reduce((sum, entry) => sum + entry.cost_estimate.haiku_tokens, 0),
      domestic_tokens: history.reduce((sum, entry) => sum + entry.cost_estimate.domestic_tokens, 0),
      estimated_cost_usd: actualCost,
    },
    token_breakdown: {
      stages,
      total_input: totalInput,
      total_output: totalOutput,
      actual_cost_usd: actualCost,
      claude_equivalent_usd: claudeEquivalent,
      savings_usd: claudeEquivalent - actualCost,
    },
  };
}

function suiteScopedConditions(conditions: DoneCondition[]): DoneCondition[] {
  return conditions.filter((condition) =>
    condition.scope === undefined
    || condition.scope === 'suite'
    || condition.scope === 'both',
  );
}

function runPolicyHooks(
  hooks: PolicyHook[],
  cwd: string,
  round: number,
): PolicyHookResult[] {
  return hooks.map((hook) => {
    const result = spawnSync('/bin/zsh', ['-lc', hook.command], {
      cwd,
      encoding: 'utf-8',
      timeout: 5 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 8,
    });
    const passed = result.status === 0 && !result.error;
    const stderr = result.error
      ? `${result.stderr || ''}\n${result.error.message}`.trim()
      : (result.stderr || '');
    return {
      stage: hook.stage,
      label: hook.label,
      passed,
      exit_code: result.status,
      stdout_tail: trimTail(result.stdout || ''),
      stderr_tail: trimTail(stderr),
      round,
    };
  });
}

// ── Main execution loop ──

export type ProgressCallback = (stage: string, detail: string) => void;

export async function executeRun(
  spec: RunSpec,
  state?: RunState,
  onProgress?: ProgressCallback,
): Promise<RunExecutionResult> {
  const progressCb = onProgress || (() => {});
  let planDiscussCollab: CollabStatusSnapshot | null | undefined;
  let activeCollabSnapshot: CollabStatusSnapshot | null | undefined;
  const emitProgress = (phase: LoopPhase, reason: string, extra?: {
    focus_task_id?: string; focus_model?: string; focus_summary?: string;
    collab?: CollabStatusSnapshot | null;
  }) => {
    const collab = extra?.collab === undefined
      ? activeCollabSnapshot
      : extra.collab;
    writeLoopProgress(spec.cwd, spec.id, {
      run_id: spec.id, round: currentState.round, phase, reason,
      planner_model: plannerModel,
      collab: collab || undefined,
      focus_task_id: extra?.focus_task_id,
      focus_model: extra?.focus_model,
      focus_summary: extra?.focus_summary,
    });
    progressCb(phase, reason);
  };
  const currentState = state || createInitialRunState(spec);
  currentState.review_failed_task_ids ||= [];
  currentState.merged_task_ids ||= [];
  currentState.task_states ||= {};
  currentState.task_verification_results ||= {};
  currentState.repair_history ||= [];
  currentState.round_cost_history ||= [];
  currentState.policy_hook_results ||= [];
  applyBudgetStatus(currentState, spec.cwd);
  const registry = new ModelRegistry();
  const projectPolicy = loadProjectVerificationPolicy(spec.cwd);
  const taskRules = loadTaskVerificationRules(spec.cwd);
  const preMergeHooks = projectPolicy?.hooks.filter((hook) => hook.stage === 'pre_merge') || [];
  const postVerifyHooks = projectPolicy?.hooks.filter((hook) => hook.stage === 'post_verify') || [];

  let plan: TaskPlan | null = loadRunPlan(spec.cwd, spec.id) ?? null;
  let latestResult: OrchestratorResult | undefined;
  let plannerModel: string | undefined;
  let planDiscuss: PlanDiscussResult | null | undefined;
  let planDiscussRoom: PlannerDiscussRoomRef | null | undefined;
  let plannerDiagnostics: Record<string, unknown> | null | undefined;

  if (blockIfBudgetExhausted(spec, currentState)) {
    return { spec, state: currentState, plan, result: loadRunResult(spec.cwd, spec.id) ?? undefined };
  }

  // ── Loop: keep going until terminal or budget exhausted ──
  while (
    currentState.round < spec.max_rounds &&
    !isTerminalStatus(currentState.status)
  ) {
    applyBudgetStatus(currentState, spec.cwd);
    if (blockIfBudgetExhausted(spec, currentState)) {
      break;
    }
    currentState.round += 1;
    const action = currentState.next_action?.kind || 'execute';
    let roundExtraStages: StageTokenUsage[] = [];
    console.log(
      `\n🔁 Round ${currentState.round}/${spec.max_rounds} — action: ${action}`,
    );
    emitProgress('executing', `Round ${currentState.round}/${spec.max_rounds} — ${action}`);

    // ── Phase 1: Planning (first round or replan) ──
    if (action === 'execute' && !plan) {
      setLoopPhase(
        spec.cwd,
        currentState,
        'planning',
        'execute',
        'Generating plan...',
      );
      emitProgress('planning', 'Generating plan via LLM planner...');

      const planning = await planGoal(spec.goal, spec.cwd, {
        onPlannerDiscussSnapshot: (snapshot) => {
          planDiscussCollab = snapshot;
          activeCollabSnapshot = snapshot;
          const replyLabel = snapshot.card.replies === 1 ? 'reply' : 'replies';
          emitProgress(
            'discussing',
            `Planner discuss ${snapshot.card.status}: ${snapshot.card.replies} ${replyLabel}`,
            {},
          );
        },
      });
      if (!planning.plan) {
        currentState.status = 'blocked';
        currentState.next_action = makeNextAction(
          'request_human',
          `Planner failed: ${planning.planner_error || 'unknown error'}`,
          [],
          planning.planner_raw_output.slice(0, 1000),
        );
        currentState.final_summary =
          planning.planner_error || 'Planner failed';
        saveRunState(spec.cwd, currentState);
        return {
          spec,
          state: currentState,
          plan: null,
          planner_model: plannerModel,
          plan_discuss: planDiscuss,
          plan_discuss_room: planDiscussRoom,
          plan_discuss_collab: planDiscussCollab,
          planner_diagnostics: plannerDiagnostics,
        };
      }

      roundExtraStages = planning.extra_stage_usages;
      plan = planning.plan;
      plannerModel = planning.planner_model;
      planDiscuss = planning.plan_discuss;
      planDiscussRoom = planning.plan_discuss_room;
      planDiscussCollab = planning.plan_discuss_collab;
      activeCollabSnapshot = planning.plan_discuss_collab;
      plannerDiagnostics = planning.planner_diagnostics;
      emitProgress('executing', `Plan ready: ${plan.tasks.length} tasks via ${plannerModel || 'auto'}${planDiscuss ? ` | discuss: ${planDiscuss.quality_gate}` : ''}`);
      seedTaskStatesFromPlan(currentState, plan);
      currentState.current_plan_id = plan.id;
      saveRunPlan(spec.cwd, spec.id, plan);
    }

    if (action === 'replan') {
      if (currentState.replan_count >= spec.max_replans) {
        currentState.status = 'partial';
        currentState.next_action = makeNextAction(
          'request_human',
          `Replan budget exhausted (${currentState.replan_count}/${spec.max_replans}). Human intervention needed.`,
        );
        currentState.final_summary = 'Replan budget exhausted';
        saveRunState(spec.cwd, currentState);
        break;
      }

      currentState.replan_count += 1;
      setLoopPhase(
        spec.cwd,
        currentState,
        'replanning',
        'replan',
        `Replanning remaining work (attempt ${currentState.replan_count}/${spec.max_replans})...`,
      );

      const failureContext = currentState.verification_results
        .filter((v) => !v.passed)
        .map(
          (v) =>
            `[${v.target.type}] ${v.target.label}: ${v.failure_class} — ${v.stderr_tail.slice(0, 200)}`,
        )
        .join('\n');
      const mergedContext = buildMergedTaskContext(currentState, plan!);

      const replanGoal = [
        spec.goal,
        '',
        '### Previous attempt failed verification:',
        failureContext || '(no explicit verification details)',
        '',
        '### Already merged successfully (do not redo these tasks):',
        mergedContext || '(none)',
        '',
        'Please create a revised plan that addresses the remaining failures only.',
      ].join('\n');

      const planning = await planGoal(replanGoal, spec.cwd, {
        onPlannerDiscussSnapshot: (snapshot) => {
          planDiscussCollab = snapshot;
          activeCollabSnapshot = snapshot;
          const replyLabel = snapshot.card.replies === 1 ? 'reply' : 'replies';
          emitProgress(
            'discussing',
            `Planner discuss ${snapshot.card.status}: ${snapshot.card.replies} ${replyLabel}`,
            {},
          );
        },
      });
      if (!planning.plan) {
        currentState.status = 'blocked';
        currentState.next_action = makeNextAction(
          'request_human',
          `Replanner failed: ${planning.planner_error || 'unknown'}`,
        );
        saveRunState(spec.cwd, currentState);
        break;
      }

      roundExtraStages = planning.extra_stage_usages;
      plan = planning.plan;
      plannerModel = planning.planner_model;
      planDiscuss = planning.plan_discuss;
      planDiscussRoom = planning.plan_discuss_room;
      planDiscussCollab = planning.plan_discuss_collab;
      activeCollabSnapshot = planning.plan_discuss_collab;
      plannerDiagnostics = planning.planner_diagnostics;
      seedTaskStatesFromPlan(currentState, plan);
      currentState.current_plan_id = plan.id;
      saveRunPlan(spec.cwd, spec.id, plan);
    }

    if (!plan) {
      currentState.status = 'blocked';
      currentState.next_action = makeNextAction(
        'request_human',
        'No plan available.',
      );
      saveRunState(spec.cwd, currentState);
      break;
    }

    // ── Phase 2: Execute or Repair ──
    let workerResults: WorkerResult[];
    let reviewResults: ReviewResult[];

    if (action === 'repair_task' && latestResult) {
      const requestedTaskIds = new Set(currentState.next_action?.task_ids || []);
      emitProgress('repairing', `Repairing ${Math.max(1, requestedTaskIds.size)} failed task(s)...`);
      setLoopPhase(
        spec.cwd,
        currentState,
        'repairing',
        'repair_task',
        `Repairing ${Math.max(1, requestedTaskIds.size)} failed task(s)...`,
        [...requestedTaskIds],
      );
      const repairTargets = new Map<string, ReviewResult>();
      for (const review of latestResult.review_results.filter((r) => !r.passed)) {
        repairTargets.set(review.taskId, review);
      }
      for (const taskId of requestedTaskIds) {
        if (repairTargets.has(taskId)) continue;
        const taskState = currentState.task_states[taskId];
        repairTargets.set(taskId, {
          taskId,
          final_stage: 'cross-review',
          passed: false,
          findings: [{
            id: 1,
            severity: 'red',
            lens: 'verification',
            file: 'task-verification',
            issue: taskState?.last_error || 'Task-scoped verification failed.',
            decision: 'flag',
            decision_reason: 'Synthesized from verification failure state',
          }],
          iterations: 0,
          duration_ms: 0,
        });
      }
      const failedReviews = [...repairTargets.values()];
      const repair = await runRepairRound(
        spec,
        currentState,
        plan,
        failedReviews,
        latestResult.worker_results,
        registry,
        {
          onRecoverySnapshot: async (taskId, snapshot) => {
            activeCollabSnapshot = snapshot;
            const replyLabel = snapshot.card.replies === 1 ? 'reply' : 'replies';
            emitProgress(
              'repairing',
              `Recovery advisory ${snapshot.card.status}: ${snapshot.card.replies} ${replyLabel}`,
              {
                collab: snapshot,
                focus_task_id: taskId,
              },
            );
            updateWorkerStatus(spec.cwd, spec.id, {
              task_id: taskId,
              status: 'discussing',
              plan_id: plan!.id,
              round: currentState.round,
              task_summary: summarizeCollabStatus(snapshot),
              last_message: snapshot.card.next,
              collab: snapshot,
            });
          },
        },
      );

      // Merge: keep passed results from previous round, replace repaired ones
      const repairedIds = new Set(repair.workerResults.map((w) => w.taskId));
      workerResults = [
        ...latestResult.worker_results.filter(
          (w) => !repairedIds.has(w.taskId),
        ),
        ...repair.workerResults,
      ];
      reviewResults = [
        ...latestResult.review_results.filter(
          (r) => r.passed || !repairedIds.has(r.taskId),
        ),
        ...repair.reviewResults,
      ];

      // If no repairs were attempted (all exhausted), escalate
      if (repair.workerResults.length === 0) {
        currentState.status = 'partial';
        currentState.next_action = makeNextAction(
          'request_human',
          'All failed tasks exhausted retry budget. Human intervention needed.',
          currentState.failed_task_ids,
        );
        saveRunState(spec.cwd, currentState);
        break;
      }
    } else {
      // Fresh execution
      setLoopPhase(
        spec.cwd,
        currentState,
        'executing',
        'execute',
        `Dispatching ${plan.tasks.length} task(s) to workers...`,
      );

      emitProgress('executing', `Dispatching ${plan.tasks.length} task(s): ${plan.tasks.map(t => `${t.id}→${t.assigned_model}`).join(', ')}`);
      const dispatchResult = await dispatchBatch(plan, registry, {
        runId: spec.id,
        round: currentState.round,
        onWorkerDiscussSnapshot: async (snapshot) => {
          activeCollabSnapshot = snapshot;
          const replyLabel = snapshot.card.replies === 1 ? 'reply' : 'replies';
          emitProgress(
            'discussing',
            `Worker discuss ${snapshot.card.status}: ${snapshot.card.replies} ${replyLabel}`,
            {
              collab: snapshot,
              focus_task_id: snapshot.card.focus_task_id,
            },
          );
        },
      }, { recordBudget: false });
      workerResults = dispatchResult.worker_results;
      const succeeded = workerResults.filter(w => w.success).length;
      emitProgress('reviewing', `Workers done: ${succeeded}/${workerResults.length} succeeded`);

      setLoopPhase(
        spec.cwd,
        currentState,
        'executing',
        'execute',
        `Reviewing ${workerResults.length} worker result(s)...`,
        workerResults.map((worker) => worker.taskId),
      );
      emitProgress('reviewing', `Reviewing ${workerResults.length} worker result(s)...`);
      reviewResults = await Promise.all(
        workerResults.map((wr) => {
          const task = plan!.tasks.find((t) => t.id === wr.taskId);
          if (!task) {
            throw new Error(`Task not found: ${wr.taskId}`);
          }
          return runReview(wr, task, plan!, registry);
        }),
      );
    }

    reviewResults = await Promise.all(
      reviewResults.map(async (review) => {
        const task = plan!.tasks.find((item) => item.id === review.taskId);
        const worker = workerResults.find((item) => item.taskId === review.taskId);
        if (!task || !worker) {
          return review;
        }

        const reviewed = await maybeRunExternalReviewSlot({
          cwd: spec.cwd,
          task,
          workerResult: worker,
          reviewResult: review,
          onSnapshot: async (snapshot) => {
            activeCollabSnapshot = snapshot;
            const replyLabel = snapshot.card.replies === 1 ? 'reply' : 'replies';
            emitProgress(
              'reviewing',
              `External review ${snapshot.card.status}: ${snapshot.card.replies} ${replyLabel}`,
              {
                collab: snapshot,
                focus_task_id: snapshot.card.focus_task_id || review.taskId,
              },
            );
            updateWorkerStatus(spec.cwd, spec.id, {
              task_id: review.taskId,
              status: worker.success ? 'completed' : 'failed',
              plan_id: plan!.id,
              round: currentState.round,
              task_summary: summarizeCollabStatus(snapshot),
              last_message: snapshot.card.next,
              collab: snapshot,
            });
          },
        });

        if (reviewed.external_review_collab) {
          updateWorkerStatus(spec.cwd, spec.id, {
            task_id: review.taskId,
            status: worker.success ? 'completed' : 'failed',
            plan_id: plan!.id,
            round: currentState.round,
            task_summary: summarizeCollabStatus(reviewed.external_review_collab),
            last_message: reviewed.external_review_collab.card.next,
            collab: reviewed.external_review_collab,
          });
        }

        return reviewed;
      }),
    );

    reviewResults.forEach((review) => {
      const worker = workerResults.find((item) => item.taskId === review.taskId);
      if (!worker) return;
      const existingSnapshot = loadWorkerStatusSnapshot(spec.cwd, spec.id);
      const existingWorker = existingSnapshot?.workers.find((item) => item.task_id === review.taskId);
      const authoritySummary = summarizeAuthorityReview(review);
      updateWorkerStatus(spec.cwd, spec.id, {
        task_id: review.taskId,
        status: review.passed ? 'completed' : 'failed',
        plan_id: plan!.id,
        round: currentState.round,
        changed_files_count: worker.changedFiles.length,
        success: review.passed,
        task_summary: mergeWorkerTaskSummary(existingWorker?.task_summary, authoritySummary),
        last_message: authoritySummary,
        error: review.passed ? undefined : review.findings[0]?.issue,
        event_message: review.passed ? 'Review passed' : 'Review failed',
      });
    });

    // Update completed/failed tracking
    updateTaskStatesFromWorkers(currentState, workerResults);
    updateTaskStatesFromReviews(currentState, reviewResults);

    currentState.completed_task_ids = workerResults
      .filter((w) => w.success)
      .map((w) => w.taskId);
    const workerFailedTaskIds = workerResults
      .filter((w) => !w.success)
      .map((w) => w.taskId);
    const reviewFailedTaskIds = reviewResults
      .filter((r) => !r.passed)
      .map((r) => r.taskId);
    currentState.review_failed_task_ids = reviewFailedTaskIds;
    currentState.failed_task_ids = dedupe([
      ...workerFailedTaskIds,
      ...reviewFailedTaskIds,
    ]);

    // ── Phase 3: Verification & Progressive Merge ──
    const reviewPassed = reviewResults.filter(r => r.passed).length;
    emitProgress('reviewing', `Reviews: ${reviewPassed}/${reviewResults.length} passed`);
    emitProgress('verifying', 'Running verification (build + tests)...');
    setLoopPhase(
      spec.cwd,
      currentState,
      'verifying',
      'finalize',
      'Running task-scoped verification...',
    );

    // Step 3a: Per-worktree smoke check (build only — not full suite)
    const smokeResults: Record<string, boolean> = {};
    for (const wr of workerResults) {
      if (!wr.success || !wr.worktreePath) continue;
      const task = plan.tasks.find((item) => item.id === wr.taskId);
      const taskConditions = getTaskVerificationConditions(spec.done_conditions, task, taskRules);
      const results = smokeVerifyWorktree(taskConditions, wr);
      recordTaskVerificationResults(currentState, wr.taskId, results);
      markTaskVerificationFailure(currentState, wr.taskId, results);
      // No build checks = pass by default (no smoke to fail)
      smokeResults[wr.taskId] = results.length === 0
        || allRequiredChecksPassed(results);
    }
    const smokeFailedTaskIds = Object.entries(smokeResults)
      .filter(([, passed]) => passed === false)
      .map(([taskId]) => taskId);
    currentState.failed_task_ids = dedupe([
      ...currentState.failed_task_ids,
      ...smokeFailedTaskIds,
    ]);

    // Step 3b: Progressive merge — each passed task merges independently
    setLoopPhase(
      spec.cwd,
      currentState,
      'verifying',
      'finalize',
      'Merging passed tasks back to the repo...',
    );
    const mergedTaskIds = mergePassedTasks(
      spec,
      plan,
      workerResults,
      reviewResults,
      smokeResults,
      preMergeHooks,
      currentState.policy_hook_results,
      currentState.round,
    );
    markMergedTasks(currentState, mergedTaskIds);

    // Step 3c: Suite-level verification on merged codebase
    setLoopPhase(
      spec.cwd,
      currentState,
      'verifying',
      'finalize',
      'Running merged-code verification...',
      mergedTaskIds,
    );
    const suiteResults = runVerificationSuite(
      suiteScopedConditions(spec.done_conditions),
      spec.cwd,
    );
    const taskSuiteResults: VerificationResult[] = [];
    for (const taskId of currentState.merged_task_ids) {
      const task = plan.tasks.find((item) => item.id === taskId);
      const taskRule = getTaskRule(task, taskRules);
      if (!taskRule || taskRule.done_conditions.length === 0) continue;

      const scopedRuleConditions = suiteScopedConditions(taskRule.done_conditions);
      if (scopedRuleConditions.length === 0) continue;

      const results = runVerificationSuite(scopedRuleConditions, spec.cwd);
      recordTaskVerificationResults(currentState, taskId, results);
      markTaskVerificationFailure(currentState, taskId, results);
      taskSuiteResults.push(...results);
    }
    currentState.verification_results = [...suiteResults, ...taskSuiteResults];
    const postVerifyResults = runPolicyHooks(postVerifyHooks, spec.cwd, currentState.round);
    currentState.policy_hook_results.push(...postVerifyResults);
    const blockingPostVerifyFailed = postVerifyResults.some((item) =>
      !item.passed && postVerifyHooks.find((hook) => hook.label === item.label && hook.stage === item.stage)?.must_pass,
    );
    const suiteVerificationPassed = allRequiredChecksPassed([...suiteResults, ...taskSuiteResults]) && !blockingPostVerifyFailed;

    // Build orchestrator result with cost tracking
    const roundCost = buildCostEstimate(roundExtraStages, workerResults, reviewResults, registry);
    const budgetStatus = recordSpending(spec.cwd, roundCost.token_breakdown.actual_cost_usd) ?? getBudgetStatus(loadConfig(spec.cwd)) ?? undefined;
    currentState.round_cost_history.push({
      round: currentState.round,
      action,
      cost_estimate: roundCost.cost_estimate,
      token_breakdown: roundCost.token_breakdown,
      budget_status: budgetStatus,
    });
    currentState.budget_status = budgetStatus;
    currentState.budget_warning = budgetStatus?.warning ?? null;
    const totalCost = aggregateRoundCosts(currentState.round_cost_history);
    const orchestratorResult: OrchestratorResult = {
      plan,
      worker_results: workerResults,
      review_results: reviewResults,
      score_updates: [],
      total_duration_ms: workerResults.reduce(
        (sum, w) => sum + w.duration_ms,
        0,
      ),
      cost_estimate: totalCost.cost_estimate,
      token_breakdown: totalCost.token_breakdown,
      budget_status: budgetStatus,
      budget_warning: budgetStatus?.warning ?? null,
      task_verification_results: currentState.task_verification_results,
    };
    latestResult = orchestratorResult;
    saveRunResult(spec.cwd, spec.id, orchestratorResult);

    // ── Phase 4: Decide next action ──
    const allReviewsPassed = reviewResults.every((r) => r.passed);
    const allSmokeChecksPassed = smokeFailedTaskIds.length === 0;

    if (allReviewsPassed && allSmokeChecksPassed && suiteVerificationPassed) {
      currentState.status = 'done';
      currentState.next_action = makeNextAction(
        'finalize',
        mergedTaskIds.length > 0
          ? `All gates passed. Merged: ${mergedTaskIds.join(', ')}.`
          : 'All review and verification gates passed.',
      );
    } else if (budgetStatus?.blocked) {
      currentState.status = 'blocked';
      currentState.next_action = makeNextAction(
        'request_human',
        budgetStatus.warning || 'Budget exhausted during run.',
      );
    } else if (allReviewsPassed && !allSmokeChecksPassed) {
      currentState.status = 'partial';
      currentState.next_action = makeNextAction(
        'repair_task',
        `${smokeFailedTaskIds.length} task(s) failed task-scoped verification. Attempting repair.`
          + (mergedTaskIds.length > 0
            ? ` (${mergedTaskIds.length} passed task(s) already merged)`
            : ''),
        smokeFailedTaskIds,
      );
    } else if (!allReviewsPassed) {
      const failedTaskIds = reviewResults
        .filter((r) => !r.passed)
        .map((r) => r.taskId);
      const noOpFailedTaskIds = failedTaskIds.filter((taskId) => currentState.task_states[taskId]?.status === 'no_op');
      currentState.status = 'partial';
      currentState.next_action = makeNextAction(
        'repair_task',
        `${failedTaskIds.length} task(s) failed review. Attempting repair.`
          + (noOpFailedTaskIds.length > 0
            ? ` (${noOpFailedTaskIds.length} no-op task(s) detected)`
            : '')
          + (mergedTaskIds.length > 0
            ? ` (${mergedTaskIds.length} passed task(s) already merged)`
            : ''),
        failedTaskIds,
      );
    } else {
      // All reviews passed but suite verification failed
      currentState.status = 'partial';
      currentState.next_action = makeNextAction(
        'replan',
        'Reviews passed but suite verification failed. Replanning with failure context.'
          + (mergedTaskIds.length > 0
            ? ` (${mergedTaskIds.length} task(s) already merged)`
            : ''),
      );
    }

    currentState.final_summary = summarizeOutcome(
      orchestratorResult,
      suiteVerificationPassed,
      mergedTaskIds,
    );
    saveRunState(spec.cwd, currentState);

    console.log(
      `  📊 Round ${currentState.round} result: ${currentState.status} — ${currentState.final_summary}`,
    );
  }

  // If we exited the loop due to max_rounds without reaching terminal
  if (
    !isTerminalStatus(currentState.status)
    && currentState.round >= spec.max_rounds
    && currentState.next_action?.kind !== 'request_human'
  ) {
    currentState.next_action = makeNextAction(
      'request_human',
      `Max rounds reached (${spec.max_rounds}). Status: ${currentState.status}.`,
    );
    saveRunState(spec.cwd, currentState);
  }

  const finalPhase: LoopPhase = isTerminalStatus(currentState.status) ? 'done' : 'blocked';
  emitProgress(finalPhase, currentState.final_summary || currentState.status);

  return {
    spec,
    state: currentState,
    plan,
    result: latestResult,
    planner_model: plannerModel,
    plan_discuss: planDiscuss,
    plan_discuss_room: planDiscussRoom,
    plan_discuss_collab: planDiscussCollab,
    planner_diagnostics: plannerDiagnostics,
  };
}

// ── Convenience entry ──

export async function runGoal(
  options: CreateRunOptions & { onProgress?: ProgressCallback },
): Promise<RunExecutionResult> {
  const { spec, state } = bootstrapRun(options);
  return executeRun(spec, state, options.onProgress);
}
