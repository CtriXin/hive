#!/usr/bin/env node
/**
 * AgentBus CLI - MVP
 * Hardened CLI for multi-agent orchestration
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRoom, joinRoom, readManifest, listParticipants } from '../src/agentbus/backend-fs.js';
import { resolve, getRoomStatus, broadcast } from '../src/agentbus/orchestrator.js';
import { createWorker } from '../src/agentbus/worker.js';
import { cleanupStaleLocks } from '../src/agentbus/lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Shared absolute path for cross-CLI communication.
const DEFAULT_DATA_DIR = path.join(process.env.HOME || require('os').homedir(), '.agentbus');
const DATA_DIR = process.env.AGENTBUS_DATA_DIR ?? DEFAULT_DATA_DIR;

// Identity storage
const IDENTITY_DIR = path.join(DATA_DIR, 'identities');
const PID_DIR = path.join(DATA_DIR, 'pids');

// ============================================================================
// Identity Management
// ============================================================================

async function getOrCreateIdentity(name?: string): Promise<{ participant_id: string; alias?: string }> {
  await fs.mkdir(IDENTITY_DIR, { recursive: true });

  // Use hostname + user as default identity name
  const defaultName = 'default';
  const identityName = name ?? defaultName;
  const identityFile = path.join(IDENTITY_DIR, `${identityName}.json`);

  try {
    const content = await fs.readFile(identityFile, 'utf-8');
    const identity = JSON.parse(content);
    return { participant_id: identity.participant_id, alias: identity.alias };
  } catch {
    // Create new identity
    const participantId = `worker-${Math.random().toString(36).slice(2, 10)}`;
    const identity = {
      participant_id: participantId,
      alias: identityName,
      created_at: Date.now(),
    };
    await fs.writeFile(identityFile, JSON.stringify(identity, null, 2));
    return { participant_id: participantId, alias: identityName };
  }
}

async function saveIdentityAlias(participantId: string, alias: string): Promise<void> {
  await fs.mkdir(IDENTITY_DIR, { recursive: true });
  const identityFile = path.join(IDENTITY_DIR, `${alias}.json`);
  const identity = {
    participant_id: participantId,
    alias,
    created_at: Date.now(),
  };
  await fs.writeFile(identityFile, JSON.stringify(identity, null, 2));
}

// ============================================================================
// PID Management for Background Workers
// ============================================================================

function getPidFile(roomId: string, participantId: string): string {
  return path.join(PID_DIR, `${roomId}-${participantId}.pid`);
}

async function writePidFile(roomId: string, participantId: string, pid: number): Promise<void> {
  await fs.mkdir(PID_DIR, { recursive: true });
  const pidFile = getPidFile(roomId, participantId);
  await fs.writeFile(pidFile, JSON.stringify({ pid, started_at: Date.now() }));
}

async function readPidFile(roomId: string, participantId: string): Promise<{ pid: number; started_at: number } | null> {
  try {
    const pidFile = getPidFile(roomId, participantId);
    const content = await fs.readFile(pidFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function removePidFile(roomId: string, participantId: string): Promise<void> {
  try {
    const pidFile = getPidFile(roomId, participantId);
    await fs.unlink(pidFile);
  } catch {
    // Ignore
  }
}

async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isWorkerRunning(roomId: string, participantId: string): Promise<boolean> {
  const pidData = await readPidFile(roomId, participantId);
  if (!pidData) return false;

  const running = await isProcessRunning(pidData.pid);
  if (!running) {
    // Clean up stale pid file
    await removePidFile(roomId, participantId);
    return false;
  }
  return true;
}

// ============================================================================
// Background Worker
// ============================================================================

async function startBackgroundWorker(
  roomId: string,
  participantId: string,
  modelId: string
): Promise<void> {
  // Check if already running
  if (await isWorkerRunning(roomId, participantId)) {
    const pidData = await readPidFile(roomId, participantId);
    console.log(`Worker already running (pid: ${pidData?.pid})`);
    console.log(`To stop: kill ${pidData?.pid}`);
    return;
  }

  // Fork detached process
  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawn(
    process.execPath,
    ['--no-warnings', scriptPath, 'watch-internal', roomId, participantId, modelId],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, AGENTBUS_DATA_DIR: DATA_DIR },
    }
  );

  child.unref();

  // Write pid file
  await writePidFile(roomId, participantId, child.pid!);

  console.log(`Started background worker (pid: ${child.pid})`);
  console.log(`Participant: ${participantId}`);
  console.log(`Room: ${roomId}`);
}

// ============================================================================
// CLI Output Helpers
// ============================================================================

function printSuccess(message: string): void {
  console.log(`✓ ${message}`);
}

function printError(message: string): void {
  console.error(`✗ ${message}`);
}

function printInfo(label: string, value: string): void {
  console.log(`  ${label.padEnd(12)} ${value}`);
}

function isRoomIdLike(value: string): boolean {
  return /^room-[a-z0-9]+-[a-z0-9]+$/i.test(value);
}

// ============================================================================
// Command Handlers
// ============================================================================

async function cmdCreate(args: string[]): Promise<void> {
  const question = args.join(' ');
  const roomId = `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const orchestratorId = `orch-${Math.random().toString(36).slice(2, 8)}`;

  const room = await createRoom(DATA_DIR, roomId, orchestratorId);

  printSuccess(`Created room: ${room.room_id}`);
  printInfo('Status:', room.status);
  printInfo('Created by:', orchestratorId);

  if (question) {
    console.log('');
    printInfo('Question:', question);
  }

  console.log('');
  console.log('To join this room:');
  console.log(`  agentbus join ${roomId}`);

  if (question) {
    console.log('');
    console.log('To resolve:');
    console.log(`  agentbus resolve ${roomId} "${question}"`);
  }
}

async function cmdJoin(args: string[]): Promise<void> {
  const roomId = args[0];
  if (!roomId) {
    printError('room-id required');
    process.exit(1);
  }

  // Parse options
  let alias: string | undefined;
  let modelId = 'default';

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--alias' || args[i] === '-a') {
      alias = args[++i];
    } else if (args[i] === '--model' || args[i] === '-m') {
      modelId = args[++i];
    } else if (!alias && !args[i].startsWith('-')) {
      // Positional alias for backward compat
      alias = args[i];
    }
  }

  const identity = await getOrCreateIdentity(alias);
  const participantId = identity.participant_id;

  // Save alias if provided
  if (alias && alias !== identity.alias) {
    await saveIdentityAlias(participantId, alias);
  }

  try {
    const participant = await joinRoom(DATA_DIR, roomId, participantId, modelId, 'worker');
    printSuccess(`Joined room: ${roomId}`);
    printInfo('Participant:', participant.participant_id);
    printInfo('Alias:', alias ?? identity.alias ?? 'none');
    printInfo('Model:', participant.model_id);

    console.log('');
    console.log('To start watching (foreground):');
    console.log(`  agentbus watch ${roomId}`);
    console.log('');
    console.log('To start watching (background):');
    console.log(`  agentbus watch ${roomId} --background`);
  } catch (err) {
    printError((err as Error).message);
    process.exit(1);
  }
}

async function cmdWatch(args: string[]): Promise<void> {
  const roomId = args[0];
  if (!roomId) {
    printError('room-id required');
    process.exit(1);
  }

  // Parse options
  let alias: string | undefined;
  let modelId = 'default';
  let background = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--background' || args[i] === '-b') {
      background = true;
    } else if (args[i] === '--alias' || args[i] === '-a') {
      alias = args[++i];
    } else if (args[i] === '--model' || args[i] === '-m') {
      modelId = args[++i];
    } else if (!alias && !args[i].startsWith('-')) {
      // Positional participant-id for backward compat
      alias = args[i];
    }
  }

  const identity = await getOrCreateIdentity(alias);
  const participantId = identity.participant_id;

  try {
    await joinRoom(DATA_DIR, roomId, participantId, modelId, 'worker');
  } catch (err) {
    printError((err as Error).message);
    process.exit(1);
  }

  if (background) {
    await startBackgroundWorker(roomId, participantId, modelId);
    return;
  }

  // Foreground mode
  console.log(`Starting worker: ${participantId} in room: ${roomId}`);
  console.log('Press Ctrl+C to stop');
  console.log('');

  const worker = createWorker({
    participant_id: participantId,
    model_id: modelId,
    room_id: roomId,
    data_dir: DATA_DIR,
    handler: async (message) => {
      const timestamp = new Date().toLocaleTimeString();
      console.log(`[${timestamp}] #${message.seq} ${message.msg_type} from ${message.from}`);

      if (message.payload?.question || message.payload?.task) {
        const input = (message.payload.question ?? message.payload.task) as string;
        // Simple echo response for CLI workers
        return {
          answer: `Worker ${participantId} processed: ${input}`,
        };
      }

      return {
        answer: `Worker ${participantId} acknowledged`,
      };
    },
  });

  const controller = new AbortController();
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    controller.abort();
  });

  await worker.start(controller.signal);
}

// Internal watch command for background mode
async function cmdWatchInternal(args: string[]): Promise<void> {
  const roomId = args[0];
  const participantId = args[1];
  const modelId = args[2] ?? 'default';

  if (!roomId || !participantId) {
    console.error('Internal: room-id and participant-id required');
    process.exit(1);
  }

  const worker = createWorker({
    participant_id: participantId,
    model_id: modelId,
    room_id: roomId,
    data_dir: DATA_DIR,
    handler: async (message) => {
      if (message.payload?.question || message.payload?.task) {
        const input = (message.payload.question ?? message.payload.task) as string;
        return {
          answer: `Worker ${participantId} processed: ${input}`,
        };
      }
      return {
        answer: `Worker ${participantId} acknowledged`,
      };
    },
  });

  // Cleanup pid file on exit
  const cleanup = async () => {
    await removePidFile(roomId, participantId);
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  await worker.start();
}

async function cmdStatus(args: string[]): Promise<void> {
  const roomId = args[0];
  if (!roomId) {
    printError('room-id required');
    process.exit(1);
  }

  const orchestratorId = 'orch-default';

  try {
    const status = await getRoomStatus({
      room_id: roomId,
      orchestrator_id: orchestratorId,
      data_dir: DATA_DIR,
      max_rounds: 2,
      timeout_ms: 30000,
    });

    printSuccess(`Room: ${status.room.room_id}`);
    printInfo('Status:', status.room.status);
    printInfo('Messages:', String(status.room.message_seq));
    printInfo('Participants:', String(status.participants.length));

    if (status.participants.length > 0) {
      console.log('');
      console.log('Participants:');
      for (const p of status.participants) {
        const running = await isWorkerRunning(roomId, p.participant_id);
        const statusStr = running ? '🟢' : '⚪';
        console.log(`  ${statusStr} ${p.participant_id} (${p.role}) cursor=${p.cursor}`);
      }
    }
  } catch (err) {
    printError((err as Error).message);
    process.exit(1);
  }
}

async function cmdList(args: string[]): Promise<void> {
  // List all rooms or participants in a room
  const roomId = args[0];

  if (roomId) {
    // List participants in room
    try {
      const participants = await listParticipants(DATA_DIR, roomId);
      printSuccess(`Participants in room: ${roomId}`);
      for (const p of participants) {
        console.log(`  • ${p.participant_id} (${p.role}, model: ${p.model_id})`);
      }
    } catch (err) {
      printError((err as Error).message);
      process.exit(1);
    }
  } else {
    // List all rooms
    const roomsDir = path.join(DATA_DIR, 'rooms');
    try {
      const entries = await fs.readdir(roomsDir, { withFileTypes: true });
      const rooms = entries.filter(e => e.isDirectory()).map(e => e.name);

      printSuccess(`Found ${rooms.length} room(s):`);
      for (const roomId of rooms) {
        try {
          const manifest = await readManifest(DATA_DIR, roomId);
          const statusIcon = manifest.room.status === 'OPEN' ? '🟢' : '🔴';
          console.log(`  ${statusIcon} ${roomId} (${manifest.room.participants.length} participants)`);
        } catch {
          console.log(`  ⚪ ${roomId} (unreadable)`);
        }
      }
    } catch {
      console.log('No rooms found');
    }
  }
}

async function cmdResolve(args: string[]): Promise<void> {
  const roomId = args[0];
  if (!roomId) {
    printError('room-id required');
    process.exit(1);
  }

  const question = args.slice(1).join(' ');
  if (!question) {
    printError('question required');
    process.exit(1);
  }

  const orchestratorId = `orch-${Math.random().toString(36).slice(2, 8)}`;

  console.log(`Resolving: "${question}"`);
  console.log(`Room: ${roomId}`);
  console.log('');

  const result = await resolve(
    {
      room_id: roomId,
      orchestrator_id: orchestratorId,
      data_dir: DATA_DIR,
      max_rounds: 2,
      timeout_ms: 30000,
    },
    {
      payload: { question },
    }
  );

  if (result.resolved) {
    printSuccess(`Resolved in ${result.rounds} round(s)`);
    printInfo('Answer:', JSON.stringify(result.final_answer));
  } else {
    printError(`Failed to resolve after ${result.rounds} round(s)`);
    if (result.error) {
      printInfo('Error:', result.error);
    }
  }

  if (result.answers.length > 0) {
    console.log('');
    console.log('Individual answers:');
    for (const a of result.answers) {
      console.log(`  • ${a.participant_id}: ${JSON.stringify(a.answer)}`);
    }
  }
}

async function cmdAsk(args: string[]): Promise<void> {
  const roomId = args[0];
  if (!roomId) {
    printError('room-id required');
    process.exit(1);
  }

  const question = args.slice(1).join(' ');
  if (!question) {
    printError('question required');
    process.exit(1);
  }

  const orchestratorId = `orch-${Math.random().toString(36).slice(2, 8)}`;

  const msg = await broadcast(
    {
      room_id: roomId,
      orchestrator_id: orchestratorId,
      data_dir: DATA_DIR,
      max_rounds: 1,
      timeout_ms: 30000,
    },
    {
      payload: { question },
    }
  );

  printSuccess(`Broadcasted message #${msg.seq}`);
  printInfo('Message ID:', msg.msg_id);
  printInfo('To:', msg.to);
  printInfo('Question:', question);
}

async function cmdCleanup(args: string[]): Promise<void> {
  const roomId = args[0];
  if (!roomId) {
    printError('room-id required');
    process.exit(1);
  }

  const cleaned = await cleanupStaleLocks(DATA_DIR, roomId);
  printSuccess(`Cleaned ${cleaned} stale locks`);
}

async function cmdStop(args: string[]): Promise<void> {
  const roomId = args[0];
  if (!roomId) {
    printError('room-id required');
    process.exit(1);
  }

  // Parse options
  let participantId: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--participant' || args[i] === '-p') {
      participantId = args[++i];
    }
  }

  if (participantId) {
    // Stop specific worker
    const pidData = await readPidFile(roomId, participantId);
    if (!pidData) {
      printError(`No running worker found for ${participantId}`);
      process.exit(1);
    }

    try {
      process.kill(pidData.pid, 'SIGTERM');
      await removePidFile(roomId, participantId);
      printSuccess(`Stopped worker ${participantId} (pid: ${pidData.pid})`);
    } catch {
      printError(`Failed to stop worker (pid: ${pidData.pid})`);
      process.exit(1);
    }
  } else {
    // Stop all workers for this room
    try {
      const entries = await fs.readdir(PID_DIR);
      const pidsForRoom = entries.filter(f => f.startsWith(`${roomId}-`));
      let stopped = 0;

      for (const pidFile of pidsForRoom) {
        const content = await fs.readFile(path.join(PID_DIR, pidFile), 'utf-8');
        const pidData = JSON.parse(content);
        const pidParticipantId = pidFile.slice(roomId.length + 1, -4); // Remove prefix and .pid

        try {
          process.kill(pidData.pid, 'SIGTERM');
          await removePidFile(roomId, pidParticipantId);
          stopped++;
        } catch {
          // Ignore failures
        }
      }

      printSuccess(`Stopped ${stopped} worker(s) for room ${roomId}`);
    } catch {
      console.log('No workers to stop');
    }
  }
}

async function cmdSmartRoom(roomId: string, args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand) {
    try {
      const manifest = await readManifest(DATA_DIR, roomId);
      const identity = await getOrCreateIdentity();
      const participantId = identity.participant_id;

      if (manifest.room.status !== 'OPEN' || await isWorkerRunning(roomId, participantId)) {
        await cmdStatus([roomId]);
        return;
      }

      await cmdWatch([roomId, '--background', '--alias', identity.alias ?? 'default']);
      return;
    } catch (err) {
      printError((err as Error).message);
      process.exit(1);
    }
  }

  switch (subcommand) {
    case 'join':
      await cmdJoin([roomId, ...args.slice(1)]);
      return;
    case 'watch':
      await cmdWatch([roomId, ...args.slice(1)]);
      return;
    case 'status':
      await cmdStatus([roomId]);
      return;
    case 'ask':
      await cmdAsk([roomId, ...args.slice(1)]);
      return;
    case 'resolve':
      await cmdResolve([roomId, ...args.slice(1)]);
      return;
    case 'stop':
      await cmdStop([roomId, ...args.slice(1)]);
      return;
    case 'cleanup':
      await cmdCleanup([roomId]);
      return;
    default:
      await cmdResolve([roomId, ...args]);
  }
}

// ============================================================================
// Main
// ============================================================================

function usage(): void {
  console.log(`
AgentBus CLI - Multi-agent orchestration system

Usage: agentbus <command> [args] [options]

Smart Usage:
  agentbus <question>                   Create room
  agentbus <room-id>                    Join + watch in background, or status if already active/closed
  agentbus <room-id> <question>         Resolve room with a question

Commands:
  create [question]                     Create a new room (auto-generates ID)
  join <room-id> [options]              Join a room as worker
  watch <room-id> [options]             Start a worker loop
  status <room-id>                      Show room status
  list [room-id]                        List all rooms or participants in room
  ask <room-id> <question>              Single broadcast, no resolve loop
  resolve <room-id> <question>          Broadcast and resolve with consensus
  cleanup <room-id>                     Clean stale locks
  stop <room-id> [options]              Stop background workers

Options:
  --alias, -a <name>                    Participant alias
  --model, -m <model>                   Model ID for worker
  --background, -b                      Run worker in background
  --participant, -p <id>                Specific participant for stop command

Examples:
  agentbus "What is 2+2?"
  agentbus room-abc123
  agentbus room-abc123 "What is 2+2?"
  agentbus create "What is 2+2?"
  agentbus join my-room --alias worker-1 --model gpt-4
  agentbus watch my-room --background
  agentbus resolve my-room "What is the capital of France?"
  agentbus list
  agentbus stop my-room

Data Directory:
  ${DATA_DIR}
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const restArgs = args.slice(1);

  if (!command) {
    usage();
    process.exit(1);
  }

  // Ensure data directory exists
  await fs.mkdir(DATA_DIR, { recursive: true });

  if (!['create', 'join', 'watch', 'watch-internal', 'status', 'list', 'resolve', 'ask', 'cleanup', 'stop', 'help', '--help', '-h'].includes(command)) {
    if (isRoomIdLike(command)) {
      await cmdSmartRoom(command, restArgs);
      return;
    }

    await cmdCreate(args);
    return;
  }

  switch (command) {
    case 'create':
      await cmdCreate(restArgs);
      break;
    case 'join':
      await cmdJoin(restArgs);
      break;
    case 'watch':
      await cmdWatch(restArgs);
      break;
    case 'watch-internal':
      // Internal command for background mode
      await cmdWatchInternal(restArgs);
      break;
    case 'status':
      await cmdStatus(restArgs);
      break;
    case 'list':
      await cmdList(restArgs);
      break;
    case 'resolve':
      await cmdResolve(restArgs);
      break;
    case 'ask':
      await cmdAsk(restArgs);
      break;
    case 'cleanup':
      await cmdCleanup(restArgs);
      break;
    case 'stop':
      await cmdStop(restArgs);
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      printError(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  printError(err.message);
  process.exit(1);
});
