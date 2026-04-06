import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type {
  DoneCondition,
  VerificationFailureClass,
  VerificationResult,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_TAIL = 4000;

function trimTail(text: string): string {
  if (!text) return '';
  return text.length <= MAX_OUTPUT_TAIL ? text : text.slice(-MAX_OUTPUT_TAIL);
}

function collectNodeBinDirs(startCwd: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();

  const visit = (baseDir: string): void => {
    let current = path.resolve(baseDir);
    while (true) {
      const binDir = path.join(current, 'node_modules', '.bin');
      if (fs.existsSync(binDir) && fs.existsSync(path.join(current, 'package.json')) && !seen.has(binDir)) {
        seen.add(binDir);
        dirs.push(binDir);
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };

  visit(startCwd);
  if (process.cwd() !== startCwd) {
    visit(process.cwd());
  }
  if (process.env.PWD && process.env.PWD !== startCwd && process.env.PWD !== process.cwd()) {
    visit(process.env.PWD);
  }

  return dirs;
}

function collectNodeModuleRoots(startCwd: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();

  const visit = (baseDir: string): void => {
    let current = path.resolve(baseDir);
    while (true) {
      const modulesDir = path.join(current, 'node_modules');
      if (fs.existsSync(modulesDir) && fs.existsSync(path.join(current, 'package.json')) && !seen.has(modulesDir)) {
        seen.add(modulesDir);
        roots.push(modulesDir);
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };

  if (process.cwd() !== startCwd) {
    visit(process.cwd());
  }
  if (process.env.PWD && process.env.PWD !== startCwd && process.env.PWD !== process.cwd()) {
    visit(process.env.PWD);
  }
  visit(startCwd);

  return roots;
}

function ensureNodeModulesAvailable(cwd: string): void {
  const packageJsonPath = path.join(cwd, 'package.json');
  const localNodeModules = path.join(cwd, 'node_modules');
  if (!fs.existsSync(packageJsonPath) || fs.existsSync(localNodeModules)) {
    return;
  }

  const fallbackModules = collectNodeModuleRoots(cwd)
    .find((dir) => path.resolve(dir) !== path.resolve(localNodeModules));
  if (!fallbackModules) {
    return;
  }

  try {
    fs.symlinkSync(fallbackModules, localNodeModules, 'dir');
  } catch {
    // Best-effort only. Verification can still fall back to PATH injection.
  }
}

function buildVerificationEnv(cwd: string): NodeJS.ProcessEnv {
  ensureNodeModulesAvailable(cwd);
  const bins = collectNodeBinDirs(cwd);
  if (bins.length === 0) {
    return { ...process.env };
  }
  return {
    ...process.env,
    PATH: `${bins.join(path.delimiter)}${path.delimiter}${process.env.PATH || ''}`,
  };
}

function classifyFailure(target: DoneCondition): VerificationFailureClass {
  switch (target.type) {
    case 'build':
      return 'build_fail';
    case 'test':
      return 'test_fail';
    case 'lint':
      return 'lint_fail';
    case 'command':
      return 'command_fail';
    case 'file_exists':
      return 'missing_output';
    case 'review_pass':
      return 'review_fail';
    default:
      return 'unknown';
  }
}

function buildSkippedResult(target: DoneCondition, reason: string): VerificationResult {
  return {
    target,
    passed: false,
    exit_code: null,
    stdout_tail: '',
    stderr_tail: reason,
    duration_ms: 0,
    failure_class: classifyFailure(target),
  };
}

export function runVerification(target: DoneCondition, cwd: string): VerificationResult {
  const start = Date.now();

  if (target.type === 'file_exists') {
    const filePath = target.path || '';
    const passed = Boolean(filePath) && fs.existsSync(filePath);
    return {
      target,
      passed,
      exit_code: passed ? 0 : 1,
      stdout_tail: passed ? `Found: ${filePath}` : '',
      stderr_tail: passed ? '' : `Missing file: ${filePath || '(empty path)'}`,
      duration_ms: Date.now() - start,
      failure_class: passed ? undefined : 'missing_output',
    };
  }

  if (target.type === 'review_pass') {
    return buildSkippedResult(target, 'review_pass is evaluated by review cascade, not shell verifier');
  }

  const command = target.command?.trim();
  if (!command) {
    return buildSkippedResult(target, `No command configured for ${target.type}`);
  }

  const result = spawnSync('/bin/zsh', ['-lc', command], {
    cwd,
    env: buildVerificationEnv(cwd),
    encoding: 'utf-8',
    timeout: target.timeout_ms || DEFAULT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024 * 8,
  });
  const errorCode = result.error && 'code' in result.error
    ? String(result.error.code)
    : undefined;

  const passed = result.status === 0 && !result.error;
  const stderr = result.error
    ? `${result.stderr || ''}\n${result.error.message}`.trim()
    : (result.stderr || '');

  return {
    target,
    passed,
    exit_code: result.status,
    stdout_tail: trimTail(result.stdout || ''),
    stderr_tail: trimTail(stderr),
    duration_ms: Date.now() - start,
    failure_class: passed ? undefined : (
      errorCode === 'ETIMEDOUT' ? 'infra_fail' : classifyFailure(target)
    ),
  };
}

export function runVerificationSuite(
  targets: DoneCondition[],
  cwd: string,
): VerificationResult[] {
  return targets.map((target) => runVerification(target, cwd));
}

export function allRequiredChecksPassed(results: VerificationResult[]): boolean {
  return results.every((result) => !result.target.must_pass || result.passed);
}
