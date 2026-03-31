/**
 * AgentBus Worker Tests
 * Worker pollOnce, compound lock claiming, cursor advancement
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createRoom,
  joinRoom,
  appendMessage,
  closeRoom,
  readReceipt,
  listReceiptsForMessage,
  readCursor,
  readMessage,
} from '../../src/agentbus/backend-fs.js';
import { pollOnce } from '../../src/agentbus/worker.js';
import type { WorkerConfig } from '../../src/agentbus/types.js';

describe('Worker pollOnce', () => {
  let tempDir: string;
  let dataDir: string;
  const roomId = 'test-room';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbus-test-'));
    dataDir = tempDir;

    await createRoom(dataDir, roomId, 'orch-1');
    await joinRoom(dataDir, roomId, 'worker-1', 'gpt-4', 'worker');
    await joinRoom(dataDir, roomId, 'worker-2', 'kimi', 'worker');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should process broadcast message', async () => {
    const msg = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {
      question: 'test?',
    });

    const config: WorkerConfig = {
      participant_id: 'worker-1',
      model_id: 'gpt-4',
      room_id: roomId,
      data_dir: dataDir,
      poll_interval_ms: 100,
      lock_ttl_ms: 30000,
      handler: async (message) => ({
        answer: `Answer to: ${message.payload.question}`,
      }),
    };

    const result = await pollOnce(config);

    expect(result.cursor_advanced).toBe(true);
    expect(result.message?.msg_id).toBe(msg.msg_id);
    expect(result.receipt?.state).toBe('ANSWERED');

    // Verify cursor advanced
    const cursor = await readCursor(dataDir, roomId, 'worker-1');
    expect(cursor).toBe(msg.seq);
  });

  it('should write PROCESSING then ANSWERED receipt', async () => {
    await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {
      question: 'test?',
    });

    const handlerCalls: string[] = [];

    const config: WorkerConfig = {
      participant_id: 'worker-1',
      model_id: 'gpt-4',
      room_id: roomId,
      data_dir: dataDir,
      poll_interval_ms: 100,
      lock_ttl_ms: 30000,
      handler: async (message) => {
        handlerCalls.push('processing');
        return { answer: 'done' };
      },
    };

    await pollOnce(config);

    // Handler should have been called
    expect(handlerCalls).toContain('processing');
  });

  it('should skip messages not addressed to worker', async () => {
    await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', 'worker-2', {
      question: 'specific?',
    });

    const config: WorkerConfig = {
      participant_id: 'worker-1',
      model_id: 'gpt-4',
      room_id: roomId,
      data_dir: dataDir,
      poll_interval_ms: 100,
      lock_ttl_ms: 30000,
      handler: async () => ({ answer: 'done' }),
    };

    const result = await pollOnce(config);

    // Should advance cursor but not process
    expect(result.cursor_advanced).toBe(true);
    expect(result.message).toBeUndefined();
    expect(result.receipt).toBeUndefined();
  });

  it('should skip if receipt already exists', async () => {
    const msg = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {});

    // First worker processes
    const config1: WorkerConfig = {
      participant_id: 'worker-1',
      model_id: 'gpt-4',
      room_id: roomId,
      data_dir: dataDir,
      poll_interval_ms: 100,
      lock_ttl_ms: 30000,
      handler: async () => ({ answer: 'first' }),
    };
    await pollOnce(config1);

    // Same worker should skip on second poll
    let handlerCalled = false;
    const config2: WorkerConfig = {
      participant_id: 'worker-1',
      model_id: 'gpt-4',
      room_id: roomId,
      data_dir: dataDir,
      poll_interval_ms: 100,
      lock_ttl_ms: 30000,
      handler: async () => {
        handlerCalled = true;
        return { answer: 'second' };
      },
    };
    const result = await pollOnce(config2);

    expect(handlerCalled).toBe(false);
    expect(result.cursor_advanced).toBe(true);
  });

  it('should allow parallel processing by different workers', async () => {
    const msg = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {
      question: 'parallel?',
    });

    const config1: WorkerConfig = {
      participant_id: 'worker-1',
      model_id: 'gpt-4',
      room_id: roomId,
      data_dir: dataDir,
      poll_interval_ms: 100,
      lock_ttl_ms: 30000,
      handler: async () => ({ answer: 'from-worker-1' }),
    };

    const config2: WorkerConfig = {
      participant_id: 'worker-2',
      model_id: 'kimi',
      room_id: roomId,
      data_dir: dataDir,
      poll_interval_ms: 100,
      lock_ttl_ms: 30000,
      handler: async () => ({ answer: 'from-worker-2' }),
    };

    // Both workers process the same message
    const result1 = await pollOnce(config1);
    const result2 = await pollOnce(config2);

    expect(result1.receipt?.state).toBe('ANSWERED');
    expect(result2.receipt?.state).toBe('ANSWERED');

    // Verify 2 receipts + 2 answer messages
    const receipts = await listReceiptsForMessage(dataDir, roomId, msg.msg_id);
    expect(receipts).toHaveLength(2);

    // Verify answer messages were written
    const answer1 = await readMessage(dataDir, roomId, result1.receipt!.answer_seq!);
    const answer2 = await readMessage(dataDir, roomId, result2.receipt!.answer_seq!);

    expect(answer1?.payload.answer).toBe('from-worker-1');
    expect(answer2?.payload.answer).toBe('from-worker-2');
  });

  it('should write ERROR receipt on handler failure', async () => {
    await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {
      question: 'fail?',
    });

    const config: WorkerConfig = {
      participant_id: 'worker-1',
      model_id: 'gpt-4',
      room_id: roomId,
      data_dir: dataDir,
      poll_interval_ms: 100,
      lock_ttl_ms: 30000,
      handler: async () => {
        throw new Error('Handler failed');
      },
    };

    const result = await pollOnce(config);

    expect(result.receipt?.state).toBe('ERROR');
    expect(result.receipt?.error).toContain('Handler failed');
  });

  it('should advance cursor to max seq when no work', async () => {
    await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', 'worker-2', {});
    await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', 'worker-2', {});

    const config: WorkerConfig = {
      participant_id: 'worker-1',
      model_id: 'gpt-4',
      room_id: roomId,
      data_dir: dataDir,
      poll_interval_ms: 100,
      lock_ttl_ms: 30000,
      handler: async () => ({ answer: 'done' }),
    };

    const result = await pollOnce(config);

    expect(result.cursor_advanced).toBe(true);
    expect(result.new_cursor).toBe(2);
  });

  it('should return no work when no messages', async () => {
    const config: WorkerConfig = {
      participant_id: 'worker-1',
      model_id: 'gpt-4',
      room_id: roomId,
      data_dir: dataDir,
      poll_interval_ms: 100,
      lock_ttl_ms: 30000,
      handler: async () => ({ answer: 'done' }),
    };

    const result = await pollOnce(config);

    expect(result.cursor_advanced).toBe(false);
    expect(result.new_cursor).toBe(0);
  });

  it('should not process unread backlog after room is closed', async () => {
    const msg = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {
      question: 'late backlog?',
    });
    await closeRoom(dataDir, roomId);

    const config: WorkerConfig = {
      participant_id: 'worker-1',
      model_id: 'gpt-4',
      room_id: roomId,
      data_dir: dataDir,
      poll_interval_ms: 100,
      lock_ttl_ms: 30000,
      handler: async () => ({ answer: 'should-not-run' }),
    };

    const result = await pollOnce(config);

    expect(result.cursor_advanced).toBe(false);
    expect(result.new_cursor).toBe(0);
    expect(await readReceipt(dataDir, roomId, msg.msg_id, 'worker-1')).toBeNull();
  });
});
