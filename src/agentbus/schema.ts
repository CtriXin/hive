/**
 * AgentBus Zod Schemas
 * Core data structures for multi-agent orchestration
 */

import { z } from 'zod';

// ============================================================================
// Enums
// ============================================================================

export const ReceiptStateEnum = z.enum([
  'PROCESSING',
  'ANSWERED',
  'TIMEOUT',
  'ERROR',
]);

export const RoomStatusEnum = z.enum([
  'OPEN',
  'CLOSED',
]);

// ============================================================================
// Base Types
// ============================================================================

export const ParticipantSchema = z.object({
  participant_id: z.string().min(1),
  model_id: z.string().min(1),
  role: z.enum(['worker', 'orchestrator', 'reviewer']),
  joined_at: z.number().int().positive(),
  cursor: z.number().int().min(0).default(0),
});

export const LockMetaSchema = z.object({
  participant_id: z.string().min(1),
  acquired_at: z.number().int().positive(),
  expires_at: z.number().int().positive(),
});

// ============================================================================
// Message Types
// ============================================================================

export const MessageSchema = z.object({
  seq: z.number().int().min(0),
  msg_id: z.string().min(1),
  msg_type: z.enum(['broadcast', 'directed', 'answer', 'system']),
  from: z.string().min(1),
  to: z.union([z.literal('*'), z.string().min(1)]),
  payload: z.record(z.unknown()),
  timestamp: z.number().int().positive(),
});

export const ReceiptSchema = z.object({
  receipt_id: z.string().min(1),
  msg_id: z.string().min(1),
  participant_id: z.string().min(1),
  state: ReceiptStateEnum,
  answer_seq: z.number().int().min(0).optional(),
  error: z.string().optional(),
  timestamp: z.number().int().positive(),
});

// ============================================================================
// Room State
// ============================================================================

export const RoomStateSchema = z.object({
  room_id: z.string().min(1),
  status: RoomStatusEnum,
  created_at: z.number().int().positive(),
  created_by: z.string().min(1),
  participants: z.array(ParticipantSchema),
  message_seq: z.number().int().min(0).default(0),
});

export const ManifestSchema = z.object({
  version: z.literal('1.0'),
  room: RoomStateSchema,
  last_updated: z.number().int().positive(),
});

// ============================================================================
// Type Exports (inferred from schemas)
// ============================================================================

export type ReceiptState = z.infer<typeof ReceiptStateEnum>;
export type RoomStatus = z.infer<typeof RoomStatusEnum>;
export type Participant = z.infer<typeof ParticipantSchema>;
export type LockMeta = z.infer<typeof LockMetaSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
export type RoomState = z.infer<typeof RoomStateSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
