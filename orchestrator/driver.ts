import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type {
  DoneCondition,
  ExecutionMode,
  LaneName,
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
  TaskRunStatus,
  TaskExecutionContract,
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
import { saveAdvisoryScoreSignals } from './advisory-score.js';
import { runReview } from './reviewer.js';
import { maybeRunRecoveryAdvisory } from './recovery-room-handler.js';
import { maybeRunExternalReviewSlot } from './review-room-handler.js';
import { allRequiredChecksPassed, runVerification, runVerificationSuite } from './verifier.js';
import { commitAndMergeWorktree } from './worktree-manager.js';
import { loadProjectVerificationPolicy, loadTaskVerificationRules, type TaskVerificationRule } from './project-policy.js';
import { selectRuleForTask } from './rule-selector.js';
import { selectPromptPolicy } from './prompt-policy.js';
import { loadLessonStore, refreshLessonStore, loadAllTransitionLogs, loadTaskStates, extractLessons } from './lesson-store.js';
import type { LessonStore, ProjectMemoryStore, FailureClass } from './types.js';
import { initProjectMemory, loadProjectMemory, saveProjectMemory, refreshMemoryFreshness } from './project-memory-store.js';
import { extractProjectMemories } from './memory-extractor.js';
import { recallProjectMemories, formatMemoryRecall } from './memory-recall.js';
import { getBudgetStatus, loadConfig, recordSpending } from './hive-config.js';
import { writeLoopProgress, readLoopProgress, type LoopPhase, type LoopProgress } from './loop-progress-store.js';
import { saveRoundScore } from './score-history.js';
import { loadWorkerStatusSnapshot, updateWorkerStatus } from './worker-status-store.js';
import {
  getModeContract,
  inferExecutionMode,
  normalizeExecutionMode,
  resolveEffectiveMode,
  type InferModeOptions,
} from './mode-policy.js';
import {
  getPendingSteeringActions,
  updateSteeringStatus,
  isDuplicateAction,
  submitSteeringAction,
  loadSteeringStore,
  type SteeringStore,
} from './steering-store.js';
import type { SteeringAction } from './types.js';
import { validateSteeringAction, applySteeringAction } from './steering-actions.js';
import {
  consumeRuntimeModelOverrides,
  resolveEffectiveRunModelPolicy,
  type RunModelPolicyPatch,
} from './run-model-policy.js';

// ── Options & Result ──

export interface CreateRunOptions {
  goal: string;
  cwd: string;
  mode?: RunMode;
  modelPolicyOverride?: RunModelPolicyPatch;
  /** Phase 5A: Operator-facing execution mode */
  execution_mode?: ExecutionMode;
  /** Operator-facing lane name (auto-derived if not provided) */
  lane?: LaneName;
  /** Agent count hint (never overrides dispatch_style) */
  agent_count?: number;
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

interface MergeBlocker {
  taskId: string;
  kind: 'scope_violation' | 'overlap_conflict' | 'hook_failed' | 'merge_conflict';
  reason: string;
  files: string[];
}

interface MergePassResult {
  mergedTaskIds: string[];
  blocked: MergeBlocker[];
}

// Module-level variable to preserve planner discuss conclusion across emitProgress calls
let plannerDiscussConclusion: LoopProgress['planner_discuss_conclusion'] | undefined;

// ── Phase 6A: Lesson helpers ──

function refreshLessonsFromHistory(cwd: string, taskRules: Record<string, TaskVerificationRule>): import('./types.js').Lesson[] {
  const store = refreshLessonStore(cwd, taskRules);
  return store.lessons;
}

function extractFreshLessons(cwd: string, taskRules: Record<string, TaskVerificationRule>): import('./types.js').Lesson[] {
  const transitionLogs = loadAllTransitionLogs(cwd);
  return extractLessons(transitionLogs, {}, taskRules);
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

function collectMergedChangedFiles(state: RunState): string[] {
  return dedupe(
    Object.values(state.task_states || {})
      .filter((task) => task.merged)
      .flatMap((task) => task.changed_files || []),
  );
}

function triggerUserProfileExtraction(spec: RunSpec, state: RunState): void {
  const executionMode = resolveEffectiveMode(spec, state).normalized;
  const changedFiles = collectMergedChangedFiles(state);

  void import('./user-profile-extractor.js')
    .then(({ extractAndSaveUserProfile }) =>
      extractAndSaveUserProfile({
        runId: spec.id,
        goal: spec.goal,
        finalSummary: state.final_summary || '',
        changedFiles,
        executionMode,
      }))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ⚠️ User profile extraction failed: ${message.slice(0, 100)}`);
    });
}

const BUILD_BASELINE_GOAL_PATTERNS = [
  /\bcompile errors?\b/i,
  /\btypescript compile\b/i,
  /\bbuild clean\b/i,
  /\bbaseline repair\b/i,
  /\brestore .*build\b/i,
  /\bbuild baseline\b/i,
  /编译错误/,
  /构建错误/,
  /恢复.*build/,
  /基线修复/,
];

const PHASE_HEARTBEAT_MS = 15_000;

const FAILED_TASK_STATUSES = new Set<TaskRunStatus>([
  'worker_failed',
  'no_op',
  'review_failed',
  'verification_failed',
  'merge_blocked',
]);

function syncFailedTaskIds(state: RunState): void {
  state.failed_task_ids = dedupe(
    Object.values(state.task_states)
      .filter((task) => FAILED_TASK_STATUSES.has(task.status))
      .map((task) => task.task_id),
  );
}

function normalizeRepoPath(file: string): string {
  return path.posix.normalize(file.replace(/\\/g, '/').replace(/^\.\//, ''));
}

function trimTail(text: string, limit = 4000): string {
  if (!text) return '';
  return text.length <= limit ? text : text.slice(-limit);
}

async function runWithHeartbeat<T>(
  run: () => Promise<T>,
  onHeartbeat: (elapsedMs: number) => void,
  intervalMs = PHASE_HEARTBEAT_MS,
): Promise<T> {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    onHeartbeat(Date.now() - startedAt);
  }, intervalMs);
  (timer as any).unref?.();
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

export function summarizeAuthorityReview(review: ReviewResult): string {
  const authority = review.authority;
  const outcome = review.verdict === 'BLOCKED'
    ? 'review blocked'
    : review.passed
      ? 'review passed'
      : 'review failed';
  if (!authority) {
    return `${outcome} at ${review.final_stage}`;
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
  } else if (authority.synthesis_attempted_by) {
    parts.push(`synth=blocked(${authority.synthesis_attempted_by})`);
  }
  if (authority.disagreement_flags?.length) {
    parts.push(`disagreement=${authority.disagreement_flags.join(',')}`);
  }

  return `${outcome} | ${parts.join(' | ')}`;
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

function taskExecutionContract(plan: TaskPlan, taskId: string): TaskExecutionContract {
  return plan.tasks.find((task) => task.id === taskId)?.execution_contract || 'implementation';
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
    retry_count: 0,
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
  plan: TaskPlan,
  workerResults: WorkerResult[],
): void {
  for (const worker of workerResults) {
    const record = ensureTaskState(state, worker.taskId);
    record.round = state.round;
    record.changed_files = worker.changedFiles;
    record.worker_success = worker.success;
    const executionContract = worker.execution_contract || taskExecutionContract(plan, worker.taskId);
    if (!worker.success) {
      record.status = 'worker_failed';
      record.last_error = worker.output.find((msg) => msg.type === 'error')?.content;
    } else if (worker.changedFiles.length === 0 && executionContract === 'implementation') {
      record.status = 'no_op';
      record.last_error = 'Worker reported success but produced no file changes.';
    }
  }
}

function findBlockingTaskVerification(
  state: RunState,
  taskId: string,
): VerificationResult | null {
  const results = state.task_verification_results[taskId] || [];
  return results.find((result) => result.target.must_pass && !result.passed)
    || results.find((result) => !result.passed)
    || null;
}

function getTaskExecutionBlocker(
  state: RunState,
  plan: TaskPlan,
  taskId: string,
): string | null {
  const record = ensureTaskState(state, taskId);
  if (!record.worker_success) {
    return record.last_error || 'Worker execution did not succeed.';
  }
  if (record.changed_files.length === 0 && taskExecutionContract(plan, taskId) === 'implementation') {
    return record.last_error || 'Worker reported success but produced no file changes.';
  }
  const failedVerification = findBlockingTaskVerification(state, taskId);
  if (failedVerification) {
    return record.last_error || summarizeVerificationFailure(failedVerification);
  }
  return null;
}

function getTaskFinalizeBlocker(
  state: RunState,
  plan: TaskPlan,
  taskId: string,
): string | null {
  const executionBlocker = getTaskExecutionBlocker(state, plan, taskId);
  if (executionBlocker) {
    return executionBlocker;
  }
  const record = ensureTaskState(state, taskId);
  if (!record.review_passed) {
    return record.last_error || 'Review did not pass.';
  }
  return null;
}

function updateTaskStatesFromReviews(
  state: RunState,
  plan: TaskPlan,
  reviewResults: ReviewResult[],
): void {
  for (const review of reviewResults) {
    const record = ensureTaskState(state, review.taskId);
    record.round = state.round;
    record.review_passed = review.passed;
    const executionBlocker = getTaskExecutionBlocker(state, plan, review.taskId);
    if (review.passed && !record.merged) {
      if (executionBlocker) {
        record.last_error ||= executionBlocker;
        continue;
      }
      record.status = 'verified';
      record.last_error = undefined;
    } else if (!review.passed) {
      if (executionBlocker) {
        record.last_error ||= executionBlocker;
        continue;
      }
      record.status = 'review_failed';
      record.last_error = review.findings[0]?.issue;
    }
  }
}

function countNoOpTasks(workerResults: WorkerResult[]): number {
  return workerResults.filter((worker) =>
    worker.success
    && worker.changedFiles.length === 0
    && worker.execution_contract === 'implementation'
  ).length;
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

function markMergeBlockedTasks(
  state: RunState,
  blockers: MergeBlocker[],
): void {
  for (const blocker of blockers) {
    const record = ensureTaskState(state, blocker.taskId);
    record.round = state.round;
    record.status = 'merge_blocked';
    record.last_error = `Merge blocked (${blocker.kind}): ${blocker.reason}`;
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
  options?: { lessons?: import('./types.js').Lesson[] },
): { rule: TaskVerificationRule | null; selection: import('./types.js').RuleSelectionResult } {
  if (!task) {
    return {
      rule: null,
      selection: {
        confidence: 0,
        selection_reason: 'No task provided for rule selection.',
        basis: 'fallback' as const,
        evidence_summary: ['Task is undefined'],
        auto_applied: false,
        relevant_lessons: [],
      },
    };
  }

  // Explicit config always wins
  if (task.verification_profile) {
    return {
      rule: taskRules[task.verification_profile] || null,
      selection: {
        selected_rule: task.verification_profile,
        confidence: 1,
        selection_reason: `Explicit verification_profile "${task.verification_profile}" specified.`,
        basis: 'explicit_config' as const,
        evidence_summary: [`Task defines verification_profile="${task.verification_profile}"`],
        auto_applied: true,
        relevant_lessons: [],
      },
    };
  }

  // Try learning-based selection
  const ruleResult = selectRuleForTask(task, taskRules, { lessons: options?.lessons });
  const matchedRule = ruleResult.selected_rule ? taskRules[ruleResult.selected_rule] : null;
  return {
    rule: matchedRule,
    selection: ruleResult,
  };
}

function getTaskVerificationConditions(
  baseConditions: DoneCondition[],
  task: SubTask | undefined,
  taskRules: Record<string, TaskVerificationRule>,
  lessons?: import('./types.js').Lesson[],
): { conditions: DoneCondition[]; selection: import('./types.js').RuleSelectionResult } {
  const { rule, selection } = getTaskRule(task, taskRules, { lessons });
  const taskConditions = rule?.done_conditions || [];
  return { conditions: dedupeConditions([...baseConditions, ...taskConditions]), selection };
}

function recordRuleSelection(
  state: RunState,
  taskId: string,
  selection: import('./types.js').RuleSelectionResult,
): void {
  const record = ensureTaskState(state, taskId);
  record.rule_selection = selection;
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
    ? summarizeVerificationFailure(failed)
    : 'verification failed';
}

function summarizeVerificationFailure(result: VerificationResult): string {
  const parts = [result.target.label];
  if (result.provider_failure_subtype) {
    parts.push(`provider failure=${result.provider_failure_subtype}`);
  }
  if (result.provider_fallback_used) {
    parts.push('fallback used');
  }
  if (result.requested_provider || result.actual_provider) {
    const requested = formatVerificationModelRef(result.requested_model, result.requested_provider);
    const actual = formatVerificationModelRef(result.actual_model, result.actual_provider);
    if (requested && actual && requested !== actual) {
      parts.push(`route ${requested} -> ${actual}`);
    } else if (actual) {
      parts.push(`route ${actual}`);
    } else if (requested) {
      parts.push(`route ${requested}`);
    }
  }
  const detail = result.failure_class || result.stderr_tail || 'verification failed';
  parts.push(detail);
  return parts.join(': ');
}

function formatVerificationModelRef(model?: string, provider?: string): string | null {
  if (model && provider) return `${model}@${provider}`;
  if (model) return model;
  if (provider) return provider;
  return null;
}

function summarizeCollabStatus(snapshot: CollabStatusSnapshot): string {
  const replyLabel = snapshot.card.replies === 1 ? 'reply' : 'replies';
  return `${snapshot.card.room_kind} ${snapshot.card.status}: ${snapshot.card.replies} ${replyLabel}`;
}

function persistPlannerAdvisoryScores(
  cwd: string,
  runId: string,
  room: PlannerDiscussRoomRef | null | undefined,
  discuss: PlanDiscussResult | null | undefined,
): void {
  if (!room?.reply_metadata?.length) {
    return;
  }
  saveAdvisoryScoreSignals({
    cwd,
    runId,
    roomId: room.room_id,
    roomKind: 'plan',
    timeoutMs: room.timeout_ms,
    qualityGate: discuss?.quality_gate || 'warn',
    replies: room.reply_metadata.map((reply) => ({
      participant_id: reply.participant_id,
      response_time_ms: reply.response_time_ms,
      content_length: reply.content_length,
      received_at: room.created_at,
    })),
    adoptedParticipantIds: discuss?.partner_models || [],
  });
}

function persistPlannerDiscussConclusion(
  cwd: string,
  runId: string,
  discuss: PlanDiscussResult | null | undefined,
): void {
  if (!discuss) return;
  // Store in module-level variable so emitProgress can preserve it
  plannerDiscussConclusion = {
    quality_gate: discuss.quality_gate,
    overall_assessment: discuss.overall_assessment,
  };
  // Also write immediately for safety
  const progress = readLoopProgress(cwd, runId);
  if (progress) {
    progress.planner_discuss_conclusion = plannerDiscussConclusion;
    writeLoopProgress(cwd, runId, progress);
  }
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

function shouldPreflightBuildBaseline(goal: string): boolean {
  return BUILD_BASELINE_GOAL_PATTERNS.some((pattern) => pattern.test(goal));
}

function preflightBuildConditions(conditions: DoneCondition[]): DoneCondition[] {
  return conditions.filter((condition) =>
    condition.type === 'build' && condition.must_pass,
  );
}

function maybeShortCircuitSatisfiedBaseline(
  spec: RunSpec,
  state: RunState,
): { shortCircuited: boolean; verificationResults: VerificationResult[] } {
  if (!shouldPreflightBuildBaseline(spec.goal)) {
    return { shortCircuited: false, verificationResults: [] };
  }

  const buildChecks = preflightBuildConditions(spec.done_conditions);
  if (buildChecks.length === 0) {
    return { shortCircuited: false, verificationResults: [] };
  }

  const results = runVerificationSuite(buildChecks, spec.cwd);
  const buildPassed = allRequiredChecksPassed(results);
  if (!buildPassed) {
    return { shortCircuited: false, verificationResults: results };
  }

  state.verification_results = results;
  state.status = 'done';
  state.next_action = makeNextAction(
    'finalize',
    'Preflight satisfied: build baseline already clean; skipping planning and dispatch.',
  );
  state.final_summary = 'Preflight satisfied: build baseline already clean; no planner or worker dispatch needed.';
  return { shortCircuited: true, verificationResults: results };
}

// ── Spec & State Factories ──

export function createRunSpec(options: CreateRunOptions): RunSpec {
  const executionMode = inferExecutionMode({
    goal: options.goal,
    explicit: options.execution_mode,
    cwd: options.cwd,
  });
  const normalizedMode = normalizeExecutionMode(executionMode);
  const lane = options.lane ?? deriveLaneFromMode(normalizedMode);
  return {
    id: makeRunId(),
    goal: options.goal,
    cwd: options.cwd,
    mode: options.mode || 'safe',
    model_policy_override_active: Boolean(options.modelPolicyOverride),
    execution_mode: normalizedMode,
    lane,
    agent_count: options.agent_count,
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

/** Derive display lane name from resolved execution mode */
function deriveLaneFromMode(mode: ExecutionMode): LaneName | undefined {
  if (mode === 'auto-execute-small' || mode === 'quick') return 'auto-execute-small';
  if (mode === 'execute-standard' || mode === 'auto') return 'execute-standard';
  if (mode === 'execute-parallel' || mode === 'think') return 'execute-parallel';
  return undefined;
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
  const effectivePolicy = resolveEffectiveRunModelPolicy(spec.cwd, spec.id);
  return {
    run_id: spec.id,
    status: 'init',
    round: 0,
    model_policy_override_active: effectivePolicy.override_active,
    model_policy_override_summary: effectivePolicy.override_summary,
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
  if (options.modelPolicyOverride) {
    const { updateRunModelOverrides } = require('./run-model-policy.js') as typeof import('./run-model-policy.js');
    updateRunModelOverrides(spec.cwd, spec.id, 'start-run', options.modelPolicyOverride);
    const effective = resolveEffectiveRunModelPolicy(spec.cwd, spec.id);
    spec.model_policy_override_active = effective.override_active;
    state.model_policy_override_active = effective.override_active;
    state.model_policy_override_summary = effective.override_summary;
  }
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
  replacementNote?: string,
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
    ...(replacementNote ? [replacementNote] : []),
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
 * Build a compact project memory context for repair prompts.
 * Recalls memories relevant to the task's failure class and estimated files.
 * Keeps output under ~300 chars so it doesn't bloat the prompt.
 */
function buildRepairMemoryContext(
  cwd: string,
  projectMemory: ProjectMemoryStore | null,
  task: SubTask,
  state: RunState,
): string | null {
  if (!projectMemory || projectMemory.memories.length === 0) return null;

  // Get the task's failure class from state if available
  const taskState = state.task_states[task.id];
  const failureClass = taskState?.last_error
    ? classifyFailureFromError(taskState.last_error)
    : undefined;

  try {
    const recall = recallProjectMemories(projectMemory, {
      goal: task.description,
      task_type: task.category,
      touched_files: task.estimated_files,
      failure_class: failureClass,
    }, { topN: 2 });

    const formatted = formatMemoryRecall(recall, 300);
    return formatted || null;
  } catch {
    return null; // memory unavailable — proceed without
  }
}

/**
 * Crude failure class inference from error message text.
 * Used to enrich repair memory recall when the task's failure class is unknown.
 */
function classifyFailureFromError(error: string): FailureClass | undefined {
  const lower = error.toLowerCase();
  if (lower.includes('build') || lower.includes('compil') || lower.includes('tsc')) return 'build';
  if (lower.includes('test') || lower.includes('vitest') || lower.includes('jest')) return 'test';
  if (lower.includes('lint')) return 'lint';
  if (lower.includes('merge') || lower.includes('conflict')) return 'merge';
  if (lower.includes('timeout') || lower.includes('provider')) return 'provider';
  return undefined;
}

type ReviewReplacementStrategy = 'original' | 'same-tier' | 'upper-tier';

interface ReviewReplacementDecision {
  modelId: string;
  strategy: ReviewReplacementStrategy;
  note?: string;
}

function speedTierRank(tier: ReturnType<ModelRegistry['getSpeedTier']>): number {
  if (tier === 'fast') return 1;
  if (tier === 'balanced') return 2;
  if (tier === 'strong') return 3;
  return 0;
}

function dedupeModelIds(modelIds: Array<string | undefined>): string[] {
  return [...new Set(modelIds.filter((modelId): modelId is string => Boolean(modelId)))];
}

function pickReviewReplacementModel(
  task: SubTask,
  previousWorkerResult: WorkerResult | undefined,
  registry: ModelRegistry,
  retryCount: number,
  cwd: string,
): ReviewReplacementDecision {
  const config = loadConfig(cwd);
  const previousActualModel = previousWorkerResult?.model || task.assigned_model;
  const previousRequestedModel = previousWorkerResult?.requested_model || task.assigned_model;
  const previousTier = registry.getSpeedTier(previousActualModel);
  const excluded = new Set(
    [previousActualModel, previousRequestedModel, task.assigned_model].filter(Boolean),
  );
  const rankedCandidates = registry
    .rankModelsForTask(task)
    .filter((candidate) => !candidate.blocked_by?.length && !candidate.model.startsWith('claude-'));
  const availableCandidates = rankedCandidates.filter((candidate) => !excluded.has(candidate.model));

  if (availableCandidates.length === 0) {
    return {
      modelId: task.assigned_model,
      strategy: 'original',
      note: 'No alternate domestic executor candidate available; keeping the original model.',
    };
  }

  if (retryCount === 0) {
    const sameTierCandidate = availableCandidates.find((candidate) =>
      previousTier !== 'unknown' && registry.getSpeedTier(candidate.model) === previousTier,
    );
    if (sameTierCandidate) {
      return {
        modelId: sameTierCandidate.model,
        strategy: 'same-tier',
        note: `Previous review failed under "${previousActualModel}". Retry with same-tier sibling "${sameTierCandidate.model}".`,
      };
    }

    return {
      modelId: availableCandidates[0].model,
      strategy: 'same-tier',
      note: `No same-tier sibling was available for "${previousActualModel}". Using best-ranked domestic replacement "${availableCandidates[0].model}".`,
    };
  }

  const configuredUpperTier = dedupeModelIds([
    config.high_tier,
    config.default_worker,
    config.fallback_worker,
    config.tiers?.executor?.model,
    config.tiers?.executor?.fallback,
  ])
    .filter((modelId) => !excluded.has(modelId) && !modelId.startsWith('claude-'));
  const strongerTierCandidates = availableCandidates.filter((candidate) =>
    speedTierRank(registry.getSpeedTier(candidate.model)) > speedTierRank(previousTier),
  );
  const upperTierCandidates = dedupeModelIds([
    ...configuredUpperTier,
    ...strongerTierCandidates.map((candidate) => candidate.model),
    ...availableCandidates.map((candidate) => candidate.model),
  ]);

  if (upperTierCandidates.length > 0) {
    return {
      modelId: upperTierCandidates[0],
      strategy: 'upper-tier',
      note: `Review still failed after same-tier repair. Escalating from "${previousActualModel}" to upper-tier model "${upperTierCandidates[0]}".`,
    };
  }

  return {
    modelId: task.assigned_model,
    strategy: 'original',
    note: 'No upper-tier replacement candidate was available; keeping the original model.',
  };
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
  previousWorkerResults: WorkerResult[],
  registry: ModelRegistry,
  inheritedSmokeResults: Record<string, boolean>,
  taskRules: Record<string, TaskVerificationRule>,
  lessons: import('./types.js').Lesson[],
  projectMemory: ProjectMemoryStore | null,
  hooks?: {
    onRecoverySnapshot?: (taskId: string, snapshot: CollabStatusSnapshot) => void | Promise<void>;
  },
): Promise<{
  workerResults: WorkerResult[];
  reviewResults: ReviewResult[];
  repairSmokeResults: Record<string, boolean>;
}> {
  const repairWorkerResults: WorkerResult[] = [];
  const repairReviewResults: ReviewResult[] = [];
  const repairSmokeResults: Record<string, boolean> = {};

  for (const review of failedReviews) {
    const task = plan.tasks.find((t) => t.id === review.taskId);
    if (!task) continue;
    const previousWorkerResult = previousWorkerResults.find((item) => item.taskId === task.id);

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
      runId: spec.id,
      task,
      reviewResult: review,
      retryCount,
      maxRetries: spec.max_worker_retries,
      repairHistory: state.repair_history.filter((entry) => entry.task_id === task.id),
      onSnapshot: async (snapshot) => {
        await hooks?.onRecoverySnapshot?.(task.id, snapshot);
      },
    });
    const isReviewFailure = state.task_states[task.id]?.status === 'review_failed';
    const replacement = isReviewFailure
      ? pickReviewReplacementModel(task, previousWorkerResult, registry, retryCount, spec.cwd)
      : {
        modelId: task.assigned_model,
        strategy: 'original' as const,
        note: undefined,
      };
    const repairPrompt = buildRepairPrompt(task, recovery.findings, replacement.note);
    const repairMemoryContext = buildRepairMemoryContext(spec.cwd, projectMemory, task, state);
    const fullRepairPrompt = repairMemoryContext
      ? `${repairPrompt}\n\n${repairMemoryContext}`
      : repairPrompt;
    const repairModel = replacement.modelId;
    const modelCap = registry.get(repairModel) || registry.get(task.assigned_model);
    const repairNotePrefix = replacement.strategy === 'original'
      ? undefined
      : `review replacement via ${replacement.strategy} model ${repairModel}`;

    // Fresh worktree, no sessionId — clean isolation for each repair attempt
    const workerResult = await spawnWorker({
      taskId: task.id,
      model: repairModel,
      provider: modelCap?.provider || repairModel,
      prompt: fullRepairPrompt,
      cwd: plan.cwd,
      worktree: true,
      contextInputs: [],
      discussThreshold: task.discuss_threshold,
      maxTurns: 25,
      assignedModel: task.assigned_model,
      runId: spec.id,
      planId: plan.id,
      round: state.round,
      taskDescription: task.description,
    });

    repairWorkerResults.push(workerResult);

    if (workerResult.success) {
      // Re-run real smoke verification on the repair worktree
      const { conditions: taskConditions, selection } = getTaskVerificationConditions(spec.done_conditions, task, taskRules, lessons);
      recordRuleSelection(state, workerResult.taskId, selection);
      const smokeCheckResults = smokeVerifyWorktree(taskConditions, workerResult);
      recordTaskVerificationResults(state, workerResult.taskId, smokeCheckResults);
      markTaskVerificationFailure(state, workerResult.taskId, smokeCheckResults);
      const reSmokePassed = smokeCheckResults.length === 0
        || allRequiredChecksPassed(smokeCheckResults);
      repairSmokeResults[task.id] = reSmokePassed;

      // Pass original smoke failure for review escalation, not re-smoke result
      const reviewResult = await runReview(
        workerResult,
        task,
        plan,
        registry,
        inheritedSmokeResults[task.id],
      );
      repairReviewResults.push(reviewResult);
      state.repair_history.push({
        task_id: task.id,
        round: state.round,
        findings_count: review.findings.length,
        outcome: reviewResult.passed ? 'fixed' : 'failed',
        note: reviewResult.passed
          ? `${repairNotePrefix ? `${repairNotePrefix}; ` : ''}repair review passed`
          : `${repairNotePrefix ? `${repairNotePrefix}; ` : ''}repair review still failing`,
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
        note: repairNotePrefix
          ? `${repairNotePrefix}; worker repair execution failed`
          : 'worker repair execution failed',
      });
    }
  }

  return {
    workerResults: repairWorkerResults,
    reviewResults: repairReviewResults,
    repairSmokeResults,
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

  return smokeChecks.map((c) => ({
    ...runVerification(c, workerResult.worktreePath),
    provider_failure_subtype: workerResult.provider_failure_subtype,
    provider_fallback_used: workerResult.provider_fallback_used,
    requested_model: workerResult.requested_model,
    requested_provider: workerResult.requested_provider,
    actual_model: workerResult.model,
    actual_provider: workerResult.provider,
  }));
}

function shouldSurfaceInfraFault(review: ReviewResult): boolean {
  if (review.failure_attribution === 'infra_fault') {
    return true;
  }
  return review.findings.some((finding) => /\binfra(?:_| )fault\b/i.test(finding.issue));
}

function hasProviderFailureContext(worker: WorkerResult): boolean {
  return Boolean(
    worker.provider_failure_subtype
    || worker.provider_fallback_used
    || worker.requested_model
    || worker.requested_provider,
  );
}

function buildInfraFaultSummary(worker: WorkerResult): string {
  const requested = formatVerificationModelRef(worker.requested_model, worker.requested_provider);
  const actual = formatVerificationModelRef(worker.model, worker.provider);
  const route = requested && actual && requested !== actual
    ? `${requested} -> ${actual}`
    : actual || requested || worker.model;
  const details = [route];
  if (worker.provider_failure_subtype) {
    details.push(`provider failure=${worker.provider_failure_subtype}`);
  }
  if (worker.provider_fallback_used) {
    details.push('fallback used');
  }
  return `Infra fault context: ${details.join(', ')}`;
}

function mergeInfraFaultIntoReview(
  review: ReviewResult,
  worker: WorkerResult | undefined,
): ReviewResult {
  if (!worker || !shouldSurfaceInfraFault(review) || !hasProviderFailureContext(worker)) {
    return review;
  }
  const summary = buildInfraFaultSummary(worker);
  const findings = review.findings.some((finding) => finding.issue === summary)
    ? review.findings
    : [
      ...review.findings,
      {
        id: review.findings.length + 1,
        severity: 'yellow' as const,
        lens: 'infra',
        file: 'worker-dispatch',
        issue: summary,
        decision: 'flag' as const,
        decision_reason: 'Attached from worker provider fallback metadata',
      },
    ];
  return {
    ...review,
    findings,
  };
}

function mergeInfraFaultsIntoReviews(
  workerResults: WorkerResult[],
  reviewResults: ReviewResult[],
): ReviewResult[] {
  return reviewResults.map((review) => mergeInfraFaultIntoReview(
    review,
    workerResults.find((worker) => worker.taskId === review.taskId),
  ));
}

function inferWorkerInfraFault(worker: WorkerResult): ReviewResult | null {
  if (worker.success || !hasProviderFailureContext(worker)) {
    return null;
  }
  const summary = buildInfraFaultSummary(worker);
  return {
    taskId: worker.taskId,
    final_stage: 'cross-review',
    passed: false,
    findings: [{
      id: 1,
      severity: 'yellow',
      lens: 'infra',
      file: 'worker-dispatch',
      issue: summary,
      decision: 'flag',
      decision_reason: 'Synthesized from worker provider failure metadata',
    }],
    iterations: 0,
    duration_ms: 0,
    failure_attribution: 'infra_fault',
  };
}

function buildWorkerInfraFaultMap(workerResults: WorkerResult[]): Map<string, ReviewResult> {
  const map = new Map<string, ReviewResult>();
  for (const worker of workerResults) {
    const synthesized = inferWorkerInfraFault(worker);
    if (synthesized) {
      map.set(worker.taskId, synthesized);
    }
  }
  return map;
}

function getRepairReviewsWithInfraFaults(
  requestedTaskIds: Set<string>,
  currentState: RunState,
  latestResult: OrchestratorResult,
): ReviewResult[] {
  const repairTargets = new Map<string, ReviewResult>();
  const workerInfraFaults = buildWorkerInfraFaultMap(latestResult.worker_results);
  for (const review of latestResult.review_results.filter((r) => !r.passed)) {
    repairTargets.set(review.taskId, review);
  }
  for (const [taskId, review] of workerInfraFaults.entries()) {
    if (!repairTargets.has(taskId)) {
      repairTargets.set(taskId, review);
    }
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
  return [...repairTargets.values()];
}

function enrichResultInfraFaultMetadata(result: OrchestratorResult): OrchestratorResult {
  return {
    ...result,
    review_results: mergeInfraFaultsIntoReviews(result.worker_results, result.review_results),
  };
}

function makeInfraFaultReason(
  taskIds: string[],
  result: OrchestratorResult,
  fallbackReason: string,
): string {
  const summaries = taskIds
    .map((taskId) => result.review_results.find((review) => review.taskId === taskId))
    .flatMap((review) => review?.findings || [])
    .filter((finding) => finding.file === 'worker-dispatch' && finding.issue.startsWith('Infra fault context:'))
    .map((finding) => finding.issue.replace('Infra fault context: ', ''));
  if (summaries.length === 0) {
    return fallbackReason;
  }
  return `${fallbackReason} (${summaries.join('; ')})`;
}

function makeReviewFailureReason(
  taskIds: string[],
  result: OrchestratorResult,
  fallbackReason: string,
): string {
  const infraTasks = result.review_results
    .filter((review) => taskIds.includes(review.taskId) && shouldSurfaceInfraFault(review))
    .map((review) => review.taskId);
  if (infraTasks.length === 0) {
    return fallbackReason;
  }
  return makeInfraFaultReason(infraTasks, result, fallbackReason);
}

function makeVerificationRepairReason(
  taskIds: string[],
  state: RunState,
  fallbackReason: string,
): string {
  const infraDetails = taskIds
    .flatMap((taskId) => state.task_verification_results[taskId] || [])
    .filter((result) => !result.passed && result.provider_failure_subtype)
    .map((result) => summarizeVerificationFailure(result));
  if (infraDetails.length === 0) {
    return fallbackReason;
  }
  return `${fallbackReason} (${infraDetails.join('; ')})`;
}

function makeMergeBlockedReason(
  taskIds: string[],
  result: OrchestratorResult,
  fallbackReason: string,
): string {
  const infraTasks = taskIds.filter((taskId) =>
    result.worker_results.some((worker) => worker.taskId === taskId && hasProviderFailureContext(worker)),
  );
  if (infraTasks.length === 0) {
    return fallbackReason;
  }
  return makeInfraFaultReason(infraTasks, result, fallbackReason);
}

function makeMaxRoundsReason(state: RunState, maxRounds: number): string {
  const pendingAction = state.next_action;
  if (!pendingAction || pendingAction.kind === 'request_human') {
    return `Max rounds reached (${maxRounds}). Status: ${state.status}.`;
  }

  return `Max rounds reached (${maxRounds}) while pending ${pendingAction.kind}: ${pendingAction.reason}`;
}

function makeMaxRoundsEscalation(
  state: RunState,
  maxRounds: number,
): NextAction {
  const pendingAction = state.next_action;
  if (!pendingAction || pendingAction.kind === 'request_human') {
    return makeNextAction(
      'request_human',
      makeMaxRoundsReason(state, maxRounds),
    );
  }

  return makeNextAction(
    'request_human',
    makeMaxRoundsReason(state, maxRounds),
    pendingAction.task_ids,
    pendingAction.instructions,
  );
}

// ── Per-task progressive merge ──

/**
 * Merge individual tasks that passed review (and optionally smoke verification).
 * Does not wait for all tasks to pass — partial progress lands on main.
 */
export function mergePassedTasks(
  spec: RunSpec,
  plan: TaskPlan,
  workerResults: WorkerResult[],
  reviewResults: ReviewResult[],
  smokeResults: Record<string, boolean>,
  preMergeHooks: PolicyHook[],
  policyHookResults: PolicyHookResult[],
  round: number,
): MergePassResult {
  if (!spec.allow_auto_merge) {
    return { mergedTaskIds: [], blocked: [] };
  }

  const blocked = new Map<string, MergeBlocker>();
  const mergeCandidates: Array<{
    review: ReviewResult;
    worker: WorkerResult;
    task: SubTask | undefined;
  }> = [];

  for (const review of reviewResults) {
    if (!review.passed) continue;
    if (smokeResults[review.taskId] === false) continue;

    const worker = workerResults.find((w) => w.taskId === review.taskId);
    const task = plan.tasks.find((t) => t.id === review.taskId);
    if (!worker?.branch || !worker.success) continue;
    if (worker.changedFiles.length === 0 && taskExecutionContract(plan, review.taskId) === 'implementation') continue;

    const expectedFiles = new Set((task?.estimated_files || []).map(normalizeRepoPath));
    const changedFiles = dedupe(worker.changedFiles.map(normalizeRepoPath));
    const outOfScopeFiles = expectedFiles.size === 0
      ? []
      : changedFiles.filter((file) => !expectedFiles.has(file));
    if (outOfScopeFiles.length > 0) {
      blocked.set(review.taskId, {
        taskId: review.taskId,
        kind: 'scope_violation',
        reason: `Changed files outside estimated_files: ${outOfScopeFiles.join(', ')}`,
        files: outOfScopeFiles,
      });
      continue;
    }

    mergeCandidates.push({ review, worker, task });
  }

  const fileOwners = new Map<string, string[]>();
  for (const candidate of mergeCandidates) {
    if (blocked.has(candidate.review.taskId)) continue;
    for (const file of dedupe(candidate.worker.changedFiles.map(normalizeRepoPath))) {
      const owners = fileOwners.get(file) || [];
      owners.push(candidate.review.taskId);
      fileOwners.set(file, owners);
    }
  }

  for (const [file, owners] of fileOwners.entries()) {
    if (owners.length <= 1) continue;
    for (const taskId of owners) {
      if (blocked.has(taskId)) continue;
      const peers = owners.filter((owner) => owner !== taskId);
      blocked.set(taskId, {
        taskId,
        kind: 'overlap_conflict',
        reason: `Overlapping changed file ${file} also touched by: ${peers.join(', ')}`,
        files: [file],
      });
    }
  }

  const mergedTaskIds: string[] = [];
  for (const candidate of mergeCandidates) {
    const taskId = candidate.review.taskId;
    if (blocked.has(taskId)) continue;

    const hookResults = runPolicyHooks(
      preMergeHooks,
      candidate.worker.worktreePath || spec.cwd,
      round,
    );
    policyHookResults.push(...hookResults);
    const blockingHookFailed = hookResults.some((item) => !item.passed && preMergeHooks.find((hook) => hook.label === item.label && hook.stage === item.stage)?.must_pass);
    if (blockingHookFailed) {
      const failedLabels = hookResults
        .filter((item) => !item.passed && preMergeHooks.find((hook) => hook.label === item.label && hook.stage === item.stage)?.must_pass)
        .map((item) => item.label);
      blocked.set(taskId, {
        taskId,
        kind: 'hook_failed',
        reason: `Blocking pre-merge hooks failed: ${failedLabels.join(', ')}`,
        files: [],
      });
      continue;
    }

    const mergeResult = commitAndMergeWorktree(
      candidate.worker.worktreePath,
      candidate.worker.branch,
      `task ${candidate.worker.taskId}: ${candidate.task?.description.slice(0, 80) || candidate.worker.taskId}`,
      spec.cwd,
    );
    if (mergeResult.merged) {
      mergedTaskIds.push(candidate.worker.taskId);
      continue;
    }

    blocked.set(taskId, {
      taskId,
      kind: 'merge_conflict',
      reason: mergeResult.error || 'git merge failed',
      files: dedupe(candidate.worker.changedFiles.map(normalizeRepoPath)),
    });
  }

  return {
    mergedTaskIds,
    blocked: [...blocked.values()],
  };
}

// ── Outcome summary ──

function summarizeOutcome(
  result: OrchestratorResult,
  suiteVerificationPassed: boolean,
  mergedTaskIds: string[],
  mergeBlockedTaskIds: string[],
): string {
  const passedReviews = result.review_results.filter((r) => r.passed).length;
  const failedReviews = result.review_results.length - passedReviews;
  const vText = suiteVerificationPassed
    ? 'verification passed'
    : 'verification failed';
  const mergeText = mergedTaskIds.length > 0
    ? `; merged: ${mergedTaskIds.join(', ')}`
    : '';
  const blockedText = mergeBlockedTaskIds.length > 0
    ? `; merge blocked: ${mergeBlockedTaskIds.join(', ')}`
    : '';
  const noOpCount = countNoOpTasks(result.worker_results);
  const noOpText = noOpCount > 0
    ? `; no-op tasks: ${noOpCount}`
    : '';
  const costText = result.token_breakdown
    ? `; $${result.token_breakdown.actual_cost_usd.toFixed(4)} (saved $${result.token_breakdown.savings_usd.toFixed(4)} vs Claude)`
    : '';
  const budgetText = result.budget_warning ? `; ${result.budget_warning}` : '';
  return `${passedReviews}/${result.review_results.length} reviews passed; ${failedReviews} failed; ${vText}${mergeText}${blockedText}${noOpText}${costText}${budgetText}.`;
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

/**
 * For minimal verification modes, exclude full-suite conditions.
 * Only keep build checks (scope 'both' or 'build') as minimal gates.
 */
export function minimalSuiteConditions(conditions: DoneCondition[]): DoneCondition[] {
  return conditions.filter((condition) =>
    condition.scope === 'both' || condition.type === 'build',
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

// ── Phase 8B: Steering at safe point ──

interface SteeringProcessResult {
  breakLoop: boolean;
  overrideAction?: { kind: NextAction['kind']; reason: string; taskIds: string[]; instructions?: string };
}

function processSteeringAtSafePoint(
  spec: RunSpec,
  state: RunState,
): SteeringProcessResult {
  if (!state.steering) {
    state.steering = { paused: false, pending_actions: [] };
  }

  // Check if paused — block further processing
  if (state.steering.paused) {
    return { breakLoop: true };
  }

  const pending = getPendingSteeringActions(spec.cwd, spec.id);
  if (pending.length === 0) {
    return { breakLoop: false };
  }

  let breakLoop = false;
  let overrideAction: SteeringProcessResult['overrideAction'];

  for (const action of pending) {
    // Suppress duplicates (exclude current action to avoid self-suppression)
    if (isDuplicateAction(spec.cwd, spec.id, action.action_type, action.task_id, undefined, action.action_id)) {
      updateSteeringStatus(spec.cwd, spec.id, action.action_id, 'suppressed', 'Duplicate action suppressed');
      continue;
    }

    const validation = validateSteeringAction(action, spec, state);
    if (!validation.allowed) {
      updateSteeringStatus(spec.cwd, spec.id, action.action_id, 'rejected', validation.reason);
      state.steering!.last_rejected = {
        action_id: action.action_id,
        action_type: action.action_type,
        reason: validation.reason!,
        applied_at: Date.now(),
      };
      console.log(`  ⛔ Steering rejected: ${action.action_type} — ${validation.reason}`);
      continue;
    }

    const applyResult = applySteeringAction(action, state, spec);
    if (applyResult.applied) {
      updateSteeringStatus(spec.cwd, spec.id, action.action_id, 'applied', applyResult.effect);
      console.log(`  ✅ Steering applied: ${action.action_type} → ${applyResult.effect}`);

      if (action.action_type === 'pause_run') {
        breakLoop = true;
      }
      if (applyResult.nextActionKind) {
        overrideAction = {
          kind: applyResult.nextActionKind as NextAction['kind'],
          reason: `Human steering: ${action.action_type}`,
          taskIds: action.task_id ? [action.task_id] : [],
          instructions: action.payload.reason,
        };
      }
      if (action.action_type === 'retry_task' && action.task_id) {
        overrideAction = {
          kind: 'repair_task',
          reason: `Human steering: retry task ${action.task_id}`,
          taskIds: [action.task_id],
          instructions: action.payload.reason,
        };
      }
      if (action.action_type === 'mark_requires_human') {
        state.status = 'partial';
        state.next_action = makeNextAction(
          'request_human',
          `Human intervention requested: ${action.payload.reason || 'operator flagged run'}`,
        );
        breakLoop = true;
      }
    }
  }

  return { breakLoop, overrideAction };
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
  let plannerDiscussConclusion: LoopProgress['planner_discuss_conclusion'] | undefined;
  const emitProgress = (phase: LoopPhase, reason: string, extra?: {
    focus_task_id?: string; focus_model?: string; focus_summary?: string;
    collab?: CollabStatusSnapshot | null;
  }) => {
    const collab = extra?.collab === undefined
      ? activeCollabSnapshot
      : extra.collab;
    const existing = readLoopProgress(spec.cwd, spec.id);
    writeLoopProgress(spec.cwd, spec.id, {
      run_id: spec.id, round: currentState.round, phase, reason,
      planner_model: plannerModel,
      collab: collab || undefined,
      focus_task_id: extra?.focus_task_id,
      focus_model: extra?.focus_model,
      focus_summary: extra?.focus_summary,
      planner_discuss_conclusion: existing?.planner_discuss_conclusion || plannerDiscussConclusion,
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
  // Phase 6A: Load cross-run lessons
  const lessonStore = loadLessonStore(spec.cwd);
  const lessons = lessonStore?.lessons
    ? refreshLessonsFromHistory(spec.cwd, taskRules)
    : extractFreshLessons(spec.cwd, taskRules);

  // Phase 7A: Initialize and extract project memory
  const projectMemory = initProjectMemory(spec.cwd);
  extractProjectMemories(spec.cwd, projectMemory);
  saveProjectMemory(spec.cwd, projectMemory);
  const preMergeHooks = projectPolicy?.hooks.filter((hook) => hook.stage === 'pre_merge') || [];
  const postVerifyHooks = projectPolicy?.hooks.filter((hook) => hook.stage === 'post_verify') || [];

  let plan: TaskPlan | null = loadRunPlan(spec.cwd, spec.id) ?? null;
  let latestResult: OrchestratorResult | undefined;
  let plannerModel: string | undefined;
  let planDiscuss: PlanDiscussResult | null | undefined;
  let planDiscussRoom: PlannerDiscussRoomRef | null | undefined;
  let plannerDiagnostics: Record<string, unknown> | null | undefined;

  if (blockIfBudgetExhausted(spec, currentState)) {
    triggerUserProfileExtraction(spec, currentState);
    return { spec, state: currentState, plan, result: loadRunResult(spec.cwd, spec.id) ?? undefined };
  }

  // ── Phase 5A.2 / 8D: Early-exit lanes (effective mode with runtime override) ──
  const effective = resolveEffectiveMode(spec, currentState);
  const { normalized: normalizedMode, contract: modeContract } = effective;
  if (effective.overridden) {
    console.log(`  🔀 Effective mode: ${effective.mode} (${effective.source}, was ${spec.execution_mode})`);
  }

  if (normalizedMode === 'record-only') {
    currentState.status = 'done';
    currentState.next_action = makeNextAction('finalize', `Record-only: goal recorded without execution — ${spec.goal}`);
    currentState.final_summary = `Record-only: goal recorded without execution — ${spec.goal}`;
    saveRunState(spec.cwd, currentState);
    emitProgress('done', `Record-only: goal recorded without execution`);
    triggerUserProfileExtraction(spec, currentState);
    return { spec, state: currentState, plan: null };
  }

  if (normalizedMode === 'clarify-first') {
    currentState.status = 'blocked';
    currentState.next_action = makeNextAction('request_human', `Clarify-first: goal requires clarification before execution — ${spec.goal}`);
    currentState.final_summary = `Clarify-first: waiting for user clarification — ${spec.goal}`;
    saveRunState(spec.cwd, currentState);
    emitProgress('blocked', `Clarify-first: waiting for user clarification`);
    triggerUserProfileExtraction(spec, currentState);
    return { spec, state: currentState, plan: null };
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

    // ── Phase 8B: Process pending steering actions at safe point ──
    const steeringResult = processSteeringAtSafePoint(spec, currentState);
    if (steeringResult.breakLoop) {
      break;
    }
    if (steeringResult.overrideAction) {
      currentState.next_action = makeNextAction(
        steeringResult.overrideAction.kind,
        steeringResult.overrideAction.reason,
        steeringResult.overrideAction.taskIds,
        steeringResult.overrideAction.instructions,
      );
    }

    if (consumeRuntimeModelOverrides(spec, currentState)) {
      const effectivePolicy = resolveEffectiveRunModelPolicy(spec.cwd, spec.id);
      spec.model_policy_override_active = effectivePolicy.override_active;
      currentState.model_policy_override_active = effectivePolicy.override_active;
      currentState.model_policy_override_summary = effectivePolicy.override_summary;
      saveRunSpec(spec.cwd, spec);
      saveRunState(spec.cwd, currentState);
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
      if (currentState.round === 1) {
        const preflight = maybeShortCircuitSatisfiedBaseline(spec, currentState);
        if (preflight.shortCircuited) {
          saveRunState(spec.cwd, currentState);
          emitProgress('done', 'Preflight satisfied: build baseline already clean');
          break;
        }
      }

      setLoopPhase(
        spec.cwd,
        currentState,
        'planning',
        'execute',
        'Generating plan...',
      );
      emitProgress('planning', 'Generating plan via LLM planner...');

      const planning = await runWithHeartbeat(
        () => planGoal(spec.goal, spec.cwd, {
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
        }, { projectMemory, runId: spec.id }),
        (elapsedMs) => {
          emitProgress('planning', `Generating plan via LLM planner... (still running ${Math.floor(elapsedMs / 1000)}s)`);
        },
      );
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
        triggerUserProfileExtraction(spec, currentState);
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
      persistPlannerAdvisoryScores(spec.cwd, spec.id, planDiscussRoom, planDiscuss);
      persistPlannerDiscussConclusion(spec.cwd, spec.id, planDiscuss);
      for (const task of plan.tasks) {
        task.prompt_policy = task.prompt_policy || selectPromptPolicy(task);
      }
      emitProgress('executing', `Plan ready: ${plan.tasks.length} tasks via ${plannerModel || 'auto'}${planDiscuss ? ` | discuss: ${planDiscuss.quality_gate}` : ''}`);
      seedTaskStatesFromPlan(currentState, plan);
      currentState.current_plan_id = plan.id;
      saveRunPlan(spec.cwd, spec.id, plan);
    }

    if (action === 'replan') {
      // Phase 5A.2: Mode contract check — some lanes forbid replan
      if (!modeContract.allow_replan) {
        console.log(`  ⏭️  ${normalizedMode}: replan not allowed by mode contract, requesting human`);
        const passedReviews = latestResult!.review_results.filter((r) => r.passed).length;
        const failedReviews = latestResult!.review_results.length - passedReviews;
        const mergeText = currentState.merged_task_ids.length > 0
          ? `; merged: ${currentState.merged_task_ids.join(', ')}` : '';
        currentState.status = 'partial';
        currentState.next_action = makeNextAction(
          'request_human',
          `${normalizedMode}: replan disabled by mode contract. Failed tasks need attention.`,
        );
        currentState.final_summary = `${passedReviews}/${latestResult!.review_results.length} reviews passed; ${failedReviews} failed; replan disabled${mergeText}.`;
        saveRunState(spec.cwd, currentState);
        break;
      }

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

      const planning = await runWithHeartbeat(
        () => planGoal(replanGoal, spec.cwd, {
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
        }, { projectMemory, runId: spec.id }),
        (elapsedMs) => {
          emitProgress('replanning', `Replanning remaining work... (still running ${Math.floor(elapsedMs / 1000)}s)`);
        },
      );
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
      persistPlannerAdvisoryScores(spec.cwd, spec.id, planDiscussRoom, planDiscuss);
      persistPlannerDiscussConclusion(spec.cwd, spec.id, planDiscuss);
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
    let mergePassResult: MergePassResult = { mergedTaskIds: [], blocked: [] };

    if (action === 'repair_task' && latestResult) {
      // Phase 5A.2: Mode contract check — some lanes forbid repair
      if (!modeContract.allow_repair) {
        console.log(`  ⏭️  ${normalizedMode}: repair not allowed by mode contract, requesting human`);
        const passedReviews = latestResult.review_results.filter((r) => r.passed).length;
        const failedReviews = latestResult.review_results.length - passedReviews;
        const mergeText = currentState.merged_task_ids.length > 0
          ? `; merged: ${currentState.merged_task_ids.join(', ')}` : '';
        currentState.status = 'partial';
        currentState.next_action = makeNextAction(
          'request_human',
          `${normalizedMode}: repair disabled by mode contract. Failed tasks need attention.`,
        );
        currentState.final_summary = `${passedReviews}/${latestResult.review_results.length} reviews passed; ${failedReviews} failed; repair disabled${mergeText}.`;
        saveRunState(spec.cwd, currentState);
        break;
      }

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
      const failedReviews = getRepairReviewsWithInfraFaults(
        requestedTaskIds,
        currentState,
        latestResult,
      );
      // Carry forward original smoke results for review escalation
      const inheritedSmokeResults = currentState._smokeResults ?? {};
      const repair = await runWithHeartbeat(
        () => runRepairRound(
          spec,
          currentState,
          plan!,
          failedReviews,
          latestResult!.worker_results,
          registry,
          inheritedSmokeResults,
          taskRules,
          lessons,
          projectMemory,
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
        ),
        (elapsedMs) => {
          emitProgress('repairing', `Repairing failed task(s)... (still running ${Math.floor(elapsedMs / 1000)}s)`);
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
          (r) => !repairedIds.has(r.taskId),
        ),
        ...repair.reviewResults,
      ];

      // Refresh smoke state with actual re-smoke results from repair worktrees.
      // This replaces the old approach of using review.passed as a proxy for smoke.passed.
      // Only tasks that were actually re-smoked get updated; others keep their original state.
      const currentSmokeResults = currentState._smokeResults ?? {};
      for (const [taskId, passed] of Object.entries(repair.repairSmokeResults)) {
        currentSmokeResults[taskId] = passed;
      }
      currentState._smokeResults = currentSmokeResults;

      // Merge repaired tasks that pass both review and re-smoke.
      // Same gating as fresh execution: review.passed && smoke !== false.
      mergePassResult = mergePassedTasks(
        spec,
        plan!,
        workerResults,
        reviewResults,
        currentSmokeResults,
        preMergeHooks,
        currentState.policy_hook_results,
        currentState.round,
      );
      markMergedTasks(currentState, mergePassResult.mergedTaskIds);

      // If no repairs were attempted (all exhausted), escalate
      if (repair.workerResults.length === 0) {
        currentState.status = 'partial';
        syncFailedTaskIds(currentState);
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
      const dispatchResult = await runWithHeartbeat(
        () => dispatchBatch(plan!, registry, {
          runId: spec.id,
          round: currentState.round,
          executionMode: normalizedMode,
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
        }, { recordBudget: false }),
        (elapsedMs) => {
          emitProgress('executing', `Dispatching ${plan!.tasks.length} task(s)... (still running ${Math.floor(elapsedMs / 1000)}s)`);
        },
      );
      workerResults = dispatchResult.worker_results;
      const succeeded = workerResults.filter(w => w.success).length;
      emitProgress('reviewing', `Workers done: ${succeeded}/${workerResults.length} succeeded`);

      // Step 2a: Per-worktree smoke check (build only) — run BEFORE review for authority-layer
      // This allows authority review to receive deterministic verification signals
      const smokeResults: Record<string, boolean> = {};
      for (const wr of workerResults) {
        if (!wr.success || !wr.worktreePath) continue;
        const task = plan!.tasks.find((t) => t.id === wr.taskId);
        const { conditions: taskConditions, selection } = getTaskVerificationConditions(spec.done_conditions, task, taskRules, lessons);
        recordRuleSelection(currentState, wr.taskId, selection);
        const results = smokeVerifyWorktree(taskConditions, wr);
        recordTaskVerificationResults(currentState, wr.taskId, results);
        markTaskVerificationFailure(currentState, wr.taskId, results);
        // No build checks = pass by default (no smoke to fail)
        smokeResults[wr.taskId] = results.length === 0
          || allRequiredChecksPassed(results);
      }
      // Persist smoke results for repair path to carry forward deterministic signal
      currentState._smokeResults = smokeResults;

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
          return runReview(wr, task, plan!, registry, smokeResults[wr.taskId]);
        }),
      );

      // Step 2c: Progressive merge — each passed task merges independently
      mergePassResult = mergePassedTasks(
        spec,
        plan!,
        workerResults,
        reviewResults,
        smokeResults,
        preMergeHooks,
        currentState.policy_hook_results,
        currentState.round,
      );
      markMergedTasks(currentState, mergePassResult.mergedTaskIds);
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
          runId: spec.id,
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
    updateTaskStatesFromWorkers(currentState, plan, workerResults);
    updateTaskStatesFromReviews(currentState, plan, reviewResults);
    markMergeBlockedTasks(currentState, mergePassResult.blocked);

    currentState.completed_task_ids = workerResults
      .filter((w) => w.success)
      .map((w) => w.taskId);
    const reviewFailedTaskIds = reviewResults
      .filter((r) => !r.passed)
      .map((r) => r.taskId);
    const mergeBlockedTaskIds = dedupe(mergePassResult.blocked.map((item) => item.taskId));
    currentState.review_failed_task_ids = reviewFailedTaskIds;
    syncFailedTaskIds(currentState);

    // ── Phase 3: Verification & Progressive Merge ──
    const reviewPassed = reviewResults.filter(r => r.passed).length;
    emitProgress('reviewing', `Reviews: ${reviewPassed}/${reviewResults.length} passed`);
    emitProgress('verifying', 'Running verification (tests only — build already checked)...');
    setLoopPhase(
      spec.cwd,
      currentState,
      'verifying',
      'finalize',
      'Running suite-level verification (tests, lint)...',
    );

    // Step 3a: Suite-level verification on merged codebase (build already ran in Step 2a)
    setLoopPhase(
      spec.cwd,
      currentState,
      'verifying',
      'finalize',
      'Running merged-code verification...',
      currentState.merged_task_ids,
    );
    // Respect mode contract verification_scope: minimal modes skip full-suite tests
    const effectiveConditions = modeContract.verification_scope === 'minimal'
      ? minimalSuiteConditions(spec.done_conditions)
      : suiteScopedConditions(spec.done_conditions);
    const suiteResults = runVerificationSuite(
      effectiveConditions,
      spec.cwd,
    );
    const taskSuiteResults: VerificationResult[] = [];
    // Skip task-level suite verification for minimal verification modes
    if (modeContract.verification_scope !== 'minimal') {
      for (const taskId of currentState.merged_task_ids) {
        const task = plan.tasks.find((item) => item.id === taskId);
        const { rule: taskRule, selection } = getTaskRule(task, taskRules, { lessons });
        if (task) recordRuleSelection(currentState, taskId, selection);
        if (!taskRule || taskRule.done_conditions.length === 0) continue;

        const scopedRuleConditions = suiteScopedConditions(taskRule.done_conditions);
        if (scopedRuleConditions.length === 0) continue;

        const results = runVerificationSuite(scopedRuleConditions, spec.cwd);
        recordTaskVerificationResults(currentState, taskId, results);
        markTaskVerificationFailure(currentState, taskId, results);
        taskSuiteResults.push(...results);
      }
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
    const orchestratorResult = enrichResultInfraFaultMetadata({
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
    });
    latestResult = orchestratorResult;
    reviewResults = orchestratorResult.review_results;
    saveRunResult(spec.cwd, spec.id, orchestratorResult);

    // ── Phase 4: Decide next action ──
    const allReviewsPassed = reviewResults.every((r) => r.passed);
    const smokeResultsMap = currentState._smokeResults ?? {};
    const smokeFailedTaskIds = Object.entries(smokeResultsMap)
      .filter(([, passed]) => passed === false)
      .map(([taskId]) => taskId);
    const allSmokeChecksPassed = smokeFailedTaskIds.length === 0;
    const executionBlockedTasks = plan.tasks
      .map((task) => ({
        taskId: task.id,
        reason: getTaskFinalizeBlocker(currentState, plan!, task.id),
      }))
      .filter((task): task is { taskId: string; reason: string } => Boolean(task.reason));
    const executionBlockedTaskIds = executionBlockedTasks.map((task) => task.taskId);
    const allExecutionGatesPassed = executionBlockedTasks.length === 0;
    const scopeBlockedTaskIds = mergePassResult.blocked
      .filter((item) => item.kind === 'scope_violation')
      .map((item) => item.taskId);
    const otherMergeBlockedTaskIds = mergePassResult.blocked
      .filter((item) => item.kind !== 'scope_violation')
      .map((item) => item.taskId);

    // For minimal verification modes, only minimal-scoped checks are blocking.
    // Out-of-scope suite failures (e.g., npm test, lint) are advisory and ignored.
    const minimalCheckKeys = new Set(
      minimalSuiteConditions(spec.done_conditions).map(conditionKey),
    );
    const minimalSuiteChecksPassed = suiteResults
      .filter((r) => minimalCheckKeys.has(conditionKey(r.target)))
      .every((r) => !r.target.must_pass || r.passed);

    // Smoke checks are advisory for minimal modes (worktree builds often fail
    // due to pre-existing errors unrelated to the worker's changes).
    const smokeChecksAdvisory = modeContract.verification_scope === 'minimal'
      && allReviewsPassed;

    // Suite verification non-blocking when all minimal required checks passed.
    // Out-of-scope failures (scope:suite) are advisory for minimal modes.
    const suiteVerificationNonBlocking = modeContract.verification_scope === 'minimal'
      && allReviewsPassed
      && minimalSuiteChecksPassed;

    if (allReviewsPassed
      && allExecutionGatesPassed
      && (allSmokeChecksPassed || smokeChecksAdvisory)
      && (suiteVerificationPassed || suiteVerificationNonBlocking)
      && mergeBlockedTaskIds.length === 0) {
      currentState.status = 'done';
      currentState.next_action = makeNextAction(
        'finalize',
        currentState.merged_task_ids.length > 0
          ? `All gates passed. Merged: ${currentState.merged_task_ids.join(', ')}.`
          : 'All review and verification gates passed.',
      );
    } else if (scopeBlockedTaskIds.length > 0) {
      currentState.status = 'partial';
      currentState.next_action = makeNextAction(
        'repair_task',
        `${scopeBlockedTaskIds.length} task(s) changed files outside estimated_files and were blocked before merge.`,
        scopeBlockedTaskIds,
      );
    } else if (budgetStatus?.blocked) {
      currentState.status = 'blocked';
      currentState.next_action = makeNextAction(
        'request_human',
        budgetStatus.warning || 'Budget exhausted during run.',
      );
    } else if (otherMergeBlockedTaskIds.length > 0) {
      currentState.status = 'partial';
      currentState.next_action = makeNextAction(
        'request_human',
        makeMergeBlockedReason(
          otherMergeBlockedTaskIds,
          orchestratorResult,
          `${otherMergeBlockedTaskIds.length} task(s) were blocked during auto-merge: ${mergePassResult.blocked.map((item) => `${item.taskId}=${item.kind}`).join(', ')}`,
        ),
        otherMergeBlockedTaskIds,
      );
    } else if (allReviewsPassed && executionBlockedTaskIds.length > 0) {
      currentState.status = 'partial';
      currentState.next_action = makeNextAction(
        'repair_task',
        `Execution gates failed for ${executionBlockedTaskIds.length} task(s): ${executionBlockedTasks.map((task) => `${task.taskId}=${task.reason}`).join('; ')}`,
        executionBlockedTaskIds,
      );
    } else if (allReviewsPassed && !allSmokeChecksPassed) {
      currentState.status = 'partial';
      currentState.next_action = makeNextAction(
        'repair_task',
        makeVerificationRepairReason(
          smokeFailedTaskIds,
          currentState,
          `${smokeFailedTaskIds.length} task(s) failed task-scoped verification. Attempting repair.`
            + (currentState.merged_task_ids.length > 0
              ? ` (${currentState.merged_task_ids.length} passed task(s) already merged)`
              : ''),
        ),
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
        makeReviewFailureReason(
          failedTaskIds,
          orchestratorResult,
          `${failedTaskIds.length} task(s) failed review. Attempting immediate review replacement/repair.`
            + (noOpFailedTaskIds.length > 0
              ? ` (${noOpFailedTaskIds.length} no-op task(s) detected)`
              : '')
            + (currentState.merged_task_ids.length > 0
              ? ` (${currentState.merged_task_ids.length} passed task(s) already merged)`
              : ''),
        ),
        failedTaskIds,
      );
    } else {
      // All reviews passed but suite verification failed
      currentState.status = 'partial';
      currentState.next_action = makeNextAction(
        'replan',
        'Reviews passed but suite verification failed. Replanning with failure context.'
          + (currentState.merged_task_ids.length > 0
            ? ` (${currentState.merged_task_ids.length} task(s) already merged)`
            : ''),
      );
    }

    // For minimal modes, suite is "passed" when full checks pass OR when
    // minimal required checks pass with no out-of-scope failures.
    const effectiveSuitePassed = suiteVerificationPassed || suiteVerificationNonBlocking;
    currentState.final_summary = summarizeOutcome(
      orchestratorResult,
      effectiveSuitePassed,
      currentState.merged_task_ids,
      mergeBlockedTaskIds,
    );
    saveRoundScore({
      cwd: spec.cwd,
      runId: spec.id,
      goal: spec.goal,
      round: currentState.round,
      action,
      status: currentState.status,
      workerResults,
      reviewResults,
      verificationResults: [...suiteResults, ...taskSuiteResults],
    });
    saveRunState(spec.cwd, currentState);

    console.log(
      `  📊 Round ${currentState.round} result: ${currentState.status} — ${currentState.final_summary}`,
    );
  }

  // If we exited the loop due to max_rounds without reaching terminal
  if (
    !isTerminalStatus(currentState.status)
    && currentState.round >= spec.max_rounds
  ) {
    currentState.next_action = makeMaxRoundsEscalation(currentState, spec.max_rounds);
    saveRunState(spec.cwd, currentState);
  }

  // Determine final phase: respect paused state distinctly from blocked
  let finalPhase: LoopPhase;
  let finalReason: string;
  if (currentState.steering?.paused) {
    finalPhase = 'paused';
    finalReason = 'Run paused by human steering';
  } else if (isTerminalStatus(currentState.status)) {
    finalPhase = 'done';
    finalReason = currentState.final_summary || currentState.status;
  } else {
    finalPhase = 'blocked';
    finalReason = currentState.final_summary || currentState.status;
  }
  emitProgress(finalPhase, finalReason);
  triggerUserProfileExtraction(spec, currentState);

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
