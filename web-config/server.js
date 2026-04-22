#!/usr/bin/env node
/**
 * Hive Config Server — 独立的模型配置页面服务器
 * Usage: node web-config/server.js [--port <port>] [--no-open]
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_HOST = '127.0.0.1';

function parsePort(argv = process.argv) {
  const idx = argv.indexOf('--port');
  return idx >= 0 ? Number(argv[idx + 1]) || 0 : 0;
}

function hasFlag(flag, argv = process.argv) {
  return argv.includes(flag);
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function pickExistingOrFirst(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates.find(Boolean) || '';
}

function homeCandidates() {
  const user = process.env.USER || process.env.LOGNAME || '';
  return uniq([
    process.env.HOME,
    user ? path.join('/Users', user) : '',
    os.homedir(),
  ]);
}

export function resolveHiveConfigPath() {
  return pickExistingOrFirst(
    homeCandidates().map((home) => path.join(home, '.hive', 'config.json')),
  );
}

export function resolveMmsRoutesPath() {
  if (process.env.MMS_ROUTES_PATH) {
    return process.env.MMS_ROUTES_PATH;
  }
  return pickExistingOrFirst(
    homeCandidates().map((home) => path.join(home, '.config', 'mms', 'model-routes.json')),
  );
}

export function readJsonSafe(filePath, defaultValue = {}) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

export function writeJsonSafe(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin'
    ? `open "${url}"`
    : platform === 'win32'
      ? `start "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.log(`Please open ${url} manually`);
    }
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, filePath) {
  if (!fs.existsSync(filePath)) {
    sendError(res, 404, 'Not found');
    return;
  }
  const ext = path.extname(filePath);
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(content);
}

export function loadMmsData(mmsRoutesPath = resolveMmsRoutesPath()) {
  const raw = readJsonSafe(mmsRoutesPath, {});
  const routes = raw && typeof raw === 'object' && raw.routes && typeof raw.routes === 'object'
    ? raw.routes
    : {};

  const providerSet = new Set();
  const models = [];

  for (const [modelId, route] of Object.entries(routes)) {
    const primary = route?.primary || route || {};
    const fallbacks = route?.fallbacks || route?.fallback_routes || [];

    if (primary.provider_id) {
      providerSet.add(primary.provider_id);
    }
    for (const fb of fallbacks) {
      if (fb?.provider_id) {
        providerSet.add(fb.provider_id);
      }
    }

    models.push({
      id: modelId,
      primary_provider: primary.provider_id || '',
      fallbacks: fallbacks.map((fb) => fb.provider_id).filter(Boolean),
    });
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  const providers = Array.from(providerSet)
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ id, display_name: id }));

  return { models, providers, path: mmsRoutesPath, exists: fs.existsSync(mmsRoutesPath) };
}

export function createConfigServer(options = {}) {
  const rootDir = options.rootDir || ROOT;
  const staticDir = options.staticDir || __dirname;
  const configPath = options.configPath || resolveHiveConfigPath();
  const mmsRoutesPath = options.mmsRoutesPath || resolveMmsRoutesPath();

  return http.createServer(async (req, res) => {
    const parsed = new URL(req.url || '/', `http://${DEFAULT_HOST}`);
    const pathname = parsed.pathname;
    const method = req.method || 'GET';

    if (pathname === '/api/data' && method === 'GET') {
      const mms = loadMmsData(mmsRoutesPath);
      const capabilities = readJsonSafe(path.join(rootDir, 'config', 'model-capabilities.json'), {});
      const profiles = readJsonSafe(path.join(rootDir, 'config', 'model-profiles.json'), {});
      sendJson(res, 200, { mms, capabilities, profiles });
      return;
    }

    if (pathname === '/api/config' && method === 'GET') {
      const config = readJsonSafe(configPath, {});
      sendJson(res, 200, { config, path: configPath });
      return;
    }

    if (pathname === '/api/config' && method === 'POST') {
      sendJson(res, 403, {
        error: 'Refusing to auto-modify ~/.hive/config.json. Global config is human-reviewed only; download the JSON, review it manually, then edit the file yourself.',
        path: configPath,
      });
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      serveStatic(res, path.join(staticDir, 'index.html'));
      return;
    }
    if (pathname === '/app.js') {
      serveStatic(res, path.join(staticDir, 'app.js'));
      return;
    }

    sendError(res, 404, 'Not found');
  });
}

function resolveListenPort(port) {
  return Number.isFinite(port) && Number(port) > 0 ? Number(port) : 0;
}

export async function startConfigServer(options = {}) {
  const requestedPort = resolveListenPort(options.port ?? parsePort());
  const host = options.host || DEFAULT_HOST;
  const noOpen = options.noOpen ?? hasFlag('--no-open');
  const server = createConfigServer(options);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : requestedPort;
  const url = `http://${host}:${actualPort}`;
  console.log(`\n🐝 Hive Config Server running at ${url}`);
  console.log(`   Config file: ${options.configPath || resolveHiveConfigPath()}`);
  console.log(`   MMS routes: ${options.mmsRoutesPath || resolveMmsRoutesPath()}`);
  if (!requestedPort) {
    console.log('   Auto-selected an available local port. Use --port <port> to pin one.');
  }
  if (!noOpen) {
    console.log('   Opening browser...');
    openBrowser(url);
  }

  return server;
}

function isExecutedDirectly() {
  if (!process.argv[1]) {
    return false;
  }
  return path.resolve(process.argv[1]) === __filename;
}

if (isExecutedDirectly()) {
  startConfigServer({
    port: parsePort(),
    host: DEFAULT_HOST,
    noOpen: hasFlag('--no-open'),
  }).catch((err) => {
    const requestedPort = resolveListenPort(parsePort());
    if (err && err.code === 'EADDRINUSE' && requestedPort) {
      console.error(`Port ${requestedPort} is already in use. Try: node web-config/server.js --port ${requestedPort + 1}`);
      process.exit(1);
    }
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
