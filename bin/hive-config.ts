#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import {
  DEFAULT_CONFIG,
  deepMerge,
  getConfigSource,
  loadConfig,
  readJsonSafe,
  writeJsonSafe,
} from '../orchestrator/hive-config.js';
import { getAvailableModels, pullModels } from '../orchestrator/model-sync.js';

type JsonRecord = Record<string, unknown>;

function assertGlobalConfigIsManualOnly(useLocal: boolean): void {
  if (useLocal) return;
  throw new Error('Refusing to auto-modify ~/.hive/config.json. Global config is human-reviewed only; edit the file manually after review, or use --local.');
}

function parseValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (!Number.isNaN(Number(raw)) && raw.trim() !== '') return Number(raw);
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function setByPath(target: JsonRecord, keyPath: string, value: unknown): void {
  const parts = keyPath.split('.');
  let cursor: JsonRecord = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as JsonRecord;
  }
  cursor[parts[parts.length - 1] || keyPath] = value;
}

function flatten(value: unknown, prefix = ''): Array<{ key: string; value: unknown }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [{ key: prefix, value }];
  }

  return Object.entries(value as JsonRecord).flatMap(([key, nested]) => {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return flatten(nested, nextPrefix);
    }
    return [{ key: nextPrefix, value: nested }];
  });
}

function showConfig(cwd: string): void {
  const { global: globalPath, local: localPath } = getConfigSource(cwd);
  const globalConfig = readJsonSafe<JsonRecord>(globalPath);
  const localConfig = localPath ? readJsonSafe<JsonRecord>(localPath) : {};
  const merged = loadConfig(cwd) as unknown as JsonRecord;

  console.log(JSON.stringify(merged, null, 2));
  console.log('');
  console.log('Sources:');

  for (const entry of flatten(merged)) {
    const fromLocal = localPath && flatten(localConfig).some((item) => item.key === entry.key);
    const fromGlobal = flatten(globalConfig).some((item) => item.key === entry.key);
    const source = fromLocal ? 'local' : fromGlobal ? 'global' : 'default';
    console.log(`${entry.key}: (${source}) ${JSON.stringify(entry.value)}`);
  }
}

function setConfig(cwd: string, keyPath: string, rawValue: string, useLocal: boolean): void {
  assertGlobalConfigIsManualOnly(useLocal);
  const { global: globalPath, local: localPath } = getConfigSource(cwd);
  const targetPath = useLocal
    ? (localPath || path.join(cwd, '.hive', 'config.json'))
    : globalPath;
  const current = readJsonSafe<JsonRecord>(targetPath);
  setByPath(current, keyPath, parseValue(rawValue));
  writeJsonSafe(targetPath, current);
  console.log(`Updated ${keyPath} in ${targetPath}`);
}

function setOverride(cwd: string, taskId: string, model: string, useLocal: boolean): void {
  assertGlobalConfigIsManualOnly(useLocal);
  const { global: globalPath, local: localPath } = getConfigSource(cwd);
  const targetPath = useLocal
    ? (localPath || path.join(cwd, '.hive', 'config.json'))
    : globalPath;
  const current = deepMerge(DEFAULT_CONFIG as unknown as JsonRecord, readJsonSafe<JsonRecord>(targetPath));
  const overrides = ((current.overrides as JsonRecord | undefined) || {}) as JsonRecord;
  overrides[taskId] = model;
  current.overrides = overrides;
  writeJsonSafe(targetPath, current);
  console.log(`Override set: ${taskId} -> ${model} (${useLocal ? 'local' : 'global'})`);
}

function resetConfig(cwd: string, useLocal: boolean, confirmed: boolean): void {
  assertGlobalConfigIsManualOnly(useLocal);
  const { global: globalPath, local: localPath } = getConfigSource(cwd);
  const targetPath = useLocal ? localPath : globalPath;
  if (!targetPath || !fs.existsSync(targetPath)) {
    console.log('Nothing to reset.');
    return;
  }
  if (!confirmed) {
    console.error('Refusing to delete config without --yes');
    process.exit(1);
  }
  fs.unlinkSync(targetPath);
  console.log(`Deleted ${targetPath}`);
}

async function main(): Promise<void> {
  const { maybePrintUpgradeNotice } = await import('../orchestrator/update-check.js');
  await maybePrintUpgradeNotice();

  const args = process.argv.slice(2);
  const command = args[0];
  const cwd = process.cwd();
  const useLocal = args.includes('--local');
  const confirmed = args.includes('--yes');

  switch (command) {
    case 'show':
      showConfig(cwd);
      return;
    case 'set':
      if (!args[1] || args[2] === undefined) {
        throw new Error('Usage: hive-config set <key> <value> [--local]');
      }
      setConfig(cwd, args[1], args[2], useLocal);
      return;
    case 'override':
      if (!args[1] || !args[2]) {
        throw new Error('Usage: hive-config override <task-id> <model> [--local]');
      }
      setOverride(cwd, args[1], args[2], useLocal);
      return;
    case 'models': {
      const models = getAvailableModels(cwd);
      if (models.length === 0) {
        console.log('No cached models available.');
        return;
      }
      for (const model of models) {
        console.log(`${model.id}\t${model.provider}\t${model.context_window ?? '-'}`);
      }
      return;
    }
    case 'pull-models': {
      const cache = await pullModels(cwd);
      console.log(`Pulled ${cache.models.length} models at ${cache.last_pull}`);
      return;
    }
    case 'reset':
      resetConfig(cwd, useLocal, confirmed);
      return;
    case 'test': {
      const { buildConfigPreflightReport, renderConfigPreflightReport } = await import('../orchestrator/config-preflight.js');
      const report = await buildConfigPreflightReport(cwd);
      console.log(renderConfigPreflightReport(report));
      const hasFailures = report.models.some((row) => row.resolution_error || row.ping_ok === false)
        || report.stage_errors.length > 0
        || report.probes.some((probe) => !probe.ok);
      process.exit(hasFailures ? 1 : 0);
    }
    case 'setup': {
      const { spawnSync } = await import('child_process');
      const { fileURLToPath } = await import('url');
      const path = await import('path');
      const currentFile = fileURLToPath(import.meta.url);
      const currentDir = path.dirname(currentFile);
      const setupArgs = args.slice(1);
      // Support both source (bin/) and compiled (dist/bin/) layouts
      const candidates = [
        path.join(currentDir, '..', '..', 'web-config', 'server.js'),
        path.join(currentDir, '..', 'web-config', 'server.js'),
      ];
      const fs = await import('fs');
      let serverPath = candidates.find((c) => fs.existsSync(c));
      if (!serverPath) {
        console.error('❌ web-config/server.js not found');
        process.exit(1);
      }
      console.log('🐝 Starting Hive Config Server...');
      const result = spawnSync(process.execPath, [serverPath, ...setupArgs], { stdio: 'inherit' });
      if (result.error) {
        throw result.error;
      }
      if ((result.status ?? 0) !== 0) {
        process.exit(result.status ?? 1);
      }
      return;
    }
    default:
      console.log([
        'Usage:',
        '  hive-config show',
        '  hive-config set <key> <value> [--local]',
        '  hive-config override <task-id> <model> [--local]',
        '  hive-config models',
        '  hive-config pull-models',
        '  hive-config test',
        '  hive-config reset [--local] --yes',
        '  hive-config setup [--port <port>] [--no-open]  # no --port => auto-pick',
      ].join('\n'));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
