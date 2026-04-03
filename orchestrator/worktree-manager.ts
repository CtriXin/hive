import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  isMain: boolean;
}

export interface WorktreeCreateOptions {
  name: string;
  cwd?: string;
  branch?: string;
  fromBranch?: string;
}

export interface WorktreeDiff {
  files: string[];
}

const WORKTREE_DIR = '.claude/worktrees';

function isTransientWorktreePath(filePath: string): boolean {
  return filePath === '.ai'
    || filePath === '.claude'
    || filePath.startsWith('.ai/')
    || filePath.startsWith('.claude/');
}

function getProjectRoot(cwd?: string): string {
  return execSync('git rev-parse --show-toplevel', {
    encoding: 'utf-8',
    cwd: cwd || undefined,
  }).trim();
}

function getWorktreesDir(cwd?: string): string {
  return path.join(getProjectRoot(cwd), WORKTREE_DIR);
}

export function listWorktrees(): WorktreeInfo[] {
  const root = getProjectRoot();
  const output = execSync('git worktree list --porcelain', { encoding: 'utf-8' });

  const worktrees: WorktreeInfo[] = [];
  const entries = output.split('\n\n');

  for (const entry of entries) {
    const lines = entry.trim().split('\n');
    if (lines.length < 2) continue;

    const attrs: Record<string, string> = {};
    for (const line of lines) {
      const [key, ...valueParts] = line.split(' ');
      if (key && valueParts.length > 0) {
        attrs[key] = valueParts.join(' ');
      }
    }

    const worktreePath = attrs['worktree'] || '';
    const branch = attrs['branch'] || '(detached)';
    const isMain = worktreePath === root;

    worktrees.push({
      name: isMain ? 'main' : path.basename(worktreePath),
      path: worktreePath,
      branch,
      isMain,
    });
  }

  return worktrees;
}

function copyUntrackedFiles(repoRoot: string, worktreePath: string): void {
  try {
    const output = execSync(
      'git ls-files --others --exclude-standard',
      { cwd: repoRoot, encoding: 'utf-8' },
    ).trim();
    if (!output) return;

    for (const relPath of output.split('\n')) {
      if (!relPath || relPath.startsWith('.claude/') || relPath.startsWith('.ai/')) continue;
      const src = path.join(repoRoot, relPath);
      const dst = path.join(worktreePath, relPath);
      try {
        const stat = fs.statSync(src);
        if (!stat.isFile()) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      } catch {
        // Skip files that can't be copied (permissions, dirs, etc.)
      }
    }
  } catch {
    // Non-critical — worker can still function without untracked files
  }
}

export function createWorktree(options: WorktreeCreateOptions): WorktreeInfo;
export function createWorktree(projectRoot: string, name: string): WorktreeInfo;
export function createWorktree(
  optionsOrProjectRoot: WorktreeCreateOptions | string,
  nameArg?: string,
): WorktreeInfo {
  const options = typeof optionsOrProjectRoot === 'string'
    ? { name: nameArg || 'worker', cwd: optionsOrProjectRoot }
    : optionsOrProjectRoot;
  const { name, branch, fromBranch = 'main', cwd } = options;
  const gitOpts = cwd ? { encoding: 'utf-8' as const, cwd } : { encoding: 'utf-8' as const };
  const worktreesDir = getWorktreesDir(cwd);
  const baseBranchName = branch || `worktree/${name}`;

  // Ensure worktrees directory exists
  execSync(`mkdir -p "${worktreesDir}"`);

  // If branch already exists (e.g. from a previous run/repair round),
  // append a short timestamp suffix to avoid collision.
  let branchName = baseBranchName;
  let worktreeName = name;
  try {
    execSync(`git rev-parse --verify "${baseBranchName}"`, {
      ...gitOpts, stdio: 'pipe',
    });
    // Branch exists — use a unique suffix
    const suffix = Date.now().toString(36);
    branchName = `${baseBranchName}-${suffix}`;
    worktreeName = `${name}-${suffix}`;
  } catch {
    // Branch does not exist — use original name
  }

  const worktreePath = path.join(worktreesDir, worktreeName);

  try {
    execSync(`git worktree add -b "${branchName}" "${worktreePath}" "${fromBranch}"`, gitOpts);
  } catch (error) {
    // If worktree already exists, just return info
    const existing = listWorktrees().find(w => w.name === worktreeName);
    if (existing) return existing;
    throw error;
  }

  // Copy untracked files into worktree so workers can see them
  copyUntrackedFiles(cwd || process.cwd(), worktreePath);

  return {
    name: worktreeName,
    path: worktreePath,
    branch: branchName,
    isMain: false,
  };
}

export function getWorktreeDiff(worktreePath: string): WorktreeDiff {
  try {
    const output = execSync('git status --porcelain', {
      cwd: worktreePath,
      encoding: 'utf-8',
    });
    return {
      files: parsePorcelainChangedFiles(output),
    };
  } catch {
    return { files: [] };
  }
}

export function parsePorcelainChangedFiles(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const rawPath = line.slice(3).trim();
      const renameParts = rawPath.split(' -> ');
      return (renameParts.at(-1) || '').trim();
    })
    .filter((filePath) => (
      Boolean(filePath)
      && !filePath.endsWith('/')
      && !isTransientWorktreePath(filePath)
    ));
}

export function removeWorktree(name: string, force = false): void {
  const worktree = listWorktrees().find(w => w.name === name);
  if (!worktree) {
    throw new Error(`Worktree '${name}' not found`);
  }

  if (worktree.isMain) {
    throw new Error('Cannot remove main worktree');
  }

  const forceFlag = force ? ' --force' : '';
  execSync(`git worktree remove "${worktree.path}"${forceFlag}`, { encoding: 'utf-8' });
}

export function getCurrentWorktree(): WorktreeInfo {
  const root = getProjectRoot();
  const worktrees = listWorktrees();
  return worktrees.find(w => w.path === root) || worktrees[0];
}

export function getWorktreePath(name: string): string {
  const worktree = listWorktrees().find(w => w.name === name);
  if (!worktree) {
    throw new Error(`Worktree '${name}' not found`);
  }
  return worktree.path;
}

export function isWorktreeClean(name: string): boolean {
  const worktree = listWorktrees().find(w => w.name === name);
  if (!worktree) return false;

  const status = execSync(`git -C "${worktree.path}" status --porcelain`, {
    encoding: 'utf-8',
  });
  return status.trim() === '';
}

export interface MergeResult {
  merged: boolean;
  error?: string;
}

/**
 * Commit worktree changes, merge branch back to main, clean up.
 * Non-throwing — returns { merged: false, error } on failure.
 */
export function commitAndMergeWorktree(
  worktreePath: string,
  branch: string,
  commitMsg: string,
  cwd?: string,
): MergeResult {
  const root = getProjectRoot(cwd);
  try {
    // Stage and commit in worktree
    const status = execSync('git status --porcelain', {
      cwd: worktreePath, encoding: 'utf-8',
    }).trim();
    const changedFiles = parsePorcelainChangedFiles(status);
    if (changedFiles.length > 0) {
      execSync(
        "git add -A -- . ':(exclude).ai' ':(exclude).claude'",
        { cwd: worktreePath, encoding: 'utf-8' },
      );
      execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, {
        cwd: worktreePath, encoding: 'utf-8',
      });
    }

    // Merge branch into main from project root
    execSync(`git merge "${branch}" --no-ff -m "merge: ${commitMsg.replace(/"/g, '\\"')}"`, {
      cwd: root, encoding: 'utf-8',
    });

    // Clean up: remove worktree and delete branch
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: root, encoding: 'utf-8',
    });
    execSync(`git branch -d "${branch}"`, {
      cwd: root, encoding: 'utf-8',
    });

    return { merged: true };
  } catch (err: any) {
    return { merged: false, error: err.message?.slice(0, 200) };
  }
}

export function lockWorktree(name: string): void {
  const lockFile = path.join(getWorktreesDir(), `${name}.lock`);
  execSync(`touch "${lockFile}"`);
}

export function unlockWorktree(name: string): void {
  const lockFile = path.join(getWorktreesDir(), `${name}.lock`);
  execSync(`rm -f "${lockFile}"`);
}
