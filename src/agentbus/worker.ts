/**
 * AgentBus Worker
 * Poll messages, claim via compound lock, process, write receipts, advance cursor
 */

import type { Message, Receipt } from './schema.js';
import type {
  PollResult,
  WorkerConfig,
  MessageHandler,
  CompoundLockKey,
} from './types.js';
import {
  readCursor,
  writeCursor,
  listMessagesSince,
  writeReceipt,
  hasReceipt,
  appendMessage,
  readManifest,
} from './backend-fs.js';
import { tryAcquireLock, releaseLock } from './lock.js';

/**
 * Check if a message is addressed to this participant
 */
function isMessageForMe(message: Message, myParticipantId: string): boolean {
  return message.to === '*' || message.to === myParticipantId;
}

/**
 * Check if a message should be processed by workers
 * System messages are internal and should be skipped
 */
function shouldProcessMessage(message: Message): boolean {
  return message.msg_type !== 'system';
}

/**
 * Poll for a single message to process
 * Implements the strict sequence:
 * 1. Read seq > cursor
 * 2. Skip messages not for me
 * 3. Skip if receipt exists
 * 4. Try compound lock claim
 * 5. Write PROCESSING receipt
 * 6. Generate answer
 * 7. Write answer message + ANSWERED receipt
 * 8. Advance cursor
 */
export async function pollOnce(config: WorkerConfig): Promise<PollResult> {
  const { participant_id, room_id, data_dir, handler } = config;

  if (!(await isRoomOpen(data_dir, room_id))) {
    return {
      cursor_advanced: false,
      new_cursor: await readCursor(data_dir, room_id, participant_id),
    };
  }

  // 1. Read current cursor
  const cursor = await readCursor(data_dir, room_id, participant_id);

  // 2. Get messages since cursor
  const messages = await listMessagesSince(data_dir, room_id, cursor);

  if (messages.length === 0) {
    return {
      cursor_advanced: false,
      new_cursor: cursor,
    };
  }

  // 3. Find first message we should process
  for (const message of messages) {
    // Skip system messages (internal orchestrator messages)
    if (!shouldProcessMessage(message)) {
      continue;
    }

    // Skip if not for me
    if (!isMessageForMe(message, participant_id)) {
      continue;
    }

    // Skip if already processed (receipt exists)
    const hasExistingReceipt = await hasReceipt(
      data_dir,
      room_id,
      message.msg_id,
      participant_id
    );
    if (hasExistingReceipt) {
      continue;
    }

    // Try to claim lock
    const lockKey: CompoundLockKey = {
      room_id,
      msg_id: message.msg_id,
      participant_id,
    };

    const lockResult = await tryAcquireLock(data_dir, lockKey, config.lock_ttl_ms);
    if (!lockResult.success) {
      // Someone else claimed it, skip to next
      continue;
    }

    try {
      // Write PROCESSING receipt
      await writeReceipt(
        data_dir,
        room_id,
        message.msg_id,
        participant_id,
        'PROCESSING'
      );

      // Generate answer
      let answer: unknown;
      let error: string | undefined;

      try {
        const result = await handler(message);
        answer = result.answer;
        error = result.error;
      } catch (err) {
        error = (err as Error).message;
      }

      // Write answer message if successful
      let answerSeq: number | undefined;
      if (!error && answer !== undefined) {
        const answerMsg = await appendMessage(
          data_dir,
          room_id,
          'answer',
          participant_id,
          message.from, // Reply to original sender
          { answer, in_reply_to: message.msg_id }
        );
        answerSeq = answerMsg.seq;
      }

      // Write final receipt
      const receiptState = error ? 'ERROR' : 'ANSWERED';
      const receipt = await writeReceipt(
        data_dir,
        room_id,
        message.msg_id,
        participant_id,
        receiptState,
        { answerSeq, error }
      );

      // Advance cursor to this message's seq
      const newCursor = message.seq;
      await writeCursor(data_dir, room_id, participant_id, newCursor);

      return {
        message,
        receipt,
        cursor_advanced: true,
        new_cursor: newCursor,
      };
    } finally {
      // Always release lock
      await releaseLock(data_dir, lockKey);
    }
  }

  // No messages processed - advance cursor to max seen
  const maxSeq = Math.max(...messages.map((m) => m.seq));
  if (maxSeq > cursor) {
    await writeCursor(data_dir, room_id, participant_id, maxSeq);
    return {
      cursor_advanced: true,
      new_cursor: maxSeq,
    };
  }

  return {
    cursor_advanced: false,
    new_cursor: cursor,
  };
}

/**
 * Check if room is still open
 */
async function isRoomOpen(dataDir: string, roomId: string): Promise<boolean> {
  try {
    const manifest = await readManifest(dataDir, roomId);
    return manifest.room.status === 'OPEN';
  } catch {
    return false;
  }
}

/**
 * Worker loop that continuously polls
 * Exits when:
 * 1. Signal is aborted
 * 2. Room is closed
 */
export async function workerLoop(
  config: WorkerConfig,
  signal?: AbortSignal
): Promise<void> {
  while (!signal?.aborted) {
    // Check if room is still open
    const roomOpen = await isRoomOpen(config.data_dir, config.room_id);
    if (!roomOpen) {
      console.log(`Room ${config.room_id} is closed, worker ${config.participant_id} exiting`);
      return;
    }

    try {
      const result = await pollOnce(config);

      // If no work was done, wait before polling again
      if (!result.cursor_advanced) {
        await sleep(config.poll_interval_ms);
      }
      // If work was done, immediately poll again for more messages
    } catch (err) {
      // Log error but continue looping
      console.error(`Worker error: ${(err as Error).message}`);
      await sleep(config.poll_interval_ms);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a simple worker that runs until signal aborts
 */
export function createWorker(
  config: Omit<WorkerConfig, 'poll_interval_ms' | 'lock_ttl_ms'> & {
    poll_interval_ms?: number;
    lock_ttl_ms?: number;
  }
): {
  start: (signal?: AbortSignal) => Promise<void>;
  pollOnce: () => Promise<PollResult>;
} {
  const fullConfig: WorkerConfig = {
    ...config,
    poll_interval_ms: config.poll_interval_ms ?? 1000,
    lock_ttl_ms: config.lock_ttl_ms ?? 30000,
  };

  return {
    start: (signal) => workerLoop(fullConfig, signal),
    pollOnce: () => pollOnce(fullConfig),
  };
}
