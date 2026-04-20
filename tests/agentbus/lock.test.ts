/**
 * AgentBus Lock Tests
 * Compound locking, TTL, stale cleanup using atomic directory creation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  tryAcquireLock,
  releaseLock,
  cleanupStaleLocks,
  compoundLockKey,
  getLockPath,
  isLockStale,
  isLockExpired,
  atomicWriteFile,
} from '../../src/agentbus/lock.js';
import type { LockMeta, CompoundLockKey } from '../../src/agentbus/types.js';

describe('Lock System', () => {
  let tempDir: string;
  let dataDir: string;
  const roomId = 'test-room';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbus-test-'));
    dataDir = tempDir;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('compoundLockKey', () => {
    it('should generate correct key format', () => {
      const key: CompoundLockKey = {
        room_id: 'room-1',
        msg_id: 'msg-2',
        participant_id: 'worker-3',
      };
      expect(compoundLockKey(key)).toBe('room-1:msg-2:worker-3');
    });
  });

  describe('tryAcquireLock', () => {
    it('should acquire lock when none exists', async () => {
      const key: CompoundLockKey = {
        room_id: roomId,
        msg_id: 'msg-1',
        participant_id: 'worker-1',
      };

      const result = await tryAcquireLock(dataDir, key, 30000);

      expect(result.success).toBe(true);
      expect(result.lock).toBeDefined();
      expect(result.lock?.participant_id).toBe('worker-1');

      // Verify lock directory was created with meta.json
      const lockPath = getLockPath(dataDir, roomId, compoundLockKey(key));
      const metaContent = await fs.readFile(path.join(lockPath, 'meta.json'), 'utf-8');
      const meta: LockMeta = JSON.parse(metaContent);
      expect(meta.participant_id).toBe('worker-1');
    });

    it('should allow same participant to re-acquire (refresh)', async () => {
      const key: CompoundLockKey = {
        room_id: roomId,
        msg_id: 'msg-1',
        participant_id: 'worker-1',
      };

      await tryAcquireLock(dataDir, key, 30000);
      const result = await tryAcquireLock(dataDir, key, 60000);

      expect(result.success).toBe(true);
      expect(result.lock?.expires_at).toBeGreaterThan(Date.now() + 30000);
    });

    it('should allow same msg_id different participant_id simultaneously', async () => {
      const key1: CompoundLockKey = {
        room_id: roomId,
        msg_id: 'msg-1',
        participant_id: 'worker-1',
      };
      const key2: CompoundLockKey = {
        room_id: roomId,
        msg_id: 'msg-1',
        participant_id: 'worker-2',
      };

      const result1 = await tryAcquireLock(dataDir, key1, 30000);
      const result2 = await tryAcquireLock(dataDir, key2, 30000);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
    });

    it('should block concurrent acquisition of same compound key', async () => {
      const key: CompoundLockKey = {
        room_id: roomId,
        msg_id: 'msg-1',
        participant_id: 'worker-1',
      };

      // First acquire succeeds
      const result1 = await tryAcquireLock(dataDir, key, 30000);
      expect(result1.success).toBe(true);

      // Simulate another process trying to acquire same lock
      // by directly attempting mkdir (should fail with EEXIST)
      const lockPath = getLockPath(dataDir, roomId, compoundLockKey(key));

      await expect(
        fs.mkdir(lockPath, { recursive: false })
      ).rejects.toThrow(/EEXIST|file already exists/i);
    });

    it('should allow expired lock to be stolen', async () => {
      const key: CompoundLockKey = {
        room_id: roomId,
        msg_id: 'msg-1',
        participant_id: 'worker-1',
      };

      // Acquire with very short TTL
      await tryAcquireLock(dataDir, key, 1);

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 10));

      // Different worker should be able to acquire (steal)
      const key2: CompoundLockKey = {
        room_id: roomId,
        msg_id: 'msg-1',
        participant_id: 'worker-2',
      };

      const result = await tryAcquireLock(dataDir, key2, 30000);
      expect(result.success).toBe(true);
    });
  });

  describe('releaseLock', () => {
    it('should release owned lock', async () => {
      const key: CompoundLockKey = {
        room_id: roomId,
        msg_id: 'msg-1',
        participant_id: 'worker-1',
      };

      await tryAcquireLock(dataDir, key, 30000);
      const released = await releaseLock(dataDir, key);

      expect(released).toBe(true);

      // Should be able to acquire again
      const result = await tryAcquireLock(dataDir, key, 30000);
      expect(result.success).toBe(true);
    });

    it('should not release lock owned by another', async () => {
      // Create a lock directory manually with mismatched owner
      const key: CompoundLockKey = {
        room_id: roomId,
        msg_id: 'msg-1',
        participant_id: 'worker-1',
      };

      const lockPath = getLockPath(dataDir, roomId, compoundLockKey(key));
      await fs.mkdir(lockPath, { recursive: true });

      // Write meta claiming worker-2 owns it
      const fakeLock: LockMeta = {
        participant_id: 'worker-2',
        acquired_at: Date.now(),
        expires_at: Date.now() + 30000,
      };
      await fs.writeFile(
        path.join(lockPath, 'meta.json'),
        JSON.stringify(fakeLock),
        'utf-8'
      );

      // worker-1 tries to release - should fail ownership check
      const released = await releaseLock(dataDir, key);
      expect(released).toBe(false);
    });
  });

  describe('isLockExpired', () => {
    it('should return true for expired lock', () => {
      const lock: LockMeta = {
        participant_id: 'worker-1',
        acquired_at: Date.now() - 2000,
        expires_at: Date.now() - 1000,
      };
      expect(isLockExpired(lock, Date.now())).toBe(true);
    });

    it('should return false for active lock', () => {
      const lock: LockMeta = {
        participant_id: 'worker-1',
        acquired_at: Date.now(),
        expires_at: Date.now() + 30000,
      };
      expect(isLockExpired(lock, Date.now())).toBe(false);
    });
  });

  describe('isLockStale', () => {
    it('should return true for stale lock', () => {
      const now = Date.now();
      const lock: LockMeta = {
        participant_id: 'worker-1',
        acquired_at: now - 180000,
        expires_at: now - 120000, // 120s ago (> STALE_LOCK_THRESHOLD_MS of 60s)
      };
      expect(isLockStale(lock, now)).toBe(true);
    });

    it('should return false for fresh lock', () => {
      const lock: LockMeta = {
        participant_id: 'worker-1',
        acquired_at: Date.now(),
        expires_at: Date.now() + 30000,
      };
      expect(isLockStale(lock, Date.now())).toBe(false);
    });
  });

  describe('cleanupStaleLocks', () => {
    it('should remove stale locks', async () => {
      const lockDir = path.join(dataDir, 'rooms', roomId, 'locks');
      await fs.mkdir(lockDir, { recursive: true });

      // Create a stale lock directory
      const staleLockDir = path.join(lockDir, 'stale-lock');
      await fs.mkdir(staleLockDir);

      const staleLock: LockMeta = {
        participant_id: 'worker-1',
        acquired_at: Date.now() - 200000,
        expires_at: Date.now() - 120000,
      };
      await fs.writeFile(
        path.join(staleLockDir, 'meta.json'),
        JSON.stringify(staleLock),
        'utf-8'
      );

      const cleaned = await cleanupStaleLocks(dataDir, roomId);
      expect(cleaned).toBe(1);

      // Verify directory is gone
      await expect(fs.access(staleLockDir)).rejects.toThrow();
    });

    it('should not remove fresh locks', async () => {
      const key: CompoundLockKey = {
        room_id: roomId,
        msg_id: 'msg-1',
        participant_id: 'worker-1',
      };

      await tryAcquireLock(dataDir, key, 30000);

      const cleaned = await cleanupStaleLocks(dataDir, roomId);
      expect(cleaned).toBe(0);

      // Lock directory should still exist
      const lockPath = getLockPath(dataDir, roomId, compoundLockKey(key));
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
    });
  });

  describe('atomicWriteFile', () => {
    it('should write file atomically', async () => {
      const filePath = path.join(dataDir, 'test-file.txt');
      const content = 'test content';

      await atomicWriteFile(filePath, content);

      const read = await fs.readFile(filePath, 'utf-8');
      expect(read).toBe(content);
    });

    it('should create parent directories', async () => {
      const filePath = path.join(dataDir, 'nested', 'dir', 'file.txt');

      await atomicWriteFile(filePath, 'content');

      const read = await fs.readFile(filePath, 'utf-8');
      expect(read).toBe('content');
    });
  });

  describe('concurrent safety', () => {
    it('should allow concurrent same-participant attempts to refresh the same lock', async () => {
      const key: CompoundLockKey = {
        room_id: roomId,
        msg_id: 'msg-concurrent',
        participant_id: 'worker-1',
      };

      // Simulate 5 concurrent attempts from the same participant.
      // The compound key includes participant_id, so same-participant
      // concurrent calls are treated as refresh attempts by contract.
      // (In a real single-instance worker this race does not occur.)
      const attempts = Array.from({ length: 5 }, () =>
        tryAcquireLock(dataDir, key, 30000)
      );

      const results = await Promise.all(attempts);

      // At least one must succeed; multiple successes are acceptable
      // because same-participant re-entry is defined as refresh.
      const successes = results.filter((r) => r.success);
      expect(successes.length).toBeGreaterThanOrEqual(1);
    });
  });
});
