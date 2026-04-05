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
}

// ── Worker ──

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
  onWorkerDiscussSnapshot?: (snapshot: CollabStatusSnapshot) => void | Promise<void>;
}

export interface WorkerResult {
  taskId: string;
  model: string;
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
  worker_discuss_collab?: CollabStatusSnapshot;
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
  transcript_path?: string;
  collab?: CollabStatusSnapshot;
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

// ── Autonomous Run Loop ──

export type RunMode = 'safe' | 'balanced' | 'aggressive';
export type RunStatus =
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
}

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
