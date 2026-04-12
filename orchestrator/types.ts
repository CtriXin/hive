// ═══════════════════════════════════════════════════════════════════
// orchestrator/types.ts — All shared interfaces for CLI2CLI
// ═══════════════════════════════════════════════════════════════════

// ── Model Registry ──

export type Complexity = 'low' | 'medium' | 'medium-high' | 'high';

export interface ModelCapability {
  id: string; // "qwen3.5-plus"
  provider: string; // "bailian-codingplan" (maps to MMS provider template id)
  display_name: string; // "Qwen 3.5 Plus"

  // Static scores (initial from benchmarks, 0-1)
  coding: number;
  tool_use_reliability: number;
  reasoning: number;
  chinese: number;

  // Dynamic scores (updated from review results)
  pass_rate: number;
  avg_iterations: number;
  total_tasks_completed: number;
  last_updated: string; // ISO timestamp

  // Constraints
  context_window: number;
  cost_per_mtok_input: number; // USD (domestic CNY converted in model-registry)
  cost_per_mtok_output: number;
  max_complexity: Complexity;

  // Affinities
  sweet_spot: string[]; // ["schema", "CRUD", "tests"]
  avoid: string[]; // ["security", "concurrency"]
}

export interface ClaudeTier {
  use_for: string[];
  cost_per_mtok_input: number; // USD
  cost_per_mtok_output: number;
}

export interface ModelCapabilitiesConfig {
  models: ModelCapability[];
  claude_tiers: Record<'opus' | 'sonnet' | 'haiku', ClaudeTier>;
}

// ── Task Planning ──

export interface TaskPlan {
  id: string; // uuid
  goal: string; // Original goal (English)
  cwd: string; // Project root
  tasks: SubTask[];
  execution_order: string[][]; // Parallel groups: [["A","B"], ["C"]]
  context_flow: Record<string, string[]>; // {"C": ["A"]} = C depends on A's output
  created_at: string; // ISO timestamp
}

export type ExecutionContract = 'implementation' | 'observe_only' | 'reconcile_if_needed';
export type TaskExecutionContract = ExecutionContract;

/** Operator-facing execution lane — high-level intent */
export type LaneName =
  | 'record-only'       // just record, no execution
  | 'clarify-first'     // not enough info, ask first
  | 'auto-execute-small' // single agent, no discuss, minimal validation
  | 'execute-standard'  // single agent + review (default)
  | 'execute-parallel'; // multi-agent parallel

/**
 * ExecutionMode — operator-facing depth / autonomy mode
 * Includes legacy (quick/think/auto) and new lane names.
 */
export type ExecutionMode =
  | 'quick' | 'think' | 'auto'
  | LaneName;

export interface ModeContract {
  planning_depth: 'skip' | 'minimal' | 'full';
  dispatch_style: 'skip' | 'single' | 'parallel' | 'full-orchestration';
  review_intensity: 'skip' | 'light' | 'standard' | 'full-cascade';
  verification_scope: 'skip' | 'minimal' | 'standard' | 'full-suite';
  discuss_gate: 'disabled' | 'standard' | 'enforced';
  max_rounds_override?: number; // mode-specific cap (0 = no override)
  allow_auto_merge: boolean;
  allow_repair: boolean;
  allow_replan: boolean;
  explain_label: string; // human-readable one-liner
}

export interface SubTask {
  id: string; // "task-a", "task-b"
  description: string; // Self-contained instruction
  complexity: Complexity;
  category: string; // "schema"|"utils"|"tests"|"api"|"security"|...
  assigned_model: string; // "qwen3.5-plus" | "claude-opus"
  assignment_reason: string;
  estimated_files: string[]; // Files this task will create/modify
  acceptance_criteria: string[]; // How to verify
  verification_profile?: string; // Optional .hive/rules/<id>.md profile
  discuss_threshold: number; // 0-1, below this → trigger discuss
  depends_on: string[]; // Task IDs
  review_scale: 'light' | 'medium' | 'heavy' | 'heavy+' | 'auto';
  prompt_policy?: PromptPolicySelection;
  execution_contract?: TaskExecutionContract;
}

export type PromptPolicyFragmentId =
  | 'strict_file_boundary'
  | 'exact_api_signatures'
  | 'json_structure_sample'
  | 'output_format_guard'
  | 'acceptance_checklist';

export interface PromptPolicySelection {
  version: string;
  fragments: PromptPolicyFragmentId[];
  reasons: string[];
}

// ── Worker ──

export interface BenchmarkRoutingPolicy {
  mode: 'fixed-provider';
  providerByFamily: {
    gpt: string;
    non_gpt: string;
  };
  disable_channel_fallback?: boolean;
  disable_model_fallback?: boolean;
}

export interface WorkerConfig {
  taskId: string;
  model: string;
  provider: string;
  prompt: string;
  cwd: string;
  worktree: boolean;
  contextInputs: ContextPacket[];
  discussThreshold: number;
  maxTurns: number; // Safety limit, default 25
  sessionId?: string; // For resume
  assignedModel?: string;
  runId?: string;
  planId?: string;
  round?: number;
  taskDescription?: string;
  fromBranch?: string;
  promptPolicy?: PromptPolicySelection;
  benchmarkRoutingPolicy?: BenchmarkRoutingPolicy;
  onWorkerDiscussSnapshot?: (snapshot: CollabStatusSnapshot) => void | Promise<void>;
  execution_contract?: TaskExecutionContract;
  /** Phase 8A: Provider health store path for resilience tracking */
  providerHealthDir?: string;
}

export interface WorkerResult {
  taskId: string;
  model: string;
  provider?: string;
  requested_model?: string;
  requested_provider?: string;
  worktreePath: string;
  branch: string; // Git branch name
  sessionId: string;
  output: WorkerMessage[];
  changedFiles: string[]; // From git diff
  success: boolean;
  duration_ms: number;
  token_usage: { input: number; output: number };
  discuss_triggered: boolean;
  discuss_results: DiscussResult[];
  prompt_policy_version?: string;
  prompt_fragments?: PromptPolicyFragmentId[];
  worker_discuss_collab?: CollabStatusSnapshot;
  /** Inherited from task at dispatch time for failure classification */
  execution_contract?: TaskExecutionContract;
  /** Phase 8A: Provider failure details if worker failed due to provider issue */
  provider_failure_subtype?: ProviderFailureSubtype;
  /** Phase 8A: Whether a provider fallback was used for this worker */
  provider_fallback_used?: boolean;
}

export interface WorkerMessage {
  type: 'assistant' | 'tool_use' | 'tool_result' | 'error' | 'system';
  content: string;
  timestamp: number;
}

// ── Worker Status (hiveshell) ──

export type WorkerLifecycleStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'discussing'
  | 'completed'
  | 'failed';

export interface WorkerStatusEntry {
  task_id: string;
  status: WorkerLifecycleStatus;
  assigned_model: string;
  active_model: string;
  provider: string;
  agent_id: string;
  task_description?: string;
  session_id?: string;
  branch?: string;
  worktree_path?: string;
  discuss_triggered: boolean;
  started_at?: string;
  finished_at?: string;
  updated_at: string;
  task_summary?: string;
  last_message?: string;
  changed_files_count?: number;
  success?: boolean;
  error?: string;
  prompt_policy_version?: string;
  prompt_fragments?: PromptPolicyFragmentId[];
  execution_contract?: TaskExecutionContract;
  provider_failure_subtype?: ProviderFailureSubtype;
  provider_fallback_used?: boolean;
  transcript_path?: string;
  collab?: CollabStatusSnapshot;
  discuss_conclusion?: {
    quality_gate: 'pass' | 'warn' | 'fail' | 'fallback';
    conclusion: string;
  };
}

export interface WorkerStatusSnapshot {
  run_id: string;
  plan_id: string;
  goal?: string;
  round: number;
  updated_at: string;
  workers: WorkerStatusEntry[];
}

export interface WorkerStatusEvent {
  run_id: string;
  plan_id: string;
  round: number;
  task_id: string;
  agent_id: string;
  status: WorkerLifecycleStatus;
  timestamp: string;
  message?: string;
  active_model?: string;
  provider?: string;
  transcript_path?: string;
}

export interface WorkerTranscriptEntry {
  run_id: string;
  plan_id: string;
  task_id: string;
  agent_id: string;
  session_id?: string;
  type: WorkerMessage['type'];
  timestamp: string;
  content: string;
}

// ── Phase 1A: Task Context Pack ──

export interface TaskContextSource {
  from_task: string;
  summary: string;
  key_outputs: string[];
  decision_trace: string[];
}

export interface TaskContextPack {
  generated_at: string;
  run_id: string;
  plan_id: string;
  task_id: string;
  task_objective: string;
  round: number;
  is_repair: boolean;
  selected_files: string[];
  verification_profile?: string;
  prompt_fragments?: PromptPolicyFragmentId[];
  prompt_policy_version?: string;
  goal_snippets?: string[];
  upstream_context: ContextPacket[];
  assigned_model?: string;
  assigned_provider?: string;
  execution_contract?: TaskExecutionContract;
  repair_context?: {
    previous_error?: string;
    previous_changed_files?: string[];
    review_findings?: Array<{ severity: FindingSeverity; file: string; line?: number; issue: string }>;
    verification_failures?: Array<{ type: string; message: string; command?: string }>;
    repair_guidance?: string[];
  };
}

export interface DispatchContextRecord {
  run_id: string;
  plan_id: string;
  task_id: string;
  round: number;
  is_repair: boolean;
  injected_context_ids: string[];
  selected_file_count: number;
  goal_snippet_count: number;
  upstream_context_count: number;
  prompt_policy_version?: string;
  generated_at: string;
}

// ── Phase 2A: Transition Log ──

export interface RunTransitionRecord {
  id: string;
  timestamp: string;
  run_id: string;
  task_id?: string;
  from_state: string;
  to_state: string;
  reason: string;
  failure_class?: FailureClass;
  retry_count?: number;
  replan_count?: number;
  round: number;
}

/** Alias for TaskRunRecord used in forensics and state maps */
export type TaskStateRecord = TaskRunRecord;

// ── Phase 4A: Routing Enforcement ──

export type RoutingOverridePolicy =
  | 'high_confidence_score'
  | 'provider_cooldown'
  | 'repair_round_boost'
  | 'fallback_best_available'
  | 'conservative_keep'
  | 'suggest_only';

export interface RoutingEnforcementResult {
  planner_assigned_model: string;
  router_selected_model: string;
  effective_model: string;
  override_applied: boolean;
  override_reason: string;
  policy: RoutingOverridePolicy;
}

export type DiscussEnforcementAction = 'none' | 'reroute' | 'escalate' | 'block' | 'suggest_only';
export type DispatchEffectivePath = 'direct' | 'rerouted' | 'escalated' | 'blocked';

// ── Phase 6A: Cross-Run Learning ──

export type LessonKind =
  | 'failure_pattern'      // task type X tends to fail with failure class Y
  | 'verification_profile'  // task type X works better with verification profile Y
  | 'mode_escalation'       // task type X is more likely to need mode escalation
  | 'provider_risk'         // provider/model combo shows elevated failure rate
  | 'repair_strategy'       // repair type X succeeds more with strategy Y
  | 'rule_recommendation';  // task pattern X benefits from rule Y

export type LessonConfidence = 'low' | 'medium' | 'high';

export interface LessonEvidence {
  source_run_id: string;
  source_artifact: 'failure_class' | 'transition_log' | 'forensics_pack' | 'verification_outcome' | 'review_outcome';
  signal: string; // brief description of the specific signal
  weight: number; // contribution to this lesson (0-1)
}

export interface Lesson {
  id: string; // 'lesson-<hash>'
  kind: LessonKind;
  /** Pattern this lesson applies to (e.g. category, file pattern prefix) */
  pattern: string;
  /** What the system should do differently based on this lesson */
  recommendation: string;
  /** Why this recommendation was made */
  reason: string;
  confidence: LessonConfidence;
  /** Evidence sources that led to this lesson */
  evidence: LessonEvidence[];
  /** How many distinct runs support this lesson */
  supporting_runs: number;
  /** How many observations (transitions, failures, verifications) support this */
  observation_count: number;
  /** When this lesson was first created */
  created_at: string; // ISO
  /** When this lesson was last updated with new evidence */
  updated_at: string; // ISO
  /** Whether this lesson is currently active (can be disabled by user) */
  active: boolean;
}

export interface LessonStore {
  lessons: Lesson[];
  generated_at: string; // ISO
}

export type RuleSelectionBasis =
  | 'explicit_config'    // user explicitly specified
  | 'project_policy'     // from .hive/project.md
  | 'learning_auto_pick' // auto-selected by lesson-based rules
  | 'learning_suggest'   // suggested by learning, not auto-applied
  | 'fallback';          // default profile used due to no signal

export interface RuleSelectionResult {
  /** The rule/profile that was selected or recommended */
  selected_rule?: string;
  /** How confident we are (0-1) */
  confidence: number;
  /** Why this rule was chosen */
  selection_reason: string;
  /** How this rule was chosen */
  basis: RuleSelectionBasis;
  /** Evidence summary supporting the selection */
  evidence_summary: string[];
  /** Whether this was auto-applied or just a suggestion */
  auto_applied: boolean;
  /** Lessons that influenced this selection */
  relevant_lessons: string[];
}

export interface DiscussEnforcementResult {
  discuss_required: boolean;
  enforcement_action: DiscussEnforcementAction;
  effective_path: DispatchEffectivePath;
  dispatch_blocked: boolean;
  escalation_target: string;
}

// ── Autonomous Run Loop ──

export type RunMode = 'safe' | 'balanced' | 'aggressive';
export type RunStatus =
  | 'init'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'repairing'
  | 'replanning'
  | 'blocked'
  | 'partial'
  | 'done';

export type DoneConditionType =
  | 'test'
  | 'build'
  | 'lint'
  | 'command'
  | 'file_exists'
  | 'review_pass';

export type VerificationScope = 'worktree' | 'suite' | 'both';
export type PolicyHookStage = 'pre_merge' | 'post_verify';

export type VerificationFailureClass =
  | 'build_fail'
  | 'test_fail'
  | 'lint_fail'
  | 'command_fail'
  | 'missing_output'
  | 'review_fail'
  | 'infra_fail'
  | 'unknown';

// ── Phase 2A: Failure Classification ──

export type FailureClass =
  | 'context'
  | 'tool'
  | 'provider'
  | 'build'
  | 'test'
  | 'lint'
  | 'verification'
  | 'merge'
  | 'policy'
  | 'review'
  | 'planner'
  | 'scope'
  | 'no_op'
  | 'budget'
  | 'unknown';

// ── Phase 8A: Provider Failure Taxonomy ──

/**
 * Fine-grained provider failure subtype.
 * Used for retry/backoff/cooldown decisions — not mixed with discuss/review/build logic.
 */
export type ProviderFailureSubtype =
  | 'rate_limit'            // 429, overloaded, throttled
  | 'timeout'               // Connection or request timeout
  | 'transient_network'     // ECONNREFUSED, ECONNRESET, DNS failure
  | 'server_error'          // 5xx from provider
  | 'auth_failure'          // 401/403, invalid key, expired token
  | 'quota_exhausted'       // Provider-side quota/credits depleted
  | 'provider_unavailable'  // Provider gateway down, MMS route missing
  | 'unknown_provider_failure';

/**
 * Circuit breaker state for a single provider.
 * healthy → degraded → open → probing → healthy (or open again)
 */
export type CircuitBreakerState = 'healthy' | 'degraded' | 'open' | 'probing';

/**
 * Resilience decision recorded for each provider failure event.
 * Must be explainable: why retry/backoff/fallback/cooldown was chosen.
 */
export interface ProviderResilienceDecision {
  provider: string;
  failure_subtype: ProviderFailureSubtype;
  action: 'immediate_retry' | 'bounded_retry' | 'backoff_retry' | 'fallback' | 'cooldown' | 'block';
  action_reason: string;
  /** Whether the task dispatch was affected (model changed, delayed, blocked) */
  dispatch_affected: boolean;
  /** If fallback was used, which provider was selected instead */
  fallback_provider?: string;
  /** Backoff delay in ms that was or would be applied */
  backoff_ms: number;
  /** Attempt number within this failure episode (1-based) */
  attempt: number;
  timestamp: number;
}

/**
 * Extended provider health state (replaces simple cooldown counter).
 * Persisted to .ai/runs/<run-id>/provider-health.json
 */
export interface ProviderHealthState {
  /** Circuit breaker state */
  breaker: CircuitBreakerState;
  /** Subtype of the most recent failure */
  last_failure_subtype?: ProviderFailureSubtype;
  /** Last time this provider state changed */
  updated_at?: string;
  /** Consecutive failure count (reset on success) */
  consecutive_failures: number;
  /** Total failures in current breaker cycle */
  cycle_failures: number;
  /** Epoch ms of last failure */
  last_failure_at: number;
  /** Epoch ms of last success (provider was usable) */
  last_success_at: number;
  /** Epoch ms when breaker opened (for cooldown expiry calculation) */
  opened_at?: number;
  /** Probing attempt count since entering probing state */
  probe_count: number;
}

/**
 * Durable provider health store data.
 */
export interface ProviderHealthStoreData {
  providers: Record<string, ProviderHealthState>;
  decisions: ProviderResilienceDecision[];
  updated_at: string;
}

export type NextActionKind =
  | 'execute'
  | 'retry_task'
  | 'repair_task'
  | 'replan'
  | 'request_human'
  | 'finalize';

export type TaskRunStatus =
  | 'pending'
  | 'worker_failed'
  | 'no_op'
  | 'review_failed'
  | 'verification_failed'
  | 'merge_blocked'
  | 'verified'
  | 'merged'
  | 'superseded';

export interface DoneCondition {
  type: DoneConditionType;
  label: string;
  command?: string;
  path?: string;
  must_pass: boolean;
  timeout_ms?: number;
  scope?: VerificationScope;
}

export interface VerificationResult {
  target: DoneCondition;
  passed: boolean;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
  duration_ms: number;
  failure_class?: VerificationFailureClass;
  provider_failure_subtype?: ProviderFailureSubtype;
  provider_fallback_used?: boolean;
  requested_model?: string;
  requested_provider?: string;
  actual_model?: string;
  actual_provider?: string;
}

export interface NextAction {
  kind: NextActionKind;
  reason: string;
  task_ids: string[];
  instructions?: string;
}

export interface TaskRunRecord {
  task_id: string;
  status: TaskRunStatus;
  round: number;
  changed_files: string[];
  merged: boolean;
  worker_success: boolean;
  review_passed: boolean;
  last_error?: string;
  retry_count: number;
  failure_class?: FailureClass;
  terminal_reason?: string;
}

export interface RepairHistoryEntry {
  task_id: string;
  round: number;
  findings_count: number;
  outcome: 'fixed' | 'failed' | 'skipped';
  note?: string;
}

export interface PolicyHook {
  stage: PolicyHookStage;
  label: string;
  command: string;
  must_pass: boolean;
}

export interface PolicyHookResult {
  stage: PolicyHookStage;
  label: string;
  passed: boolean;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
  round: number;
}

export interface RunSpec {
  id: string;
  goal: string;
  cwd: string;
  origin_cwd?: string;
  task_cwd?: string;
  mode: RunMode;
  /** Phase 5A: Operator-facing execution mode */
  execution_mode?: ExecutionMode;
  /** Operator-facing lane name (display only) */
  lane?: LaneName;
  /** Agent count hint (never overrides dispatch_style from contract) */
  agent_count?: number;
  done_conditions: DoneCondition[];
  max_rounds: number;
  max_worker_retries: number;
  max_replans: number;
  allow_auto_merge: boolean;
  stop_on_high_risk: boolean;
  created_at: string;
}

export interface RunState {
  run_id: string;
  status: RunStatus;
  round: number;
  current_plan_id?: string;
  completed_task_ids: string[];
  failed_task_ids: string[];
  review_failed_task_ids: string[];
  merged_task_ids: string[];
  retry_counts: Record<string, number>;
  replan_count: number;
  task_states: Record<string, TaskRunRecord>;
  task_verification_results: Record<string, VerificationResult[]>;
  repair_history: RepairHistoryEntry[];
  round_cost_history: RoundCostEntry[];
  policy_hook_results: PolicyHookResult[];
  verification_results: VerificationResult[];
  budget_status?: BudgetStatus;
  budget_warning?: string | null;
  next_action?: NextAction;
  final_summary?: string;
  updated_at: string;
  /** Phase 2A: persisted transition log */
  transition_log?: RunTransitionRecord[];
  /** Task-scoped smoke verification results from the latest execution/repair round.
   * Key: taskId, Value: true if smoke passed, false if failed. */
  _smokeResults?: Record<string, boolean>;
  /** Phase 8B: human steering state */
  steering?: RunStateSteering;
  /** Phase 5A.1: mode escalation history */
  mode_escalation_history?: Array<{ from: ExecutionMode; to: ExecutionMode; reason: string; round: number }>;
  /** Runtime mode override set by steering escalate/downgrade actions.
   *  Supersedes spec.execution_mode for display and decision purposes within this run. */
  runtime_mode_override?: ExecutionMode;
}

// ── Context Recycling ──

export interface ContextPacket {
  from_task: string;
  summary: string;
  key_outputs: {
    file: string;
    purpose: string;
    key_exports: string[];
  }[];
  decisions_made: string[];
}

// ── Discussion ──

export interface DiscussTrigger {
  uncertain_about: string;
  options: string[];
  leaning: string;
  why: string;
  task_id: string;
  worker_model: string;
}

export interface DiscussResult {
  decision: string;
  reasoning: string;
  escalated: boolean;
  escalated_to?: 'sonnet' | 'opus';
  thread_id: string;
  quality_gate: 'pass' | 'warn' | 'fail';
}

// ── Review ──

export type ReviewStage = 'cross-review' | 'a2a-lenses' | 'sonnet' | 'opus';
export type A2aVerdict = 'PASS' | 'CONTESTED' | 'REJECT' | 'BLOCKED';
export type FindingSeverity = 'red' | 'yellow' | 'green';
export type A2aLens = 'challenger' | 'architect' | 'subtractor';

export interface ReviewAuthorityMetadata {
  source: 'legacy-cascade' | 'authority-layer';
  mode: 'single' | 'pair';
  members: string[];
  disagreement_flags?: string[];
  synthesized_by?: string;
  synthesis_strategy?: 'model' | 'heuristic';
  synthesis_attempted_by?: string;
}

export type ReviewFailureAttribution =
  | 'none'
  | 'prompt_fault'
  | 'model_fault'
  | 'task_design_fault'
  | 'infra_fault'
  | 'mixed'
  | 'unknown';

export interface ReviewResult {
  taskId: string;
  final_stage: ReviewStage; // Highest stage reached
  passed: boolean;
  verdict?: A2aVerdict; // If a2a was invoked
  findings: ReviewFinding[];
  iterations: number;
  duration_ms: number;
  token_stages?: StageTokenUsage[];
  external_review_collab?: CollabStatusSnapshot;
  authority?: ReviewAuthorityMetadata;
  provider_failure_subtype?: ProviderFailureSubtype;
  provider_fallback_used?: boolean;
  requested_model?: string;
  requested_provider?: string;
  actual_model?: string;
  actual_provider?: string;
  failure_attribution?: ReviewFailureAttribution;
  prompt_fault_confidence?: number;
  recommended_fragments?: PromptPolicyFragmentId[];
}

export interface ReviewFinding {
  id: number;
  severity: FindingSeverity;
  lens: A2aLens | 'cross-review' | 'sonnet' | 'opus' | string;
  file: string;
  line?: number;
  issue: string;
  decision: 'accept' | 'dismiss' | 'flag';
  decision_reason?: string;
}

export interface CrossReviewResult {
  passed: boolean;
  confidence: number; // 0-1
  failure_attribution?: ReviewFailureAttribution;
  prompt_fault_confidence?: number;
  recommended_fragments?: PromptPolicyFragmentId[];
  flagged_issues: Array<{
    severity: FindingSeverity;
    file: string;
    line?: number;
    issue: string;
  }>;
  reviewer_model: string;
}

export interface A2aLensResult {
  lens: A2aLens;
  model: string;
  findings: ReviewFinding[];
  raw_output: string;
}

export interface A2aReviewResult {
  verdict: A2aVerdict;
  lens_results: A2aLensResult[];
  all_findings: ReviewFinding[];
  red_count: number;
  yellow_count: number;
  green_count: number;
}

// ── Orchestrator Output ──

export interface OrchestratorResult {
  plan: TaskPlan;
  worker_results: WorkerResult[];
  review_results: ReviewResult[];
  score_updates: { model: string; old_pass_rate: number; new_pass_rate: number }[];
  total_duration_ms: number;
  cost_estimate: {
    opus_tokens: number;
    sonnet_tokens: number;
    haiku_tokens: number;
    domestic_tokens: number;
    estimated_cost_usd: number;
  };
  token_breakdown?: TokenBreakdown;
  budget_status?: BudgetStatus;
  budget_warning?: string | null;
  task_verification_results?: Record<string, VerificationResult[]>;
}

// ── Provider Registry (替代 MMS credentials.sh) ──

export interface ProviderEntry {
  id: string;
  display_name: string;
  anthropic_base_url?: string;
  openai_base_url?: string;
  api_key_env: string;
  protocol: 'anthropic_native' | 'openai_only' | 'both';
  note?: string;
}

export interface ProvidersConfig {
  providers: Record<string, ProviderEntry>;
}

// ── Translator (Tier 0) ──

export interface TranslationResult {
  original: string;
  english: string;
  confidence: number;
  translator_model: string;
  duration_ms: number;
  token_usage?: { input: number; output: number };
  stage_usage?: StageTokenUsage;
}

// ── Token Breakdown ──

export interface StageTokenUsage {
  stage: string;  // 'planner' | 'worker:task-a' | 'cross-review:task-a' | 'a2a:task-a' | 'reporter'
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export interface TokenBreakdown {
  stages: StageTokenUsage[];
  total_input: number;
  total_output: number;
  actual_cost_usd: number;
  claude_equivalent_usd: number;
  savings_usd: number;
}

export interface BudgetStatus {
  monthly_limit_usd: number;
  current_spent_usd: number;
  remaining_usd: number;
  remaining_ratio: number;
  warn_at: number;
  block: boolean;
  blocked: boolean;
  warning: string | null;
}

export interface RoundCostEntry {
  round: number;
  action: NextActionKind;
  cost_estimate: {
    opus_tokens: number;
    sonnet_tokens: number;
    haiku_tokens: number;
    domestic_tokens: number;
    estimated_cost_usd: number;
  };
  token_breakdown: TokenBreakdown;
  budget_status?: BudgetStatus;
}

// ── Plan Checkpoint (P1: result persistence + resume) ──

export interface PlanCheckpoint {
  plan_id: string;
  completed_groups: number;
  completed_task_ids: string[];
  context_cache: Record<string, ContextPacket>;
  worker_results_refs: string[];
  updated_at: string;
}

// ── Reporter ──

export interface ReportOptions {
  language: 'zh' | 'en';
  format: 'summary' | 'detailed';
  target: 'stdout' | 'file' | 'callback';
  callback?: (report: string) => void;
}

// ── Collaboration & Discussion types (extracted to collab-types.ts) ──
// Import types used within this file, then re-export all for consumers
import type {
  CollabConfig as _CollabConfig,
  HumanBridgeRef as _HumanBridgeRef,
  MindkeeperRoomRef as _MindkeeperRoomRef,
  CollabStatusSnapshot as _CollabStatusSnapshot,
} from './collab-types.js';

// Re-export under original names so all consumers keep working
export type CollabConfig = _CollabConfig;
export type HumanBridgeRef = _HumanBridgeRef;
export type MindkeeperRoomRef = _MindkeeperRoomRef;
export type CollabStatusSnapshot = _CollabStatusSnapshot;

export type {
  PlanDiscussTransport,
  PlanningBriefTask,
  PlanningBrief,
  WorkerDiscussBrief,
  ReviewBriefFinding,
  ReviewBrief,
  RecoveryBriefAttempt,
  RecoveryBrief,
  CollabRoomKind,
  CollabCardStatus,
  CollabCard,
  CollabLifecycleEvent,
  HumanBridgeKind,
  HumanBridgeThreadKind,
  HumanBridgeStatus,
  PlannerDiscussReplyMetadata,
  PlannerDiscussRoomRef,
  DiscussionReply,
  PlanDiscussResult,
} from './collab-types.js';

// ── Protocol Adapter ──

export interface AdaptedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

// ── Tier Config (per-tier model selection) ──

export interface TierConfig {
  model: string;            // model ID or 'auto' for registry-based selection
  fallback?: string;        // fallback model ID
  allow_domestic?: boolean; // whether domestic models are allowed (default true)
}

export interface DiscussTierConfig {
  model: string | string[];  // single partner or multiple (1v2). 'auto' = registry picks
  fallback?: string;
  mode?: 'auto' | 'always' | 'off'; // 'auto' = no plan discuss; 'always' = force plan discuss
}

export interface ReviewerTierConfig {
  cross_review: TierConfig;
  arbitration: TierConfig;   // was review_tier (Sonnet)
  final_review: TierConfig;  // was high_tier (Opus)
}

export interface TiersConfig {
  translator: TierConfig;
  planner: TierConfig;
  discuss: DiscussTierConfig;
  executor: TierConfig;
  reviewer: ReviewerTierConfig;
  reporter: TierConfig;
}

// ── Hive Config (双层: global + project) ──

export interface HiveConfig {
  // Legacy fields (still supported for backward compat)
  orchestrator: string;
  high_tier: string;
  review_tier: string;
  default_worker: string;
  fallback_worker: string;
  translator_model?: string;
  overrides: Record<string, string>;
  budget: {
    monthly_limit_usd: number;
    warn_at: number;
    block: boolean;
    current_spent_usd: number;
    reset_day: number;
    last_reset?: string;
  };
  host: 'claude-code' | 'codex' | 'mms';
  providers_path?: string;
  // Per-tier model configuration
  tiers: TiersConfig;
  // Collaboration config (Phase 1: planner discuss transport)
  collab?: CollabConfig;
}

// ── Planning Input & Runtime Hooks (hiveshell) ──

export interface PlanningInput {
  goal: string;
  context_blocks: string[];
}

export interface RunHookContext {
  spec: RunSpec;
  state: RunState;
  action: NextActionKind;
  round: number;
  planning_input?: PlanningInput;
  plan?: TaskPlan | null;
  worker_results?: WorkerResult[];
  review_results?: ReviewResult[];
  verification_results?: VerificationResult[];
}

export type RunHook = (
  context: RunHookContext,
) => void | Promise<void>;

export interface RunRuntimeHooks {
  beforePlan?: RunHook;
  afterPlan?: RunHook;
  afterExecution?: RunHook;
  beforeReview?: RunHook;
  afterReview?: RunHook;
  afterRun?: RunHook;
}

// ── Phase 7A: Project Memory + Cross-Session Recall ──

export type MemoryCategory =
  | 'recurring_failure'    // repeated failure pattern across runs
  | 'effective_repair'     // repair tactic that worked repeatedly
  | 'stable_preference'    // rule/profile/model combo that works well
  | 'risky_area'           // fragile file / common regression zone
  | 'routing_tendency';    // mode/routing pattern with evidence

export type MemorySourceKind =
  | 'failure_class'
  | 'forensics_pack'
  | 'transition_log'
  | 'verification_outcome'
  | 'review_outcome'
  | 'lesson';

export interface MemoryEvidence {
  source_run_id: string;
  source_artifact: MemorySourceKind;
  signal: string; // brief description of the specific signal
  artifact_path?: string; // pointer to run artifact
  weight: number; // 0-1, recency-weighted
}

export interface ProjectMemoryEntry {
  memory_id: string; // 'mem-<hash>'
  category: MemoryCategory;
  /** Short, human-readable summary of this memory */
  summary: string;
  /** Detailed explanation of what this memory captures */
  detail: string;
  /** Evidence supporting this memory */
  evidence: MemoryEvidence[];
  /** Source run IDs that contributed to this memory */
  source_run_ids: string[];
  /** Source artifact paths for traceability */
  source_artifacts: string[];
  /** Confidence in this memory (0-1) */
  confidence: number;
  /** When this memory was first created */
  created_at: string; // ISO
  /** When this memory was last updated with new evidence */
  updated_at: string; // ISO
  /** Recency decay factor: 1.0 = fresh, decays over time */
  recency: number;
  /** Whether this memory is still considered active */
  active: boolean;
  /** Stale marker — set when memory is too old or evidence decayed */
  stale: boolean;
}

export interface ProjectMemoryStore {
  project_id: string; // repo basename or explicit project id
  memories: ProjectMemoryEntry[];
  generated_at: string; // ISO
}

export interface MemoryRecallInput {
  /** Current goal being worked on */
  goal: string;
  /** Task type / category if known */
  task_type?: string;
  /** Files the task may touch */
  touched_files?: string[];
  /** Failure class if this is a repair context */
  failure_class?: FailureClass;
  /** Current execution mode */
  execution_mode?: ExecutionMode;
}

export interface MemoryRecallResult {
  /** Relevant memories, sorted by relevance */
  memories: Array<{
    entry: ProjectMemoryEntry;
    relevance_score: number; // 0-1, how relevant to current context
    why_relevant: string; // brief explanation
  }>;
  /** Total memories considered before filtering */
  total_candidates: number;
  /** Why these were selected */
  selection_reason: string;
}

// ── Phase 8B: Human Steering Surface ──

/** Steering action types — machine-readable control-plane input */
export type SteeringActionType =
  | 'pause_run'
  | 'resume_run'
  | 'retry_task'
  | 'skip_task'
  | 'escalate_mode'
  | 'downgrade_mode'
  | 'request_replan'
  | 'force_discuss'
  | 'mark_requires_human'
  | 'inject_steering_note';

/** Where the action applies */
export type SteeringScope = 'run' | 'task';

/** Status of a steering action through its lifecycle */
export type SteeringActionStatus =
  | 'pending'       // submitted, not yet processed
  | 'applied'       // accepted and applied at safe point
  | 'rejected'      // refused by validator
  | 'suppressed'    // duplicate of already-processed action; ignored for idempotency;
  | 'expired';      // run reached terminal state before action could apply

/** Payload varies by action_type */
export interface SteeringActionPayload {
  /** Target execution_mode for escalate_mode / downgrade_mode */
  target_mode?: ExecutionMode;
  /** Target task_id for task-level actions */
  task_id?: string;
  /** Free-text instruction for inject_steering_note */
  note?: string;
  /** Reason provided by the operator */
  reason?: string;
  /** Additional structured data */
  extra?: Record<string, unknown>;
}

/** A single steering action request */
export interface SteeringAction {
  action_id: string; // `steer-<hash>`
  run_id: string;
  task_id?: string; // set for task-level actions
  action_type: SteeringActionType;
  scope: SteeringScope;
  payload: SteeringActionPayload;
  requested_by: string; // 'human' | 'mcp' | 'cli' | 'auto'
  requested_at: string; // ISO timestamp
  status: SteeringActionStatus;
  /** Epoch ms when action was applied (or rejected) */
  applied_at?: number;
  /** Why rejected, or effect summary when applied */
  outcome?: string;
}

/** Phase 8B: steering state attached to RunState */
export interface RunStateSteering {
  /** Whether the run is currently paused by human request */
  paused: boolean;
  /** Pending steering actions waiting for safe-point application */
  pending_actions: string[]; // action_ids
  /** Most recently applied action summary */
  last_applied?: { action_id: string; action_type: string; outcome: string; applied_at: number };
  /** Most recently rejected action summary */
  last_rejected?: { action_id: string; action_type: string; reason: string; applied_at: number };
}

// ── Score History (hiveshell) ──

export interface RunScoreSignals {
  worker_count: number;
  worker_success_count: number;
  review_count: number;
  review_pass_count: number;
  verification_count: number;
  verification_pass_count: number;
  verification_fail_count: number;
  discuss_triggered_count: number;
  changed_files_count: number;
  prompt_fragment_usage: Partial<Record<PromptPolicyFragmentId, number>>;
  prompt_policy_version_usage: Record<string, number>;
  total_duration_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

export interface RoundScoreEntry {
  run_id: string;
  round: number;
  action: NextActionKind;
  status: RunStatus;
  created_at: string;
  score: number;
  delta_from_previous?: number;
  summary: string;
  signals: RunScoreSignals;
}

export interface RunScoreHistory {
  run_id: string;
  goal?: string;
  updated_at: string;
  latest_score?: number;
  best_score?: number;
  rounds: RoundScoreEntry[];
}
