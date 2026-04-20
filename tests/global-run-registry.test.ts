import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';

const REGISTRY_PATH = '/tmp/hive-global-run-registry-test.json';
const PROJECT_A = '/tmp/hive-global-run-registry-a';
const PROJECT_B = '/tmp/hive-global-run-registry-b';

function resetDirs(): void {
  fs.rmSync(REGISTRY_PATH, { force: true });
  fs.rmSync(PROJECT_A, { recursive: true, force: true });
  fs.rmSync(PROJECT_B, { recursive: true, force: true });
  fs.mkdirSync(PROJECT_A, { recursive: true });
  fs.mkdirSync(PROJECT_B, { recursive: true });
}

function spawnRegistryWriter(cwd: string, runId: string, updatedAt: string, delayMs = 0): Promise<void> {
  const tsxBin = path.resolve(process.cwd(), 'node_modules', '.bin', 'tsx');
  const moduleUrl = pathToFileURL(path.resolve(process.cwd(), 'orchestrator', 'global-run-registry.ts')).href;
  const script = `
    import { trackRunState } from ${JSON.stringify(moduleUrl)};
    trackRunState(process.env.HIVE_TEST_CWD || '', {
      run_id: process.env.HIVE_TEST_RUN_ID || '',
      status: 'running',
      round: 1,
      task_states: {},
      next_action: { kind: 'dispatch', reason: 'continue' },
      verification_results: [],
      steering: { paused: false, pending_actions: [], applied_actions: [] },
      updated_at: process.env.HIVE_TEST_UPDATED_AT || '',
    });
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, ['--eval', script], {
      env: {
        ...process.env,
        HIVE_WEB_REGISTRY_PATH: REGISTRY_PATH,
        HIVE_WEB_REGISTRY_TEST_DELAY_MS: String(delayMs),
        HIVE_TEST_CWD: cwd,
        HIVE_TEST_RUN_ID: runId,
        HIVE_TEST_UPDATED_AT: updatedAt,
        VITEST: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `registry writer exited with code ${code}`));
    });
  });
}

describe('global-run-registry', () => {
  beforeEach(() => {
    resetDirs();
    vi.stubEnv('HIVE_WEB_REGISTRY_PATH', REGISTRY_PATH);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('preserves concurrent writes from different processes', async () => {
    const writerA = spawnRegistryWriter(PROJECT_A, 'run-a', '2026-04-20T10:00:00.000Z', 250);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const writerB = spawnRegistryWriter(PROJECT_B, 'run-b', '2026-04-20T10:00:01.000Z');

    await Promise.all([writerA, writerB]);

    const stored = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8')) as {
      runs: Array<{ cwd: string; run_id: string }>;
    };

    expect(
      stored.runs
        .map((run) => `${run.cwd}:${run.run_id}`)
        .sort(),
    ).toEqual([
      `${PROJECT_A}:run-a`,
      `${PROJECT_B}:run-b`,
    ]);
  });
});
