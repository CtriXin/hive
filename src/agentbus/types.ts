/**
 * AgentBus TypeScript Types
 * Additional type definitions not covered by Zod schemas
 */

import type {
  Message,
  Receipt,
  Participant,
  LockMeta,
  ReceiptState,
} from './schema.js';

// ============================================================================
// Lock Types
// ============================================================================

export interface LockKey {
  /** Message ID being processed */
  msg_id: string;
  /** Participant attempting to claim */
  participant_id: string;
}

export interface CompoundLockKey {
  /** Room ID */
  room_id: string;
  /** Message ID */
  msg_id: string;
  /** Participant ID */
  participant_id: string;
}

export interface LockResult {
  success: boolean;
  lock?: LockMeta;
  error?: string;
}

// ============================================================================
// Worker Types
// ============================================================================

export interface PollResult {
  /** Message that was processed, if any */
  message?: Message;
  /** Receipt that was written */
  receipt?: Receipt;
  /** Whether cursor was advanced */
  cursor_advanced: boolean;
  /** New cursor position */
  new_cursor: number;
}

export interface WorkerConfig {
  participant_id: string;
  model_id: string;
  room_id: string;
  /** Root directory for agentbus data */
  data_dir: string;
  /** Polling interval in ms */
  poll_interval_ms: number;
  /** Lock TTL in ms */
  lock_ttl_ms: number;
  /** Handler for processing messages */
  handler: MessageHandler;
}

export type MessageHandler = (
  message: Message
) => Promise<{
  answer: unknown;
  error?: string;
}>;

// ============================================================================
// Orchestrator Types
// ============================================================================

export interface OrchestratorConfig {
  room_id: string;
  orchestrator_id: string;
  data_dir: string;
  max_rounds: number;
  timeout_ms: number;
}

export interface ResolveResult {
  resolved: boolean;
  rounds: number;
  answers: Array<{
    participant_id: string;
    answer: unknown;
  }>;
  final_answer?: unknown;
  error?: string;
}

export interface BroadcastRequest {
  payload: Record<string, unknown>;
  expect_replies_from?: string[];
  timeout_ms?: number;
}

// ============================================================================
// Backend Types
// ============================================================================

export interface BackendConfig {
  data_dir: string;
  /** Default lock TTL in ms */
  default_lock_ttl_ms: number;
  /** Stale lock cleanup threshold in ms */
  stale_lock_threshold_ms: number;
}

export interface CursorData {
  participant_id: string;
  cursor: number;
  updated_at: number;
}
