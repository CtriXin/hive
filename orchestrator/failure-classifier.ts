// ═══════════════════════════════════════════════════════════════════
// orchestrator/failure-classifier.ts — Phase 2A: Failure Classification
// ═══════════════════════════════════════════════════════════════════
/**
 * Centralized failure classification for deterministic repair/replan decisions.
 * Maps observed failures to stable FailureClass categories.
 */

import type {
  FailureClass,
  VerificationResult,
  ReviewResult,
  WorkerResult,
  RunTransitionRecord,
  TaskExecutionContract,
} from './types.js';
import { isNoOpFailure } from './task-contract.js';

/**
 * Classify worker failure based on output and context
 */
export function classifyWorkerFailure(workerResult: WorkerResult): FailureClass {
  // No output produced — only counts as no_op for 'implementation' contract
  const taskCtx: Parameters<typeof isNoOpFailure>[0] = workerResult.execution_contract
    ? { execution_contract: workerResult.execution_contract } as any
    : undefined;
  if (isNoOpFailure(taskCtx, workerResult)) {
    return 'no_op';
  }

  if (!workerResult.success) {
    const errorContent = workerResult.output
      .filter((m) => m.type === 'error' || m.type === 'assistant')
      .map((m) => m.content)
      .join('\n');

    // Provider/API failures
    if (
      /\b(API Error: [45]\d{2}|限流|rate.?limit|overloaded|Please run \/login|timeout|ECONNREFUSED)\b/i.test(
        errorContent,
      )
    ) {
      return 'provider';
    }

    if (/\b(observe-only task modified files unexpectedly|write forbidden|unexpected write)\b/i.test(errorContent)) {
      return 'scope';
    }

    // Tool misuse
    if (/\b(tool[_ -]?call|tool[_ -]?use|invalid tool|unknown tool|tool not found)\b/i.test(errorContent)) {
      return 'tool';
    }

    // Context/prompt misunderstanding
    if (
      /\b(context|prompt|instruction|misunderstand|confused|unclear|ambiguous)\b/i.test(
        errorContent,
      )
    ) {
      return 'context';
    }

    // Default worker failure
    return 'context';
  }

  return 'unknown';
}

/**
 * Classify review failure based on findings
 */
export function classifyReviewFailure(reviewResult: ReviewResult): FailureClass {
  if (reviewResult.passed) {
    return 'unknown';
  }

  // Check for explicit failure attribution
  if (reviewResult.failure_attribution) {
    switch (reviewResult.failure_attribution) {
      case 'prompt_fault':
        return 'context';
      case 'model_fault':
        return 'context';
      case 'infra_fault':
        return 'provider';
      case 'task_design_fault':
        return 'context';
      case 'mixed':
      case 'unknown':
        break;
    }
  }

  // Analyze findings for patterns
  const issuesText = reviewResult.findings.map((f) => f.issue).join('\n');

  // Security/correctness issues
  if (/\b(security|vulnerability|injection|xss|csrf|auth|permission)\b/i.test(issuesText)) {
    return 'review';
  }

  // API/signature issues
  if (/\b(api|signature|interface|contract|breaking change)\b/i.test(issuesText)) {
    return 'review';
  }

  // Code quality issues
  if (/\b(style|format|readability|maintainability|best practice)\b/i.test(issuesText)) {
    return 'review';
  }

  // Missing functionality
  if (/\b(missing|incomplete|not implemented|todo|placeholder)\b/i.test(issuesText)) {
    return 'context';
  }

  return 'review';
}

/**
 * Classify verification failure based on result
 */
export function classifyVerificationFailure(
  verificationResult: VerificationResult,
): FailureClass {
  if (verificationResult.passed) {
    return 'unknown';
  }

  const target = verificationResult.target;
  const stderr = verificationResult.stderr_tail || '';
  const stdout = verificationResult.stdout_tail || '';
  const output = `${stderr}\n${stdout}`.toLowerCase();

  switch (target.type) {
    case 'build':
      return 'build';
    case 'test':
      return 'test';
    case 'lint':
      return 'lint';
    case 'command':
      // Try to classify command failure by output
      if (/\b(permission|denied|unauthorized|forbidden)\b/i.test(output)) {
        return 'policy';
      }
      if (/\b(not found|missing|ENOENT|ENOEXEC)\b/i.test(output)) {
        return 'context';
      }
      return 'verification';
    case 'file_exists':
      return 'verification';
    case 'review_pass':
      return 'review';
    default:
      return 'verification';
  }
}

/**
 * Classify merge failure based on blocker kind
 */
export function classifyMergeFailure(blockerKind: string): FailureClass {
  switch (blockerKind) {
    case 'scope_violation':
      return 'scope';
    case 'overlap_conflict':
      return 'merge';
    case 'hook_failed':
      return 'policy';
    case 'merge_conflict':
      return 'merge';
    default:
      return 'merge';
  }
}

/**
 * Classify planner failure
 */
export function classifyPlannerFailure(plannerError: string): FailureClass {
  const errorText = plannerError.toLowerCase();

  if (/\b(timeout|rate.?limit|overloaded|API Error)\b/i.test(errorText)) {
    return 'provider';
  }

  // Check for "misunderstood" keyword specifically
  if (/\b(misunderstood|misunderstand)\b/i.test(errorText)) {
    return 'context';
  }

  if (/\b(context|prompt|instruction|confused|unclear|ambiguous)\b/i.test(errorText)) {
    return 'context';
  }

  return 'planner';
}

/**
 * Classify policy hook failure
 */
export function classifyPolicyHookFailure(
  hookStage: string,
  hookLabel: string,
  stderr: string,
): FailureClass {
  const output = stderr.toLowerCase();

  if (/\b(permission|denied|unauthorized|forbidden|policy)\b/i.test(output)) {
    return 'policy';
  }

  if (/\b(build|compile|syntax|TS\d+|error TS)\b/i.test(output)) {
    return 'build';
  }

  if (/\b(test|fail|assert|expect)\b/i.test(output)) {
    return 'test';
  }

  return 'policy';
}

/**
 * Get failure class from a transition record
 */
export function getFailureClassFromTransition(
  transition: RunTransitionRecord,
): FailureClass | null {
  if (transition.failure_class) {
    return transition.failure_class;
  }

  // Infer from state transition
  const { to_state, reason } = transition;

  if (to_state === 'blocked') {
    if (/\bplanner\b/i.test(reason)) return 'planner';
    if (/\bbudget\b/i.test(reason)) return 'budget';
    return 'unknown';
  }

  if (to_state === 'worker_failed') {
    if (/\bprovider|API|rate limit\b/i.test(reason)) return 'provider';
    return 'context';
  }

  if (to_state === 'review_failed') {
    return 'review';
  }

  if (to_state === 'verification_failed') {
    if (/\bbuild\b/i.test(reason)) return 'build';
    if (/\btest\b/i.test(reason)) return 'test';
    if (/\blint\b/i.test(reason)) return 'lint';
    return 'verification';
  }

  if (to_state === 'merge_blocked') {
    if (/\bscope\b/i.test(reason)) return 'scope';
    return 'merge';
  }

  return null;
}

/**
 * Determine if a failure is repairable based on failure class
 */
export function isFailureRepairable(failureClass: FailureClass): boolean {
  // Generally repairable: context, review, verification, scope, no_op
  const repairable: FailureClass[] = [
    'context',
    'review',
    'verification',
    'scope',
    'no_op',
    'lint',
    'test',
  ];

  // Generally not repairable: provider, budget, merge (sometimes)
  const nonRepairable: FailureClass[] = ['provider', 'budget'];

  if (repairable.includes(failureClass)) return true;
  if (nonRepairable.includes(failureClass)) return false;

  // Unknown: default to allowing repair
  return true;
}

/**
 * Determine if a failure should trigger replan vs repair
 */
export function shouldReplanVsRepair(
  failureClass: FailureClass,
  retryCount: number,
  maxRetries: number,
): 'repair' | 'replan' | 'blocked' {
  // Budget exhaustion always blocks
  if (failureClass === 'budget') {
    return 'blocked';
  }

  // Provider failures may need replan if persistent
  if (failureClass === 'provider') {
    return retryCount >= maxRetries - 1 ? 'replan' : 'repair';
  }

  // Context failures: try repair first, replan if repeated
  if (failureClass === 'context') {
    return retryCount >= maxRetries - 1 ? 'replan' : 'repair';
  }

  // Planner failures always need replan
  if (failureClass === 'planner') {
    return 'replan';
  }

  // Most other failures: try repair first
  return 'repair';
}

/**
 * Generate human-readable failure summary
 */
export function summarizeFailure(
  failureClass: FailureClass,
  reason: string,
): string {
  const descriptions: Record<FailureClass, string> = {
    context: 'Task context or instruction misunderstanding',
    tool: 'Tool misuse or unavailable tool',
    provider: 'Provider API failure or rate limit',
    build: 'Compilation or build failure',
    test: 'Test failure',
    lint: 'Linting failure',
    verification: 'Verification failure',
    merge: 'Git merge conflict or strategy failure',
    policy: 'Policy hook failure',
    review: 'Code review failure',
    planner: 'Planning or replanning failure',
    scope: 'Scope violation (changed files outside estimated_files)',
    no_op: 'No output produced (empty diff)',
    budget: 'Budget exhausted',
    unknown: 'Unclassified failure',
  };

  const description = descriptions[failureClass] || 'Unknown failure';
  return `${description}: ${reason}`;
}

/**
 * FailureClassifier - stateless utility for classifying failures
 */
export const FailureClassifier = {
  classifyWorkerFailure,
  classifyReviewFailure,
  classifyVerificationFailure,
  classifyMergeFailure,
  classifyPlannerFailure,
  classifyPolicyHookFailure,
  getFailureClassFromTransition,
  isFailureRepairable,
  shouldReplanVsRepair,
  summarizeFailure,
};
