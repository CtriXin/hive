// ═══════════════════════════════════════════════════════════════════
// discuss-lib/types.ts — Shared types for cross-model interactions
// ═══════════════════════════════════════════════════════════════════

// ── Severity & Verdict ──

export type FindingSeverity = 'red' | 'yellow' | 'green';
export type A2aVerdict = 'PASS' | 'CONTESTED' | 'REJECT' | 'BLOCKED';
export type A2aLens = 'challenger' | 'architect' | 'subtractor';

// ── Discussion ──

export interface DiscussTrigger {
  uncertain_about: string;
  options: string[];
  leaning: string;
  why: string;
  task_id: string;
  worker_model: string;
  /** Optional context about the implementation */
  context?: string;
}

export interface DiscussionReply {
  agreement: string;
  pushback: string;
  risks: string[];
  better_options: string[];
  recommended_next_step: string;
  questions_back: string[];
  one_paragraph_synthesis: string;
}

export interface DiscussResult {
  decision: string;
  reasoning: string;
  escalated: boolean;
  escalated_to?: string;
  thread_id: string;
  quality_gate: 'pass' | 'warn' | 'fail';
  reply?: DiscussionReply;
}

export interface DiscussOptions {
  modelId: string;
  cwd?: string;
}

// ── Review Finding ──

export interface ReviewFinding {
  id: number;
  severity: FindingSeverity;
  lens: A2aLens | 'cross-review' | string;
  file: string;
  line?: number;
  issue: string;
  decision: 'accept' | 'dismiss' | 'flag';
  decision_reason?: string;
}

// ── Cross-Review ──

export interface CrossReviewResult {
  passed: boolean;
  confidence: number;
  flagged_issues: Array<{
    severity: FindingSeverity;
    file: string;
    line?: number;
    issue: string;
  }>;
  reviewer_model: string;
}

export interface CrossReviewOptions {
  reviewerModelId: string;
  cwd?: string;
}

// ── A2a 3-Lens Review ──

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

export interface A2aReviewInput {
  /** Path to the git worktree with changes */
  worktreePath: string;
  /** Changed files (relative paths) */
  changedFiles: string[];
  /** Task description for context */
  taskDescription: string;
  /** Task category */
  category?: string;
  /** Task complexity */
  complexity?: string;
}

export interface A2aReviewOptions {
  /** Model IDs to use for each lens (up to 3) */
  models: string[];
  /** Override scale detection */
  scale?: 'light' | 'medium' | 'heavy' | 'heavy+' | 'auto';
}

// ── Multi-Model Debate ──

export interface DebateRoundResult {
  model: string;
  reply: DiscussionReply | null;
  raw_output: string;
  quality_gate: 'pass' | 'warn' | 'fail';
}

export interface DebateResult {
  rounds: DebateRoundResult[][];
  synthesis: DebateRoundResult | null;
  thread_id: string;
  models_used: string[];
}

// ── Group Debate (A vs B) ──

export interface GroupDebateResult {
  /** Results from each group's internal debate */
  group_results: DebateResult[];
  /** Final cross-confrontation of all group conclusions */
  final_synthesis: DebateRoundResult | null;
  /** Which model did the final synthesis */
  judge_model: string;
  thread_id: string;
  models_used: string[];
}

// ── Config ──

export interface ModelRoute {
  anthropic_base_url: string;
  api_key: string;
  provider_id?: string;
  use_count?: number;
  priority?: number;
  role?: string;
  openai_base_url?: string;
  fallback_routes?: ModelRoute[];
}

export interface DiscussConfig {
  default_models: string[];
  model_routes_path?: string;
  fallback_model?: string;
  providers?: Record<string, { base_url: string; api_key: string }>;
}
