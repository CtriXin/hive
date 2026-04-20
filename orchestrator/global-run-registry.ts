import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { RunSpec, RunState, WorkerStatusSnapshot } from './types.js';

export interface GlobalTrackedRun {
  cwd: string;
  project_name: string;
  run_id: string;
  goal: string;
  status: string;
  updated_at: string;
  source: 'run' | 'worker';
  active: boolean;
}

interface GlobalRunRegistryFile {
  version: 1;
  updated_at: string;
  runs: GlobalTrackedRun[];
}

export interface GlobalProjectSummary {
  id: string;
  cwd: string;
  name: string;
  updated_at: string;
  active_count: number;
  active_run_id?: string;
  active_status?: string;
  active_goal?: string;
  recent_run_id?: string;
  recent_status?: string;
  recent_goal?: string;
}

const REGISTRY_FILE = 'web-run-registry.json';
const MAX_RUNS_PER_PROJECT = 16;
const DISCOVERY_TTL_MS = 30_000;
const REGISTRY_LOCK_TIMEOUT_MS = 3_000;
const REGISTRY_LOCK_RETRY_MS = 25;
const REGISTRY_LOCK_STALE_MS = 15_000;
const ACTIVE_RUN_STATUSES = new Set([
  'init',
  'planning',
  'executing',
  'verifying',
  'repairing',
  'replanning',
  'running',
  'blocked',
  'paused',
]);
const ACTIVE_WORKER_STATUSES = new Set([
  'queued',
  'starting',
  'running',
  'discussing',
]);
const DISCOVERY_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.cache',
  'Library',
  'Applications',
  'Movies',
  'Music',
  'Pictures',
  'Public',
  'Downloads',
  'Desktop',
]);

let discoveryCache: { expiresAt: number; projects: string[] } = {
  expiresAt: 0,
  projects: [],
};

function testRegistryPath(): string {
  const workerId = process.env.VITEST_WORKER_ID || '0';
  return path.join(os.tmpdir(), `hive-web-run-registry-${process.pid}-${workerId}.json`);
}

function realHomeDir(): string {
  const user = process.env.USER || process.env.LOGNAME || '';
  const explicit = user ? path.join('/Users', user) : '';
  if (explicit && fs.existsSync(explicit)) return explicit;
  return os.homedir();
}

function registryPath(): string {
  const override = process.env.HIVE_WEB_REGISTRY_PATH?.trim();
  if (override) return override;
  if (process.env.VITEST) return testRegistryPath();
  return path.join(realHomeDir(), '.hive', REGISTRY_FILE);
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

function registryLockPath(filePath: string): string {
  return `${filePath}.lock`;
}

function sleepMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function registryTestDelayMs(): number {
  if (!process.env.VITEST) return 0;
  const raw = process.env.HIVE_WEB_REGISTRY_TEST_DELAY_MS?.trim();
  const value = Number(raw || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isStaleRegistryLock(lockPath: string): boolean {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > REGISTRY_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function withRegistryLock<T>(callback: () => T): T {
  const filePath = registryPath();
  const lockPath = registryLockPath(filePath);
  const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      ensureDir(path.dirname(lockPath));
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') throw error;
      if (isStaleRegistryLock(lockPath)) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`registry lock timeout: ${lockPath}`);
      }
      sleepMs(REGISTRY_LOCK_RETRY_MS);
    }
  }

  try {
    return callback();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

function readRegistry(): GlobalRunRegistryFile {
  const filePath = registryPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { version: 1, updated_at: nowIso(), runs: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as GlobalRunRegistryFile;
    if (!parsed || !Array.isArray(parsed.runs)) {
      return { version: 1, updated_at: nowIso(), runs: [] };
    }
    return {
      version: 1,
      updated_at: parsed.updated_at || nowIso(),
      runs: parsed.runs.filter(Boolean),
    };
  } catch {
    return { version: 1, updated_at: nowIso(), runs: [] };
  }
}

function writeRegistry(registry: GlobalRunRegistryFile): void {
  const filePath = registryPath();
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function projectName(cwd: string): string {
  const name = path.basename(path.resolve(cwd));
  return name || cwd;
}

function projectId(cwd: string): string {
  return Buffer.from(path.resolve(cwd)).toString('base64url');
}

function cleanGoal(goal: string | undefined): string {
  return String(goal || '').replace(/\s+/g, ' ').trim();
}

function discoveryRoots(): Array<{ root: string; maxDepth: number }> {
  if (process.env.VITEST) return [];
  const override = process.env.HIVE_WEB_DISCOVERY_ROOT?.trim();
  if (override) return [{ root: path.resolve(override), maxDepth: 6 }];
  const home = realHomeDir();
  const candidates = [
    { root: home, maxDepth: 2 },
    { root: path.join(home, 'auto-skills'), maxDepth: 5 },
    { root: path.join(home, 'workspace'), maxDepth: 5 },
    { root: path.join(home, 'repos'), maxDepth: 5 },
    { root: path.join(home, 'code'), maxDepth: 5 },
  ];
  return candidates.filter((candidate) => fs.existsSync(candidate.root));
}

function discoverProjectsUnder(root: string, depth: number, found: Set<string>): void {
  if (depth < 0) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  if (entries.some((entry) => entry.isDirectory() && entry.name === '.ai')) {
    const runsPath = path.join(root, '.ai', 'runs');
    if (fs.existsSync(runsPath)) {
      found.add(path.resolve(root));
      return;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (DISCOVERY_SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    discoverProjectsUnder(path.join(root, entry.name), depth - 1, found);
  }
}

function discoverProjectRoots(): string[] {
  const now = Date.now();
  if (discoveryCache.expiresAt > now) return discoveryCache.projects;
  const found = new Set<string>();
  for (const target of discoveryRoots()) {
    try {
      const output = execFileSync('find', [target.root, '-maxdepth', String(target.maxDepth), '-path', '*/.ai/runs', '-type', 'd'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of output.split('\n').map((item) => item.trim()).filter(Boolean)) {
        found.add(path.resolve(line, '..', '..'));
      }
      continue;
    } catch {
      discoverProjectsUnder(target.root, target.maxDepth, found);
    }
  }
  discoveryCache = {
    expiresAt: now + DISCOVERY_TTL_MS,
    projects: [...found].sort(),
  };
  return discoveryCache.projects;
}

function isActiveRunStatus(status: string | undefined): boolean {
  return ACTIVE_RUN_STATUSES.has(String(status || '').trim());
}

function deriveWorkerSnapshotStatus(snapshot: WorkerStatusSnapshot): string {
  const workers = snapshot.workers || [];
  if (workers.some((worker) => ACTIVE_WORKER_STATUSES.has(worker.status))) return 'running';
  if (workers.some((worker) => worker.status === 'failed')) return 'failed';
  if (workers.length > 0 && workers.every((worker) => worker.status === 'completed')) return 'completed';
  return 'partial';
}

function isWorkerSnapshotActive(snapshot: WorkerStatusSnapshot): boolean {
  return (snapshot.workers || []).some((worker) => ACTIVE_WORKER_STATUSES.has(worker.status));
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function scanProjectRuns(cwd: string): {
  updated_at: string;
  active_count: number;
  active_run_id?: string;
  active_status?: string;
  active_goal?: string;
  recent_run_id?: string;
  recent_status?: string;
  recent_goal?: string;
} {
  const runsDir = path.join(cwd, '.ai', 'runs');
  if (!fs.existsSync(runsDir)) {
    return { updated_at: new Date(0).toISOString(), active_count: 0 };
  }
  const entries = fs.readdirSync(runsDir)
    .map((runId) => {
      const state = readJson<{ status?: string; updated_at?: string }>(path.join(runsDir, runId, 'state.json'));
      const spec = readJson<{ goal?: string }>(path.join(runsDir, runId, 'spec.json'));
      const worker = readJson<WorkerStatusSnapshot>(path.join(runsDir, runId, 'worker-status.json'));
      const status = state?.status || (worker ? deriveWorkerSnapshotStatus(worker) : 'unknown');
      const updated_at = state?.updated_at || worker?.updated_at || new Date(0).toISOString();
      const goal = cleanGoal(spec?.goal || worker?.goal || worker?.workers?.[0]?.task_description || '');
      return {
        run_id: runId,
        status,
        updated_at,
        goal: goal || '-',
        active: isActiveRunStatus(status) || (worker ? isWorkerSnapshotActive(worker) : false),
      };
    })
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const active = entries.filter((entry) => entry.active);
  const latest = entries[0];
  const lead = active[0] || latest;
  return {
    updated_at: lead?.updated_at || new Date(0).toISOString(),
    active_count: active.length,
    active_run_id: active[0]?.run_id,
    active_status: active[0]?.status,
    active_goal: active[0]?.goal,
    recent_run_id: latest?.run_id,
    recent_status: latest?.status,
    recent_goal: latest?.goal,
  };
}

function trimRegistryRuns(runs: GlobalTrackedRun[]): GlobalTrackedRun[] {
  const groups = new Map<string, GlobalTrackedRun[]>();
  for (const run of runs) {
    const key = path.resolve(run.cwd);
    const list = groups.get(key) || [];
    list.push(run);
    groups.set(key, list);
  }
  const next: GlobalTrackedRun[] = [];
  for (const list of groups.values()) {
    list
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, MAX_RUNS_PER_PROJECT)
      .forEach((entry) => next.push(entry));
  }
  return next.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

function upsertRun(input: Omit<GlobalTrackedRun, 'project_name'> & { project_name?: string }): void {
  try {
    withRegistryLock(() => {
      const registry = readRegistry();
      const normalizedCwd = path.resolve(input.cwd);
      const project = input.project_name || projectName(normalizedCwd);
      const index = registry.runs.findIndex((entry) => entry.cwd === normalizedCwd && entry.run_id === input.run_id);
      const existing = index >= 0 ? registry.runs[index] : null;
      const nextEntry: GlobalTrackedRun = {
        cwd: normalizedCwd,
        project_name: project,
        run_id: input.run_id,
        goal: cleanGoal(input.goal) || existing?.goal || '-',
        status: input.status || existing?.status || 'unknown',
        updated_at: input.updated_at || existing?.updated_at || nowIso(),
        source: existing?.source === 'run' ? 'run' : input.source,
        active: input.active,
      };
      if (index >= 0) registry.runs[index] = nextEntry;
      else registry.runs.push(nextEntry);
      const testDelayMs = registryTestDelayMs();
      if (testDelayMs > 0) sleepMs(testDelayMs);
      registry.updated_at = nowIso();
      registry.runs = trimRegistryRuns(registry.runs);
      writeRegistry(registry);
    });
  } catch {
    // Global registry is best-effort only.
  }
}

export function trackRunSpec(cwd: string, spec: RunSpec): void {
  upsertRun({
    cwd,
    run_id: spec.id,
    goal: spec.goal,
    status: 'init',
    updated_at: spec.created_at || nowIso(),
    source: 'run',
    active: true,
  });
}

export function trackRunState(cwd: string, state: RunState): void {
  upsertRun({
    cwd,
    run_id: state.run_id,
    goal: '',
    status: state.status || 'unknown',
    updated_at: state.updated_at || nowIso(),
    source: 'run',
    active: isActiveRunStatus(state.status),
  });
}

export function trackWorkerSnapshot(cwd: string, snapshot: WorkerStatusSnapshot): void {
  const firstTask = snapshot.workers?.[0];
  upsertRun({
    cwd,
    run_id: snapshot.run_id,
    goal: snapshot.goal || firstTask?.task_description || firstTask?.task_summary || '',
    status: deriveWorkerSnapshotStatus(snapshot),
    updated_at: snapshot.updated_at || nowIso(),
    source: 'worker',
    active: isWorkerSnapshotActive(snapshot),
  });
}

export function listGlobalProjects(fallbackCwd?: string): GlobalProjectSummary[] {
  const registry = readRegistry();
  const projectMap = new Map<string, GlobalTrackedRun[]>();
  for (const run of registry.runs) {
    const key = path.resolve(run.cwd);
    const list = projectMap.get(key) || [];
    list.push(run);
    projectMap.set(key, list);
  }

  const fallback = fallbackCwd ? path.resolve(fallbackCwd) : '';
  if (fallback && !projectMap.has(fallback)) {
    projectMap.set(fallback, []);
  }
  for (const discovered of discoverProjectRoots()) {
    if (!projectMap.has(discovered)) {
      projectMap.set(discovered, []);
    }
  }

  const projects = [...projectMap.entries()].map(([cwd, runs]) => {
    const sorted = [...runs].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    const active = sorted.filter((run) => run.active);
    const newest = sorted[0];
    const live = active[0] || newest;
    const diskFallback = runs.length === 0 ? scanProjectRuns(cwd) : null;
    return {
      id: projectId(cwd),
      cwd,
      name: projectName(cwd),
      updated_at: live?.updated_at || diskFallback?.updated_at || new Date(0).toISOString(),
      active_count: active.length || diskFallback?.active_count || 0,
      active_run_id: live?.active ? live.run_id : (active[0]?.run_id || diskFallback?.active_run_id),
      active_status: live?.active ? live.status : (active[0]?.status || diskFallback?.active_status),
      active_goal: live?.active ? live.goal : (active[0]?.goal || diskFallback?.active_goal),
      recent_run_id: newest?.run_id || diskFallback?.recent_run_id,
      recent_status: newest?.status || diskFallback?.recent_status,
      recent_goal: newest?.goal || diskFallback?.recent_goal,
    } satisfies GlobalProjectSummary;
  });

  return projects.sort((left, right) => {
    if (left.active_count !== right.active_count) return right.active_count - left.active_count;
    return right.updated_at.localeCompare(left.updated_at);
  });
}
