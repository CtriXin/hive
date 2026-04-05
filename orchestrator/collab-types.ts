// orchestrator/collab-types.ts — Collaboration & discuss types
import type { Complexity } from './types.js';

// ── Collaboration Config (Phase 1: planner discuss transport) ──

export type PlanDiscussTransport = 'local' | 'agentbus';

export interface PlanningBriefTask {
  id: string;
  complexity: Complexity;
  category: string;
  description: string;
  assigned_model: string;
  depends_on: string[];
  estimated_files: string[];
}

export interface PlanningBrief {
  type: 'planning-brief';
  version: 1;
  created_at: string;
  goal: string;
  planner_model: string;
  cwd_hint: string;
  task_count: number;
  tasks: PlanningBriefTask[];
  execution_order: string[][];
  context_flow: Record<string, string[]>;
  review_focus: string;
  questions: string[];
}

export interface WorkerDiscussBrief {
  type: 'worker-discuss-brief';
  version: 1;
  created_at: string;
  task_id: string;
  worker_model: string;
  cwd_hint: string;
  uncertain_about: string;
  options: string[];
  leaning: string;
  why: string;
  task_description: string;
}

export interface ReviewBriefFinding {
  severity: 'red' | 'yellow' | 'green';
  file: string;
  issue: string;
}

export interface ReviewBrief {
  type: 'review-brief';
  version: 1;
  created_at: string;
  task_id: string;
  worker_model: string;
  cwd_hint: string;
  final_stage: 'cross-review' | 'a2a-lenses' | 'sonnet' | 'opus';
  passed: boolean;
  task_description: string;
  changed_files: string[];
  finding_count: number;
  findings: ReviewBriefFinding[];
  ask: string;
}

export interface RecoveryBriefAttempt {
  round: number;
  outcome: 'fixed' | 'failed' | 'skipped';
  note?: string;
}

export interface RecoveryBrief {
  type: 'recovery-brief';
  version: 1;
  created_at: string;
  task_id: string;
  worker_model: string;
  cwd_hint: string;
  retry_count: number;
  max_retries: number;
  task_description: string;
  finding_count: number;
  findings: ReviewBriefFinding[];
  recent_attempts: RecoveryBriefAttempt[];
  ask: string;
}

export interface CollabConfig {
  plan_discuss_transport: PlanDiscussTransport;
  plan_discuss_timeout_ms: number;
  plan_discuss_min_replies: number;
  worker_discuss_transport: PlanDiscussTransport;
  worker_discuss_timeout_ms: number;
  worker_discuss_min_replies: number;
  review_transport?: 'off' | 'agentbus';
  review_timeout_ms?: number;
  review_min_replies?: number;
  recovery_transport?: 'off' | 'agentbus';
  recovery_timeout_ms?: number;
  recovery_min_replies?: number;
  recovery_after_failures?: number;
}

export type CollabRoomKind = 'plan' | 'task_discuss' | 'review' | 'recovery';

export type CollabCardStatus =
  | 'open'
  | 'collecting'
  | 'synthesizing'
  | 'closed'
  | 'fallback';

export interface CollabCard {
  room_id: string;
  room_kind: CollabRoomKind;
  status: CollabCardStatus;
  replies: number;
  last_reply_at?: string;
  join_hint?: string;
  focus_task_id?: string;
  next: string;
}

export interface CollabLifecycleEvent {
  type:
    | 'room:opened'
    | 'reply:arrived'
    | 'synthesis:started'
    | 'synthesis:done'
    | 'fallback:local'
    | 'room:closed';
  room_id: string;
  room_kind: CollabRoomKind;
  at: string;
  reply_count?: number;
  focus_task_id?: string;
  note?: string;
}

export interface CollabStatusSnapshot {
  card: CollabCard;
  recent_events: CollabLifecycleEvent[];
}

export interface MindkeeperRoomRef {
  room_id: string;
  room_kind: CollabRoomKind;
  scope: 'run' | 'task';
  status: CollabCardStatus;
  replies: number;
  focus_task_id?: string;
  join_hint?: string;
  last_reply_at?: string;
}

export type HumanBridgeKind = 'agent-im';
export type HumanBridgeThreadKind = 'discord' | 'session';
export type HumanBridgeStatus = 'linked' | 'active' | 'closed';

export interface HumanBridgeRef {
  room_id: string;
  room_kind: CollabRoomKind;
  scope: 'run' | 'task';
  bridge_kind: HumanBridgeKind;
  thread_kind: HumanBridgeThreadKind;
  thread_id: string;
  status: HumanBridgeStatus;
  focus_task_id?: string;
  thread_title?: string;
  last_human_reply_at?: string;
  updated_at?: string;
}

export interface PlannerDiscussReplyMetadata {
  participant_id: string;
  response_time_ms: number;
  content_length: number;
}

export interface PlannerDiscussRoomRef {
  room_id: string;
  transport: 'agentbus';
  reply_count: number;
  timeout_ms: number;
  join_hint?: string;
  created_at: string;
  reply_metadata?: PlannerDiscussReplyMetadata[];
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

export interface PlanDiscussResult {
  partner_models: string[];
  task_gaps: string[];
  task_redundancies: string[];
  model_suggestions: string[];
  execution_order_issues: string[];
  overall_assessment: string;
  quality_gate: 'pass' | 'warn' | 'fail';
}
