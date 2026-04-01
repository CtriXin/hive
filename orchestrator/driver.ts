import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type {
  DoneCondition,
  NextAction,
  OrchestratorResult,
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
import { reviewCascade } from './reviewer.js';
import { allRequiredChecksPassed, runVerification, runVerificationSuite } from './verifier.js';
import { commitAndMergeWorktree } from './worktree-manager.js';
import { loadProjectVerificationPolicy } from './project-policy.js';

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

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function trimTail(text: string, limit = 4000): string {
  if (!text) return '';
  return text.length <= limit ? text : text.slice(-limit);
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
      record.status = 'review_failed';
      record.last_error = review.findings[0]?.issue;
    }
  }
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
    repair_history: [],
    round_cost_history: [],
    policy_hook_results: [],
    verification_results: [],
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
  const issueList = findings
    .filter((f) => f.decision !== 'dismiss')
    .map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.issue}`)
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

    const repairPrompt = buildRepairPrompt(task, review.findings);
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
      const reviewResult = await reviewCascade(
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
  const costText = result.token_breakdown
    ? `; $${result.token_breakdown.actual_cost_usd.toFixed(4)} (saved $${result.token_breakdown.savings_usd.toFixed(4)} vs Claude)`
    : '';
  return `${passedReviews}/${result.review_results.length} reviews passed; ${failedReviews} failed; ${vText}${mergeText}${costText}.`;
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

export async function executeRun(
  spec: RunSpec,
  state?: RunState,
): Promise<RunExecutionResult> {
  const currentState = state || createInitialRunState(spec);
  currentState.review_failed_task_ids ||= [];
  currentState.merged_task_ids ||= [];
  currentState.task_states ||= {};
  currentState.repair_history ||= [];
  currentState.round_cost_history ||= [];
  currentState.policy_hook_results ||= [];
  const registry = new ModelRegistry();
  const projectPolicy = loadProjectVerificationPolicy(spec.cwd);
  const preMergeHooks = projectPolicy?.hooks.filter((hook) => hook.stage === 'pre_merge') || [];
  const postVerifyHooks = projectPolicy?.hooks.filter((hook) => hook.stage === 'post_verify') || [];

  let plan: TaskPlan | null = loadRunPlan(spec.cwd, spec.id) ?? null;
  let latestResult: OrchestratorResult | undefined;

  // ── Loop: keep going until terminal or budget exhausted ──
  while (
    currentState.round < spec.max_rounds &&
    !isTerminalStatus(currentState.status)
  ) {
    currentState.round += 1;
    const action = currentState.next_action?.kind || 'execute';
    let roundExtraStages: StageTokenUsage[] = [];
    console.log(
      `\n🔁 Round ${currentState.round}/${spec.max_rounds} — action: ${action}`,
    );

    // ── Phase 1: Planning (first round or replan) ──
    if (action === 'execute' && !plan) {
      currentState.status = 'planning';
      currentState.next_action = makeNextAction(
        'execute',
        'Generating plan...',
      );
      saveRunState(spec.cwd, currentState);

      const planning = await planGoal(spec.goal, spec.cwd);
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
        return { spec, state: currentState, plan: null };
      }

      roundExtraStages = planning.extra_stage_usages;
      plan = planning.plan;
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
      currentState.status = 'replanning';
      saveRunState(spec.cwd, currentState);

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

      const planning = await planGoal(replanGoal, spec.cwd);
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
      currentState.status = 'repairing';
      saveRunState(spec.cwd, currentState);

      const failedReviews = latestResult.review_results.filter(
        (r) => !r.passed,
      );
      const repair = await runRepairRound(
        spec,
        currentState,
        plan,
        failedReviews,
        latestResult.worker_results,
        registry,
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
      currentState.status = 'executing';
      currentState.next_action = makeNextAction(
        'execute',
        'Dispatching tasks to workers...',
      );
      saveRunState(spec.cwd, currentState);

      const dispatchResult = await dispatchBatch(plan, registry);
      workerResults = dispatchResult.worker_results;

      reviewResults = await Promise.all(
        workerResults.map((wr) => {
          const task = plan!.tasks.find((t) => t.id === wr.taskId);
          if (!task) {
            throw new Error(`Task not found: ${wr.taskId}`);
          }
          return reviewCascade(wr, task, plan!, registry);
        }),
      );
    }

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
    currentState.status = 'verifying';
    saveRunState(spec.cwd, currentState);

    // Step 3a: Per-worktree smoke check (build only — not full suite)
    const smokeResults: Record<string, boolean> = {};
    for (const wr of workerResults) {
      if (!wr.success || !wr.worktreePath) continue;
      const results = smokeVerifyWorktree(spec.done_conditions, wr);
      // No build checks = pass by default (no smoke to fail)
      smokeResults[wr.taskId] = results.length === 0
        || allRequiredChecksPassed(results);
    }

    // Step 3b: Progressive merge — each passed task merges independently
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
    const suiteResults = runVerificationSuite(
      suiteScopedConditions(spec.done_conditions),
      spec.cwd,
    );
    currentState.verification_results = suiteResults;
    const postVerifyResults = runPolicyHooks(postVerifyHooks, spec.cwd, currentState.round);
    currentState.policy_hook_results.push(...postVerifyResults);
    const blockingPostVerifyFailed = postVerifyResults.some((item) =>
      !item.passed && postVerifyHooks.find((hook) => hook.label === item.label && hook.stage === item.stage)?.must_pass,
    );
    const suiteVerificationPassed = allRequiredChecksPassed(suiteResults) && !blockingPostVerifyFailed;

    // Build orchestrator result with cost tracking
    const roundCost = buildCostEstimate(roundExtraStages, workerResults, reviewResults, registry);
    currentState.round_cost_history.push({
      round: currentState.round,
      action,
      cost_estimate: roundCost.cost_estimate,
      token_breakdown: roundCost.token_breakdown,
    });
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
    };
    latestResult = orchestratorResult;
    saveRunResult(spec.cwd, spec.id, orchestratorResult);

    // ── Phase 4: Decide next action ──
    const allReviewsPassed = reviewResults.every((r) => r.passed);

    if (allReviewsPassed && suiteVerificationPassed) {
      currentState.status = 'done';
      currentState.next_action = makeNextAction(
        'finalize',
        mergedTaskIds.length > 0
          ? `All gates passed. Merged: ${mergedTaskIds.join(', ')}.`
          : 'All review and verification gates passed.',
      );
    } else if (!allReviewsPassed) {
      const failedTaskIds = reviewResults
        .filter((r) => !r.passed)
        .map((r) => r.taskId);
      currentState.status = 'partial';
      currentState.next_action = makeNextAction(
        'repair_task',
        `${failedTaskIds.length} task(s) failed review. Attempting repair.`
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
  if (!isTerminalStatus(currentState.status)) {
    currentState.next_action = makeNextAction(
      'request_human',
      `Max rounds reached (${spec.max_rounds}). Status: ${currentState.status}.`,
    );
    saveRunState(spec.cwd, currentState);
  }

  return {
    spec,
    state: currentState,
    plan,
    result: latestResult,
  };
}

// ── Convenience entry ──

export async function runGoal(
  options: CreateRunOptions,
): Promise<RunExecutionResult> {
  const { spec, state } = bootstrapRun(options);
  return executeRun(spec, state);
}
