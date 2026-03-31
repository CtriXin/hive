/**
 * AgentBus Message Tests
 * Message append, receipt management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createRoom,
  joinRoom,
  appendMessage,
  readMessage,
  listMessagesSince,
  writeReceipt,
  readReceipt,
  hasReceipt,
  listReceiptsForMessage,
} from '../../src/agentbus/backend-fs.js';

describe('Message Operations', () => {
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

  describe('appendMessage', () => {
    it('should append a broadcast message', async () => {
      const msg = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {
        question: 'test?',
      });

      expect(msg.seq).toBe(1);
      expect(msg.msg_type).toBe('broadcast');
      expect(msg.from).toBe('orch-1');
      expect(msg.to).toBe('*');
      expect(msg.payload.question).toBe('test?');
    });

    it('should increment sequence numbers', async () => {
      const msg1 = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {});
      const msg2 = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {});
      const msg3 = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {});

      expect(msg1.seq).toBe(1);
      expect(msg2.seq).toBe(2);
      expect(msg3.seq).toBe(3);
    });

    it('should write message to file', async () => {
      const msg = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {
        data: 'value',
      });

      const read = await readMessage(dataDir, roomId, msg.seq);
      expect(read).toBeDefined();
      expect(read?.msg_id).toBe(msg.msg_id);
      expect(read?.payload.data).toBe('value');
    });

    it('should reject append to closed room', async () => {
      const { closeRoom } = await import('../../src/agentbus/backend-fs.js');
      await closeRoom(dataDir, roomId);

      await expect(
        appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {})
      ).rejects.toThrow('not open');
    });
  });

  describe('readMessage', () => {
    it('should return null for non-existent message', async () => {
      const msg = await readMessage(dataDir, roomId, 999);
      expect(msg).toBeNull();
    });

    it('should read existing message', async () => {
      const written = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {
        test: 'data',
      });

      const read = await readMessage(dataDir, roomId, written.seq);
      expect(read?.msg_id).toBe(written.msg_id);
      expect(read?.payload.test).toBe('data');
    });
  });

  describe('listMessagesSince', () => {
    it('should return messages after cursor', async () => {
      await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', { n: 1 });
      await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', { n: 2 });
      await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', { n: 3 });

      const messages = await listMessagesSince(dataDir, roomId, 1);

      expect(messages).toHaveLength(2);
      expect(messages[0].payload.n).toBe(2);
      expect(messages[1].payload.n).toBe(3);
    });

    it('should return empty array when no messages', async () => {
      const messages = await listMessagesSince(dataDir, roomId, 0);
      expect(messages).toEqual([]);
    });
  });

  describe('writeReceipt', () => {
    it('should write PROCESSING receipt', async () => {
      const msg = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {});

      const receipt = await writeReceipt(
        dataDir,
        roomId,
        msg.msg_id,
        'worker-1',
        'PROCESSING'
      );

      expect(receipt.msg_id).toBe(msg.msg_id);
      expect(receipt.participant_id).toBe('worker-1');
      expect(receipt.state).toBe('PROCESSING');
    });

    it('should write ANSWERED receipt with answer_seq', async () => {
      const msg = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {});

      const receipt = await writeReceipt(
        dataDir,
        roomId,
        msg.msg_id,
        'worker-1',
        'ANSWERED',
        { answerSeq: 2 }
      );

      expect(receipt.state).toBe('ANSWERED');
      expect(receipt.answer_seq).toBe(2);
    });

    it('should write ERROR receipt', async () => {
      const msg = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {});

      const receipt = await writeReceipt(
        dataDir,
        roomId,
        msg.msg_id,
        'worker-1',
        'ERROR',
        { error: 'Something failed' }
      );

      expect(receipt.state).toBe('ERROR');
      expect(receipt.error).toBe('Something failed');
    });
  });

  describe('readReceipt', () => {
    it('should return null for non-existent receipt', async () => {
      const receipt = await readReceipt(dataDir, roomId, 'fake-msg', 'worker-1');
      expect(receipt).toBeNull();
    });

    it('should read existing receipt', async () => {
      const msg = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {});
      await writeReceipt(dataDir, roomId, msg.msg_id, 'worker-1', 'PROCESSING');

      const read = await readReceipt(dataDir, roomId, msg.msg_id, 'worker-1');
      expect(read?.state).toBe('PROCESSING');
      expect(read?.participant_id).toBe('worker-1');
    });
  });

  describe('hasReceipt', () => {
    it('should return false when no receipt', async () => {
      const msg = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {});
      const has = await hasReceipt(dataDir, roomId, msg.msg_id, 'worker-1');
      expect(has).toBe(false);
    });

    it('should return true when receipt exists', async () => {
      const msg = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {});
      await writeReceipt(dataDir, roomId, msg.msg_id, 'worker-1', 'PROCESSING');

      const has = await hasReceipt(dataDir, roomId, msg.msg_id, 'worker-1');
      expect(has).toBe(true);
    });
  });

  describe('listReceiptsForMessage', () => {
    it('should return empty array for message with no receipts', async () => {
      const msg = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {});
      const receipts = await listReceiptsForMessage(dataDir, roomId, msg.msg_id);
      expect(receipts).toEqual([]);
    });

    it('should list all receipts for a message', async () => {
      const msg = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {});

      await writeReceipt(dataDir, roomId, msg.msg_id, 'worker-1', 'ANSWERED');
      await writeReceipt(dataDir, roomId, msg.msg_id, 'worker-2', 'ANSWERED');

      const receipts = await listReceiptsForMessage(dataDir, roomId, msg.msg_id);
      expect(receipts).toHaveLength(2);
    });

    it('should allow same broadcast to have independent receipts', async () => {
      const msg = await appendMessage(dataDir, roomId, 'broadcast', 'orch-1', '*', {});

      const receipt1 = await writeReceipt(
        dataDir,
        roomId,
        msg.msg_id,
        'worker-1',
        'ANSWERED',
        { answerSeq: 2 }
      );
      const receipt2 = await writeReceipt(
        dataDir,
        roomId,
        msg.msg_id,
        'worker-2',
        'ANSWERED',
        { answerSeq: 3 }
      );

      // Each participant has their own receipt
      expect(receipt1.participant_id).toBe('worker-1');
      expect(receipt1.answer_seq).toBe(2);
      expect(receipt2.participant_id).toBe('worker-2');
      expect(receipt2.answer_seq).toBe(3);

      // Message itself is unchanged (read-only)
      const original = await readMessage(dataDir, roomId, msg.seq);
      expect(original?.msg_id).toBe(msg.msg_id);
    });
  });
});
