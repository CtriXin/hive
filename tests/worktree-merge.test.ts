import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { commitAndMergeWorktree, createWorktree, getWorktreeDiff } from '../orchestrator/worktree-manager.js';

const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-worktree-merge-'));
  tempDirs.push(dir);
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Hive Test"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "hive-test@example.com"', { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n', 'utf-8');
  execSync('git add README.md && git commit -m "init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

function makeRepoOnBranch(branchName: string): string {
  const repo = makeRepo();
  execSync(`git checkout -b "${branchName}"`, { cwd: repo, stdio: 'ignore' });
  return repo;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('worktree merge', () => {
  it('reports files that were already committed inside the worker branch', () => {
    const repo = makeRepo();
    const worktree = createWorktree({ cwd: repo, name: 'task-committed' });

    fs.mkdirSync(path.join(worktree.path, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(worktree.path, 'docs', 'final.md'), '# Final\n', 'utf-8');
    execSync('git add docs/final.md && git commit -m "worker commit"', {
      cwd: worktree.path,
      stdio: 'ignore',
    });

    const diff = getWorktreeDiff(worktree.path);

    expect(diff.committedFiles).toEqual(['docs/final.md']);
    expect(diff.workingTreeFiles).toEqual([]);
    expect(diff.files).toEqual(['docs/final.md']);

    const result = commitAndMergeWorktree(
      worktree.path,
      worktree.branch,
      'task committed: merge worker branch',
      repo,
    );

    expect(result).toEqual({ merged: true });
    expect(fs.readFileSync(path.join(repo, 'docs', 'final.md'), 'utf-8')).toBe('# Final\n');
  });

  it('defaults to the current branch when the repo does not use main', () => {
    const repo = makeRepoOnBranch('trunk');
    const worktree = createWorktree({ cwd: repo, name: 'task-trunk' });

    execSync('git rev-parse --verify trunk', { cwd: worktree.path, stdio: 'ignore' });
    fs.writeFileSync(path.join(worktree.path, 'TRUNK.txt'), 'ok\n', 'utf-8');

    const diff = getWorktreeDiff(worktree.path);
    expect(diff.files).toEqual(['TRUNK.txt']);
    expect(diff.baseRef).toBe('trunk');
  });

  it('keeps untouched copied untracked files out of the reported diff', () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'copied.md'), '# copied\n', 'utf-8');

    const worktree = createWorktree({ cwd: repo, name: 'task-copied' });

    expect(getWorktreeDiff(worktree.path).files).toEqual([]);
  });

  it('merges worktree changes back into the target repo root', () => {
    const repo = makeRepo();
    const worktree = createWorktree({ cwd: repo, name: 'task-a' });

    fs.writeFileSync(path.join(worktree.path, 'README.md'), '# Repo\n\n- merged from worktree\n', 'utf-8');

    const result = commitAndMergeWorktree(
      worktree.path,
      worktree.branch,
      'task task-a: update readme',
      repo,
    );

    expect(result).toEqual({ merged: true });
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf-8')).toContain('- merged from worktree');
    expect(fs.existsSync(worktree.path)).toBe(false);
  });

  it('does not merge transient .ai artifacts back into the target repo', () => {
    const repo = makeRepo();
    const worktree = createWorktree({ cwd: repo, name: 'task-b' });

    fs.writeFileSync(path.join(worktree.path, 'README.md'), '# Repo\n\n- merged cleanly\n', 'utf-8');
    fs.mkdirSync(path.join(worktree.path, '.ai', 'restore'), { recursive: true });
    fs.writeFileSync(path.join(worktree.path, '.ai', 'restore', 'latest-compact-restore-prompt.md'), 'temp\n', 'utf-8');

    const result = commitAndMergeWorktree(
      worktree.path,
      worktree.branch,
      'task task-b: update readme only',
      repo,
    );

    expect(result).toEqual({ merged: true });
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf-8')).toContain('- merged cleanly');
    expect(fs.existsSync(path.join(repo, '.ai'))).toBe(false);
  });

  it('handles commit messages with shell-significant characters', () => {
    const repo = makeRepo();
    const worktree = createWorktree({ cwd: repo, name: 'task-c' });

    fs.writeFileSync(path.join(worktree.path, 'README.md'), '# Repo\n\n- merged with quoted message\n', 'utf-8');

    const result = commitAndMergeWorktree(
      worktree.path,
      worktree.branch,
      'task task-c: update `README.md` > keep docs-only',
      repo,
    );

    expect(result).toEqual({ merged: true });
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf-8')).toContain('- merged with quoted message');
    expect(execSync('git log --format=%s -1', { cwd: repo, encoding: 'utf-8' }).trim())
      .toBe('merge: task task-c: update `README.md` > keep docs-only');
  });
});
