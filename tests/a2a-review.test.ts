import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractSignatures } from '../orchestrator/discuss-lib/a2a-review.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-a2a-review-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('a2a-review', () => {
  it('ignores directory entries when extracting signatures', () => {
    const cwd = makeTempDir();
    fs.mkdirSync(path.join(cwd, '.ai'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'index.ts'),
      'export function smoke(): string { return "ok"; }\n',
      'utf-8',
    );

    const signatures = extractSignatures(cwd, ['.ai/', 'index.ts']);

    expect(signatures).toContain('index.ts:1');
    expect(signatures).not.toContain('.ai/');
  });
});
