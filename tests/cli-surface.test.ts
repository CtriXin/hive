import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RunSpec, RunState } from '../orchestrator/types.js';
import { main } from '../orchestrator/index.js';

const TMP_DIR = '/tmp/hive-cli-surface-test';
const RUN_ID = 'run-cli-surface';

function resetDir(): void {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function makeSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    id: RUN_ID,
    goal: 'Validate CLI host-visible surfaces',
    cwd: TMP_DIR,
    mode: 'safe',
    done_conditions: [],
    max_rounds: 1,
    max_worker_retries: 1,
    max_replans: 1,
    allow_auto_merge: true,
    stop_on_high_risk: false,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: RUN_ID,
    status: 'partial',
    round: 1,
    completed_task_ids: [],
    failed_task_ids: ['task-a'],
    retry_counts: {},
    replan_count: 0,
    verification_results: [],
    next_action: {
      kind: 'request_human',
      reason: 'Max rounds reached (1) while pending repair_task: 1 task(s) still need attention.',
      task_ids: ['task-a'],
    },
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode?: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const argvBefore = [...process.argv];
  const envBefore = process.env.HIVE_NO_UPDATE_CHECK;

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    stdout.push(parts.map(String).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__EXIT__${code ?? 0}`);
  }) as never);

  process.env.HIVE_NO_UPDATE_CHECK = '1';
  process.argv = ['node', 'orchestrator/index.ts', ...args];

  let exitCode: number | undefined;
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('__EXIT__')) {
      exitCode = Number(message.replace('__EXIT__', ''));
    } else {
      throw error;
    }
  } finally {
    process.argv = argvBefore;
    if (envBefore === undefined) {
      delete process.env.HIVE_NO_UPDATE_CHECK;
    } else {
      process.env.HIVE_NO_UPDATE_CHECK = envBefore;
    }
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return {
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    exitCode,
  };
}

describe('CLI host-visible surfaces', () => {
  beforeEach(() => {
    resetDir();
  });

  afterEach(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });

  it('shell shows pending repair context for scope_violation blockers', async () => {
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), makeSpec({
      goal: 'Preserve repair context in shell',
    }));
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), makeState({
      task_states: {
        'task-a': {
          task_id: 'task-a',
          status: 'merge_blocked',
          round: 1,
          changed_files: ['src/task-a.ts', 'src/unexpected.ts'],
          merged: false,
          worker_success: true,
          review_passed: true,
          last_error: 'Merge blocked (scope_violation): Changed files outside estimated_files: src/unexpected.ts',
        },
      },
      final_summary: '1 task blocked before merge',
      next_action: {
        kind: 'request_human',
        reason: 'Max rounds reached (1) while pending repair_task: 1 task(s) changed files outside estimated_files and were blocked before merge.',
        task_ids: ['task-a'],
      },
    }));

    const result = await runCli(['shell', '--cwd', TMP_DIR, '--run-id', RUN_ID]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('== HiveShell ==');
    expect(result.stdout).toContain('- next: request_human - Max rounds reached (1) while pending repair_task');
    expect(result.stdout).toContain('== Merge Blockers ==');
    expect(result.stdout).toContain('Merge blocked (scope_violation): Changed files outside estimated_files: src/unexpected.ts');
  });

  it('compact then restore preserves overlap_conflict blocker context', async () => {
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), makeSpec({
      goal: 'Preserve overlap blockers in restore',
    }));
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), makeState({
      task_states: {
        'task-b': {
          task_id: 'task-b',
          status: 'merge_blocked',
          round: 1,
          changed_files: ['src/shared.ts'],
          merged: false,
          worker_success: true,
          review_passed: true,
          last_error: 'Merge blocked (overlap_conflict): Overlapping changed file src/shared.ts also touched by: task-c',
        },
      },
      final_summary: '1 task blocked by overlap',
      next_action: {
        kind: 'request_human',
        reason: 'Max rounds reached (1) while pending request_human: 1 task(s) were blocked during auto-merge: task-b=overlap_conflict',
        task_ids: ['task-b'],
      },
    }));

    const compact = await runCli(['compact', '--cwd', TMP_DIR, '--run-id', RUN_ID]);
    const restore = await runCli(['restore', '--cwd', TMP_DIR]);

    expect(compact.exitCode).toBeUndefined();
    expect(compact.stdout).toContain('# Hive Compact Packet');
    expect(compact.stdout).toContain('Merge blocked (overlap_conflict): Overlapping changed file src/shared.ts also touched by: task-c');
    expect(compact.stdout).toContain('🧾 latest run: run-cli-surface');

    expect(restore.exitCode).toBeUndefined();
    expect(restore.stderr).toBe('');
    expect(restore.stdout).toContain('Run: run-cli-surface');
    expect(restore.stdout).toContain('Next action: request_human: Max rounds reached (1) while pending request_human');
    expect(restore.stdout).toContain('- task-b: Merge blocked (overlap_conflict): Overlapping changed file src/shared.ts also touched by: task-c');
    expect(restore.stdout).toContain('🧾 latest run: run-cli-surface');
  });

  it('workspace fallback compact can feed restore without a run snapshot', async () => {
    const planDir = path.join(TMP_DIR, '.ai', 'plan');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(
      path.join(planDir, 'current.md'),
      [
        '# Current Plan: Workspace Only',
        '## Current Goal',
        '- Validate workspace restore fallback',
        '',
        '## Current Stage',
        '- No Hive run exists yet',
        '',
        '## Highest Priority Next',
        '- Keep restore usable from workspace packet',
      ].join('\n'),
      'utf-8',
    );

    const compact = await runCli(['compact', '--cwd', TMP_DIR]);
    const restore = await runCli(['restore', '--cwd', TMP_DIR]);

    expect(compact.exitCode).toBeUndefined();
    expect(compact.stdout).toContain('# Hive Workspace Restore Card');
    expect(compact.stdout).toContain('Validate workspace restore fallback');
    expect(compact.stdout).not.toContain('🧾 latest run:');

    expect(restore.exitCode).toBeUndefined();
    expect(restore.stderr).toBe('');
    expect(restore.stdout).toContain('Use this workspace restore card as the smallest resume surface.');
    expect(restore.stdout).toContain('Validate workspace restore fallback');
    expect(restore.stdout).not.toContain('🧾 latest run:');
  });
});
