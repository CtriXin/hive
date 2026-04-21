// ═══════════════════════════════════════════════════════════════════
// orchestrator/agentbus-adapter.ts — Thin bridge from Hive to AgentBus
// ═══════════════════════════════════════════════════════════════════
// No Hive run-state mutation. No business logic about plan quality.
// Failure is explicit and easy to debug.

import type {
  DiscussResult,
  PlanDiscussResult,
  PlannerDiscussRoomRef,
  PlannerDiscussReplyMetadata,
  PlanningBrief,
  RecoveryBrief,
  ReviewBrief,
  WorkerDiscussBrief,
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

export interface WorkerDiscussRoom {
  room_id: string;
  join_hint?: string;
  orchestrator_id: string;
}

export interface OpenWorkerRoomInput {
  cwd: string;
  brief: WorkerDiscussBrief;
}

export interface ReviewRoom {
  room_id: string;
  join_hint?: string;
  orchestrator_id: string;
}

export interface OpenReviewRoomInput {
  cwd: string;
  brief: ReviewBrief;
}

export interface RecoveryRoom {
  room_id: string;
  join_hint?: string;
  orchestrator_id: string;
}

export interface OpenRecoveryRoomInput {
  cwd: string;
  brief: RecoveryBrief;
}

// ── Internal helpers ──

const AGENTBUS_DATA_DIR = () =>
  process.env.AGENTBUS_DATA_DIR
  || `${process.env.HOME || ''}/.agentbus`;
const NON_BLOCKING_REPLY_GRACE_MS = 2500;

function makePlannerOrchestratorId(): string {
  return `hive-planner-${Date.now().toString(36)}`;
}

function makeWorkerOrchestratorId(taskId: string): string {
  return `hive-worker-${taskId}-${Date.now().toString(36)}`;
}

function makeReviewOrchestratorId(taskId: string): string {
  return `hive-review-${taskId}-${Date.now().toString(36)}`;
}

function makeRecoveryOrchestratorId(taskId: string): string {
  return `hive-recovery-${taskId}-${Date.now().toString(36)}`;
}

function makeRoomId(): string {
  return `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function openBroadcastRoom(
  roomId: string,
  orchestratorId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const dataDir = AGENTBUS_DATA_DIR();
  const { createRoom, appendMessage } = await import('../src/agentbus/backend-fs.js');
  await createRoom(dataDir, roomId, orchestratorId);
  await appendMessage(
    dataDir,
    roomId,
    'broadcast',
    orchestratorId,
    '*',
    payload,
  );
}

// ── Public API ──

export async function openPlannerDiscussRoom(
  input: OpenRoomInput,
): Promise<PlannerDiscussRoom> {
  const roomId = makeRoomId();
  const orchestratorId = makePlannerOrchestratorId();
  await openBroadcastRoom(roomId, orchestratorId, input.brief as unknown as Record<string, unknown>);

  return {
    room_id: roomId,
    join_hint: `agentbus join ${roomId}`,
    orchestrator_id: orchestratorId,
  };
}

export async function collectDiscussReplies(
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
  room_kind?: 'plan' | 'task_discuss' | 'review' | 'recovery';
  summary?: Record<string, unknown>;
}

export async function closeDiscussRoom(
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
        type: input.room_kind === 'task_discuss'
          ? 'worker-discuss-summary'
          : input.room_kind === 'review'
            ? 'external-review-summary'
            : input.room_kind === 'recovery'
              ? 'recovery-summary'
            : 'planner-discuss-summary',
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

// ── Backward-compat aliases ──

/** @deprecated Use collectDiscussReplies instead */
export const collectPlannerDiscussReplies = collectDiscussReplies;
/** @deprecated Use closeDiscussRoom instead */
export const closePlannerDiscussRoom = closeDiscussRoom;

// ── Worker discuss room ──

export async function openWorkerDiscussRoom(
  input: OpenWorkerRoomInput,
): Promise<WorkerDiscussRoom> {
  const roomId = makeRoomId();
  const orchestratorId = makeWorkerOrchestratorId(input.brief.task_id);
  await openBroadcastRoom(roomId, orchestratorId, input.brief as unknown as Record<string, unknown>);

  return {
    room_id: roomId,
    join_hint: `agentbus join ${roomId}`,
    orchestrator_id: orchestratorId,
  };
}

export async function openReviewRoom(
  input: OpenReviewRoomInput,
): Promise<ReviewRoom> {
  const roomId = makeRoomId();
  const orchestratorId = makeReviewOrchestratorId(input.brief.task_id);
  await openBroadcastRoom(roomId, orchestratorId, input.brief as unknown as Record<string, unknown>);

  return {
    room_id: roomId,
    join_hint: `agentbus join ${roomId}`,
    orchestrator_id: orchestratorId,
  };
}

export async function openRecoveryRoom(
  input: OpenRecoveryRoomInput,
): Promise<RecoveryRoom> {
  const roomId = makeRoomId();
  const orchestratorId = makeRecoveryOrchestratorId(input.brief.task_id);
  await openBroadcastRoom(roomId, orchestratorId, input.brief as unknown as Record<string, unknown>);

  return {
    room_id: roomId,
    join_hint: `agentbus join ${roomId}`,
    orchestrator_id: orchestratorId,
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

// ── Worker discuss reply synthesis ──
// Merges AgentBus replies into a DiscussResult for worker consumption.

export function synthesizeWorkerDiscussReplies(
  replies: AgentBusReply[],
  trigger: { leaning: string; task_id: string },
): DiscussResult {
  if (replies.length === 0) {
    return {
      decision: trigger.leaning,
      reasoning: 'No AgentBus replies collected; using original leaning.',
      escalated: false,
      thread_id: `agentbus-${trigger.task_id}-${Date.now()}`,
      quality_gate: 'warn',
    };
  }

  const synthParts = replies.map(r =>
    `[${r.participant_id}] ${r.content.slice(0, 300)}`,
  );

  return {
    decision: replies[0]!.content.slice(0, 200),
    reasoning: synthParts.join('\n'),
    escalated: false,
    thread_id: `agentbus-${trigger.task_id}-${Date.now()}`,
    quality_gate: replies.length >= 2 ? 'pass' : 'warn',
  };
}

// ── Model-based worker synthesis ──
// Tries a cheap LLM call to synthesize replies into a DiscussResult.
// Falls back to the heuristic synthesizeWorkerDiscussReplies on failure.

export async function synthesizeWorkerDiscussRepliesWithModel(
  replies: AgentBusReply[],
  trigger: { leaning: string; task_id: string },
  config: any,
  workerModel: string,
): Promise<DiscussResult> {
  const rawDiscussModel = config.tiers?.discuss?.model || 'auto';

  // Lazy imports — same pattern as planner-runner.ts synthesizeAgentBusReplies
  const { resolveTierModel } = await import('./hive-config.js');
  const { safeQuery, extractTextFromMessages } = await import('./sdk-query-safe.js');
  const { buildSdkEnv } = await import('./project-paths.js');
  const { resolveProviderForModel } = await import('./provider-resolver.js');

  const { ModelRegistry } = await import('./model-registry.js');
  const registry = new ModelRegistry();

  const singleModelSelector: string = Array.isArray(rawDiscussModel)
    ? (rawDiscussModel[0] || 'auto')
    : rawDiscussModel;
  const discussTierModel = resolveTierModel(
    singleModelSelector,
    () => registry.selectDiscussPartner(workerModel),
    registry,
    'review',
    config,
  );

  const replyText = replies.map(r =>
    `[${r.participant_id}]: ${r.content}`,
  ).join('\n\n');

  const synthPrompt = [
    'You are a senior developer. Synthesize these code review replies into a structured worker decision.',
    '',
    '## Worker Context',
    `Uncertain about: ${trigger.leaning}`,
    '',
    `Worker model: ${workerModel}`,
    '',
    '## Review Replies',
    replyText,
    '',
    'Respond with ONLY a JSON object:',
    '{',
    '  "decision": "clear decision (≤200 chars)",',
    '  "reasoning": "brief reasoning citing participant IDs",',
    '  "escalated": false,',
    '  "quality_gate": "pass" | "warn" | "fail"',
    '}',
  ].join('\n');

  try {
    let env: Record<string, string>;
    try {
      const resolved = resolveProviderForModel(discussTierModel);
      env = buildSdkEnv(discussTierModel, resolved.baseUrl, resolved.apiKey);
    } catch {
      if (!discussTierModel.startsWith('claude-')) {
        throw new Error(
          `Discuss synthesis model "${discussTierModel}" has no direct Claude Code transport route.`,
        );
      }
      env = buildSdkEnv(discussTierModel);
    }

    const result = await safeQuery({
      prompt: synthPrompt,
      options: { cwd: process.cwd(), maxTurns: 1, env, model: discussTierModel },
    });
    const text = extractTextFromMessages(result.messages);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.decision && parsed.reasoning) {
        return {
          decision: String(parsed.decision).slice(0, 200),
          reasoning: String(parsed.reasoning).slice(0, 500),
          escalated: Boolean(parsed.escalated) || false,
          thread_id: `agentbus-model-${trigger.task_id}-${Date.now()}`,
          quality_gate: parsed.quality_gate || 'warn',
        };
      }
    }
  } catch (err: any) {
    console.log(`  ⚠️ Worker AgentBus model synthesis failed: ${err.message?.slice(0, 80)}`);
  }

  // Fallback to heuristic synthesis
  return synthesizeWorkerDiscussReplies(replies, trigger);
}
