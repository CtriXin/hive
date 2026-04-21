import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  clearWebConfigPolicyStage,
  clearWebModelPolicyStage,
  consumePolicySaveResult,
  createWebConfigSnapshot,
  deleteWebConfigSnapshot,
  listWebActiveRuns,
  listWebMmsMeta,
  listWebMmsRoutes,
  listWebModelDetails,
  listWebModelRouting,
  listWebProjects,
  listWebProviders,
  listWebRuns,
  loadWebConfigPolicy,
  loadWebDashboardSnapshot,
  loadWebGlobalConfig,
  loadWebModelPolicy,
  listWebModelOptions,
  listWebConfigSnapshots,
  resetWebConfigPolicy,
  resetWebGlobalConfig,
  resetWebModelPolicy,
  restoreWebConfigSnapshot,
  submitWebSteeringAction,
  updateWebConfigPolicy,
  updateWebGlobalConfig,
  updateWebModelPolicy,
} from './web-dashboard.js';
import { buildCompactPacket } from './compact-packet.js';
import { buildDoctorReport, renderDoctorReport } from './doctor.js';
import { loadHiveShellDashboard } from './hiveshell-dashboard.js';
import type { RunModelPolicyPatch, RunModelPolicySource, RunModelPolicyStage } from './run-model-policy.js';
import type { SteeringActionType } from './types.js';

export interface DashboardServerOptions {
  port?: number;
  cwd: string;
}

function resolveWebDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const candidates = [
    path.join(currentDir, '..', 'web'),
    path.join(currentDir, '..', '..', 'web'),
    path.join(process.cwd(), 'web'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      resolve(body);
    });
  });
}

function parsePath(url: string): { pathname: string; searchParams: URLSearchParams } {
  const parsed = new URL(url, 'http://localhost');
  return { pathname: parsed.pathname, searchParams: parsed.searchParams };
}

function resolveRequestCwd(defaultCwd: string, searchParams: URLSearchParams): string {
  const requested = searchParams.get('cwd');
  if (!requested) return defaultCwd;
  return path.resolve(requested);
}

function resolveConfigScope(searchParams: URLSearchParams): 'global' | 'project' {
  return searchParams.get('scope') === 'project' ? 'project' : 'global';
}

function runExists(cwd: string, runId: string): boolean {
  return Boolean(loadWebDashboardSnapshot(cwd, runId));
}

function parseJsonBody<T>(body: string): T {
  return body ? JSON.parse(body) as T : {} as T;
}

export function createDashboardServer(options: DashboardServerOptions): http.Server {
  const { cwd } = options;
  const webDir = resolveWebDir();

  const server = http.createServer(async (req, res) => {
    const { pathname, searchParams } = parsePath(req.url || '/');
    const method = req.method || 'GET';
    const requestCwd = resolveRequestCwd(cwd, searchParams);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Static HTML
    if (method === 'GET' && pathname === '/') {
      const indexPath = path.join(webDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        sendHtml(res, 200, fs.readFileSync(indexPath, 'utf-8'));
        return;
      }
      sendError(res, 404, 'index.html not found');
      return;
    }

    if (method === 'GET' && pathname === '/api/projects') {
      sendJson(res, 200, { projects: listWebProjects(cwd), selected_cwd: requestCwd });
      return;
    }

    if (method === 'GET' && pathname === '/api/active-runs') {
      sendJson(res, 200, { runs: listWebActiveRuns(cwd) });
      return;
    }

    // API: list runs
    if (method === 'GET' && pathname === '/api/runs') {
      const runs = listWebRuns(requestCwd);
      sendJson(res, 200, { runs });
      return;
    }

    if (method === 'GET' && pathname === '/api/model-options') {
      sendJson(res, 200, { models: listWebModelOptions(requestCwd) });
      return;
    }

    if (method === 'GET' && pathname === '/api/providers') {
      sendJson(res, 200, { providers: listWebProviders(requestCwd) });
      return;
    }

    if (method === 'GET' && pathname === '/api/mms-routes') {
      sendJson(res, 200, { routes: listWebMmsRoutes() });
      return;
    }

    if (method === 'GET' && pathname === '/api/mms-meta') {
      sendJson(res, 200, { meta: listWebMmsMeta() });
      return;
    }

    if (method === 'GET' && pathname === '/api/doctor') {
      const modelId = searchParams.get('model') || undefined;
      const report = await buildDoctorReport(requestCwd, { modelIds: modelId ? [modelId] : undefined });
      sendJson(res, 200, { report, markdown: renderDoctorReport(report) });
      return;
    }

    if (method === 'GET' && pathname === '/api/model-routing') {
      sendJson(res, 200, { routing: listWebModelRouting(requestCwd) });
      return;
    }

    if (method === 'GET' && pathname === '/api/models') {
      sendJson(res, 200, { models: listWebModelDetails(requestCwd) });
      return;
    }

    if (method === 'GET' && pathname === '/api/global-config') {
      const scope = resolveConfigScope(searchParams);
      const surface = loadWebGlobalConfig(requestCwd, scope);
      sendJson(res, 200, surface);
      return;
    }

    if (method === 'POST' && pathname === '/api/global-config') {
      const scope = resolveConfigScope(searchParams);
      const body = await readBody(req);
      let payload: { patch?: Record<string, unknown> } = {};
      try {
        payload = parseJsonBody(body);
      } catch {
        sendError(res, 400, 'invalid json body');
        return;
      }
      if (!payload.patch || typeof payload.patch !== 'object') {
        sendError(res, 400, 'invalid config patch');
        return;
      }
      try {
        const surface = updateWebGlobalConfig(requestCwd, payload.patch, scope);
        sendJson(res, 200, surface);
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/global-config/reset') {
      const scope = resolveConfigScope(searchParams);
      try {
        const surface = resetWebGlobalConfig(requestCwd, scope);
        sendJson(res, 200, surface);
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/snapshots') {
      sendJson(res, 200, { snapshots: listWebConfigSnapshots() });
      return;
    }

    if (method === 'POST' && pathname === '/api/snapshots') {
      const body = await readBody(req);
      let payload: { label?: string } = {};
      try {
        payload = parseJsonBody(body);
      } catch {
        sendError(res, 400, 'invalid json body');
        return;
      }
      try {
        const snapshot = createWebConfigSnapshot(payload.label);
        sendJson(res, 200, { snapshot });
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const snapshotRestoreMatch = pathname.match(/^\/api\/snapshots\/([^/]+)\/restore$/);
    if (method === 'POST' && snapshotRestoreMatch) {
      const snapshotId = decodeURIComponent(snapshotRestoreMatch[1]);
      try {
        const config = restoreWebConfigSnapshot(snapshotId);
        sendJson(res, 200, { config });
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const snapshotDeleteMatch = pathname.match(/^\/api\/snapshots\/([^/]+)$/);
    if (method === 'DELETE' && snapshotDeleteMatch) {
      const snapshotId = decodeURIComponent(snapshotDeleteMatch[1]);
      try {
        deleteWebConfigSnapshot(snapshotId);
        sendJson(res, 200, { deleted: true });
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const configPolicyMatch = pathname.match(/^\/api\/config-policy(?:\/(global|project))?$/);
    if (configPolicyMatch) {
      const scope = configPolicyMatch[1] as 'global' | 'project' | undefined;
      const effectiveRunId = searchParams.get('runId') || listWebRuns(requestCwd)[0]?.id || '';

      if (method === 'GET' && !scope) {
        const policy = loadWebConfigPolicy(requestCwd, effectiveRunId);
        sendJson(res, 200, { policy, save_result: consumePolicySaveResult() });
        return;
      }

      if (!scope || (scope !== 'global' && scope !== 'project')) {
        sendError(res, 404, 'invalid config policy scope');
        return;
      }

      if (method === 'POST') {
        const body = await readBody(req);
        let payload: { patch?: RunModelPolicyPatch } = {};
        try {
          payload = parseJsonBody(body);
        } catch {
          sendError(res, 400, 'invalid json body');
          return;
        }
        if (!payload.patch || typeof payload.patch !== 'object') {
          sendError(res, 400, 'invalid config policy patch');
          return;
        }
        try {
          const policy = updateWebConfigPolicy(requestCwd, effectiveRunId, scope, payload.patch);
          sendJson(res, 200, { policy, save_result: consumePolicySaveResult() });
        } catch (error) {
          sendError(res, 400, error instanceof Error ? error.message : String(error));
        }
        return;
      }

      if (method === 'DELETE') {
        try {
          const policy = resetWebConfigPolicy(requestCwd, effectiveRunId, scope);
          sendJson(res, 200, { policy, save_result: consumePolicySaveResult() });
        } catch (error) {
          sendError(res, 400, error instanceof Error ? error.message : String(error));
        }
        return;
      }
    }

    const configPolicyStageMatch = pathname.match(/^\/api\/config-policy\/(global|project)\/stages\/([^/]+)$/);
    if (method === 'DELETE' && configPolicyStageMatch) {
      const scope = configPolicyStageMatch[1] as 'global' | 'project';
      const stage = decodeURIComponent(configPolicyStageMatch[2]) as RunModelPolicyStage;
      const effectiveRunId = searchParams.get('runId') || listWebRuns(requestCwd)[0]?.id || '';
      try {
        const policy = clearWebConfigPolicyStage(requestCwd, effectiveRunId, scope, stage);
        sendJson(res, 200, { policy, save_result: consumePolicySaveResult() });
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    // API: run snapshot
    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (method === 'GET' && runMatch) {
      const runId = decodeURIComponent(runMatch[1]);
      const snapshot = loadWebDashboardSnapshot(requestCwd, runId);
      if (!snapshot) {
        sendError(res, 404, `run not found: ${runId}`);
        return;
      }
      sendJson(res, 200, snapshot);
      return;
    }

    // API: compact
    const compactMatch = pathname.match(/^\/api\/runs\/([^/]+)\/compact$/);
    if (method === 'GET' && compactMatch) {
      const runId = decodeURIComponent(compactMatch[1]);
      const data = loadHiveShellDashboard(requestCwd, runId);
      if (!data || !data.state) {
        sendError(res, 404, `run not found: ${runId}`);
        return;
      }
      const compact = buildCompactPacket(data);
      sendJson(res, 200, { compact });
      return;
    }

    const modelPolicyMatch = pathname.match(/^\/api\/runs\/([^/]+)\/model-policy$/);
    if (modelPolicyMatch) {
      const runId = decodeURIComponent(modelPolicyMatch[1]);
      if (!runExists(requestCwd, runId)) {
        sendError(res, 404, `run not found: ${runId}`);
        return;
      }

      if (method === 'GET') {
        const policy = loadWebModelPolicy(requestCwd, runId);
        sendJson(res, 200, { policy, save_result: consumePolicySaveResult() });
        return;
      }

      if (method === 'POST') {
        const body = await readBody(req);
        let payload: { source?: RunModelPolicySource; patch?: RunModelPolicyPatch } = {};
        try {
          payload = parseJsonBody(body);
        } catch {
          sendError(res, 400, 'invalid json body');
          return;
        }
        if (!payload.source || (payload.source !== 'start-run' && payload.source !== 'runtime-next-stage')) {
          sendError(res, 400, 'invalid model policy source');
          return;
        }
        if (!payload.patch || typeof payload.patch !== 'object') {
          sendError(res, 400, 'invalid model policy patch');
          return;
        }
        const policy = updateWebModelPolicy(requestCwd, runId, payload.source, payload.patch);
        sendJson(res, 200, { policy, save_result: consumePolicySaveResult() });
        return;
      }

      if (method === 'DELETE') {
        const sourceParam = searchParams.get('source');
        const source = sourceParam === 'start-run' || sourceParam === 'runtime-next-stage'
          ? sourceParam
          : undefined;
        const policy = resetWebModelPolicy(requestCwd, runId, source);
        sendJson(res, 200, { policy, save_result: consumePolicySaveResult() });
        return;
      }
    }

    const modelPolicyStageMatch = pathname.match(/^\/api\/runs\/([^/]+)\/model-policy\/stages\/([^/]+)$/);
    if (method === 'DELETE' && modelPolicyStageMatch) {
      const runId = decodeURIComponent(modelPolicyStageMatch[1]);
      const stage = decodeURIComponent(modelPolicyStageMatch[2]) as RunModelPolicyStage;
      const sourceParam = searchParams.get('source');
      const source = sourceParam === 'runtime-next-stage' ? 'runtime-next-stage' : 'start-run';
      if (!runExists(requestCwd, runId)) {
        sendError(res, 404, `run not found: ${runId}`);
        return;
      }
      const policy = clearWebModelPolicyStage(requestCwd, runId, source, stage);
      sendJson(res, 200, { policy, save_result: consumePolicySaveResult() });
      return;
    }

    // API: steering action
    const actionMatch = pathname.match(/^\/api\/runs\/([^/]+)\/actions\/([^/]+)$/);
    if (method === 'POST' && actionMatch) {
      const runId = decodeURIComponent(actionMatch[1]);
      const actionType = decodeURIComponent(actionMatch[2]) as SteeringActionType;
      if (!runExists(requestCwd, runId)) {
        sendError(res, 404, `run not found: ${runId}`);
        return;
      }

      const body = await readBody(req);
      let payload: { reason?: string; taskId?: string } = {};
      if (body) {
        try {
          payload = parseJsonBody(body);
        } catch {
          sendError(res, 400, 'invalid json body');
          return;
        }
      }

      const result = submitWebSteeringAction(
        requestCwd,
        runId,
        actionType,
        payload.reason,
        payload.taskId,
      );
      sendJson(res, 200, { action: result });
      return;
    }

    sendError(res, 404, 'not found');
  });

  return server;
}

export function startDashboardServer(options: DashboardServerOptions): http.Server {
  const port = options.port || 3100;
  const server = createDashboardServer(options);
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Hive Web Dashboard running at http://localhost:${port}`);
  });
  return server;
}
