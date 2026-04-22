import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RunSpec, RunState, SteeringActionType } from '../orchestrator/types.js';
import {
  listWebActiveRuns,
  listWebModelRouting,
  listWebProjects,
  listWebRuns,
  loadWebDashboardSnapshot,
  resetWebConfigPolicy,
  submitWebSteeringAction,
} from '../orchestrator/web-dashboard.js';
import { createDashboardServer, startDashboardServer } from '../orchestrator/web-dashboard-server.js';
import { invalidateCache as invalidateMmsCache } from '../orchestrator/mms-routes-loader.js';

const TMP_DIR = '/tmp/hive-web-dashboard-test';
const OTHER_TMP_DIR = '/tmp/hive-web-dashboard-test-other';
const GLOBAL_HOME = '/tmp/hive-web-dashboard-home';
const RUN_ID = 'run-web-test';
const REGISTRY_PATH = '/tmp/hive-web-dashboard-registry.json';

function resetDir(): void {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
  if (fs.existsSync(OTHER_TMP_DIR)) {
    fs.rmSync(OTHER_TMP_DIR, { recursive: true, force: true });
  }
  if (fs.existsSync(GLOBAL_HOME)) {
    fs.rmSync(GLOBAL_HOME, { recursive: true, force: true });
  }
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(OTHER_TMP_DIR, { recursive: true });
  fs.mkdirSync(path.join(GLOBAL_HOME, '.hive'), { recursive: true });
  fs.writeFileSync(path.join(GLOBAL_HOME, '.hive', 'config.json'), '{}', 'utf-8');
  if (fs.existsSync(REGISTRY_PATH)) {
    fs.rmSync(REGISTRY_PATH, { force: true });
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function writeMmsRoutes(routes: Record<string, unknown>): void {
  writeJson(path.join(GLOBAL_HOME, '.config', 'mms', 'model-routes.json'), {
    _meta: { generated_at: new Date().toISOString(), generator: 'test' },
    routes,
  });
  invalidateMmsCache();
}

function makeSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    id: RUN_ID,
    goal: 'Test web dashboard',
    cwd: TMP_DIR,
    mode: 'safe',
    done_conditions: [],
    max_rounds: 6,
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
    status: 'running',
    round: 2,
    task_states: {},
    next_action: { kind: 'dispatch', reason: 'continue' },
    verification_results: [],
    steering: { paused: false, pending_actions: [], applied_actions: [] },
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('web-dashboard adapter', () => {
  beforeEach(() => {
    resetDir();
    invalidateMmsCache();
    vi.restoreAllMocks();
    vi.stubEnv('HIVE_WEB_REGISTRY_PATH', REGISTRY_PATH);
    vi.stubEnv('HOME', GLOBAL_HOME);
    vi.stubEnv('USER', 'hive-web-test-user');
    vi.stubEnv('LOGNAME', 'hive-web-test-user');
    vi.stubEnv('MMS_ROUTES_PATH', path.join(GLOBAL_HOME, '.config', 'mms', 'model-routes.json'));
  });

  afterEach(() => {
    invalidateMmsCache();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('listWebRuns returns empty array when no runs exist', () => {
    const runs = listWebRuns(TMP_DIR);
    expect(runs).toEqual([]);
  });

  it('listWebRuns sorts runs by updated_at desc and marks latest', () => {
    const specA = makeSpec({ id: 'run-a', goal: 'A' });
    const stateA = makeState({ run_id: 'run-a', updated_at: '2026-04-10T10:00:00Z' });
    const specB = makeSpec({ id: 'run-b', goal: 'B' });
    const stateB = makeState({ run_id: 'run-b', updated_at: '2026-04-15T10:00:00Z' });

    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-a', 'spec.json'), specA);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-a', 'state.json'), stateA);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-b', 'spec.json'), specB);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-b', 'state.json'), stateB);

    const runs = listWebRuns(TMP_DIR);
    expect(runs.length).toBe(2);
    expect(runs[0].id).toBe('run-b');
    expect(runs[0].is_latest).toBe(true);
    expect(runs[1].id).toBe('run-a');
    expect(runs[1].is_latest).toBe(false);
  });

  it('listWebProjects falls back to current cwd when global registry is empty', () => {
    const projects = listWebProjects(TMP_DIR);
    expect(projects).toHaveLength(1);
    expect(projects[0].cwd).toBe(TMP_DIR);
    expect(projects[0].name).toBe(path.basename(TMP_DIR));
  });

  it('listWebActiveRuns only returns fresh active runs', () => {
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-fresh', 'spec.json'), makeSpec({ id: 'run-fresh', goal: 'Fresh active run' }));
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-fresh', 'state.json'), makeState({
      run_id: 'run-fresh',
      status: 'running',
      updated_at: new Date().toISOString(),
    }));
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-stale', 'spec.json'), makeSpec({ id: 'run-stale', goal: 'Stale active run' }));
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-stale', 'state.json'), makeState({
      run_id: 'run-stale',
      status: 'running',
      updated_at: '2026-04-01T00:00:00.000Z',
    }));

    const runs = listWebActiveRuns(TMP_DIR);
    expect(runs).toHaveLength(1);
    expect(runs[0].run_id).toBe('run-fresh');
    expect(runs[0].project.cwd).toBe(TMP_DIR);
  });

  it('listWebRuns includes worker-only runs', () => {
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'dispatch-only', 'worker-status.json'), {
      run_id: 'dispatch-only',
      plan_id: 'dispatch-only',
      updated_at: '2026-04-20T10:00:00Z',
      goal: 'Worker only dispatch',
      workers: [
        {
          task_id: 'task-a',
          status: 'running',
          assigned_model: 'kimi-k2.5',
          active_model: 'kimi-k2.5',
          task_description: 'Worker task',
        },
      ],
    });

    const runs = listWebRuns(TMP_DIR);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe('dispatch-only');
    expect(runs[0].source).toBe('worker');
    expect(runs[0].status).toBe('running');
    expect(runs[0].is_active).toBe(true);
  });

  it('loadWebDashboardSnapshot returns null when no runs exist', () => {
    const snapshot = loadWebDashboardSnapshot(TMP_DIR);
    expect(snapshot).toBeNull();
  });

  it('loadWebDashboardSnapshot loads latest run when runId omitted', () => {
    const spec = makeSpec({ id: 'run-latest', goal: 'Latest run' });
    const state = makeState({ run_id: 'run-latest', status: 'done' });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-latest', 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-latest', 'state.json'), state);

    const snapshot = loadWebDashboardSnapshot(TMP_DIR);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.runId).toBe('run-latest');
    expect(snapshot!.truth.status).toBe('done');
    expect(snapshot!.truth.goal).toBe('Latest run');
  });

  it('loadWebDashboardSnapshot loads specified run', () => {
    const specA = makeSpec({ id: 'run-a', goal: 'A' });
    const stateA = makeState({ run_id: 'run-a' });
    const specB = makeSpec({ id: 'run-b', goal: 'B' });
    const stateB = makeState({ run_id: 'run-b' });

    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-a', 'spec.json'), specA);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-a', 'state.json'), stateA);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-b', 'spec.json'), specB);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-b', 'state.json'), stateB);

    const snapshot = loadWebDashboardSnapshot(TMP_DIR, 'run-a');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.runId).toBe('run-a');
    expect(snapshot!.truth.goal).toBe('A');
  });

  it('loadWebDashboardSnapshot uses artifact updated_at instead of request time', () => {
    const spec = makeSpec({ id: 'run-updated-at', created_at: '2026-04-10T08:00:00.000Z' });
    const state = makeState({
      run_id: 'run-updated-at',
      updated_at: '2026-04-10T10:30:00.000Z',
    });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-updated-at', 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-updated-at', 'state.json'), state);

    const snapshot = loadWebDashboardSnapshot(TMP_DIR, 'run-updated-at');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.updated_at).toBe('2026-04-10T10:30:00.000Z');
  });

  it('listWebModelRouting exposes per-model channel choices for exact mapping', () => {
    writeMmsRoutes({
      'gpt-5.4': {
        anthropic_base_url: 'http://82.156.121.141:4001',
        api_key: 'primary-key',
        provider_id: 'xin',
        priority: 100,
        role: 'auto',
        fallback_routes: [
          {
            anthropic_base_url: 'http://127.0.0.1:18317/v1',
            api_key: 'cpa-key',
            provider_id: 'us-cpa-local-codex',
            priority: 90,
            role: 'fallback',
          },
        ],
      },
    });
    writeJson(path.join(GLOBAL_HOME, '.hive', 'config.json'), {
      model_channel_map: { 'gpt-5.4': 'cpa' },
    });

    const rows = listWebModelRouting(TMP_DIR);
    const row = rows.find((item) => item.model_id === 'gpt-5.4');
    expect(row).toBeTruthy();
    expect(row?.selection.mode).toBe('exact');
    expect(row?.selection.pattern).toBe('gpt-5.4');
    expect(row?.selection.selector).toBe('cpa');
    expect(row?.effective_provider_id).toBe('us-cpa-local-codex');
    expect(row?.available_channels.map((item) => item.provider_id)).toEqual(['xin', 'us-cpa-local-codex']);
    expect(row?.available_channels[0].route_role).toBe('main');
    expect(row?.available_channels[1].route_role).toBe('fallback');
  });

  it('listWebModelRouting marks wildcard mapping as inherited pattern', () => {
    writeMmsRoutes({
      'gpt-5.3': {
        anthropic_base_url: 'http://82.156.121.141:4001',
        api_key: 'primary-key',
        provider_id: 'xin',
        priority: 100,
        role: 'auto',
        fallback_routes: [
          {
            anthropic_base_url: 'http://127.0.0.1:18317/v1',
            api_key: 'cpa-key',
            provider_id: 'us-cpa-local-codex',
            priority: 90,
            role: 'fallback',
          },
        ],
      },
    });
    writeJson(path.join(GLOBAL_HOME, '.hive', 'config.json'), {
      model_channel_map: { 'gpt-*': 'cpa' },
    });

    const rows = listWebModelRouting(TMP_DIR);
    const row = rows.find((item) => item.model_id === 'gpt-5.3');
    expect(row).toBeTruthy();
    expect(row?.selection.mode).toBe('pattern');
    expect(row?.selection.pattern).toBe('gpt-*');
    expect(row?.selection.selector).toBe('cpa');
    expect(row?.effective_provider_id).toBe('us-cpa-local-codex');
  });

  it('loadWebDashboardSnapshot surfaces attention signals', () => {
    const spec = makeSpec();
    const state = makeState({
      steering: { paused: false, pending_actions: [], applied_actions: [] },
      next_action: { kind: 'request_human', reason: 'blocked', task_ids: ['t1'] },
    });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);

    const snapshot = loadWebDashboardSnapshot(TMP_DIR, RUN_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.attention.paused).toBe(false);
    expect(snapshot!.attention.primary_blocker).toContain('blocked');
  });

  it('loadWebDashboardSnapshot returns user-friendly verdict', () => {
    const spec = makeSpec();
    const state = makeState({
      status: 'blocked',
      steering: { paused: false, pending_actions: [], applied_actions: [] },
      next_action: { kind: 'request_human', reason: 'waiting for user input' },
    });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);

    const snapshot = loadWebDashboardSnapshot(TMP_DIR, RUN_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.verdict.state).toBe('blocked');
    expect(snapshot!.verdict.headline).toBe('运行被阻塞');
    expect(snapshot!.verdict.severity).toBe('warning');
    expect(snapshot!.verdict.needs_user).toBe(true);
    expect(snapshot!.verdict.why_stopped).toContain('waiting for user input');
    expect(snapshot!.verdict.suggested_action.label).toBe('查看并处理');
    expect(snapshot!.focus.scope).toBe('run');
  });

  it('loadWebDashboardSnapshot verdict for paused run suggests resume', () => {
    const spec = makeSpec();
    const state = makeState({
      status: 'running',
      steering: { paused: true, pending_actions: [], applied_actions: [] },
    });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);

    const snapshot = loadWebDashboardSnapshot(TMP_DIR, RUN_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.verdict.state).toBe('paused');
    expect(snapshot!.verdict.headline).toBe('运行已暂停');
    expect(snapshot!.verdict.why_stopped).toContain('运行已被手动暂停');
    expect(snapshot!.verdict.needs_user).toBe(true);
    expect(snapshot!.verdict.suggested_action.label).toBe('继续运行');
    expect(snapshot!.verdict.suggested_action.action_type).toBe('resume_run');
  });

  it('loadWebDashboardSnapshot treats init run as preparing/running instead of unknown', () => {
    const spec = makeSpec();
    const state = makeState({
      status: 'init',
      round: 0,
      next_action: { kind: 'execute', reason: 'Generate initial plan and start the first execution round.', task_ids: [] },
    });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);

    const snapshot = loadWebDashboardSnapshot(TMP_DIR, RUN_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.verdict.state).toBe('running');
    expect(snapshot!.verdict.headline).toBe('正在准备运行');
    expect(snapshot!.verdict.severity).toBe('info');
    expect(snapshot!.verdict.why_stopped.length).toBeGreaterThan(0);
  });

  it('loadWebDashboardSnapshot explains run-level focus when no task needs attention', () => {
    const spec = makeSpec({ allow_auto_merge: false });
    const state = makeState({
      status: 'partial',
      next_action: { kind: 'request_human', reason: 'Replan budget exhausted (1/1). Human intervention needed.' },
      task_states: {
        'task-a': {
          task_id: 'task-a',
          status: 'verified',
          round: 1,
          changed_files: ['todo.js'],
          merged: false,
          worker_success: true,
          review_passed: true,
          retry_count: 0,
        } as any,
      },
    });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);

    const snapshot = loadWebDashboardSnapshot(TMP_DIR, RUN_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.focus.scope).toBe('run');
    expect(snapshot!.focus.title).toContain('运行级');
    expect(snapshot!.focus.checks.join(' ')).toContain('worker worktree');
    expect(snapshot!.model_policy.note).toContain('MMS route');
    expect(snapshot!.verdict.why_stopped).toContain('自动重规划次数已用完');
  });

  it('loadWebDashboardSnapshot surfaces provider health', () => {
    const spec = makeSpec();
    const state = makeState();
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'provider-health.json'), {
      providers: {
        anthropic: { breaker: 'healthy', last_failure_subtype: undefined },
        kimi: { breaker: 'degraded', last_failure_subtype: 'rate_limit' },
      },
    });

    const snapshot = loadWebDashboardSnapshot(TMP_DIR, RUN_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.provider).not.toBeNull();
    expect(snapshot!.provider!.healthy).toBe(1);
    expect(snapshot!.provider!.degraded).toBe(1);
    expect(snapshot!.provider!.unhealthy.length).toBe(1);
    expect(snapshot!.provider!.unhealthy[0].provider).toBe('kimi');
  });

  it('loadWebDashboardSnapshot maps tasks from worker snapshot', () => {
    const spec = makeSpec();
    const state = makeState();
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'worker-status.json'), {
      run_id: RUN_ID,
      plan_id: 'plan-1',
      round: 1,
      workers: [
        {
          task_id: 'task-a',
          status: 'completed',
          assigned_model: 'kimi',
          active_model: 'kimi',
          task_summary: 'Did something',
          last_message: 'ok',
        },
      ],
    });

    const snapshot = loadWebDashboardSnapshot(TMP_DIR, RUN_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.tasks.length).toBe(1);
    expect(snapshot!.tasks[0].task_id).toBe('task-a');
    expect(snapshot!.tasks[0].status).toBe('completed');
  });

  it('loadWebDashboardSnapshot handles missing artifacts gracefully', () => {
    const spec = makeSpec();
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);

    const snapshot = loadWebDashboardSnapshot(TMP_DIR, RUN_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.truth.status).toBe('unknown');
    expect(snapshot!.tasks).toEqual([]);
    expect(snapshot!.compact).toBeNull();
  });

  it('loadWebDashboardSnapshot derives running status from worker-only run', () => {
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'dispatch-only', 'worker-status.json'), {
      run_id: 'dispatch-only',
      plan_id: 'dispatch-only',
      updated_at: '2026-04-20T10:00:00Z',
      goal: 'Worker only dispatch',
      round: 1,
      workers: [
        {
          task_id: 'task-a',
          status: 'running',
          assigned_model: 'kimi-k2.5',
          active_model: 'kimi-k2.5',
          task_summary: 'Running tool: Bash',
        },
      ],
    });

    const snapshot = loadWebDashboardSnapshot(TMP_DIR, 'dispatch-only');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.truth.status).toBe('running');
    expect(snapshot!.verdict.headline).toBe('运行中');
    expect(snapshot!.project.cwd).toBe(TMP_DIR);
  });

  it('submitWebSteeringAction writes and returns action', () => {
    const spec = makeSpec();
    const state = makeState();
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);

    const action = submitWebSteeringAction(TMP_DIR, RUN_ID, 'pause_run' as SteeringActionType, 'testing');
    expect(action.run_id).toBe(RUN_ID);
    expect(action.action_type).toBe('pause_run');
    expect(action.scope).toBe('run');
    expect(action.status).toBe('pending');
    expect(action.requested_by).toBe('web');

    const storePath = path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'steering.json');
    expect(fs.existsSync(storePath)).toBe(true);
  });

  it('resetWebConfigPolicy preserves non-policy config fields', () => {
    fs.mkdirSync(path.join(TMP_DIR, '.git'), { recursive: true });
    writeJson(path.join(TMP_DIR, '.hive', 'config.json'), {
      budget: { monthly_limit_usd: 999, warn_at: 0.4 },
      tiers: {
        planner: { model: 'qwen3-max', fallback: 'glm-5-turbo' },
      },
    });

    const policy = resetWebConfigPolicy(TMP_DIR, '', 'project');
    expect(policy).not.toBeNull();

    const configPath = path.join(TMP_DIR, '.hive', 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(stored.budget.monthly_limit_usd).toBe(999);
    expect(stored.budget.warn_at).toBe(0.4);
    expect(stored.tiers).toBeUndefined();
  });

  it('loadWebDashboardSnapshot returns attention_tasks filtered by cue', () => {
    const spec = makeSpec();
    const state = makeState({
      task_states: {
        'task-ready': { task_id: 'task-ready', status: 'merged', round: 1, changed_files: [], merged: true, worker_success: true, review_passed: true, retry_count: 0 } as any,
        'task-passive': { task_id: 'task-passive', status: 'superseded', round: 1, changed_files: [], merged: false, worker_success: false, review_passed: false, retry_count: 0 } as any,
        'task-blocked': { task_id: 'task-blocked', status: 'merge_blocked', round: 1, changed_files: [], merged: false, worker_success: false, review_passed: false, retry_count: 0, last_error: 'conflict' } as any,
        'task-human': { task_id: 'task-human', status: 'worker_failed', round: 1, changed_files: [], merged: false, worker_success: false, review_passed: false, retry_count: 0 } as any,
      },
      next_action: { kind: 'request_human', reason: 'need your input', task_ids: ['task-human'] },
    });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);

    const snapshot = loadWebDashboardSnapshot(TMP_DIR, RUN_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.attention_tasks.length).toBe(2);
    const ids = snapshot!.attention_tasks.map((t) => t.task_id);
    expect(ids).toContain('task-human');
    expect(ids).toContain('task-blocked');
    expect(ids).not.toContain('task-ready');
    expect(ids).not.toContain('task-passive');
    expect(snapshot!.attention_tasks.every((t) => t.cue && t.cue_reason)).toBe(true);
  });

  it('loadWebDashboardSnapshot attention_tasks sorted by cue priority', () => {
    const spec = makeSpec();
    const state = makeState({
      task_states: {
        'task-watch': { task_id: 'task-watch', status: 'pending', round: 1, changed_files: [], merged: false, worker_success: false, review_passed: false, retry_count: 0 } as any,
        'task-review': { task_id: 'task-review', status: 'review_failed', round: 1, changed_files: [], merged: false, worker_success: false, review_passed: false, retry_count: 0 } as any,
        'task-blocked': { task_id: 'task-blocked', status: 'merge_blocked', round: 1, changed_files: [], merged: false, worker_success: false, review_passed: false, retry_count: 0, last_error: 'x' } as any,
        'task-human': { task_id: 'task-human', status: 'worker_failed', round: 1, changed_files: [], merged: false, worker_success: false, review_passed: false, retry_count: 0 } as any,
      },
      next_action: { kind: 'request_human', reason: 'need your input', task_ids: ['task-human'] },
    });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);

    const snapshot = loadWebDashboardSnapshot(TMP_DIR, RUN_ID);
    expect(snapshot).not.toBeNull();
    const cues = snapshot!.attention_tasks.map((t) => t.cue);
    expect(cues[0]).toBe('needs_human');
    expect(cues[1]).toBe('blocked');
    expect(cues[2]).toBe('needs_review');
    expect(cues[3]).toBe('watch');
  });

  it('loadWebDashboardSnapshot attention_tasks empty when all tasks ready', () => {
    const spec = makeSpec();
    const state = makeState({
      task_states: {
        'task-a': { task_id: 'task-a', status: 'merged', round: 1, changed_files: [], merged: true, worker_success: true, review_passed: true, retry_count: 0 } as any,
        'task-b': { task_id: 'task-b', status: 'verified', round: 1, changed_files: [], merged: false, worker_success: true, review_passed: true, retry_count: 0 } as any,
      },
    });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);

    const snapshot = loadWebDashboardSnapshot(TMP_DIR, RUN_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.attention_tasks).toEqual([]);
  });

  it('verdict why_stopped uses next_action reason when available', () => {
    const spec = makeSpec();
    const state = makeState({
      status: 'running',
      next_action: { kind: 'execute', reason: 'Dispatching next batch of tasks for round 3' },
    });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);

    const snapshot = loadWebDashboardSnapshot(TMP_DIR, RUN_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.verdict.why_stopped).toBe('Dispatching next batch of tasks for round 3');
    expect(snapshot!.verdict.state).toBe('running');
  });
});

describe('web-dashboard server', () => {
  beforeEach(() => {
    resetDir();
    vi.stubEnv('HIVE_WEB_REGISTRY_PATH', REGISTRY_PATH);
    vi.stubEnv('HOME', GLOBAL_HOME);
    vi.stubEnv('USER', 'hive-web-test-user');
    vi.stubEnv('LOGNAME', 'hive-web-test-user');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function request(
    server: ReturnType<typeof createDashboardServer>,
    method: string,
    path: string,
    body?: string,
  ): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        const req = require('http').request(
          { hostname: '127.0.0.1', port: addr.port, path, method, headers: body ? { 'Content-Type': 'application/json' } : {} },
          (res: any) => {
            let raw = '';
            res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
            res.on('end', () => {
              server.close(() => {
                try {
                  resolve({ status: res.statusCode || 0, data: raw ? JSON.parse(raw) : raw });
                } catch {
                  resolve({ status: res.statusCode || 0, data: raw });
                }
              });
            });
          },
        );
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });
    });
  }

  it('GET /api/runs returns empty runs', async () => {
    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(server, 'GET', '/api/runs');
    expect(res.status).toBe(200);
    expect((res.data as any).runs).toEqual([]);
  });

  it('GET /api/model-options returns model list', async () => {
    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(server, 'GET', '/api/model-options');
    expect(res.status).toBe(200);
    expect(Array.isArray((res.data as any).models)).toBe(true);
    expect(typeof (res.data as any).models[0]?.blacklisted).toBe('boolean');
  });

  it('GET /api/projects returns fallback current project', async () => {
    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(server, 'GET', '/api/projects');
    expect(res.status).toBe(200);
    expect((res.data as any).projects[0].cwd).toBe(TMP_DIR);
  });

  it('GET /api/active-runs only returns fresh active runs', async () => {
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-fresh', 'spec.json'), makeSpec({ id: 'run-fresh', goal: 'Fresh active run' }));
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-fresh', 'state.json'), makeState({
      run_id: 'run-fresh',
      status: 'running',
      updated_at: new Date().toISOString(),
    }));
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-stale', 'spec.json'), makeSpec({ id: 'run-stale', goal: 'Stale active run' }));
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-stale', 'state.json'), makeState({
      run_id: 'run-stale',
      status: 'paused',
      updated_at: '2026-04-01T00:00:00.000Z',
    }));

    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(server, 'GET', '/api/active-runs');
    expect(res.status).toBe(200);
    expect((res.data as any).runs).toHaveLength(1);
    expect((res.data as any).runs[0].run_id).toBe('run-fresh');
  });

  it('GET /api/runs/:runId returns 404 when run missing', async () => {
    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(server, 'GET', '/api/runs/missing');
    expect(res.status).toBe(404);
    expect((res.data as any).error).toContain('not found');
  });

  it('GET /api/runs/:runId returns snapshot when run exists', async () => {
    const spec = makeSpec({ id: 'run-srv', goal: 'Server test' });
    const state = makeState({ run_id: 'run-srv', status: 'done' });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-srv', 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-srv', 'state.json'), state);

    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(server, 'GET', '/api/runs/run-srv');
    expect(res.status).toBe(200);
    expect((res.data as any).runId).toBe('run-srv');
    expect((res.data as any).truth.status).toBe('done');
  });

  it('GET /api/runs respects cwd query parameter', async () => {
    const spec = makeSpec({ id: 'run-other', cwd: OTHER_TMP_DIR, goal: 'Other repo run' });
    const state = makeState({ run_id: 'run-other', status: 'done' });
    writeJson(path.join(OTHER_TMP_DIR, '.ai', 'runs', 'run-other', 'spec.json'), spec);
    writeJson(path.join(OTHER_TMP_DIR, '.ai', 'runs', 'run-other', 'state.json'), state);

    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(server, 'GET', `/api/runs/run-other?cwd=${encodeURIComponent(OTHER_TMP_DIR)}`);
    expect(res.status).toBe(200);
    expect((res.data as any).project.cwd).toBe(OTHER_TMP_DIR);
    expect((res.data as any).truth.goal).toBe('Other repo run');
  });

  it('POST /api/runs/:runId/actions/:actionType submits steering', async () => {
    const spec = makeSpec({ id: 'run-act', goal: 'Action test' });
    const state = makeState({ run_id: 'run-act' });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-act', 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-act', 'state.json'), state);

    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(server, 'POST', '/api/runs/run-act/actions/request_replan', JSON.stringify({ reason: 'web test' }));
    expect(res.status).toBe(200);
    expect((res.data as any).action.action_type).toBe('request_replan');
    expect((res.data as any).action.status).toBe('pending');
  });

  it('GET /api/runs/:runId/model-policy returns current policy', async () => {
    const spec = makeSpec({ id: 'run-policy', goal: 'Policy test' });
    const state = makeState({ run_id: 'run-policy' });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-policy', 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-policy', 'state.json'), state);

    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(server, 'GET', '/api/runs/run-policy/model-policy');
    expect(res.status).toBe(200);
    expect((res.data as any).policy).toBeTruthy();
    expect(Array.isArray((res.data as any).policy.stages)).toBe(true);
  });

  it('POST /api/runs/:runId/model-policy persists override', async () => {
    const spec = makeSpec({ id: 'run-policy-save', goal: 'Policy save test' });
    const state = makeState({ run_id: 'run-policy-save' });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-policy-save', 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-policy-save', 'state.json'), state);

    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(
      server,
      'POST',
      '/api/runs/run-policy-save/model-policy',
      JSON.stringify({
        source: 'start-run',
        patch: { planner: { model: 'qwen3-max', fallback: 'glm-5-turbo' } },
      }),
    );
    expect(res.status).toBe(200);
    expect((res.data as any).policy.override_active).toBe(true);

    const stored = JSON.parse(
      fs.readFileSync(path.join(TMP_DIR, '.ai', 'runs', 'run-policy-save', 'model-overrides.json'), 'utf-8'),
    );
    expect(stored.start_time.planner.model).toBe('qwen3-max');
  });

  it('DELETE /api/runs/:runId/model-policy clears override for scope', async () => {
    const spec = makeSpec({ id: 'run-policy-reset', goal: 'Policy reset test' });
    const state = makeState({ run_id: 'run-policy-reset' });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-policy-reset', 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-policy-reset', 'state.json'), state);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-policy-reset', 'model-overrides.json'), {
      start_time: { planner: { model: 'qwen3-max' } },
      updated_at: new Date().toISOString(),
    });

    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(server, 'DELETE', '/api/runs/run-policy-reset/model-policy?source=start-run');
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(TMP_DIR, '.ai', 'runs', 'run-policy-reset', 'model-overrides.json'))).toBe(false);
  });

  it('DELETE /api/runs/:runId/model-policy/stages/:stage clears one stage override', async () => {
    const spec = makeSpec({ id: 'run-policy-clear-stage', goal: 'Policy clear stage' });
    const state = makeState({ run_id: 'run-policy-clear-stage' });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-policy-clear-stage', 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-policy-clear-stage', 'state.json'), state);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-policy-clear-stage', 'model-overrides.json'), {
      start_time: {
        planner: { model: 'qwen3-max' },
        executor: { model: 'glm-5-turbo' },
      },
      updated_at: new Date().toISOString(),
    });

    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(server, 'DELETE', '/api/runs/run-policy-clear-stage/model-policy/stages/planner?source=start-run');
    expect(res.status).toBe(200);
    const stored = JSON.parse(
      fs.readFileSync(path.join(TMP_DIR, '.ai', 'runs', 'run-policy-clear-stage', 'model-overrides.json'), 'utf-8'),
    );
    expect(stored.start_time.planner).toBeUndefined();
    expect(stored.start_time.executor.model).toBe('glm-5-turbo');
  });

  it('POST /api/runs/:runId/actions/:actionType returns 404 for missing run', async () => {
    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(server, 'POST', '/api/runs/no-such-run/actions/request_replan', JSON.stringify({ reason: 'web test' }));
    expect(res.status).toBe(404);
    expect((res.data as any).error).toContain('run not found');
    expect(fs.existsSync(path.join(TMP_DIR, '.ai', 'runs', 'no-such-run', 'steering.json'))).toBe(false);
  });

  it('POST /api/runs/:runId/actions/:actionType returns 400 for malformed json', async () => {
    const spec = makeSpec({ id: 'run-bad-json', goal: 'Bad JSON test' });
    const state = makeState({ run_id: 'run-bad-json' });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-bad-json', 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-bad-json', 'state.json'), state);

    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(server, 'POST', '/api/runs/run-bad-json/actions/request_replan', '{"reason":');
    expect(res.status).toBe(400);
    expect((res.data as any).error).toBe('invalid json body');
    expect(fs.existsSync(path.join(TMP_DIR, '.ai', 'runs', 'run-bad-json', 'steering.json'))).toBe(false);
  });

  it('POST /api/runs/:runId/model-policy returns 400 for malformed json', async () => {
    const spec = makeSpec({ id: 'run-policy-bad-json', goal: 'Policy bad json' });
    const state = makeState({ run_id: 'run-policy-bad-json' });
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-policy-bad-json', 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', 'run-policy-bad-json', 'state.json'), state);

    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(server, 'POST', '/api/runs/run-policy-bad-json/model-policy', '{"source":');
    expect(res.status).toBe(400);
    expect((res.data as any).error).toBe('invalid json body');
  });

  it('POST /api/config-policy/global is blocked because global config is manual-only', async () => {
    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(
      server,
      'POST',
      '/api/config-policy/global',
      JSON.stringify({ patch: { planner: { model: 'qwen3-max', fallback: 'glm-5-turbo' } } }),
    );
    expect(res.status).toBe(403);
    const stored = JSON.parse(fs.readFileSync(path.join(GLOBAL_HOME, '.hive', 'config.json'), 'utf-8'));
    expect(stored.tiers?.planner?.model).not.toBe('qwen3-max');
  });

  it('GET /api/global-config marks global scope as read-only', async () => {
    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(
      server,
      'GET',
      '/api/global-config',
    );
    expect(res.status).toBe(200);
    expect((res.data as any).target.scope).toBe('global');
    expect((res.data as any).target.writable).toBe(false);
  });

  it('POST /api/global-config blocks global model_blacklist writes', async () => {
    const server = createDashboardServer({ cwd: TMP_DIR });
    const saveRes = await request(
      server,
      'POST',
      '/api/global-config',
      JSON.stringify({ patch: { model_blacklist: ['claude-*', ' claude-* '] } }),
    );
    expect(saveRes.status).toBe(403);

    const stored = JSON.parse(fs.readFileSync(path.join(GLOBAL_HOME, '.hive', 'config.json'), 'utf-8'));
    expect(stored.model_blacklist).toBeUndefined();

    const modelRes = await request(createDashboardServer({ cwd: TMP_DIR }), 'GET', '/api/model-options');
    expect(modelRes.status).toBe(200);
    expect((modelRes.data as any).models.some((model: any) => model.id.startsWith('claude-') && model.blacklisted)).toBe(false);
  });

  it('POST /api/global-config blocks global model_channel_map writes', async () => {
    writeMmsRoutes({
      'gpt-5.4': {
        anthropic_base_url: 'http://82.156.121.141:4001',
        api_key: 'primary-key',
        provider_id: 'xin',
        priority: 100,
        role: 'auto',
        fallback_routes: [
          {
            anthropic_base_url: 'http://127.0.0.1:18317/v1',
            api_key: 'cpa-key',
            provider_id: 'us-cpa-local-codex',
            priority: 90,
            role: 'fallback',
          },
        ],
      },
    });

    const server = createDashboardServer({ cwd: TMP_DIR });
    const saveRes = await request(
      server,
      'POST',
      '/api/global-config',
      JSON.stringify({ patch: { model_channel_map: { 'gpt-5.4': 'cpa' } } }),
    );
    expect(saveRes.status).toBe(403);

    const stored = JSON.parse(fs.readFileSync(path.join(GLOBAL_HOME, '.hive', 'config.json'), 'utf-8'));
    expect(stored.model_channel_map).toBeUndefined();

    const routingRes = await request(createDashboardServer({ cwd: TMP_DIR }), 'GET', '/api/model-routing');
    expect(routingRes.status).toBe(200);
    const row = (routingRes.data as any).routing.find((item: any) => item.model_id === 'gpt-5.4');
    expect(row.effective_provider_id).toBe('xin');
    expect(row.selection.mode).not.toBe('exact');
  });

  it('POST /api/global-config?scope=project persists project model_channel_map without touching global config', async () => {
    fs.mkdirSync(path.join(TMP_DIR, '.git'), { recursive: true });
    writeMmsRoutes({
      'gpt-5.4': {
        anthropic_base_url: 'http://82.156.121.141:4001',
        api_key: 'primary-key',
        provider_id: 'xin',
        priority: 100,
        role: 'auto',
        fallback_routes: [
          {
            anthropic_base_url: 'http://127.0.0.1:18317/v1',
            api_key: 'cpa-key',
            provider_id: 'us-cpa-local-codex',
            priority: 90,
            role: 'fallback',
          },
        ],
      },
    });

    const server = createDashboardServer({ cwd: TMP_DIR });
    const saveRes = await request(
      server,
      'POST',
      '/api/global-config?scope=project',
      JSON.stringify({ patch: { model_channel_map: { 'gpt-5.4': 'cpa' } } }),
    );
    expect(saveRes.status).toBe(200);
    expect((saveRes.data as any).target.scope).toBe('project');
    expect((saveRes.data as any).target.path).toBe(path.join(TMP_DIR, '.hive', 'config.json'));

    const projectStored = JSON.parse(fs.readFileSync(path.join(TMP_DIR, '.hive', 'config.json'), 'utf-8'));
    expect(projectStored.model_channel_map).toEqual({ 'gpt-5.4': 'cpa' });

    const globalStored = JSON.parse(fs.readFileSync(path.join(GLOBAL_HOME, '.hive', 'config.json'), 'utf-8'));
    expect(globalStored.model_channel_map).toBeUndefined();

    const routingRes = await request(createDashboardServer({ cwd: TMP_DIR }), 'GET', '/api/model-routing');
    expect(routingRes.status).toBe(200);
    const row = (routingRes.data as any).routing.find((item: any) => item.model_id === 'gpt-5.4');
    expect(row.effective_provider_id).toBe('us-cpa-local-codex');
  });

  it('POST /api/global-config rejects global writes before resolving selectors', async () => {
    writeMmsRoutes({
      'gpt-5.4': {
        anthropic_base_url: 'https://crs.adsconflux.xyz/openai',
        api_key: 'crs-1',
        provider_id: 'companycrsopenai',
        priority: 160,
        role: 'auto',
      },
      'gpt-5': {
        anthropic_base_url: 'http://127.0.0.1:19300/openai',
        api_key: 'crs-2',
        provider_id: 'uscrsopenai',
        priority: 150,
        role: 'auto',
      },
    });

    const server = createDashboardServer({ cwd: TMP_DIR });
    const saveRes = await request(
      server,
      'POST',
      '/api/global-config',
      JSON.stringify({ patch: { model_channel_map: { 'gpt-5.4': 'crs' } } }),
    );
    expect(saveRes.status).toBe(403);
    expect((saveRes.data as any).error).toContain('human-reviewed only');
  });

  it('GET /api/doctor returns report with current config and model diagnostics', async () => {
    writeMmsRoutes({
      'gpt-5.4': {
        anthropic_base_url: 'http://82.156.121.141:4001',
        api_key: 'primary-key',
        provider_id: 'xin',
        priority: 100,
        role: 'auto',
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      ok: true,
    } as any);

    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(server, 'GET', '/api/doctor?model=gpt-5.4');
    expect(res.status).toBe(200);
    expect((res.data as any).report.mms.exists).toBe(true);
    expect((res.data as any).report.models.some((item: any) => item.model_id === 'gpt-5.4')).toBe(true);
    expect((res.data as any).markdown).toContain('== Hive Doctor ==');
    fetchMock.mockRestore();
  });

  it('DELETE /api/config-policy/project preserves unrelated config fields', async () => {
    fs.mkdirSync(path.join(TMP_DIR, '.git'), { recursive: true });
    writeJson(path.join(TMP_DIR, '.hive', 'config.json'), {
      budget: { monthly_limit_usd: 888, warn_at: 0.5 },
      tiers: {
        planner: { model: 'qwen3-max' },
        executor: { fallback: 'glm-5-turbo' },
      },
    });

    const server = createDashboardServer({ cwd: TMP_DIR });
    const res = await request(server, 'DELETE', '/api/config-policy/project');
    expect(res.status).toBe(200);

    const stored = JSON.parse(fs.readFileSync(path.join(TMP_DIR, '.hive', 'config.json'), 'utf-8'));
    expect(stored.budget.monthly_limit_usd).toBe(888);
    expect(stored.budget.warn_at).toBe(0.5);
    expect(stored.tiers).toBeUndefined();
  });

  it('GET / returns index.html when present', async () => {
    fs.mkdirSync(path.join(TMP_DIR, 'web'), { recursive: true });
    fs.writeFileSync(path.join(TMP_DIR, 'web', 'index.html'), '<html><body>Hive</body></html>', 'utf-8');

    const server = createDashboardServer({ cwd: TMP_DIR });
    return new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        const req = require('http').request(
          { hostname: '127.0.0.1', port: addr.port, path: '/', method: 'GET' },
          (res: any) => {
            let raw = '';
            res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
            res.on('end', () => {
              server.close(() => {
                try {
                  expect(res.statusCode).toBe(200);
                  expect(res.headers['content-type']).toContain('text/html');
                  expect(raw).toContain('Hive');
                  resolve(undefined);
                } catch (e) {
                  reject(e);
                }
              });
            });
          },
        );
        req.on('error', reject);
        req.end();
      });
    });
  });

  it('startDashboardServer auto-picks an available port when none is specified', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const server = await startDashboardServer({ cwd: TMP_DIR });
    try {
      const addr = server.address() as { port: number } | null;
      expect(addr && addr.port).toBeGreaterThan(0);
      expect(logSpy.mock.calls.some((call) => String(call[0]).includes('http://127.0.0.1:'))).toBe(true);
      expect(logSpy.mock.calls.some((call) => String(call[0]).includes('Auto-selected'))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      logSpy.mockRestore();
    }
  });
});
