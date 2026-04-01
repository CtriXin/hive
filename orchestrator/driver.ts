import fs from 'fs';
import path from 'path';
import type {
  DoneCondition,
  NextAction,
  OrchestratorResult,
  ReviewFinding,
  ReviewResult,
  RunMode,
  RunSpec,
  RunState,
  SubTask,
  TaskPlan,
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

// ── Done Conditions ──

export function inferDefaultDoneConditions(cwd: string): DoneCondition[] {
  const scripts = readPackageScripts(cwd);
  const conditions: DoneCondition[] = [];
  const timeout = 10 * 60 * 1000;

  if (scripts.build) {
    conditions.push({
      type: 'build', label: 'npm run build',
      command: 'npm run build', must_pass: true, timeout_ms: timeout,
    });
  }
  if (scripts.test) {
    conditions.push({
      type: 'test', label: 'npm test',
      command: 'npm test', must_pass: true, timeout_ms: timeout,
    });
  }
  if (scripts.lint) {
    conditions.push({
      type: 'lint', label: 'npm run lint',
      command: 'npm run lint', must_pass: true, timeout_ms: timeout,
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
    retry_counts: {},
    replan_count: 0,
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
    } else {
      repairReviewResults.push({
        taskId: task.id,
        final_stage: 'cross-review',
        passed: false,
        findings: [],
        iterations: 0,
        duration_ms: 0,
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

  // Only run build checks in isolation — tests/lint need full codebase
  const smokeChecks = conditions.filter((c) => c.type === 'build');
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
  return `${passedReviews}/${result.review_results.length} reviews passed; ${failedReviews} failed; ${vText}${mergeText}.`;
}

// ── Main execution loop ──

export async function executeRun(
  spec: RunSpec,
  state?: RunState,
): Promise<RunExecutionResult> {
  const currentState = state || createInitialRunState(spec);
  const registry = new ModelRegistry();

  let plan: TaskPlan | null = loadRunPlan(spec.cwd, spec.id) ?? null;
  let latestResult: OrchestratorResult | undefined;

  // ── Loop: keep going until terminal or budget exhausted ──
  while (
    currentState.round < spec.max_rounds &&
    !isTerminalStatus(currentState.status)
  ) {
    currentState.round += 1;
    const action = currentState.next_action?.kind || 'execute';
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

      plan = planning.plan;
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

      const replanGoal = `${spec.goal}\n\n### Previous attempt failed verification:\n${failureContext}\n\nPlease create a revised plan that addresses these failures.`;

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

      plan = planning.plan;
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
    currentState.completed_task_ids = workerResults
      .filter((w) => w.success)
      .map((w) => w.taskId);
    currentState.failed_task_ids = workerResults
      .filter((w) => !w.success)
      .map((w) => w.taskId);

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
    );

    // Step 3c: Suite-level verification on merged codebase
    const suiteResults = runVerificationSuite(spec.done_conditions, spec.cwd);
    currentState.verification_results = suiteResults;
    const suiteVerificationPassed = allRequiredChecksPassed(suiteResults);

    // Build orchestrator result
    const orchestratorResult: OrchestratorResult = {
      plan,
      worker_results: workerResults,
      review_results: reviewResults,
      score_updates: [],
      total_duration_ms: workerResults.reduce(
        (sum, w) => sum + w.duration_ms,
        0,
      ),
      cost_estimate: {
        opus_tokens: 0,
        sonnet_tokens: 0,
        haiku_tokens: 0,
        domestic_tokens: 0,
        estimated_cost_usd: 0,
      },
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
