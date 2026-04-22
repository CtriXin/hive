import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadExecutePlanFromJson,
  normalizeExecutePlanArg,
  validateNormalizedExecutePlanArgs,
} from '../mcp-server/index.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-execute-plan-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('execute_plan arg normalization', () => {
  it('treats empty-string tool args as omitted', () => {
    expect(normalizeExecutePlanArg('')).toBeUndefined();
    expect(normalizeExecutePlanArg('   ')).toBeUndefined();
    expect(normalizeExecutePlanArg('\n\t')).toBeUndefined();
  });

  it('accepts plan_path when the paired optional arg is an empty string', () => {
    const planJson = normalizeExecutePlanArg('');
    const planPath = normalizeExecutePlanArg('  /tmp/latest-plan.json  ');

    expect(planJson).toBeUndefined();
    expect(planPath).toBe('/tmp/latest-plan.json');
    expect(validateNormalizedExecutePlanArgs(planJson, planPath)).toBeNull();
  });

  it('still rejects non-empty plan_json and plan_path together', () => {
    const argError = validateNormalizedExecutePlanArgs(
      normalizeExecutePlanArg('{"id":"plan-1"}'),
      normalizeExecutePlanArg('/tmp/latest-plan.json'),
    );

    expect(argError).toBe('execute_plan accepts either plan_json or plan_path, not both.');
  });
});

describe('execute_plan plan_json loading', () => {
  it('returns a direct hint when plan_json looks like a file path', () => {
    const cwd = makeTempDir();
    const planPath = path.join(cwd, 'latest-plan.json');
    fs.writeFileSync(planPath, '{"plan_path_only":true}\n', 'utf-8');

    const resolved = loadExecutePlanFromJson(planPath);

    expect(resolved.plan).toBeNull();
    expect(resolved.error).toBe(`execute_plan plan_json looks like a file path (${planPath}). Pass it as plan_path instead.`);
  });
});
