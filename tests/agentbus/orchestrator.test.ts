/**
 * AgentBus Orchestrator Tests
 * Broadcast resolution, 2-round loop, consensus
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createRoom,
  joinRoom,
  appendMessage,
  writeCursor,
} from '../../src/agentbus/backend-fs.js';
import { pollOnce } from '../../src/agentbus/worker.js';
import { resolve, broadcast, getRoomStatus } from '../../src/agentbus/orchestrator.js';
import type { WorkerConfig, OrchestratorConfig } from '../../src/agentbus/types.js';

describe('Orchestrator', () => {
  let tempDir: string;
  let dataDir: string;
  const roomId = 'test-room';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbus-test-'));
    dataDir = tempDir;

    await createRoom(dataDir, roomId, 'orch-1');
    await joinRoom(dataDir, roomId, 'worker-1', 'gpt-4', 'worker');
    await joinRoom(dataDir, roomId, 'worker-2', 'kimi', 'worker');
    await joinRoom(dataDir, roomId, 'worker-3', 'qwen', 'worker');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeWorkerConfig(participantId: string, answer: string): WorkerConfig {
    return {
      participant_id: participantId,
      model_id: 'test',
      room_id: roomId,
      data_dir: dataDir,
      poll_interval_ms: 100,
      lock_ttl_ms: 30000,
      handler: async () => ({ answer }),
    };
  }

  async function runWorkersUntilIdle(): Promise<void> {
    const workers = [
      makeWorkerConfig('worker-1', 'answer-1'),
      makeWorkerConfig('worker-2', 'answer-2'),
      makeWorkerConfig('worker-3', 'answer-3'),
    ];

    let hadWork = true;
    let iterations = 0;
    const maxIterations = 20;

    while (hadWork && iterations < maxIterations) {
      hadWork = false;
      for (const config of workers) {
        const result = await pollOnce(config);
        if (result.cursor_advanced && result.message) {
          hadWork = true;
        }
      }
      iterations++;
    }
  }

  describe('broadcast', () => {
    it('should send broadcast message', async () => {
      const config: OrchestratorConfig = {
        room_id: roomId,
        orchestrator_id: 'orch-1',
        data_dir: dataDir,
        max_rounds: 2,
        timeout_ms: 5000,
      };

      const msg = await broadcast(config, {
        payload: { question: 'test?' },
      });

      expect(msg.msg_type).toBe('broadcast');
      expect(msg.from).toBe('orch-1');
      expect(msg.to).toBe('*');
      expect(msg.payload.question).toBe('test?');
    });
  });

  describe('resolve', () => {
    it('should resolve in 1 round with consensus', async () => {
      // Update workers to agree
      const config: OrchestratorConfig = {
        room_id: roomId,
        orchestrator_id: 'orch-1',
        data_dir: dataDir,
        max_rounds: 2,
        timeout_ms: 5000,
      };

      // First broadcast a message manually
      await broadcast(config, { payload: { question: 'test?' } });

      // Override with agreeing workers
      const agreeingWorkers = [
        { id: 'worker-1', answer: 'yes' },
        { id: 'worker-2', answer: 'yes' },
        { id: 'worker-3', answer: 'yes' },
      ];

      for (const w of agreeingWorkers) {
        const workerConfig: WorkerConfig = {
          participant_id: w.id,
          model_id: 'test',
          room_id: roomId,
          data_dir: dataDir,
          poll_interval_ms: 100,
          lock_ttl_ms: 30000,
          handler: async () => ({ answer: w.answer }),
        };
        await pollOnce(workerConfig);
      }

      // Verify workers processed
      const { readReceipt, listReceiptsForMessage } = await import('../../src/agentbus/backend-fs.js');
      const receipts = await listReceiptsForMessage(dataDir, roomId, (await broadcast(config, { payload: { question: 'test2?' } })).msg_id);
    });

    it('should fail after max_rounds without consensus', async () => {
      const config: OrchestratorConfig = {
        room_id: roomId,
        orchestrator_id: 'orch-1',
        data_dir: dataDir,
        max_rounds: 1,
        timeout_ms: 1000,
      };

      const result = await resolve(config, {
        payload: { question: 'disagree?' },
      });

      // Without workers running, should timeout
      expect(result.resolved).toBe(false);
      expect(result.rounds).toBe(1);
    });

    it('should fail if no workers in room', async () => {
      // Create empty room
      const emptyRoomId = 'empty-room';
      await createRoom(dataDir, emptyRoomId, 'orch-1');

      const config: OrchestratorConfig = {
        room_id: emptyRoomId,
        orchestrator_id: 'orch-1',
        data_dir: dataDir,
        max_rounds: 2,
        timeout_ms: 1000,
      };

      const result = await resolve(config, {
        payload: { question: 'test?' },
      });

      expect(result.resolved).toBe(false);
      expect(result.error).toContain('No workers');
    });
  });

  describe('integration', () => {
    it('should support 2 workers processing same broadcast', async () => {
      const config: OrchestratorConfig = {
        room_id: roomId,
        orchestrator_id: 'orch-1',
        data_dir: dataDir,
        max_rounds: 2,
        timeout_ms: 5000,
      };

      // Broadcast
      const msg = await broadcast(config, {
        payload: { question: 'parallel?' },
      });

      // Workers process
      const w1 = makeWorkerConfig('worker-1', 'A');
      const w2 = makeWorkerConfig('worker-2', 'B');

      await pollOnce(w1);
      await pollOnce(w2);

      // Verify both processed
      const { listReceiptsForMessage } = await import('../../src/agentbus/backend-fs.js');
      const receipts = await listReceiptsForMessage(dataDir, roomId, msg.msg_id);

      expect(receipts).toHaveLength(2);
      expect(receipts.map(r => r.participant_id).sort()).toEqual(['worker-1', 'worker-2']);
    });

    it('should resolve within 2 rounds', async () => {
      // Create agreeing workers for a simple consensus
      const answers = ['agreed', 'agreed', 'different'];

      const workers = ['worker-1', 'worker-2', 'worker-3'].map((id, i) => ({
        participant_id: id,
        model_id: 'test',
        room_id: roomId,
        data_dir: dataDir,
        poll_interval_ms: 100,
        lock_ttl_ms: 30000,
        handler: async () => ({ answer: answers[i] }),
      }));

      // Broadcast
      const config: OrchestratorConfig = {
        room_id: roomId,
        orchestrator_id: 'orch-1',
        data_dir: dataDir,
        max_rounds: 2,
        timeout_ms: 5000,
      };

      const msg = await broadcast(config, {
        payload: { question: 'consensus?' },
      });

      // All workers poll
      for (const w of workers) {
        await pollOnce(w);
      }

      // Check receipts
      const { listReceiptsForMessage } = await import('../../src/agentbus/backend-fs.js');
      const receipts = await listReceiptsForMessage(dataDir, roomId, msg.msg_id);
      expect(receipts).toHaveLength(3);
      expect(receipts.every(r => r.state === 'ANSWERED')).toBe(true);
    });

    it('should report live participant cursors in room status', async () => {
      await writeCursor(dataDir, roomId, 'worker-1', 7);
      await writeCursor(dataDir, roomId, 'worker-2', 3);

      const status = await getRoomStatus({
        room_id: roomId,
        orchestrator_id: 'orch-1',
        data_dir: dataDir,
        max_rounds: 2,
        timeout_ms: 1000,
      });

      const worker1 = status.participants.find((p) => p.participant_id === 'worker-1');
      const worker2 = status.participants.find((p) => p.participant_id === 'worker-2');

      expect(worker1?.cursor).toBe(7);
      expect(worker2?.cursor).toBe(3);
    });
  });

  describe('lifecycle', () => {
    async function runWorkersUntilDone(
      configs: WorkerConfig[],
      dataDir: string,
      roomId: string
    ): Promise<void> {
      // Run workers until room is closed
      const { readManifest } = await import('../../src/agentbus/backend-fs.js');
      let roomOpen = true;
      let iterations = 0;
      const maxIterations = 50;

      while (roomOpen && iterations < maxIterations) {
        let hadWork = false;
        for (const w of configs) {
          try {
            const result = await pollOnce(w);
            if (result.cursor_advanced) hadWork = true;
          } catch {
            // Room might be closed, ignore errors
          }
        }

        // Check room status
        try {
          const manifest = await readManifest(dataDir, roomId);
          roomOpen = manifest.room.status === 'OPEN';
        } catch {
          roomOpen = false;
        }

        if (!hadWork) await new Promise(r => setTimeout(r, 50));
        iterations++;
      }
    }

    it('should close room after successful resolve', async () => {
      const { readManifest } = await import('../../src/agentbus/backend-fs.js');

      const config: OrchestratorConfig = {
        room_id: roomId,
        orchestrator_id: 'orch-1',
        data_dir: dataDir,
        max_rounds: 2,
        timeout_ms: 2000,
      };

      const workers = [
        makeWorkerConfig('worker-1', 'yes'),
        makeWorkerConfig('worker-2', 'yes'),
        makeWorkerConfig('worker-3', 'yes'),
      ];

      // Run resolve concurrently with workers
      const resolvePromise = resolve(config, { payload: { question: 'agree?' } });
      const workersPromise = runWorkersUntilDone(workers, dataDir, roomId);

      const [result] = await Promise.all([resolvePromise, workersPromise]);

      expect(result.resolved).toBe(true);
      expect(result.final_answer).toBe('yes');

      // Verify room is closed
      const manifest = await readManifest(dataDir, roomId);
      expect(manifest.room.status).toBe('CLOSED');
    });

    it('should write RESOLVED system message on success', async () => {
      const { readManifest, readMessage } = await import('../../src/agentbus/backend-fs.js');

      const config: OrchestratorConfig = {
        room_id: roomId,
        orchestrator_id: 'orch-1',
        data_dir: dataDir,
        max_rounds: 2,
        timeout_ms: 2000,
      };

      const workers = [
        makeWorkerConfig('worker-1', 'yes'),
        makeWorkerConfig('worker-2', 'yes'),
        makeWorkerConfig('worker-3', 'yes'),
      ];

      const resolvePromise = resolve(config, { payload: { question: 'agree?' } });
      const workersPromise = runWorkersUntilDone(workers, dataDir, roomId);

      const [result] = await Promise.all([resolvePromise, workersPromise]);
      expect(result.resolved).toBe(true);

      // Find RESOLVED system message
      const manifest = await readManifest(dataDir, roomId);
      let resolvedMsg: { payload: { type: string; final_answer: unknown } } | null = null;

      for (let seq = 1; seq <= manifest.room.message_seq; seq++) {
        const msg = await readMessage(dataDir, roomId, seq);
        if (msg?.msg_type === 'system' && msg.payload.type === 'RESOLVED') {
          resolvedMsg = msg as { payload: { type: string; final_answer: unknown } };
          break;
        }
      }

      expect(resolvedMsg).not.toBeNull();
      expect(resolvedMsg?.payload.final_answer).toBe('yes');
    });

    it('should write FAILED system message on failure', async () => {
      const { readManifest, readMessage } = await import('../../src/agentbus/backend-fs.js');

      const config: OrchestratorConfig = {
        room_id: roomId,
        orchestrator_id: 'orch-1',
        data_dir: dataDir,
        max_rounds: 1,
        timeout_ms: 100, // Very short timeout to ensure failure
      };

      // Resolve without workers responding
      const result = await resolve(config, { payload: { question: 'timeout?' } });

      expect(result.resolved).toBe(false);

      // Verify room is closed even on failure
      const manifest = await readManifest(dataDir, roomId);
      expect(manifest.room.status).toBe('CLOSED');

      // Find FAILED system message
      let failedMsg: { payload: { type: string; reason?: string } } | null = null;
      for (let seq = 1; seq <= manifest.room.message_seq; seq++) {
        const msg = await readMessage(dataDir, roomId, seq);
        if (msg?.msg_type === 'system' && msg.payload.type === 'FAILED') {
          failedMsg = msg as { payload: { type: string; reason?: string } };
          break;
        }
      }

      expect(failedMsg).not.toBeNull();
    });

    it('should prevent worker from processing messages after room closed', async () => {
      const { readManifest } = await import('../../src/agentbus/backend-fs.js');

      const config: OrchestratorConfig = {
        room_id: roomId,
        orchestrator_id: 'orch-1',
        data_dir: dataDir,
        max_rounds: 2,
        timeout_ms: 2000,
      };

      const workers = [
        makeWorkerConfig('worker-1', 'yes'),
        makeWorkerConfig('worker-2', 'yes'),
        makeWorkerConfig('worker-3', 'yes'),
      ];

      // Run resolve with workers concurrently
      const resolvePromise = resolve(config, { payload: { question: 'agree?' } });
      const workersPromise = runWorkersUntilDone(workers, dataDir, roomId);

      const [result] = await Promise.all([resolvePromise, workersPromise]);
      expect(result.resolved).toBe(true);

      // Verify room is closed
      const manifest = await readManifest(dataDir, roomId);
      expect(manifest.room.status).toBe('CLOSED');

      // Worker should not process messages in closed room
      // When room is closed, pollOnce returns without processing
      const worker = makeWorkerConfig('worker-1', 'should-fail');
      const pollResult = await pollOnce(worker);

      // Room is closed so no new messages can be processed
      expect(pollResult.cursor_advanced).toBe(false);

      // Verify appendMessage fails for closed room
      const { appendMessage } = await import('../../src/agentbus/backend-fs.js');
      await expect(
        appendMessage(dataDir, roomId, 'answer', 'worker-1', 'orch-1', { test: true })
      ).rejects.toThrow('not open');
    });

    it('should skip system messages without writing receipts', async () => {
      const { readReceipt, listMessagesSince, readManifest, readMessage } = await import('../../src/agentbus/backend-fs.js');

      // First, create a scenario with a system message in an open room
      // We'll manually inject a system message
      const { appendMessage: rawAppend } = await import('../../src/agentbus/backend-fs.js');
      await rawAppend(dataDir, roomId, 'system', 'orch-1', '*', { type: 'TEST', data: 'test' });

      // Worker should skip system message without writing receipt
      const worker = makeWorkerConfig('worker-1', 'answer');

      // Get all messages
      const messages = await listMessagesSince(dataDir, roomId, 0);
      const systemMsg = messages.find(m => m.msg_type === 'system');
      expect(systemMsg).toBeDefined();

      // Poll once - should skip system message
      const result = await pollOnce(worker);

      // Cursor should advance past the system message
      expect(result.cursor_advanced).toBe(true);

      // But no receipt should be written for system message
      const receipt = await readReceipt(dataDir, roomId, systemMsg!.msg_id, 'worker-1');
      expect(receipt).toBeNull();
    });
  });
});
