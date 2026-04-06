import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(() => ({
    status: 0,
    stdout: 'ok',
    stderr: '',
    error: null,
  })),
}));

vi.mock('child_process', () => ({
  spawnSync: spawnSyncMock,
}));

import { runVerification } from '../orchestrator/verifier.js';

describe('verifier env fallback', () => {
  const originalCwd = process.cwd();
  const originalPwd = process.env.PWD;
  let tempRoot = '';

  beforeEach(() => {
    spawnSyncMock.mockClear();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-verifier-'));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env.PWD = originalPwd;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('prepends node_modules bin from process cwd when target cwd has no local install', () => {
    const originDir = path.join(tempRoot, 'origin');
    const taskDir = path.join(tempRoot, 'task');
    fs.mkdirSync(path.join(originDir, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(originDir, 'package.json'), '{"name":"origin"}');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'package.json'), '{"name":"task"}');
    process.chdir(originDir);
    process.env.PWD = originDir;

    runVerification({
      type: 'build',
      label: 'npm run build',
      command: 'npm run build',
      must_pass: true,
      scope: 'suite',
    }, taskDir);

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const options = spawnSyncMock.mock.calls[0][2];
    expect(options.cwd).toBe(taskDir);
    expect(fs.realpathSync(path.join(taskDir, 'node_modules'))).toBe(fs.realpathSync(path.join(originDir, 'node_modules')));
  });
});
