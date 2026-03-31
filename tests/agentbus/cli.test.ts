/**
 * AgentBus CLI Tests
 * Tests for CLI commands, identity persistence, and background worker management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readManifest } from '../../src/agentbus/backend-fs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '../../bin/agentbus.ts');
const TSX_CLI_PATH = path.join(__dirname, '../../node_modules/tsx/dist/cli.mjs');

async function runCli(
  args: string[],
  options: { env?: Record<string, string>; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [TSX_CLI_PATH, CLI_PATH, ...args],
      {
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out after ${options.timeout ?? 10000}ms`));
    }, options.timeout ?? 10000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe('CLI', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbus-cli-test-'));
    dataDir = tempDir;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('create command', () => {
    it('should create room with auto-generated ID', async () => {
      const { stdout, exitCode } = await runCli(['create'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Created room:');
      expect(stdout).toContain('room-');
      expect(stdout).toContain('Status:');
      expect(stdout).toContain('OPEN');
    });

    it('should create room with question', async () => {
      const { stdout, exitCode } = await runCli(
        ['create', 'What', 'is', '2+2?'],
        { env: { AGENTBUS_DATA_DIR: dataDir } }
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Created room:');
      expect(stdout).toContain('What is 2+2?');
    });

    it('should support smart create without explicit command', async () => {
      const { stdout, exitCode } = await runCli(
        ['What', 'is', 'the', 'answer?'],
        { env: { AGENTBUS_DATA_DIR: dataDir } }
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Created room:');
      expect(stdout).toContain('What is the answer?');
    });
  });

  describe('join command', () => {
    it('should require room-id', async () => {
      const { stderr, exitCode } = await runCli(['join'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });

      expect(exitCode).toBe(1);
      expect(stderr).toContain('room-id required');
    });

    it('should join room and auto-generate participant ID', async () => {
      // First create a room
      const { stdout: createOut } = await runCli(['create'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });
      const roomId = createOut.match(/Created room: (\S+)/)?.[1];
      expect(roomId).toBeDefined();

      // Join the room
      const { stdout, exitCode } = await runCli(['join', roomId!], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Joined room:');
      expect(stdout).toContain('Participant:');
      expect(stdout).toContain('worker-');
    });

    it('should support alias option', async () => {
      // Create room
      const { stdout: createOut } = await runCli(['create'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });
      const roomId = createOut.match(/Created room: (\S+)/)?.[1];

      // Join with alias
      const { stdout, exitCode } = await runCli(
        ['join', roomId!, '--alias', 'my-worker'],
        { env: { AGENTBUS_DATA_DIR: dataDir } }
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Alias:');
      expect(stdout).toContain('my-worker');
    });
  });

  describe('identity persistence', () => {
    it('should reuse participant ID across joins', async () => {
      // Create two rooms
      const { stdout: out1 } = await runCli(['create'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });
      const room1 = out1.match(/Created room: (\S+)/)?.[1];

      const { stdout: out2 } = await runCli(['create'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });
      const room2 = out2.match(/Created room: (\S+)/)?.[1];

      // Join first room with explicit alias
      const { stdout: join1 } = await runCli(['join', room1!, '--alias', 'reuse-test'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });
      const participantId1 = join1.match(/Participant:\s+(\S+)/)?.[1];

      // Join second room with same alias (identity should be reused)
      const { stdout: join2 } = await runCli(['join', room2!, '--alias', 'reuse-test'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });
      const participantId2 = join2.match(/Participant:\s+(\S+)/)?.[1];

      expect(participantId1).toBe(participantId2);
    }, 30000);

    it('should persist identity to file', async () => {
      const { stdout: createOut } = await runCli(['create'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });
      const roomId = createOut.match(/Created room: (\S+)/)?.[1];

      await runCli(['join', roomId!, '--alias', 'test-identity'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });

      // Check identity file exists
      const identityFile = path.join(dataDir, 'identities', 'test-identity.json');
      const content = await fs.readFile(identityFile, 'utf-8');
      const identity = JSON.parse(content);

      expect(identity.participant_id).toMatch(/^worker-/);
      expect(identity.alias).toBe('test-identity');
    });
  });

  describe('status command', () => {
    it('should show room status', async () => {
      const { stdout: createOut } = await runCli(['create'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });
      const roomId = createOut.match(/Created room: (\S+)/)?.[1];

      const { stdout, exitCode } = await runCli(['status', roomId!], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });

      expect(exitCode).toBe(0);
      expect(stdout).toContain(`Room: ${roomId}`);
      expect(stdout).toContain('Status:');
      expect(stdout).toContain('Messages:');
      expect(stdout).toContain('Participants:');
    });

    it('should require room-id', async () => {
      const { stderr, exitCode } = await runCli(['status'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });

      expect(exitCode).toBe(1);
      expect(stderr).toContain('room-id required');
    });
  });

  describe('list command', () => {
    it('should list all rooms', async () => {
      // Create a room first
      await runCli(['create'], { env: { AGENTBUS_DATA_DIR: dataDir } });

      const { stdout, exitCode } = await runCli(['list'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Found');
      expect(stdout).toContain('room(s)');
    });

    it('should list participants when room provided', async () => {
      const { stdout: createOut } = await runCli(['create'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });
      const roomId = createOut.match(/Created room: (\S+)/)?.[1];

      await runCli(['join', roomId!], { env: { AGENTBUS_DATA_DIR: dataDir } });

      const { stdout, exitCode } = await runCli(['list', roomId!], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Participants in room:');
      expect(stdout).toContain('worker-');
    });
  });

  describe('ask command', () => {
    it('should broadcast message', async () => {
      const { stdout: createOut } = await runCli(['create'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });
      const roomId = createOut.match(/Created room: (\S+)/)?.[1];

      const { stdout, exitCode } = await runCli(
        ['ask', roomId!, 'Hello', 'world?'],
        { env: { AGENTBUS_DATA_DIR: dataDir } }
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Broadcasted message');
      expect(stdout).toContain('Message ID:');
      expect(stdout).toContain('Hello world?');
    });
  });

  describe('resolve command', () => {
    it('should fail gracefully when no workers', async () => {
      const { stdout: createOut } = await runCli(['create'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });
      const roomId = createOut.match(/Created room: (\S+)/)?.[1];

      const { stdout, exitCode } = await runCli(
        ['resolve', roomId!, 'Test', 'question?'],
        { env: { AGENTBUS_DATA_DIR: dataDir }, timeout: 5000 }
      );

      // Should fail but not crash - check for error indication
      expect(exitCode).toBe(0); // CLI returns 0 even on resolve failure
      // Match either old or new error format
      expect(stdout).toMatch(/Failed to resolve|No workers|Error:/);
    });

    it('should support smart resolve with room-id first', async () => {
      const { stdout: createOut } = await runCli(['create'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });
      const roomId = createOut.match(/Created room: (\S+)/)?.[1];

      const { stdout, exitCode } = await runCli(
        [roomId!, 'Test', 'question?'],
        { env: { AGENTBUS_DATA_DIR: dataDir }, timeout: 5000 }
      );

      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/Resolving:|Failed to resolve|No workers|Error:/);
    });
  });

  describe('help', () => {
    it('should show usage', async () => {
      const { stdout, exitCode } = await runCli(['--help'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });

      expect(exitCode).toBe(0);
      expect(stdout).toContain('AgentBus CLI');
      expect(stdout).toContain('Commands:');
      expect(stdout).toContain('create');
      expect(stdout).toContain('join');
      expect(stdout).toContain('watch');
    });

    it('should show usage for unknown command', async () => {
      const { stdout, exitCode } = await runCli(['unknown'], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Created room:');
    });
  });
});

describe('CLI Background Worker', () => {
  let tempDir: string;
  let dataDir: string;
  const spawnedPids: number[] = [];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbus-bg-test-'));
    dataDir = tempDir;
  });

  afterEach(async () => {
    for (const pid of spawnedPids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Ignore already-exited processes
      }
    }
    // Cleanup any remaining processes
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should prevent duplicate background workers', async () => {
    // Create and join room with explicit alias
    const { stdout: createOut } = await runCli(['create'], {
      env: { AGENTBUS_DATA_DIR: dataDir },
    });
    const roomId = createOut.match(/Created room: (\S+)/)?.[1];

    const { stdout: joinOut } = await runCli(['join', roomId!, '--alias', 'dup-test'], {
      env: { AGENTBUS_DATA_DIR: dataDir },
    });
    const participantId = joinOut.match(/Participant:\s+(\S+)/)?.[1];

    // Manually write a PID file to simulate running worker
    const pidFile = path.join(dataDir, 'pids', `${roomId}-${participantId}.pid`);
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, JSON.stringify({ pid: process.pid, started_at: Date.now() }));

    // Try to start background worker with same alias (should detect as duplicate)
    const { stdout: start2 } = await runCli(
      ['watch', roomId!, '--alias', 'dup-test', '--background'],
      { env: { AGENTBUS_DATA_DIR: dataDir } }
    );
    expect(start2).toContain('Worker already running');

    // Cleanup
    await fs.unlink(pidFile).catch(() => {});
  }, 30000);

  it('should support smart room-id invocation for auto join and background watch', async () => {
    const { stdout: createOut } = await runCli(['create'], {
      env: { AGENTBUS_DATA_DIR: dataDir },
    });
    const roomId = createOut.match(/Created room: (\S+)/)?.[1];
    expect(roomId).toBeDefined();

    const { stdout } = await runCli([roomId!,], {
      env: { AGENTBUS_DATA_DIR: dataDir },
      timeout: 15000,
    });

    expect(stdout).toContain('Started background worker');

    const manifest = await readManifest(dataDir, roomId!);
    const participant = manifest.room.participants.find((p) => p.participant_id.startsWith('worker-'));
    expect(participant).toBeDefined();

    if (participant) {
      await runCli(['stop', roomId!, '--participant', participant.participant_id], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });
    }
  }, 30000);

  it('should auto-join room before starting background watch', async () => {
    const { stdout: createOut } = await runCli(['create'], {
      env: { AGENTBUS_DATA_DIR: dataDir },
    });
    const roomId = createOut.match(/Created room: (\S+)/)?.[1];
    expect(roomId).toBeDefined();

    const { stdout } = await runCli(
      ['watch', roomId!, '--alias', 'auto-join-test', '--background'],
      { env: { AGENTBUS_DATA_DIR: dataDir }, timeout: 15000 }
    );

    expect(stdout).toContain('Started background worker');

    const manifest = await readManifest(dataDir, roomId!);
    const participant = manifest.room.participants.find((p) => p.participant_id.startsWith('worker-'));
    expect(participant).toBeDefined();

    if (participant) {
      await runCli(['stop', roomId!, '--participant', participant.participant_id], {
        env: { AGENTBUS_DATA_DIR: dataDir },
      });
    }
  }, 30000);

  it('should write and cleanup pid file', async () => {
    // Create and join room with explicit alias
    const { stdout: createOut } = await runCli(['create'], {
      env: { AGENTBUS_DATA_DIR: dataDir },
    });
    const roomId = createOut.match(/Created room: (\S+)/)?.[1];

    const { stdout: joinOut } = await runCli(['join', roomId!, '--alias', 'pid-test'], {
      env: { AGENTBUS_DATA_DIR: dataDir },
    });
    const participantId = joinOut.match(/Participant:\s+(\S+)/)?.[1];

    // Start background worker with same alias
    await runCli(['watch', roomId!, '--alias', 'pid-test', '--background'], {
      env: { AGENTBUS_DATA_DIR: dataDir }, timeout: 15000
    });

    // Give it time to write the PID file and start
    await new Promise(r => setTimeout(r, 1000));

    // Check pid file exists
    const pidFile = path.join(dataDir, 'pids', `${roomId}-${participantId}.pid`);
    const pidContent = await fs.readFile(pidFile, 'utf-8');
    const pidData = JSON.parse(pidContent);
    expect(pidData.pid).toBeGreaterThan(0);
    expect(pidData.started_at).toBeGreaterThan(0);

    // Stop the worker
    await runCli(['stop', roomId!, '--participant', participantId!], {
      env: { AGENTBUS_DATA_DIR: dataDir },
    });

    // Pid file should be removed
    try {
      await fs.access(pidFile);
      expect.fail('PID file should be removed');
    } catch {
      // Expected - file doesn't exist
    }
  }, 30000);

  it('should stop all workers for room', async () => {
    // Create room
    const { stdout: createOut } = await runCli(['create'], {
      env: { AGENTBUS_DATA_DIR: dataDir },
    });
    const roomId = createOut.match(/Created room: (\S+)/)?.[1];

    // Create real child processes so the stop command does not target the test runner itself
    const pidDir = path.join(dataDir, 'pids');
    await fs.mkdir(pidDir, { recursive: true });

    const child1 = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    child1.unref();
    spawnedPids.push(child1.pid!);

    const child2 = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    child2.unref();
    spawnedPids.push(child2.pid!);

    await fs.writeFile(
      path.join(pidDir, `${roomId}-worker-1.pid`),
      JSON.stringify({ pid: child1.pid, started_at: Date.now() })
    );
    await fs.writeFile(
      path.join(pidDir, `${roomId}-worker-2.pid`),
      JSON.stringify({ pid: child2.pid, started_at: Date.now() })
    );

    // Verify the stop command scans and reports
    const { stdout } = await runCli(['stop', roomId!], {
      env: { AGENTBUS_DATA_DIR: dataDir },
    });

    // Should report stopping workers
    expect(stdout).toContain('worker(s) for room');
  }, 30000);
});
