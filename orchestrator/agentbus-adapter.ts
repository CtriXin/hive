// ═══════════════════════════════════════════════════════════════════
// orchestrator/agentbus-adapter.ts — Thin bridge from Hive to AgentBus
// ═══════════════════════════════════════════════════════════════════
// No Hive run-state mutation. No business logic about plan quality.
// Failure is explicit and easy to debug.

import type {
  PlanDiscussResult,
  PlannerDiscussRoomRef,
  PlannerDiscussReplyMetadata,
  PlanningBrief,
} from './types.js';

// ── Exported types ──

export interface AgentBusReply {
  participant_id: string;
  content: string;
  response_time_ms: number;
  content_length: number;
  received_at: string;
}

export interface PlannerDiscussRoom {
  room_id: string;
  join_hint?: string;
  orchestrator_id: string;
}

export interface OpenRoomInput {
  cwd: string;
  brief: PlanningBrief;
}

export interface CollectRepliesInput {
  cwd: string;
  room_id: string;
  timeout_ms: number;
  min_replies?: number;
  on_reply?: (reply: AgentBusReply) => void | Promise<void>;
}

// ── Internal helpers ──

const AGENTBUS_DATA_DIR = () =>
  process.env.AGENTBUS_DATA_DIR
  || `${process.env.HOME || ''}/.agentbus`;
const NON_BLOCKING_REPLY_GRACE_MS = 2500;

function makeOrchestratorId(): string {
  return `hive-planner-${Date.now().toString(36)}`;
}

function makeRoomId(): string {
  return `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Public API ──

export async function openPlannerDiscussRoom(
  input: OpenRoomInput,
): Promise<PlannerDiscussRoom> {
  const dataDir = AGENTBUS_DATA_DIR();
  const roomId = makeRoomId();
  const orchestratorId = makeOrchestratorId();

  const { createRoom } = await import('../src/agentbus/backend-fs.js');
  await createRoom(dataDir, roomId, orchestratorId);

  // The opening broadcast is the entire planning brief so another session
  // can join late and still review without any extra Hive context.
  const { appendMessage } = await import('../src/agentbus/backend-fs.js');
  await appendMessage(
    dataDir,
    roomId,
    'broadcast',
    orchestratorId,
    '*',
    input.brief as unknown as Record<string, unknown>,
  );

  return {
    room_id: roomId,
    join_hint: `agentbus join ${roomId}`,
    orchestrator_id: orchestratorId,
  };
}

export async function collectPlannerDiscussReplies(
  input: CollectRepliesInput,
): Promise<AgentBusReply[]> {
  const dataDir = AGENTBUS_DATA_DIR();
  const {
    readMessage,
    listMessagesSince,
  } = await import('../src/agentbus/backend-fs.js');

  const broadcastMessage = await readMessage(dataDir, input.room_id, 1);
  if (!broadcastMessage) {
    throw new Error(`Planner discuss room ${input.room_id} has no opening brief`);
  }

  // Collect answer messages (seq > 1) as replies
  const replies: AgentBusReply[] = [];
  const seenParticipants = new Set<string>();
  const startTime = Date.now();
  const checkInterval = 500;
  const minReplies = input.min_replies ?? 0;
  const waitBudgetMs = minReplies === 0
    ? Math.min(input.timeout_ms, NON_BLOCKING_REPLY_GRACE_MS)
    : input.timeout_ms;
  const deadline = startTime + waitBudgetMs;

  while (Date.now() < deadline) {
    const messages = await listMessagesSince(
      dataDir, input.room_id, 1,
    );

    for (const msg of messages) {
      if (msg.msg_type === 'answer') {
        const content = typeof msg.payload === 'string'
          ? msg.payload
          : JSON.stringify(msg.payload);
        if (!seenParticipants.has(msg.from)) {
          seenParticipants.add(msg.from);
          replies.push({
            participant_id: msg.from,
            content,
            response_time_ms: Math.max(0, msg.timestamp - broadcastMessage.timestamp),
            content_length: content.length,
            received_at: new Date(msg.timestamp).toISOString(),
          });
          await input.on_reply?.(replies[replies.length - 1]!);
        }
      }
    }

    if (minReplies > 0 && replies.length >= minReplies) {
      break;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await new Promise(r => setTimeout(r, Math.min(checkInterval, remainingMs)));
  }

  return replies;
}

export interface CloseRoomInput {
  room_id: string;
  orchestrator_id: string;
  summary?: Record<string, unknown>;
}

export async function closePlannerDiscussRoom(
  input: CloseRoomInput,
): Promise<void> {
  const dataDir = AGENTBUS_DATA_DIR();
  const { appendMessage, closeRoom } = await import('../src/agentbus/backend-fs.js');

  if (input.summary) {
    await appendMessage(
      dataDir,
      input.room_id,
      'system',
      input.orchestrator_id,
      '*',
      {
        type: 'planner-discuss-summary',
        ...input.summary,
      },
    );
  }

  await closeRoom(dataDir, input.room_id);
}

export function buildRoomRef(
  room: PlannerDiscussRoom,
  replies: AgentBusReply[],
  timeoutMs: number,
): PlannerDiscussRoomRef {
  const replyMetadata: PlannerDiscussReplyMetadata[] = replies.map((reply) => ({
    participant_id: reply.participant_id,
    response_time_ms: reply.response_time_ms ?? 0,
    content_length: reply.content_length ?? reply.content.length,
  }));

  return {
    room_id: room.room_id,
    transport: 'agentbus',
    reply_count: replies.length,
    timeout_ms: timeoutMs,
    join_hint: room.join_hint,
    created_at: new Date().toISOString(),
    reply_metadata: replyMetadata.length > 0 ? replyMetadata : undefined,
  };
}

// ── Reply synthesis ──
// Lightweight merge of AgentBus replies into a PlanDiscussResult.
// For the cheap summarization pass, call synthesizeAgentBusRepliesWithModel() instead.

export function mergeAgentBusReplies(
  replies: AgentBusReply[],
): PlanDiscussResult {
  return {
    partner_models: replies.map(r => r.participant_id),
    task_gaps: [],
    task_redundancies: [],
    model_suggestions: [],
    execution_order_issues: [],
    overall_assessment: replies.map(r =>
      `[${r.participant_id}] ${r.content.slice(0, 200)}`,
    ).join('\n'),
    quality_gate: 'warn' as const,
  };
}
