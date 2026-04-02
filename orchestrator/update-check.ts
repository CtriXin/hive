import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveProjectPath } from './project-paths.js';

const UPDATE_CHECK_URL = 'https://raw.githubusercontent.com/CtriXin/hive/main/package.json';
const CACHE_DIR = path.join(os.homedir(), '.hive-orchestrator', '.cache');
const CACHE_PATH = path.join(CACHE_DIR, 'update-check.json');
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 1500;

interface UpdateCheckCache {
  checked_at: string;
  latest_version?: string;
}

function parseSemver(version: string): number[] | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isRemoteVersionNewer(currentVersion: string, latestVersion: string): boolean {
  const current = parseSemver(currentVersion);
  const latest = parseSemver(latestVersion);
  if (!current || !latest) return false;

  for (let i = 0; i < 3; i += 1) {
    if (latest[i]! > current[i]!) return true;
    if (latest[i]! < current[i]!) return false;
  }
  return false;
}

function loadCurrentVersion(): string | null {
  try {
    const packageJsonPath = resolveProjectPath('package.json');
    const raw = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    return typeof raw.version === 'string' ? raw.version : null;
  } catch {
    return null;
  }
}

function loadCache(): UpdateCheckCache | null {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as UpdateCheckCache;
  } catch {
    return null;
  }
}

function saveCache(cache: UpdateCheckCache): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {
    // Non-fatal: update prompt should never block the main command.
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  const response = await fetch(UPDATE_CHECK_URL, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const raw = await response.json();
  return typeof raw.version === 'string' ? raw.version : null;
}

function shouldRefreshCache(cache: UpdateCheckCache | null): boolean {
  if (!cache?.checked_at) return true;
  const checkedAt = new Date(cache.checked_at).getTime();
  if (!Number.isFinite(checkedAt)) return true;
  return (Date.now() - checkedAt) >= CHECK_INTERVAL_MS;
}

function printUpgradeNotice(currentVersion: string, latestVersion: string): void {
  console.log('');
  console.log(`⚠️  Hive update available: v${currentVersion} -> v${latestVersion}`);
  console.log('   Upgrade: curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash');
  console.log('   The upgrade script installs dependencies and runs npm run build automatically.');
  console.log('');
}

export async function maybePrintUpgradeNotice(): Promise<void> {
  if (process.env.HIVE_NO_UPDATE_CHECK === '1') return;

  const currentVersion = loadCurrentVersion();
  if (!currentVersion) return;

  let cache = loadCache();
  if (shouldRefreshCache(cache)) {
    try {
      const latestVersion = await fetchLatestVersion();
      cache = {
        checked_at: new Date().toISOString(),
        latest_version: latestVersion || undefined,
      };
      saveCache(cache);
    } catch {
      cache = {
        checked_at: new Date().toISOString(),
        latest_version: cache?.latest_version,
      };
      saveCache(cache);
    }
  }

  if (cache?.latest_version && isRemoteVersionNewer(currentVersion, cache.latest_version)) {
    printUpgradeNotice(currentVersion, cache.latest_version);
  }
}
