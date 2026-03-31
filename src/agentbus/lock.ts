/**
 * AgentBus Lock System
 * Compound locking with TTL and stale cleanup using atomic directory creation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LockResult, CompoundLockKey } from './types.js';
import type { LockMeta } from './schema.js';

/** Default lock TTL in milliseconds */
const DEFAULT_LOCK_TTL_MS = 30000;

/** Stale lock threshold in milliseconds */
const STALE_LOCK_THRESHOLD_MS = 60000;

/**
 * Generate compound lock key string
 * Format: {room_id}:{msg_id}:{participant_id}
 */
export function compoundLockKey(key: CompoundLockKey): string {
  return `${key.room_id}:${key.msg_id}:${key.participant_id}`;
}

/**
 * Generate lock directory path for a room
 */
export function getLockDir(dataDir: string, roomId: string): string {
  return path.join(dataDir, 'rooms', roomId, 'locks');
}

/**
 * Generate lock directory path (locks are directories for atomic mkdir)
 */
export function getLockPath(
  dataDir: string,
  roomId: string,
  lockKey: string
): string {
  return path.join(getLockDir(dataDir, roomId), lockKey);
}

/**
 * Get meta file path inside lock directory
 */
function getLockMetaPath(lockPath: string): string {
  return path.join(lockPath, 'meta.json');
}

/**
 * Check if a lock is stale
 */
export function isLockStale(lock: LockMeta, now: number): boolean {
  return now > lock.expires_at + STALE_LOCK_THRESHOLD_MS;
}

/**
 * Check if a lock is expired (TTL exceeded)
 */
export function isLockExpired(lock: LockMeta, now: number): boolean {
  return now > lock.expires_at;
}

/**
 * Read lock meta if it exists
 */
async function readLockMeta(lockPath: string): Promise<LockMeta | null> {
  try {
    const content = await fs.readFile(getLockMetaPath(lockPath), 'utf-8');
    return JSON.parse(content) as LockMeta;
  } catch {
    return null;
  }
}

/**
 * Try to acquire a compound lock using atomic directory creation
 * Returns success=false if lock already held by another participant
 *
 * Atomicity guarantee: Uses fs.mkdir() which is atomic at OS level.
 * If two processes try to create the same directory simultaneously,
 * only one will succeed (EEXIST error for the other).
 */
export async function tryAcquireLock(
  dataDir: string,
  key: CompoundLockKey,
  ttlMs: number = DEFAULT_LOCK_TTL_MS
): Promise<LockResult> {
  const now = Date.now();
  const lockMeta: LockMeta = {
    participant_id: key.participant_id,
    acquired_at: now,
    expires_at: now + ttlMs,
  };

  const lockKey = compoundLockKey(key);
  const lockPath = getLockPath(dataDir, key.room_id, lockKey);
  const lockDir = getLockDir(dataDir, key.room_id);

  try {
    // Ensure parent lock directory exists
    await fs.mkdir(lockDir, { recursive: true });

    // Try to read existing lock (for refresh or steal scenarios)
    const existingLock = await readLockMeta(lockPath);

    if (existingLock) {
      // Same participant can refresh their own lock
      if (existingLock.participant_id === key.participant_id) {
        await atomicWriteFile(getLockMetaPath(lockPath), JSON.stringify(lockMeta, null, 2));
        return { success: true, lock: lockMeta };
      }

      // Lock held by different participant - check if expired/stale
      if (!isLockExpired(existingLock, now) && !isLockStale(existingLock, now)) {
        return {
          success: false,
          error: `Lock held by ${existingLock.participant_id} until ${existingLock.expires_at}`,
        };
      }

      // Lock is expired/stale - steal it by removing and recreating
      try {
        await fs.rm(lockPath, { recursive: true, force: true });
      } catch {
        // Ignore errors during cleanup
      }
    }

    // ATOMIC CLAIM: Create lock directory
    // Only one process can succeed here - others get EEXIST
    await fs.mkdir(lockPath, { recursive: false });

    // Write meta file inside lock directory
    await fs.writeFile(
      getLockMetaPath(lockPath),
      JSON.stringify(lockMeta, null, 2),
      'utf-8'
    );

    return { success: true, lock: lockMeta };
  } catch (err) {
    const errorMsg = (err as Error).message;

    // EEXIST means another process claimed the lock simultaneously
    if (errorMsg.includes('EEXIST') || (err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Re-check if we lost the race to someone else
      const existingLock = await readLockMeta(lockPath);
      if (existingLock && existingLock.participant_id !== key.participant_id) {
        return {
          success: false,
          error: `Lock held by ${existingLock.participant_id} until ${existingLock.expires_at}`,
        };
      }
      // Lock exists but we can't tell who owns it - fail safe
      return {
        success: false,
        error: `Lock already claimed (race condition)`,
      };
    }

    return {
      success: false,
      error: `Failed to acquire lock: ${errorMsg}`,
    };
  }
}

/**
 * Release a compound lock
 * Only releases if held by the same participant
 */
export async function releaseLock(
  dataDir: string,
  key: CompoundLockKey
): Promise<boolean> {
  const lockKey = compoundLockKey(key);
  const lockPath = getLockPath(dataDir, key.room_id, lockKey);

  try {
    // Verify ownership before releasing
    const existingLock = await readLockMeta(lockPath);

    if (!existingLock) {
      // Lock doesn't exist - consider released
      return true;
    }

    if (existingLock.participant_id !== key.participant_id) {
      return false;
    }

    // Remove the entire lock directory
    await fs.rm(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    // Error reading or removing - consider released
    return true;
  }
}

/**
 * Atomic file write using write-then-rename pattern
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, filePath);
}

/**
 * Cleanup stale locks in a room
 */
export async function cleanupStaleLocks(
  dataDir: string,
  roomId: string
): Promise<number> {
  const lockDir = getLockDir(dataDir, roomId);
  const now = Date.now();
  let cleaned = 0;

  try {
    const entries = await fs.readdir(lockDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const lockPath = path.join(lockDir, entry.name);
      const lockMeta = await readLockMeta(lockPath);

      if (lockMeta && isLockStale(lockMeta, now)) {
        try {
          await fs.rm(lockPath, { recursive: true, force: true });
          cleaned++;
        } catch {
          // Skip locks we can't remove
        }
      }
    }
  } catch {
    // Directory doesn't exist or can't read
  }

  return cleaned;
}
