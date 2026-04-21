import fs from 'fs';
import os from 'os';
import path from 'path';
import { readJsonSafe, writeJsonSafe } from './hive-config.js';

export interface ConfigSnapshotMeta {
  id: string;
  created_at: string;
  label: string;
  size: number;
}

interface ConfigSnapshot {
  id: string;
  created_at: string;
  label: string;
  source_path: string;
  config: Record<string, unknown>;
}

function getSnapshotDir(): string {
  return path.join(os.homedir(), '.hive', 'snapshots');
}

function ensureSnapshotDir(): string {
  const dir = getSnapshotDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getGlobalConfigPath(): string {
  const sandboxHome = path.join(os.homedir(), '.hive', 'config.json');
  const realUser = process.env.USER || process.env.LOGNAME || '';
  const realHome = realUser ? path.join('/Users', realUser, '.hive', 'config.json') : '';
  if (fs.existsSync(sandboxHome)) return sandboxHome;
  if (realHome && fs.existsSync(realHome)) return realHome;
  return sandboxHome;
}

function makeSnapshotId(label?: string): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  return `config-${iso}${label ? '-' + label : ''}`;
}

export function listConfigSnapshots(): ConfigSnapshotMeta[] {
  const dir = getSnapshotDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith('config-') && f.endsWith('.json'));
  const results: ConfigSnapshotMeta[] = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    const data = readJsonSafe<ConfigSnapshot>(filePath);
    const stat = fs.statSync(filePath);
    results.push({
      id: file.replace('.json', ''),
      created_at: (data.created_at as string) || new Date(stat.mtimeMs).toISOString(),
      label: (data.label as string) || file,
      size: stat.size,
    });
  }
  return results.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function createConfigSnapshot(label?: string): ConfigSnapshotMeta {
  const sourcePath = getGlobalConfigPath();
  const config = readJsonSafe(sourcePath);
  const id = makeSnapshotId(label);
  const snapshot: ConfigSnapshot = {
    id,
    created_at: new Date().toISOString(),
    label: label || '手动快照',
    source_path: sourcePath,
    config: config as Record<string, unknown>,
  };
  const dir = ensureSnapshotDir();
  writeJsonSafe(path.join(dir, `${id}.json`), snapshot);
  const stat = fs.statSync(path.join(dir, `${id}.json`));
  return { id, created_at: snapshot.created_at, label: snapshot.label, size: stat.size };
}

export function restoreConfigSnapshot(snapshotId: string): Record<string, unknown> {
  const dir = getSnapshotDir();
  const filePath = path.join(dir, `${snapshotId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`快照不存在: ${snapshotId}`);
  }
  const snapshot = readJsonSafe<ConfigSnapshot>(filePath);
  const sourcePath = snapshot.source_path || getGlobalConfigPath();
  writeJsonSafe(sourcePath, snapshot.config);
  return snapshot.config as Record<string, unknown>;
}

export function deleteConfigSnapshot(snapshotId: string): void {
  const dir = getSnapshotDir();
  const filePath = path.join(dir, `${snapshotId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`快照不存在: ${snapshotId}`);
  }
  fs.unlinkSync(filePath);
}
