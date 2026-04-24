import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RunSpec, RunState, ReviewResult } from '../orchestrator/types.js';
import { main } from '../orchestrator/index.js';
import { formatWatch } from '../orchestrator/watch-format.js';
import type { WatchData } from '../orchestrator/watch-loader.js';

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

  it('status surfaces human progress and handoff without opening transcripts', async () => {
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), makeSpec({
      goal: 'Surface request_human progress in status',
    }));
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), makeState({
      status: 'partial',
      next_action: {
        kind: 'request_human',
        reason: 'Need human approval for risky merge',
        task_ids: ['task-a'],
        instructions: 'Approve task-a before merge',
      },
      task_states: {
        'task-a': {
          task_id: 'task-a',
          status: 'review_failed',
          round: 1,
          changed_files: ['src/task-a.ts'],
          merged: false,
          worker_success: true,
          review_passed: false,
          retry_count: 1,
          last_error: 'Risky merge requires approval',
        },
      } as any,
    }));
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'loop-progress.json'), {
      run_id: RUN_ID,
      round: 1,
      phase: 'blocked',
      reason: 'Waiting for human approval',
      focus_task_id: 'task-a',
      focus_agent_id: 'task-a@run-cli-surface',
      focus_model: 'kimi-for-coding',
      updated_at: new Date().toISOString(),
    });

    const result = await runCli(['status', '--cwd', TMP_DIR, '--run-id', RUN_ID]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain('🧶 progress: request_human');
    expect(result.stdout).toContain('🧭 why: Approve task-a before merge');
    expect(result.stdout).toContain('📍 next: request_human: Need human approval for risky merge');
    expect(result.stdout).toContain('🤝 handoff: task-a | task-a@run-cli-surface | kimi-for-coding');
  });

  it('watch --once shows Authority section when review results contain degradation', async () => {
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), makeSpec({
      goal: 'Surface authority degradation in watch',
    }));
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), makeState({
      status: 'partial',
      final_summary: 'authority degraded to single reviewer',
    }));
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'result.json'), {
      plan: {
        id: 'plan-1',
        goal: 'Surface authority degradation in watch',
        cwd: TMP_DIR,
        tasks: [],
        execution_order: [],
        context_flow: {},
        created_at: new Date().toISOString(),
      },
      worker_results: [],
      review_results: [{
        taskId: 'task-a',
        final_stage: 'cross-review',
        passed: true,
        findings: [],
        iterations: 1,
        duration_ms: 1,
        authority: {
          source: 'authority-layer',
          mode: 'single',
          members: ['claude-sonnet-4-6'],
          reviewer_runtime_failures: [
            { model: 'kimi-k2.5', reason: 'bridge_unavailable' },
          ],
        },
      }],
      score_updates: [],
      total_duration_ms: 0,
      cost_estimate: { total_usd: 0, by_model: {} },
    });

    const result = await runCli(['watch', '--cwd', TMP_DIR, '--run-id', RUN_ID, '--once']);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('== Authority ==');
    expect(result.stdout).toContain('kimi-k2.5');
    expect(result.stdout).toContain('bridge_unavailable');
  });
});

function baseWatchData(overrides?: Partial<WatchData>): WatchData {
  return {
    run_id: 'run-cli-surface-001',
    status: 'executing',
    round: 2,
    max_rounds: 6,
    phase: 'executing',
    mode: { current_mode: 'execute-standard', escalated: false, escalation_history: [] },
    focus_task: 'task-a',
    focus_agent: 'worker-1',
    focus_summary: 'Implement auth middleware',
    latest_reason: 'execute: Dispatching tasks',
    steering: { is_paused: false, pending_count: 0, recent_actions: [] },
    provider: { total: 0, healthy: 0, degraded: 0, open: 0, probing: 0, any_unhealthy: false, details: [] },
    updated_at: '2026-04-11T10:00:00.000Z',
    artifacts_available: ['spec', 'state'],
    artifacts_missing: [],
    taskCues: [],
    ...overrides,
  };
}

describe('CLI conclusion-first surfaces', () => {
  describe('first-screen conclusions stable across states', () => {
    it('blocked state shows BLOCKED in first section', () => {
      const data = baseWatchData({ status: 'blocked', latest_reason: 'request_human: Need clarification' });
      const output = formatWatch(data);
      const firstBlock = output.split('\n\n')[1] || '';
      expect(firstBlock).toContain('BLOCKED');
    });

    it('paused state shows PAUSED in first section', () => {
      const data = baseWatchData({
        status: 'executing',
        steering: { is_paused: true, pending_count: 1, recent_actions: [] },
      });
      const output = formatWatch(data);
      const firstBlock = output.split('\n\n')[1] || '';
      expect(firstBlock).toContain('PAUSED');
    });

    it('done state shows DONE in first section', () => {
      const data = baseWatchData({ status: 'done' });
      const output = formatWatch(data);
      const firstBlock = output.split('\n\n')[1] || '';
      expect(firstBlock).toContain('DONE');
    });

    it('partial state shows PARTIAL in first section', () => {
      const data = baseWatchData({ status: 'partial' });
      const output = formatWatch(data);
      const firstBlock = output.split('\n\n')[1] || '';
      expect(firstBlock).toContain('PARTIAL');
    });

    it('running state shows focus in first section', () => {
      const data = baseWatchData();
      const output = formatWatch(data);
      const firstBlock = output.split('\n\n')[1] || '';
      expect(firstBlock).toContain('focus:');
    });
  });

  describe('authority degradation appears in high-priority area', () => {
    it('watch shows Authority section when degradation present', () => {
      const reviewResults: ReviewResult[] = [{
        taskId: 'task-a', final_stage: 'light', passed: true, findings: [],
        iterations: 1, duration_ms: 1,
        authority: {
          source: 'authority-layer', mode: 'single', members: ['model-a'],
          reviewer_runtime_failures: [
            { model: 'kimi-k2.5', reason: 'bridge_unavailable' },
          ],
        },
      }];
      const output = formatWatch(baseWatchData(), undefined, { reviewResults });
      expect(output).toContain('Authority');
      expect(output).toContain('kimi-k2.5');
      expect(output).toContain('bridge_unavailable');
    });
  });

  describe('provider visibility', () => {
    it('normal provider shows concise line', () => {
      const data = baseWatchData({
        provider: {
          total: 2, healthy: 2, degraded: 0, open: 0, probing: 0,
          any_unhealthy: false, details: [
            { provider: 'openai', breaker: 'healthy' },
            { provider: 'anthropic', breaker: 'healthy' },
          ],
        },
      });
      const output = formatWatch(data);
      expect(output).toContain('2 tracked, 2 healthy');
    });

    it('degraded provider shows detail with subtype', () => {
      const data = baseWatchData({
        provider: {
          total: 3, healthy: 2, degraded: 1, open: 0, probing: 0,
          any_unhealthy: true, details: [
            { provider: 'kimi', breaker: 'degraded', subtype: 'rate_limit' },
          ],
          summary_text: '3 total | 2 healthy | 1 degraded',
        },
      });
      const output = formatWatch(data);
      expect(output).toContain('degraded');
      expect(output).toContain('kimi');
    });

    it('no provider section when no data', () => {
      const output = formatWatch(baseWatchData());
      expect(output).not.toContain('Provider');
    });
  });

  describe('normal run not verbose', () => {
    it('healthy run has concise output', () => {
      const data = baseWatchData();
      const output = formatWatch(data);
      const lineCount = output.split('\n').length;
      expect(lineCount).toBeLessThan(25);
    });
  });
});

describe('CLI alias + latest-run ergonomics', () => {
  beforeEach(() => {
    resetDir();
  });

  afterEach(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });

  function setupRun(runId: string, cwd: string = TMP_DIR): void {
    writeJson(path.join(cwd, '.ai', 'runs', runId, 'spec.json'), makeSpec({ id: runId }));
    writeJson(path.join(cwd, '.ai', 'runs', runId, 'state.json'), makeState({ run_id: runId }));
  }

  describe('short aliases route to original commands', () => {
    it('hive s is equivalent to hive status', async () => {
      setupRun('run-alias-test');
      const sResult = await runCli(['s', '--cwd', TMP_DIR]);
      const statusResult = await runCli(['status', '--cwd', TMP_DIR]);
      expect(sResult.exitCode).toBe(statusResult.exitCode);
      expect(sResult.stdout).toContain('run-alias-test');
      expect(statusResult.stdout).toContain('run-alias-test');
    });

    it('hive c is equivalent to hive compact', async () => {
      setupRun('run-alias-compact');
      const cResult = await runCli(['c', '--cwd', TMP_DIR]);
      const compactResult = await runCli(['compact', '--cwd', TMP_DIR]);
      expect(cResult.exitCode).toBe(compactResult.exitCode);
      expect(cResult.stdout).toContain('# Hive Compact Packet');
      expect(compactResult.stdout).toContain('# Hive Compact Packet');
    });

    it('hive w --once is equivalent to hive watch --once', async () => {
      setupRun('run-alias-watch');
      const wResult = await runCli(['w', '--cwd', TMP_DIR, '--once']);
      const watchResult = await runCli(['watch', '--cwd', TMP_DIR, '--once']);
      expect(wResult.exitCode).toBe(watchResult.exitCode);
      expect(wResult.stdout).toContain('==');
      expect(watchResult.stdout).toContain('==');
    });

    it('hive r is equivalent to hive resume', async () => {
      setupRun('run-alias-resume');
      const rResult = await runCli(['r', '--cwd', TMP_DIR]);
      const resumeResult = await runCli(['resume', '--cwd', TMP_DIR]);
      expect(rResult.exitCode).toBe(resumeResult.exitCode);
      expect(rResult.stdout).toContain('run-alias-resume');
      expect(resumeResult.stdout).toContain('run-alias-resume');
    });

    it('hive ws is equivalent to hive workers', async () => {
      setupRun('run-alias-workers');
      const wsResult = await runCli(['ws', '--cwd', TMP_DIR]);
      const workersResult = await runCli(['workers', '--cwd', TMP_DIR]);
      expect(wsResult.exitCode).toBe(workersResult.exitCode);
    });
  });

  describe('latest-run default fallback', () => {
    it('hive s without --run-id shows latest run', async () => {
      setupRun('run-oldest');
      setupRun('run-newest');
      const result = await runCli(['s', '--cwd', TMP_DIR]);
      expect(result.stdout).toContain('run-newest');
    });

    it('hive c without --run-id uses latest run', async () => {
      setupRun('run-oldest-compact');
      setupRun('run-newest-compact');
      const result = await runCli(['c', '--cwd', TMP_DIR]);
      expect(result.stdout).toContain('run-newest-compact');
    });

    it('hive score without --run-id uses latest run', async () => {
      setupRun('run-oldest-score');
      setupRun('run-newest-score');
      const scoreDir = path.join(TMP_DIR, '.ai', 'runs', 'run-newest-score');
      writeJson(path.join(scoreDir, 'score-history.json'), {
        run_id: 'run-newest-score',
        goal: 'score test',
        latest_score: 75,
        best_score: 80,
        rounds: [{ round: 1, action: 'dispatch', status: 'completed', score: 75, delta_from_previous: null, summary: 'test' }],
        updated_at: new Date().toISOString(),
      });
      const result = await runCli(['score', '--cwd', TMP_DIR]);
      expect(result.stdout).toContain('run-newest-score');
    });
  });

  describe('missing run error message', () => {
    it('hive s with no runs shows clear error', async () => {
      const result = await runCli(['s', '--cwd', TMP_DIR]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('no run found');
    });

    it('hive c with no runs falls back to workspace packet', async () => {
      const result = await runCli(['c', '--cwd', TMP_DIR]);
      // compact gracefully falls back to workspace packet, no run required
      expect(result.stdout).toContain('# Hive Workspace Restore Card');
    });

    it('hive score with no runs shows clear error', async () => {
      const result = await runCli(['score', '--cwd', TMP_DIR]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('no run');
    });
  });

  describe('short command stability', () => {
    it('hive s works on a run with minimal artifacts', async () => {
      setupRun('run-minimal');
      const result = await runCli(['s', '--cwd', TMP_DIR]);
      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toContain('run-minimal');
    });

    it('hive r --execute works without explicit --run-id', async () => {
      setupRun('run-execute-test');
      const result = await runCli(['r', '--cwd', TMP_DIR, '--execute']);
      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toContain('run-execute-test');
    });

    it('hive help shows quick path', async () => {
      const result = await runCli(['help']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hive s');
      expect(result.stdout).toContain('hive w --once');
      expect(result.stdout).toContain('hive c');
      expect(result.stdout).toContain('hive r --execute');
    });

    it('no args shows quick path', async () => {
      const result = await runCli([]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('hive s');
      expect(result.stdout).toContain('hive w --once');
      expect(result.stdout).toContain('hive c');
      expect(result.stdout).toContain('hive r --execute');
    });
  });

  describe('doctor surface', () => {
    it('hive doctor shows MMS and config diagnostics', async () => {
      const homeDir = path.join(TMP_DIR, 'home');
      const routesPath = path.join(homeDir, '.config', 'mms', 'model-routes.json');
      fs.mkdirSync(path.dirname(routesPath), { recursive: true });
      writeJson(routesPath, {
        _meta: { generated_at: new Date().toISOString(), generator: 'test' },
        routes: {
          'gpt-5.4': {
            anthropic_base_url: 'http://82.156.121.141:4001',
            api_key: 'primary-key',
            provider_id: 'xin',
            priority: 100,
            role: 'auto',
          },
        },
      });
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        status: 200,
        ok: true,
      } as any);
      vi.stubEnv('HOME', homeDir);
      vi.stubEnv('USER', 'cli-surface-user');
      vi.stubEnv('LOGNAME', 'cli-surface-user');
      vi.stubEnv('MMS_ROUTES_PATH', routesPath);

      const result = await runCli(['doctor', '--cwd', TMP_DIR, '--model', 'gpt-5.4']);

      expect(result.exitCode).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('== Hive Doctor ==');
      expect(result.stdout).toContain('== MMS ==');
      expect(result.stdout).toContain('== Config Layers ==');
      expect(result.stdout).toContain('gpt-5.4');

      fetchMock.mockRestore();
      vi.unstubAllEnvs();
    });

    it('hive doctor tells user to run mms when model-routes.json is missing', async () => {
      const homeDir = path.join(TMP_DIR, 'home-missing-mms');
      const routesPath = path.join(homeDir, '.config', 'mms', 'model-routes.json');
      vi.stubEnv('HOME', homeDir);
      vi.stubEnv('USER', 'cli-surface-user');
      vi.stubEnv('LOGNAME', 'cli-surface-user');
      vi.stubEnv('MMS_ROUTES_PATH', routesPath);

      const result = await runCli(['doctor', '--cwd', TMP_DIR, '--model', 'gpt-5.4']);

      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toContain(`未找到 ${routesPath}`);
      expect(result.stdout).toContain('先执行 `mms` 刷新 model-routes');

      vi.unstubAllEnvs();
    });

    it('hive doctor shows auto policy and web hint when MMS exists but hive mapping is empty', async () => {
      const homeDir = path.join(TMP_DIR, 'home-auto-policy');
      const routesPath = path.join(homeDir, '.config', 'mms', 'model-routes.json');
      fs.mkdirSync(path.dirname(routesPath), { recursive: true });
      writeJson(routesPath, {
        version: 1,
        generated_at: new Date().toISOString(),
        routes: {
          'gpt-5.4': {
            primary: {
              anthropic_base_url: 'http://82.156.121.141:4001',
              openai_base_url: 'http://82.156.121.141:4001/openai',
              api_key: 'primary-key',
              provider_id: 'xin',
            },
          },
        },
      });
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        status: 200,
        ok: true,
      } as any);
      vi.stubEnv('HOME', homeDir);
      vi.stubEnv('USER', 'cli-surface-user');
      vi.stubEnv('LOGNAME', 'cli-surface-user');
      vi.stubEnv('MMS_ROUTES_PATH', routesPath);

      const result = await runCli(['doctor', '--cwd', TMP_DIR, '--model', 'gpt-5.4']);

      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toContain('policy=auto [MMS primary]');

      fetchMock.mockRestore();
      vi.unstubAllEnvs();
    });

    it('hive doctor explains that GPT OpenAI bridge failed when chat/completions returns 404', async () => {
      const homeDir = path.join(TMP_DIR, 'home-gpt-404');
      const routesPath = path.join(homeDir, '.config', 'mms', 'model-routes.json');
      fs.mkdirSync(path.dirname(routesPath), { recursive: true });
      writeJson(routesPath, {
        version: 1,
        generated_at: new Date().toISOString(),
        routes: {
          'gpt-5.4': {
            primary: {
              anthropic_base_url: 'https://relay.example.com',
              openai_base_url: 'https://relay.example.com/openai',
              api_key: 'primary-key',
              provider_id: 'companycrsopenai',
            },
          },
        },
      });
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        status: 404,
        ok: false,
      } as any);
      vi.stubEnv('HOME', homeDir);
      vi.stubEnv('USER', 'cli-surface-user');
      vi.stubEnv('LOGNAME', 'cli-surface-user');
      vi.stubEnv('MMS_ROUTES_PATH', routesPath);

      const result = await runCli(['doctor', '--cwd', TMP_DIR, '--model', 'gpt-5.4']);

      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toContain('HTTP 404');
      expect(result.stdout).toContain('OpenAI bridge');
      expect(result.stdout).toContain('chat/completions 本身不可用');

      fetchMock.mockRestore();
      vi.unstubAllEnvs();
    });

    it('hive doctor retries transient timeout before marking model unhealthy', async () => {
      const homeDir = path.join(TMP_DIR, 'home-doctor-retry');
      const routesPath = path.join(homeDir, '.config', 'mms', 'model-routes.json');
      fs.mkdirSync(path.dirname(routesPath), { recursive: true });
      writeJson(routesPath, {
        version: 1,
        generated_at: new Date().toISOString(),
        routes: {
          'glm-5': {
            primary: {
              anthropic_base_url: 'http://127.0.0.1:4001',
              openai_base_url: 'http://127.0.0.1:4001',
              api_key: 'primary-key',
              provider_id: 'newapi-personal-tokyo',
            },
          },
        },
      });
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
        } as any);
      vi.stubEnv('HOME', homeDir);
      vi.stubEnv('USER', 'cli-surface-user');
      vi.stubEnv('LOGNAME', 'cli-surface-user');
      vi.stubEnv('MMS_ROUTES_PATH', routesPath);

      const result = await runCli(['doctor', '--cwd', TMP_DIR, '--model', 'glm-5']);

      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toContain('glm-5: OK');
      expect(result.stdout).not.toContain('glm-5: TIMEOUT');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockRestore();
      vi.unstubAllEnvs();
    });

    it('hive doctor downgrades repeated timeout to WARN instead of ERROR', async () => {
      const homeDir = path.join(TMP_DIR, 'home-doctor-timeout-warn');
      const routesPath = path.join(homeDir, '.config', 'mms', 'model-routes.json');
      fs.mkdirSync(path.dirname(routesPath), { recursive: true });
      writeJson(routesPath, {
        version: 1,
        generated_at: new Date().toISOString(),
        routes: {
          'glm-5': {
            primary: {
              anthropic_base_url: 'http://127.0.0.1:4001',
              openai_base_url: 'http://127.0.0.1:4001',
              api_key: 'primary-key',
              provider_id: 'newapi-personal-tokyo',
            },
          },
        },
      });
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('The operation was aborted due to timeout'));
      vi.stubEnv('HOME', homeDir);
      vi.stubEnv('USER', 'cli-surface-user');
      vi.stubEnv('LOGNAME', 'cli-surface-user');
      vi.stubEnv('MMS_ROUTES_PATH', routesPath);

      const result = await runCli(['doctor', '--cwd', TMP_DIR, '--model', 'glm-5']);

      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toContain('glm-5: WARN');
      expect(result.stdout).not.toContain('glm-5: ERROR');
      expect(fetchMock).toHaveBeenCalledTimes(3);

      fetchMock.mockRestore();
      vi.unstubAllEnvs();
    });
  });
});
