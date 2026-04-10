// ═══════════════════════════════════════════════════════════════════
// orchestrator/discuss-gate.ts — Mechanical discuss gating for workers
// ═══════════════════════════════════════════════════════════════════
/**
 * Mechanical discuss gating: deterministic rules for when discussion is required.
 * No heuristics, no ML—pure condition checking with clear trigger reasons.
 */

import type { Complexity, FailureClass, SubTask } from './types.js';
import type { ModelRegistry } from './model-registry.js';

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface DiscussGateResult {
  /** True if discussion is mechanically required */
  discuss_required: boolean;
  /** Human-readable reason for the trigger (empty if not triggered) */
  trigger_reason: string;
  /** Policy identifier for the trigger condition */
  trigger_policy: DiscussTriggerPolicy;
  /** Recommended escalation target (model or authority) */
  escalation_target: EscalationTarget;
}

export type DiscussTriggerPolicy =
  | 'confidence_threshold'
  | 'high_complexity_repair'
  | 'high_risk_failure_class'
  | 'unstable_retries'
  | 'capability_mismatch'
  | 'none';

export interface EscalationTarget {
  /** Type of escalation */
  type: 'model' | 'authority' | 'none';
  /** Specific model recommendation (if type is 'model') */
  model?: string;
  /** Authority level (if type is 'authority') */
  authority?: 'sonnet' | 'opus' | 'cross_model';
  /** Human-readable recommendation */
  recommendation: string;
}

export interface DiscussGateInput {
  /** Worker confidence score (0-1) */
  worker_confidence: number;
  /** Task complexity */
  complexity: Complexity;
  /** Whether this is a repair/retry round */
  is_repair_round: boolean;
  /** Previous failure class (null if first attempt) */
  failure_class: FailureClass | null;
  /** Number of retries so far */
  retry_count: number;
  /** Assigned model ID */
  assigned_model: string;
  /** Task category/domain */
  category: string;
  /** Registry for capability lookups */
  registry: ModelRegistry;
}

// ═══════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════

const CONFIDENCE_THRESHOLD = 0.7;
const HIGH_COMPLEXITY_RETRY_THRESHOLD = 2;
const UNSTABLE_RETRY_THRESHOLD = 3;

const HIGH_RISK_FAILURE_CLASSES: FailureClass[] = ['context', 'planner', 'scope'];

// ═══════════════════════════════════════════════════════════════════
// Main Entry Point
// ═══════════════════════════════════════════════════════════════════

export function evaluateDiscussGate(input: DiscussGateInput): DiscussGateResult {
  const checks = [
    checkConfidenceThreshold,
    checkHighComplexityRepair,
    checkHighRiskFailureClass,
    checkUnstableRetries,
    checkCapabilityMismatch,
  ];

  for (const check of checks) {
    const result = check(input);
    if (result.discuss_required) {
      return result;
    }
  }

  return {
    discuss_required: false,
    trigger_reason: '',
    trigger_policy: 'none',
    escalation_target: { type: 'none', recommendation: 'No escalation needed' },
  };
}

// ═══════════════════════════════════════════════════════════════════
// Individual Check Functions
// ═══════════════════════════════════════════════════════════════════

function checkConfidenceThreshold(input: DiscussGateInput): DiscussGateResult {
  if (input.worker_confidence >= CONFIDENCE_THRESHOLD) {
    return noTrigger();
  }

  const target = selectEscalationForConfidence(input);

  return {
    discuss_required: true,
    trigger_reason: `Worker confidence ${input.worker_confidence.toFixed(2)} below threshold ${CONFIDENCE_THRESHOLD}`,
    trigger_policy: 'confidence_threshold',
    escalation_target: target,
  };
}

function checkHighComplexityRepair(input: DiscussGateInput): DiscussGateResult {
  if (!input.is_repair_round) {
    return noTrigger();
  }

  const isHighComplexity = input.complexity === 'high' || input.complexity === 'medium-high';
  if (!isHighComplexity) {
    return noTrigger();
  }

  const target = selectEscalationForComplexity(input);

  return {
    discuss_required: true,
    trigger_reason: `High complexity (${input.complexity}) task in repair round ${input.retry_count}`,
    trigger_policy: 'high_complexity_repair',
    escalation_target: target,
  };
}

function checkHighRiskFailureClass(input: DiscussGateInput): DiscussGateResult {
  if (!input.failure_class) {
    return noTrigger();
  }

  if (!HIGH_RISK_FAILURE_CLASSES.includes(input.failure_class)) {
    return noTrigger();
  }

  const target = selectEscalationForFailureClass(input.failure_class);

  return {
    discuss_required: true,
    trigger_reason: `High-risk failure class: ${input.failure_class}`,
    trigger_policy: 'high_risk_failure_class',
    escalation_target: target,
  };
}

function checkUnstableRetries(input: DiscussGateInput): DiscussGateResult {
  if (input.retry_count < UNSTABLE_RETRY_THRESHOLD) {
    return noTrigger();
  }

  const target = selectEscalationForUnstable(input);

  return {
    discuss_required: true,
    trigger_reason: `Multiple retries (${input.retry_count}) indicate instability`,
    trigger_policy: 'unstable_retries',
    escalation_target: target,
  };
}

function checkCapabilityMismatch(input: DiscussGateInput): DiscussGateResult {
  const modelConfig = input.registry.get(input.assigned_model);
  if (!modelConfig) {
    return noTrigger();
  }

  const mismatch = detectCapabilityMismatch(input, modelConfig);
  if (!mismatch.hasMismatch) {
    return noTrigger();
  }

  const target = selectEscalationForMismatch(input, mismatch);

  return {
    discuss_required: true,
    trigger_reason: mismatch.reason,
    trigger_policy: 'capability_mismatch',
    escalation_target: target,
  };
}

// ================================================================
// Helper Types and Functions
// ═══════════════════════════════════════════════════════════════════

interface MismatchInfo {
  hasMismatch: boolean;
  reason: string;
  recommendedModel?: string;
}

function noTrigger(): DiscussGateResult {
  return {
    discuss_required: false,
    trigger_reason: '',
    trigger_policy: 'none',
    escalation_target: { type: 'none', recommendation: 'No escalation needed' },
  };
}

function detectCapabilityMismatch(
  input: DiscussGateInput,
  modelConfig: { max_complexity: Complexity; sweet_spot: string[]; avoid: string[] },
): MismatchInfo {
  const complexityOrder: Complexity[] = ['low', 'medium', 'medium-high', 'high'];
  const taskLevel = complexityOrder.indexOf(input.complexity);
  const modelLevel = complexityOrder.indexOf(modelConfig.max_complexity);

  if (taskLevel > modelLevel) {
    return {
      hasMismatch: true,
      reason: `Task complexity ${input.complexity} exceeds model max ${modelConfig.max_complexity}`,
    };
  }

  if (modelConfig.avoid.includes(input.category)) {
    return {
      hasMismatch: true,
      reason: `Model avoid list includes task category ${input.category}`,
    };
  }

  return { hasMismatch: false, reason: '' };
}

// ═══════════════════════════════════════════════════════════════════
// Escalation Target Selection
// ═══════════════════════════════════════════════════════════════════

function selectEscalationForConfidence(input: DiscussGateInput): EscalationTarget {
  if (input.worker_confidence < 0.5) {
    return {
      type: 'authority',
      authority: 'sonnet',
      recommendation: 'Low confidence—escalate to Sonnet for guidance',
    };
  }
  return {
    type: 'model',
    model: input.registry.selectDiscussPartner(input.assigned_model),
    recommendation: 'Moderate uncertainty—discuss with partner model',
  };
}

function selectEscalationForComplexity(input: DiscussGateInput): EscalationTarget {
  if (input.complexity === 'high' && input.retry_count >= HIGH_COMPLEXITY_RETRY_THRESHOLD) {
    return {
      type: 'authority',
      authority: 'opus',
      recommendation: 'High complexity repair—escalate to Opus',
    };
  }
  return {
    type: 'model',
    model: input.registry.selectDiscussPartner(input.assigned_model),
    recommendation: 'Complex task repair—discuss with partner model',
  };
}

function selectEscalationForFailureClass(failureClass: FailureClass): EscalationTarget {
  switch (failureClass) {
    case 'planner':
      return {
        type: 'authority',
        authority: 'opus',
        recommendation: 'Planner failure—escalate to Opus for replanning',
      };
    case 'context':
      return {
        type: 'authority',
        authority: 'cross_model',
        recommendation: 'Context misunderstanding—cross-model discussion',
      };
    case 'scope':
      return {
        type: 'authority',
        authority: 'sonnet',
        recommendation: 'Scope violation—Sonnet review required',
      };
    default:
      return {
        type: 'model',
        model: 'kimi-k2.5',
        recommendation: 'High-risk failure—discuss with reliable model',
      };
  }
}

function selectEscalationForUnstable(input: DiscussGateInput): EscalationTarget {
  if (input.retry_count >= 5) {
    return {
      type: 'authority',
      authority: 'opus',
      recommendation: 'Persistent instability—Opus arbitration required',
    };
  }
  return {
    type: 'authority',
    authority: 'cross_model',
    recommendation: 'Multiple retries—cross-model analysis needed',
  };
}

function selectEscalationForMismatch(input: DiscussGateInput, mismatch: MismatchInfo): EscalationTarget {
  const betterModel = mismatch.recommendedModel || input.registry.selectDiscussPartner(input.assigned_model);

  return {
    type: 'model',
    model: betterModel,
    recommendation: `Capability mismatch—escalate to ${betterModel}`,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Convenience API
// ═══════════════════════════════════════════════════════════════════

export function shouldTriggerDiscuss(
  workerConfidence: number,
  complexity: Complexity,
  isRepairRound: boolean,
  failureClass: FailureClass | null,
  retryCount: number,
  assignedModel: string,
  category: string,
  registry: ModelRegistry,
): boolean {
  const result = evaluateDiscussGate({
    worker_confidence: workerConfidence,
    complexity,
    is_repair_round: isRepairRound,
    failure_class: failureClass,
    retry_count: retryCount,
    assigned_model: assignedModel,
    category,
    registry,
  });
  return result.discuss_required;
}

export function getEscalationTarget(
  workerConfidence: number,
  complexity: Complexity,
  isRepairRound: boolean,
  failureClass: FailureClass | null,
  retryCount: number,
  assignedModel: string,
  category: string,
  registry: ModelRegistry,
): EscalationTarget {
  const result = evaluateDiscussGate({
    worker_confidence: workerConfidence,
    complexity,
    is_repair_round: isRepairRound,
    failure_class: failureClass,
    retry_count: retryCount,
    assigned_model: assignedModel,
    category,
    registry,
  });
  return result.escalation_target;
}

// ═══════════════════════════════════════════════════════════════════
// Policy Introspection
// ═══════════════════════════════════════════════════════════════════

export interface DiscussGatePolicy {
  confidence_threshold: number;
  high_complexity_retry_threshold: number;
  unstable_retry_threshold: number;
  high_risk_failure_classes: FailureClass[];
}

export function getDiscussGatePolicy(): DiscussGatePolicy {
  return {
    confidence_threshold: CONFIDENCE_THRESHOLD,
    high_complexity_retry_threshold: HIGH_COMPLEXITY_RETRY_THRESHOLD,
    unstable_retry_threshold: UNSTABLE_RETRY_THRESHOLD,
    high_risk_failure_classes: [...HIGH_RISK_FAILURE_CLASSES],
  };
}

export function isHighRiskFailureClass(failureClass: FailureClass): boolean {
  return HIGH_RISK_FAILURE_CLASSES.includes(failureClass);
}

// ═══════════════════════════════════════════════════════════════════
// Task-level Integration
// ═══════════════════════════════════════════════════════════════════

export interface TaskDiscussContext {
  task: SubTask;
  round: number;
  previous_failure_class?: FailureClass;
  worker_confidence?: number;
}

export function evaluateTaskDiscussGate(
  context: TaskDiscussContext,
  registry: ModelRegistry,
): DiscussGateResult {
  const workerConfidence = context.worker_confidence ?? 1.0;
  const isRepairRound = context.round > 0;
  const retryCount = context.round;

  return evaluateDiscussGate({
    worker_confidence: workerConfidence,
    complexity: context.task.complexity,
    is_repair_round: isRepairRound,
    failure_class: context.previous_failure_class || null,
    retry_count: retryCount,
    assigned_model: context.task.assigned_model,
    category: context.task.category,
    registry,
  });
}
