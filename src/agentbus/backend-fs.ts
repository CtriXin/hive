/**
 * AgentBus Filesystem Backend
 * Room CRUD, message append, receipt management, cursor operations
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { atomicWriteFile } from './lock.js';
import type {
  Manifest,
  RoomState,
  Participant,
  Message,
  Receipt,
} from './schema.js';
import {
  ManifestSchema,
  RoomStateSchema,
  MessageSchema,
  ReceiptSchema,
  ParticipantSchema,
} from './schema.js';
import type { CursorData } from './types.js';

// ============================================================================
// Directory Helpers
// ============================================================================

export function getRoomDir(dataDir: string, roomId: string): string {
  return path.join(dataDir, 'rooms', roomId);
}

export function getManifestPath(dataDir: string, roomId: string): string {
  return path.join(getRoomDir(dataDir, roomId), 'manifest.json');
}

export function getMessagesDir(dataDir: string, roomId: string): string {
  return path.join(getRoomDir(dataDir, roomId), 'messages');
}

export function getMessagePath(
  dataDir: string,
  roomId: string,
  seq: number
): string {
  return path.join(getMessagesDir(dataDir, roomId), `${seq}.json`);
}

export function getReceiptsDir(
  dataDir: string,
  roomId: string,
  msgId: string
): string {
  return path.join(getMessagesDir(dataDir, roomId), msgId, 'receipts');
}

export function getReceiptPath(
  dataDir: string,
  roomId: string,
  msgId: string,
  participantId: string
): string {
  return path.join(
    getReceiptsDir(dataDir, roomId, msgId),
    `${participantId}.json`
  );
}

export function getCursorPath(
  dataDir: string,
  roomId: string,
  participantId: string
): string {
  return path.join(
    getRoomDir(dataDir, roomId),
    'cursors',
    `${participantId}.json`
  );
}

// ============================================================================
// Manifest Mutation Lock (Room-level)
// ============================================================================

function getManifestLockDir(dataDir: string, roomId: string): string {
  return path.join(getRoomDir(dataDir, roomId), 'manifest-lock');
}

async function acquireManifestLock(dataDir: string, roomId: string): Promise<void> {
  const lockDir = getManifestLockDir(dataDir, roomId);
  await fs.mkdir(lockDir, { recursive: true });

  const lockFile = path.join(lockDir, 'mutation.lock');

  while (true) {
    try {
      await fs.mkdir(lockFile, { recursive: false });
      return; // Got the lock
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        await new Promise((r) => setTimeout(r, 5));
      } else {
        throw err;
      }
    }
  }
}

async function releaseManifestLock(dataDir: string, roomId: string): Promise<void> {
  const lockFile = path.join(getManifestLockDir(dataDir, roomId), 'mutation.lock');
  try {
    await fs.rmdir(lockFile);
  } catch {
    // Ignore cleanup errors
  }
}

async function withManifestLock<T>(
  dataDir: string,
  roomId: string,
  fn: () => Promise<T>
): Promise<T> {
  await acquireManifestLock(dataDir, roomId);
  try {
    return await fn();
  } finally {
    await releaseManifestLock(dataDir, roomId);
  }
}

// ============================================================================
// Room Operations
// ============================================================================

export async function createRoom(
  dataDir: string,
  roomId: string,
  createdBy: string
): Promise<RoomState> {
  const roomDir = getRoomDir(dataDir, roomId);

  // Check if room already exists
  try {
    await fs.access(getManifestPath(dataDir, roomId));
    throw new Error(`Room ${roomId} already exists`);
  } catch (err) {
    if ((err as Error).message.includes('already exists')) throw err;
    // Doesn't exist - proceed
  }

  const now = Date.now();
  const roomState: RoomState = {
    room_id: roomId,
    status: 'OPEN',
    created_at: now,
    created_by: createdBy,
    participants: [],
    message_seq: 0,
  };

  const manifest: Manifest = {
    version: '1.0',
    room: roomState,
    last_updated: now,
  };

  // Create directory structure
  await fs.mkdir(roomDir, { recursive: true });
  await fs.mkdir(getMessagesDir(dataDir, roomId), { recursive: true });
  await fs.mkdir(path.join(roomDir, 'cursors'), { recursive: true });
  await fs.mkdir(path.join(roomDir, 'locks'), { recursive: true });

  // Write manifest
  await atomicWriteFile(
    getManifestPath(dataDir, roomId),
    JSON.stringify(manifest, null, 2)
  );

  return roomState;
}

export async function readManifest(
  dataDir: string,
  roomId: string
): Promise<Manifest> {
  const content = await fs.readFile(getManifestPath(dataDir, roomId), 'utf-8');
  const manifest = JSON.parse(content);
  return ManifestSchema.parse(manifest);
}

export async function writeManifest(
  dataDir: string,
  manifest: Manifest
): Promise<void> {
  const updated: Manifest = {
    ...manifest,
    last_updated: Date.now(),
  };
  await atomicWriteFile(
    getManifestPath(dataDir, manifest.room.room_id),
    JSON.stringify(updated, null, 2)
  );
}

/**
 * Read and modify manifest under lock
 * Use this for all manifest mutations to prevent race conditions
 */
export async function withManifest<T>(
  dataDir: string,
  roomId: string,
  mutate: (manifest: Manifest) => Promise<T>
): Promise<T> {
  return withManifestLock(dataDir, roomId, async () => {
    const manifest = await readManifest(dataDir, roomId);
    const result = await mutate(manifest);
    await writeManifest(dataDir, manifest);
    return result;
  });
}

export async function joinRoom(
  dataDir: string,
  roomId: string,
  participantId: string,
  modelId: string,
  role: Participant['role'] = 'worker'
): Promise<Participant> {
  return withManifest(dataDir, roomId, async (manifest) => {
    if (manifest.room.status !== 'OPEN') {
      throw new Error(`Room ${roomId} is not open`);
    }

    // Check if already joined
    const existing = manifest.room.participants.find(
      (p) => p.participant_id === participantId
    );
    if (existing) {
      return existing;
    }

    const participant: Participant = {
      participant_id: participantId,
      model_id: modelId,
      role,
      joined_at: Date.now(),
      cursor: 0,
    };

    manifest.room.participants.push(participant);

    // Initialize cursor file (outside manifest lock is OK, idempotent)
    const cursorData: CursorData = {
      participant_id: participantId,
      cursor: 0,
      updated_at: Date.now(),
    };
    await atomicWriteFile(
      getCursorPath(dataDir, roomId, participantId),
      JSON.stringify(cursorData, null, 2)
    );

    return participant;
  });
}

export async function listParticipants(
  dataDir: string,
  roomId: string
): Promise<Participant[]> {
  const manifest = await readManifest(dataDir, roomId);
  return manifest.room.participants;
}

export async function listParticipantsWithCursor(
  dataDir: string,
  roomId: string
): Promise<Participant[]> {
  const participants = await listParticipants(dataDir, roomId);
  return Promise.all(
    participants.map(async (participant) => ({
      ...participant,
      cursor: await readCursor(dataDir, roomId, participant.participant_id),
    }))
  );
}

export async function closeRoom(
  dataDir: string,
  roomId: string
): Promise<void> {
  await withManifest(dataDir, roomId, async (manifest) => {
    manifest.room.status = 'CLOSED';
  });
}

// ============================================================================
// Seq Allocation (Concurrent-safe)
// ============================================================================

export async function appendMessage(
  dataDir: string,
  roomId: string,
  msgType: Message['msg_type'],
  from: string,
  to: Message['to'],
  payload: Record<string, unknown>
): Promise<Message> {
  return withManifestLock(dataDir, roomId, async () => {
    const manifest = await readManifest(dataDir, roomId);

    if (manifest.room.status !== 'OPEN') {
      throw new Error(`Room ${roomId} is not open`);
    }

    const seq = manifest.room.message_seq + 1;
    const message: Message = {
      seq,
      msg_id: uuidv4(),
      msg_type: msgType,
      from,
      to,
      payload,
      timestamp: Date.now(),
    };

    MessageSchema.parse(message);

    await atomicWriteFile(
      getMessagePath(dataDir, roomId, seq),
      JSON.stringify(message, null, 2)
    );

    manifest.room.message_seq = seq;
    await writeManifest(dataDir, manifest);

    return message;
  });
}

export async function readMessage(
  dataDir: string,
  roomId: string,
  seq: number
): Promise<Message | null> {
  try {
    const content = await fs.readFile(
      getMessagePath(dataDir, roomId, seq),
      'utf-8'
    );
    const message = JSON.parse(content);
    return MessageSchema.parse(message);
  } catch {
    return null;
  }
}

export async function listMessagesSince(
  dataDir: string,
  roomId: string,
  sinceSeq: number
): Promise<Message[]> {
  const manifest = await readManifest(dataDir, roomId);
  const messages: Message[] = [];

  for (let seq = sinceSeq + 1; seq <= manifest.room.message_seq; seq++) {
    const msg = await readMessage(dataDir, roomId, seq);
    if (msg) {
      messages.push(msg);
    }
  }

  return messages;
}

// ============================================================================
// Receipt Operations
// ============================================================================

export async function writeReceipt(
  dataDir: string,
  roomId: string,
  msgId: string,
  participantId: string,
  state: Receipt['state'],
  options: { answerSeq?: number; error?: string } = {}
): Promise<Receipt> {
  const receipt: Receipt = {
    receipt_id: uuidv4(),
    msg_id: msgId,
    participant_id: participantId,
    state,
    answer_seq: options.answerSeq,
    error: options.error,
    timestamp: Date.now(),
  };

  // Validate before writing
  ReceiptSchema.parse(receipt);

  // Ensure receipts directory exists
  await fs.mkdir(getReceiptsDir(dataDir, roomId, msgId), { recursive: true });

  // Write receipt atomically
  await atomicWriteFile(
    getReceiptPath(dataDir, roomId, msgId, participantId),
    JSON.stringify(receipt, null, 2)
  );

  return receipt;
}

export async function readReceipt(
  dataDir: string,
  roomId: string,
  msgId: string,
  participantId: string
): Promise<Receipt | null> {
  try {
    const content = await fs.readFile(
      getReceiptPath(dataDir, roomId, msgId, participantId),
      'utf-8'
    );
    const receipt = JSON.parse(content);
    return ReceiptSchema.parse(receipt);
  } catch {
    return null;
  }
}

export async function hasReceipt(
  dataDir: string,
  roomId: string,
  msgId: string,
  participantId: string
): Promise<boolean> {
  try {
    await fs.access(getReceiptPath(dataDir, roomId, msgId, participantId));
    return true;
  } catch {
    return false;
  }
}

export async function listReceiptsForMessage(
  dataDir: string,
  roomId: string,
  msgId: string
): Promise<Receipt[]> {
  try {
    const receiptsDir = getReceiptsDir(dataDir, roomId, msgId);
    const files = await fs.readdir(receiptsDir);
    const receipts: Receipt[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await fs.readFile(
          path.join(receiptsDir, file),
          'utf-8'
        );
        const receipt = JSON.parse(content);
        receipts.push(ReceiptSchema.parse(receipt));
      } catch {
        // Skip invalid receipts
      }
    }

    return receipts;
  } catch {
    return [];
  }
}

// ============================================================================
// Cursor Operations
// ============================================================================

export async function readCursor(
  dataDir: string,
  roomId: string,
  participantId: string
): Promise<number> {
  try {
    const content = await fs.readFile(
      getCursorPath(dataDir, roomId, participantId),
      'utf-8'
    );
    const data: CursorData = JSON.parse(content);
    return data.cursor;
  } catch {
    return 0;
  }
}

export async function writeCursor(
  dataDir: string,
  roomId: string,
  participantId: string,
  cursor: number
): Promise<void> {
  const cursorData: CursorData = {
    participant_id: participantId,
    cursor,
    updated_at: Date.now(),
  };
  await atomicWriteFile(
    getCursorPath(dataDir, roomId, participantId),
    JSON.stringify(cursorData, null, 2)
  );
}
