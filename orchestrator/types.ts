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
  cost_per_mtok_input: number; // ¥
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
}

export interface WorkerMessage {
  type: 'assistant' | 'tool_use' | 'tool_result' | 'error' | 'system';
  content: string;
  timestamp: number;
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

export interface ReviewResult {
  taskId: string;
  final_stage: ReviewStage; // Highest stage reached
  passed: boolean;
  verdict?: A2aVerdict; // If a2a was invoked
  findings: ReviewFinding[];
  iterations: number;
  duration_ms: number;
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
}

// ── Reporter ──

export interface ReportOptions {
  language: 'zh' | 'en';
  format: 'summary' | 'detailed';
  target: 'stdout' | 'file' | 'callback';
  callback?: (report: string) => void;
}

// ── Discussion (SDK-based) ──

export interface DiscussionReply {
  agreement: string;
  pushback: string;
  risks: string[];
  better_options: string[];
  recommended_next_step: string;
  questions_back: string[];
  one_paragraph_synthesis: string;
  quality_gate: 'pass' | 'warn' | 'fail';
}

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

export interface ReviewerTierConfig {
  cross_review: TierConfig;
  arbitration: TierConfig;   // was review_tier (Sonnet)
  final_review: TierConfig;  // was high_tier (Opus)
}

export interface TiersConfig {
  translator: TierConfig;
  planner: TierConfig;
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
  };
  host: 'claude-code' | 'codex' | 'mms';
  providers_path?: string;
  // Per-tier model configuration
  tiers: TiersConfig;
}
