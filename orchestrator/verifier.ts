import fs from 'fs';
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
