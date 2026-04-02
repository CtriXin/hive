import fs from 'fs';
import path from 'path';

export interface LatestRunLocator {
  version: 1;
  run_id: string;
  origin_cwd: string;
  task_cwd: string;
  latest_restore_prompt_path: string;
  latest_packet_path?: string;
  updated_at: string;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function restoreDir(cwd: string): string {
  return path.join(cwd, '.ai', 'restore');
}

function locatorPath(cwd: string): string {
  return path.join(restoreDir(cwd), 'latest-run-pointer.json');
}

export function saveLatestRunLocator(locator: LatestRunLocator): string {
  const filePath = locatorPath(locator.origin_cwd);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(locator, null, 2));
  return filePath;
}

export function loadLatestRunLocator(cwd: string): LatestRunLocator | null {
  try {
    const filePath = locatorPath(cwd);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as LatestRunLocator;
  } catch {
    return null;
  }
}
