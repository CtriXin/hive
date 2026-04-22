import { execFileSync, execSync } from 'child_process';
import crypto from 'crypto';
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
  committedFiles: string[];
  workingTreeFiles: string[];
  baseRef?: string;
}

const WORKTREE_DIR = '.claude/worktrees';

function isTransientWorktreePath(filePath: string): boolean {
  return filePath === '.ai'
    || filePath === '.claude'
    || filePath === UNTRACKED_MANIFEST
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

function getCurrentWorktreeStartPoint(cwd?: string): string {
  const gitOpts = cwd ? { encoding: 'utf-8' as const, cwd } : { encoding: 'utf-8' as const };
  try {
    const branch = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      ...gitOpts,
      stdio: 'pipe',
    }).trim();
    if (branch) {
      return branch;
    }
  } catch {
    // Detached HEAD or symbolic ref unavailable — fall through to commit SHA.
  }

  return execFileSync('git', ['rev-parse', 'HEAD'], {
    ...gitOpts,
    stdio: 'pipe',
  }).trim();
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

const UNTRACKED_MANIFEST = '.untracked-manifest.json';
const COPIED_FILE_SENTINEL_DATE = new Date('2000-01-01T00:00:00.000Z');

interface UntrackedManifestFileEntry {
  hash: string;
  mtimeMs?: number;
  ctimeMs?: number;
}

interface UntrackedManifestData {
  version: 2;
  baseBranch?: string;
  files: Record<string, UntrackedManifestFileEntry>;
}

function fileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(content).digest('hex');
}

function normalizeManifestFileEntry(value: unknown): UntrackedManifestFileEntry | null {
  if (typeof value === 'string') {
    return { hash: value };
  }
  if (!value || typeof value !== 'object') return null;
  const hash = typeof (value as UntrackedManifestFileEntry).hash === 'string'
    ? (value as UntrackedManifestFileEntry).hash
    : null;
  if (!hash) return null;
  const mtimeMs = typeof (value as UntrackedManifestFileEntry).mtimeMs === 'number'
    ? (value as UntrackedManifestFileEntry).mtimeMs
    : undefined;
  const ctimeMs = typeof (value as UntrackedManifestFileEntry).ctimeMs === 'number'
    ? (value as UntrackedManifestFileEntry).ctimeMs
    : undefined;
  return { hash, mtimeMs, ctimeMs };
}

function readUntrackedManifest(worktreePath: string): UntrackedManifestData | null {
  const manifestPath = path.join(worktreePath, UNTRACKED_MANIFEST);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (raw && typeof raw === 'object' && raw.files && typeof raw.files === 'object') {
      const files = Object.fromEntries(
        Object.entries(raw.files)
          .map(([filePath, value]) => [filePath, normalizeManifestFileEntry(value)])
          .filter((entry): entry is [string, UntrackedManifestFileEntry] => Boolean(entry[1])),
      );
      return {
        version: 2,
        baseBranch: typeof raw.baseBranch === 'string' ? raw.baseBranch : undefined,
        files,
      };
    }

    const files = Object.fromEntries(
      Object.entries(raw || {})
        .map(([filePath, value]) => [filePath, normalizeManifestFileEntry(value)])
        .filter((entry): entry is [string, UntrackedManifestFileEntry] => Boolean(entry[1])),
    );
    return { version: 2, files };
  } catch {
    return null;
  }
}

function copyUntrackedFiles(repoRoot: string, worktreePath: string, baseBranch?: string): void {
  const manifest: Record<string, UntrackedManifestFileEntry> = {};
  try {
    const output = execSync(
      'git ls-files --others --exclude-standard',
      { cwd: repoRoot, encoding: 'utf-8' },
    ).trim();
    if (output) {
      for (const relPath of output.split('\n')) {
        if (!relPath || relPath.startsWith('.claude/') || relPath.startsWith('.ai/')) continue;
        const src = path.join(repoRoot, relPath);
        const dst = path.join(worktreePath, relPath);
        try {
          const stat = fs.statSync(src);
          if (!stat.isFile()) continue;
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, dst);
          try {
            fs.utimesSync(dst, COPIED_FILE_SENTINEL_DATE, COPIED_FILE_SENTINEL_DATE);
          } catch {
            // Fall back to the filesystem mtime when utimes is unavailable.
          }
          manifest[relPath] = {
            hash: fileHash(src),
            mtimeMs: fs.statSync(dst).mtimeMs,
            ctimeMs: fs.statSync(dst).ctimeMs,
          };
        } catch {
          // Skip files that can't be copied
        }
      }
    }
  } catch {
    // Non-critical
  }

  if (Object.keys(manifest).length > 0 || baseBranch) {
    fs.writeFileSync(
      path.join(worktreePath, UNTRACKED_MANIFEST),
      JSON.stringify({
        version: 2,
        baseBranch,
        files: manifest,
      } satisfies UntrackedManifestData),
    );
  }
}

/** Returns files that were copied as untracked but NOT modified by the worker */
export function getUnchangedCopiedFiles(worktreePath: string): string[] {
  const manifest = readUntrackedManifest(worktreePath);
  if (!manifest) return [];
  try {
    const unchanged: string[] = [];
    for (const [relPath, entry] of Object.entries(manifest.files)) {
      const filePath = path.join(worktreePath, relPath);
      try {
        if (!fs.existsSync(filePath)) continue;
        const stat = fs.statSync(filePath);
        const sameHash = fileHash(filePath) === entry.hash;
        const sameMtime = entry.mtimeMs === undefined || stat.mtimeMs === entry.mtimeMs;
        const sameCtime = entry.ctimeMs === undefined || stat.ctimeMs === entry.ctimeMs;
        if (sameHash && sameMtime && sameCtime) {
          unchanged.push(relPath);
        }
      } catch {
        // File may have been deleted — that's a real change, don't add
      }
    }
    return unchanged;
  } catch {
    return [];
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
  const { name, branch, fromBranch, cwd } = options;
  const gitOpts = cwd ? { encoding: 'utf-8' as const, cwd } : { encoding: 'utf-8' as const };
  const worktreesDir = getWorktreesDir(cwd);
  const baseBranchName = branch || `worktree/${name}`;
  const startPoint = fromBranch || getCurrentWorktreeStartPoint(cwd);

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
    execSync(`git worktree add -b "${branchName}" "${worktreePath}" "${startPoint}"`, gitOpts);
  } catch (error) {
    // If worktree already exists, just return info
    const existing = listWorktrees().find(w => w.name === worktreeName);
    if (existing) return existing;
    throw error;
  }

  // Copy untracked files into worktree so workers can see them
  copyUntrackedFiles(cwd || process.cwd(), worktreePath, startPoint);

  return {
    name: worktreeName,
    path: worktreePath,
    branch: branchName,
    isMain: false,
  };
}

function dedupeFiles(files: string[]): string[] {
  return [...new Set(files)];
}

function parseNameOnlyChangedFiles(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((filePath) => (
      Boolean(filePath)
      && !filePath.endsWith('/')
      && !isTransientWorktreePath(filePath)
    ));
}

function getWorktreeBaseRef(worktreePath: string): string | undefined {
  const manifest = readUntrackedManifest(worktreePath);
  if (manifest?.baseBranch) return manifest.baseBranch;
  try {
    execFileSync('git', ['rev-parse', '--verify', 'main'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return 'main';
  } catch {
    return undefined;
  }
}

function listWorkingTreeChangedFiles(worktreePath: string): string[] {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return parsePorcelainChangedFiles(output);
  } catch {
    return [];
  }
}

function listCommittedChangedFiles(worktreePath: string, baseRef?: string): string[] {
  if (!baseRef) return [];
  try {
    const output = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACDMRTUXB', `${baseRef}...HEAD`], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return parseNameOnlyChangedFiles(output);
  } catch {
    return [];
  }
}

export function getWorktreeDiff(worktreePath: string): WorktreeDiff {
  const baseRef = getWorktreeBaseRef(worktreePath);
  const unchangedCopies = new Set(getUnchangedCopiedFiles(worktreePath));
  const committedFiles = dedupeFiles(
    listCommittedChangedFiles(worktreePath, baseRef)
      .filter((filePath) => !unchangedCopies.has(filePath)),
  );
  const workingTreeFiles = dedupeFiles(
    listWorkingTreeChangedFiles(worktreePath)
      .filter((filePath) => !unchangedCopies.has(filePath)),
  );

  return {
    baseRef,
    committedFiles,
    workingTreeFiles,
    files: dedupeFiles([...committedFiles, ...workingTreeFiles]),
  };
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
    // Stage only real changes (exclude unchanged untracked copies)
    const diff = getWorktreeDiff(worktreePath);
    if (diff.workingTreeFiles.length > 0) {
      // Stage each real change individually instead of git add -A
      for (const file of diff.workingTreeFiles) {
        try {
          execFileSync('git', ['add', '--', file], { cwd: worktreePath, encoding: 'utf-8' });
        } catch {
          // File may have been deleted
          execFileSync('git', ['rm', '--cached', '--', file], {
            cwd: worktreePath,
            encoding: 'utf-8',
            stdio: 'pipe',
          }).toString();
        }
      }
      execFileSync('git', ['commit', '-m', commitMsg], {
        cwd: worktreePath,
        encoding: 'utf-8',
      });
    }

    // Merge branch into main from project root
    execFileSync('git', ['merge', branch, '--no-ff', '-m', `merge: ${commitMsg}`], {
      cwd: root,
      encoding: 'utf-8',
    });

    // Clean up: remove worktree and delete branch
    execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: root,
      encoding: 'utf-8',
    });
    execFileSync('git', ['branch', '-d', branch], {
      cwd: root,
      encoding: 'utf-8',
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
