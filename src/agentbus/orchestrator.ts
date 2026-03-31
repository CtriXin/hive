/**
 * AgentBus Orchestrator
 * Minimal viable orchestrator for broadcast-based resolution
 */

import type { Message, Receipt, Participant } from './schema.js';
import type {
  OrchestratorConfig,
  ResolveResult,
  BroadcastRequest,
} from './types.js';
import {
  appendMessage,
  readMessage,
  listMessagesSince,
  listReceiptsForMessage,
  readManifest,
  closeRoom,
  listParticipantsWithCursor,
} from './backend-fs.js';
import { readCursor } from './backend-fs.js';

interface PendingRound {
  round: number;
  broadcastMsgId: string;
  broadcastSeq: number;
  expectedParticipants: string[];
  answers: Map<string, unknown>;
  receipts: Map<string, Receipt>;
}

/**
 * Broadcast a message to all participants
 */
export async function broadcast(
  config: OrchestratorConfig,
  request: BroadcastRequest
): Promise<Message> {
  const manifest = await readManifest(config.data_dir, config.room_id);

  if (manifest.room.status !== 'OPEN') {
    throw new Error(`Room ${config.room_id} is not open`);
  }

  return appendMessage(
    config.data_dir,
    config.room_id,
    'broadcast',
    config.orchestrator_id,
    '*',
    request.payload
  );
}

/**
 * Wait for replies from expected participants
 */
async function waitForReplies(
  config: OrchestratorConfig,
  pending: PendingRound,
  timeoutMs: number
): Promise<boolean> {
  const startTime = Date.now();
  const checkInterval = 100;

  while (Date.now() - startTime < timeoutMs) {
    // Check receipts for the broadcast message
    const receipts = await listReceiptsForMessage(
      config.data_dir,
      config.room_id,
      pending.broadcastMsgId
    );

    for (const receipt of receipts) {
      if (receipt.state === 'ANSWERED' && receipt.answer_seq) {
        // Read the answer message
        const answerMsg = await readMessage(
          config.data_dir,
          config.room_id,
          receipt.answer_seq
        );
        if (answerMsg) {
          pending.answers.set(receipt.participant_id, answerMsg.payload);
        }
        pending.receipts.set(receipt.participant_id, receipt);
      } else if (receipt.state === 'ERROR') {
        pending.receipts.set(receipt.participant_id, receipt);
      }
    }

    // Check if we have all expected replies
    const answeredCount = pending.expectedParticipants.filter((pid) =>
      pending.receipts.has(pid)
    ).length;

    if (answeredCount >= pending.expectedParticipants.length) {
      return true;
    }

    await sleep(checkInterval);
  }

  return false;
}

/**
 * Collect answers from participants
 * Answer messages have payload: { answer, in_reply_to }
 */
async function collectAnswers(
  config: OrchestratorConfig,
  pending: PendingRound
): Promise<Array<{ participant_id: string; answer: unknown }>> {
  const results: Array<{ participant_id: string; answer: unknown }> = [];

  for (const participantId of pending.expectedParticipants) {
    const answerPayload = pending.answers.get(participantId);
    // Answer payload is { answer, in_reply_to }
    if (answerPayload && typeof answerPayload === 'object' && 'answer' in answerPayload) {
      results.push({ participant_id: participantId, answer: (answerPayload as { answer: unknown }).answer });
    }
  }

  return results;
}

/**
 * Synthesize answers into a final answer
 * (Simple implementation: majority vote for strings, first for others)
 */
async function synthesize(answers: Array<{ participant_id: string; answer: unknown }>): Promise<unknown> {
  if (answers.length === 0) {
    return undefined;
  }

  if (answers.length === 1) {
    return answers[0].answer;
  }

  // Try majority vote for string answers
  const stringAnswers = answers.filter((a) => typeof a.answer === 'string');
  if (stringAnswers.length === answers.length) {
    const counts = new Map<string, number>();
    for (const { answer } of stringAnswers) {
      const str = answer as string;
      counts.set(str, (counts.get(str) ?? 0) + 1);
    }

    let maxCount = 0;
    let winner: unknown;
    for (const [answer, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        winner = answer;
      }
    }

    // Require majority (>50%)
    if (maxCount > answers.length / 2) {
      return winner;
    }
  }

  // Return array of all answers
  return answers.map((a) => a.answer);
}

/**
 * Verify if answer meets criteria
 * (Simple implementation: check for consensus)
 */
async function verify(
  answers: Array<{ participant_id: string; answer: unknown }>,
  synthesized: unknown
): Promise<{ valid: boolean; reason?: string }> {
  if (answers.length === 0) {
    return { valid: false, reason: 'No answers received' };
  }

  // Check for consensus on string answers
  if (typeof synthesized === 'string') {
    const agreeing = answers.filter((a) => a.answer === synthesized).length;
    if (agreeing > answers.length / 2) {
      return { valid: true };
    }
    return {
      valid: false,
      reason: `No consensus: ${agreeing}/${answers.length} agree`,
    };
  }

  // For non-strings, just check we have answers
  return { valid: answers.length > 0 };
}

/**
 * Main resolve loop
 * Broadcast → wait → collect → synthesize → verify → resolve or followup
 */
export async function resolve(
  config: OrchestratorConfig,
  initialRequest: BroadcastRequest
): Promise<ResolveResult> {
  const manifest = await readManifest(config.data_dir, config.room_id);

  // Get list of worker participants (exclude orchestrator)
  const workers = manifest.room.participants.filter(
    (p) => p.participant_id !== config.orchestrator_id && p.role === 'worker'
  );

  if (workers.length === 0) {
    return {
      resolved: false,
      rounds: 0,
      answers: [],
      error: 'No workers in room',
    };
  }

  const expectedParticipants = workers.map((w) => w.participant_id);
  let currentRequest = initialRequest;

  for (let round = 1; round <= config.max_rounds; round++) {
    // Broadcast to all workers
    const broadcastMsg = await broadcast(config, currentRequest);

    const pending: PendingRound = {
      round,
      broadcastMsgId: broadcastMsg.msg_id,
      broadcastSeq: broadcastMsg.seq,
      expectedParticipants,
      answers: new Map(),
      receipts: new Map(),
    };

    // Wait for replies
    const timeoutMs = currentRequest.timeout_ms ?? config.timeout_ms;
    const allReplied = await waitForReplies(config, pending, timeoutMs);

    if (!allReplied && pending.receipts.size === 0) {
      const errorMsg = 'No replies received within timeout';

      // Write failure message and close room
      await appendMessage(
        config.data_dir,
        config.room_id,
        'system',
        config.orchestrator_id,
        '*',
        {
          type: 'FAILED',
          reason: errorMsg,
          round,
          participant_count: 0,
        }
      );

      await closeRoom(config.data_dir, config.room_id);

      return {
        resolved: false,
        rounds: round,
        answers: [],
        error: errorMsg,
      };
    }

    // Collect answers
    const answers = await collectAnswers(config, pending);

    // Synthesize
    const synthesized = await synthesize(answers);

    // Verify
    const verification = await verify(answers, synthesized);

    if (verification.valid) {
      // Write resolution message
      await appendMessage(
        config.data_dir,
        config.room_id,
        'system',
        config.orchestrator_id,
        '*',
        {
          type: 'RESOLVED',
          final_answer: synthesized,
          round,
          participant_count: answers.length,
        }
      );

      // Close the room
      await closeRoom(config.data_dir, config.room_id);

      return {
        resolved: true,
        rounds: round,
        answers,
        final_answer: synthesized,
      };
    }

    // If not resolved and this is the last round, fail
    if (round === config.max_rounds) {
      const errorMsg = `Failed to resolve after ${round} rounds: ${verification.reason}`;

      // Write failure message
      await appendMessage(
        config.data_dir,
        config.room_id,
        'system',
        config.orchestrator_id,
        '*',
        {
          type: 'FAILED',
          reason: errorMsg,
          round,
          participant_count: answers.length,
        }
      );

      // Close the room
      await closeRoom(config.data_dir, config.room_id);

      return {
        resolved: false,
        rounds: round,
        answers,
        final_answer: synthesized,
        error: errorMsg,
      };
    }

    // Follow-up: ask again with context about the disagreement
    currentRequest = {
      payload: {
        ...currentRequest.payload,
        context: {
          previous_answers: answers,
          synthesized,
          verification_failed: verification.reason,
          round,
        },
      },
      expect_replies_from: expectedParticipants,
      timeout_ms: timeoutMs,
    };
  }

  // Should never reach here
  return {
    resolved: false,
    rounds: config.max_rounds,
    answers: [],
    error: 'Max rounds exceeded',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get room status
 */
export async function getRoomStatus(
  config: OrchestratorConfig
): Promise<{
  room: { room_id: string; status: string; message_seq: number };
  participants: Participant[];
  my_cursor: number;
}> {
  const manifest = await readManifest(config.data_dir, config.room_id);
  const cursor = await readCursor(
    config.data_dir,
    config.room_id,
    config.orchestrator_id
  );
  const participants = await listParticipantsWithCursor(
    config.data_dir,
    config.room_id
  );

  return {
    room: {
      room_id: manifest.room.room_id,
      status: manifest.room.status,
      message_seq: manifest.room.message_seq,
    },
    participants,
    my_cursor: cursor,
  };
}
