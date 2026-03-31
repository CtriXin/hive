/**
 * AgentBus Room Tests
 * Room CRUD, participant management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createRoom,
  joinRoom,
  closeRoom,
  readManifest,
  listParticipants,
  readCursor,
} from '../../src/agentbus/backend-fs.js';

describe('Room Operations', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbus-test-'));
    dataDir = tempDir;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('createRoom', () => {
    it('should create a new room', async () => {
      const room = await createRoom(dataDir, 'test-room', 'orch-1');

      expect(room.room_id).toBe('test-room');
      expect(room.status).toBe('OPEN');
      expect(room.created_by).toBe('orch-1');
      expect(room.participants).toEqual([]);
      expect(room.message_seq).toBe(0);
    });

    it('should create manifest file', async () => {
      await createRoom(dataDir, 'test-room', 'orch-1');

      const manifest = await readManifest(dataDir, 'test-room');
      expect(manifest.version).toBe('1.0');
      expect(manifest.room.room_id).toBe('test-room');
    });

    it('should reject duplicate room creation', async () => {
      await createRoom(dataDir, 'test-room', 'orch-1');

      await expect(createRoom(dataDir, 'test-room', 'orch-1')).rejects.toThrow(
        'already exists'
      );
    });
  });

  describe('joinRoom', () => {
    it('should allow participant to join', async () => {
      await createRoom(dataDir, 'test-room', 'orch-1');
      const participant = await joinRoom(
        dataDir,
        'test-room',
        'worker-1',
        'gpt-4',
        'worker'
      );

      expect(participant.participant_id).toBe('worker-1');
      expect(participant.model_id).toBe('gpt-4');
      expect(participant.role).toBe('worker');
      expect(participant.cursor).toBe(0);
    });

    it('should update manifest with participant', async () => {
      await createRoom(dataDir, 'test-room', 'orch-1');
      await joinRoom(dataDir, 'test-room', 'worker-1', 'gpt-4', 'worker');

      const manifest = await readManifest(dataDir, 'test-room');
      expect(manifest.room.participants).toHaveLength(1);
      expect(manifest.room.participants[0].participant_id).toBe('worker-1');
    });

    it('should initialize cursor file', async () => {
      await createRoom(dataDir, 'test-room', 'orch-1');
      await joinRoom(dataDir, 'test-room', 'worker-1', 'gpt-4', 'worker');

      const cursor = await readCursor(dataDir, 'test-room', 'worker-1');
      expect(cursor).toBe(0);
    });

    it('should return existing participant if already joined', async () => {
      await createRoom(dataDir, 'test-room', 'orch-1');
      await joinRoom(dataDir, 'test-room', 'worker-1', 'gpt-4', 'worker');

      const participant = await joinRoom(
        dataDir,
        'test-room',
        'worker-1',
        'gpt-4',
        'worker'
      );
      expect(participant.participant_id).toBe('worker-1');

      const manifest = await readManifest(dataDir, 'test-room');
      expect(manifest.room.participants).toHaveLength(1);
    });

    it('should reject join to closed room', async () => {
      await createRoom(dataDir, 'test-room', 'orch-1');
      await closeRoom(dataDir, 'test-room');

      await expect(
        joinRoom(dataDir, 'test-room', 'worker-1', 'gpt-4', 'worker')
      ).rejects.toThrow('not open');
    });

    it('should allow multiple participants', async () => {
      await createRoom(dataDir, 'test-room', 'orch-1');
      await joinRoom(dataDir, 'test-room', 'worker-1', 'gpt-4', 'worker');
      await joinRoom(dataDir, 'test-room', 'worker-2', 'gpt-4', 'worker');

      const participants = await listParticipants(dataDir, 'test-room');
      expect(participants).toHaveLength(2);
      expect(participants.map((p) => p.participant_id)).toContain('worker-1');
      expect(participants.map((p) => p.participant_id)).toContain('worker-2');
    });
  });

  describe('closeRoom', () => {
    it('should close an open room', async () => {
      await createRoom(dataDir, 'test-room', 'orch-1');
      await closeRoom(dataDir, 'test-room');

      const manifest = await readManifest(dataDir, 'test-room');
      expect(manifest.room.status).toBe('CLOSED');
    });
  });

  describe('lifecycle', () => {
    it('should support full room lifecycle', async () => {
      // Create
      await createRoom(dataDir, 'test-room', 'orch-1');

      // Join
      await joinRoom(dataDir, 'test-room', 'worker-1', 'gpt-4', 'worker');
      await joinRoom(dataDir, 'test-room', 'worker-2', 'kimi', 'worker');

      // List
      const participants = await listParticipants(dataDir, 'test-room');
      expect(participants).toHaveLength(2);

      // Close
      await closeRoom(dataDir, 'test-room');
      const manifest = await readManifest(dataDir, 'test-room');
      expect(manifest.room.status).toBe('CLOSED');
    });
  });
});
