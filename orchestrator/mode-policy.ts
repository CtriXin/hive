// orchestrator/mode-policy.ts — Execution mode contracts and runtime behavior
// Phase 5A: Quick / Think / Auto modes

import type { ExecutionMode, ModeContract, FailureClass } from './types.js';

const MODE_CONTRACTS: Record<ExecutionMode, ModeContract> = {
  quick: {
    planning_depth: 'minimal',
    dispatch_style: 'single',
    review_intensity: 'light',
    verification_scope: 'minimal',
    discuss_gate: 'disabled',
    allow_auto_merge: true,
    allow_repair: false,
    allow_replan: false,
    explain_label: 'Quick: fast answer, minimal orchestration, no repair/replan',
  },
  think: {
    planning_depth: 'full',
    dispatch_style: 'parallel',
    review_intensity: 'full-cascade',
    verification_scope: 'standard',
    discuss_gate: 'standard',
    allow_auto_merge: false,
    allow_repair: true,
    allow_replan: true,
    explain_label: 'Think: deep analysis and review, step-by-step, no auto-merge',
  },
  auto: {
    planning_depth: 'full',
    dispatch_style: 'full-orchestration',
    review_intensity: 'full-cascade',
    verification_scope: 'full-suite',
    discuss_gate: 'enforced',
    allow_auto_merge: true,
    allow_repair: true,
    allow_replan: true,
    explain_label: 'Auto: full orchestration — plan, dispatch, review, verify, repair, replan',
  },
  // New operator-facing lane contracts
  'record-only': {
    planning_depth: 'skip',
    dispatch_style: 'skip',
    review_intensity: 'skip',
    verification_scope: 'skip',
    discuss_gate: 'disabled',
    allow_auto_merge: false,
    allow_repair: false,
    allow_replan: false,
    explain_label: 'Record-only: just record the goal, no execution',
  },
  'clarify-first': {
    planning_depth: 'skip',
    dispatch_style: 'skip',
    review_intensity: 'skip',
    verification_scope: 'skip',
    discuss_gate: 'disabled',
    allow_auto_merge: false,
    allow_repair: false,
    allow_replan: false,
    explain_label: 'Clarify-first: waiting for user clarification before execution',
  },
  'auto-execute-small': {
    planning_depth: 'minimal',
    dispatch_style: 'single',
    review_intensity: 'light',
    verification_scope: 'minimal',
    discuss_gate: 'disabled',
    allow_auto_merge: true,
    allow_repair: false,
    allow_replan: false,
    explain_label: 'Auto-execute-small: single agent, lite review, no repair/replan',
  },
  'execute-standard': {
    planning_depth: 'full',
    dispatch_style: 'single',
    review_intensity: 'full-cascade',
    verification_scope: 'standard',
    discuss_gate: 'standard',
    allow_auto_merge: true,
    allow_repair: true,
    allow_replan: true,
    explain_label: 'Execute-standard: single agent with full review, repair and replan',
  },
  'execute-parallel': {
    planning_depth: 'full',
    dispatch_style: 'parallel',
    review_intensity: 'full-cascade',
    verification_scope: 'standard',
    discuss_gate: 'standard',
    allow_auto_merge: false,
    allow_repair: true,
    allow_replan: true,
    explain_label: 'Execute-parallel: multi-agent parallel with full review',
  },
};

export interface EffectiveModeResult {
  mode: ExecutionMode;
  normalized: ExecutionMode;
  contract: ModeContract;
  source: 'runtime_override' | 'spec' | 'default';
  overridden: boolean;
}

/**
 * Phase 8D: Unified effective mode resolver.
 * Priority: 1) state.runtime_mode_override  2) spec.execution_mode  3) default 'auto'.
 * All mode-sensitive paths must go through this helper — never read spec.execution_mode
 * directly when a RunState is available (it may have a runtime_mode_override).
 */
export function resolveEffectiveMode(
  spec: { execution_mode?: ExecutionMode },
  state: { runtime_mode_override?: ExecutionMode },
): EffectiveModeResult {
  const rawMode = state.runtime_mode_override ?? spec.execution_mode ?? 'auto';
  const normalized = normalizeExecutionMode(rawMode);
  return {
    mode: rawMode,
    normalized,
    contract: getModeContract(normalized),
    source: state.runtime_mode_override
      ? 'runtime_override'
      : spec.execution_mode
        ? 'spec'
        : 'default',
    overridden: !!state.runtime_mode_override,
  };
}

export function getModeContract(mode: ExecutionMode): ModeContract {
  return MODE_CONTRACTS[mode];
}

/** Normalize any ExecutionMode value into a contract-backed mode */
export function normalizeExecutionMode(mode: ExecutionMode): ExecutionMode {
  switch (mode) {
    case 'quick':  return 'auto-execute-small';
    case 'think':  return 'execute-parallel';
    case 'auto':   return 'execute-standard';
    default:       return mode;
  }
}

/** Auto-classify a goal into an execution lane via heuristic keyword scan */
export function autoClassifyLane(goal: string): ExecutionMode {
  const lower = goal.toLowerCase();

  // Blockers for lite path
  const liteBlockers = [
    /multi.?repo/i, /schema\s*(change|migration|alter)/i,
    /public\s*(api|contract|interface)/i, /deploy|release|rollout/i,
    /cross.?module|cross-module/i, /migration.*data/i,
    /refactor.*multiple/i, /multi.?service/i,
    /database\s*(change|schema|migration)/i,
  ];
  if (liteBlockers.some(rx => rx.test(lower))) {
    return 'execute-standard';
  }

  // Promote to parallel
  const parallelSignals = [
    /implement.*and.*test/i, /(backend|frontend|api).*and.*(frontend|backend|client)/i,
    /multiple.*module/i, /several.*file.*change/i, /feature.*module.*module/i,
  ];
  if (parallelSignals.filter(rx => rx.test(lower)).length >= 2) {
    return 'execute-parallel';
  }

  // Qualify for lite
  const smallSignals = [
    /fix\s+(a\s+)?(bug|typo|lint|style)/i, /add\s+(a\s+)?(test|validation|check|log)/i,
    /update\s+(a\s+)?(comment|doc|readme)/i, /rename\s+/i,
    /remove\s+(unused|dead)/i, /simple\s+/i, /trivial/i,
    /one\s+(line|file|function)/i, /minor/i, /small/i,
  ];
  if (smallSignals.some(rx => rx.test(lower)) && goal.length < 300) {
    return 'auto-execute-small';
  }

  return 'execute-standard';
}

export interface InferModeOptions {
  goal?: string;
  explicit?: ExecutionMode;
  cwd?: string;
}

/** Infer execution mode: explicit override > auto-classification */
export function inferExecutionMode(options?: InferModeOptions): ExecutionMode {
  if (options?.explicit) {
    return normalizeExecutionMode(options.explicit);
  }
  return autoClassifyLane(options?.goal || '');
}

/**
 * Phase 5A.1: Rich escalation inputs
 * Extends beyond the original (mode, riskLevel) with real loop signals.
 */
export interface EscalationInput {
  currentMode: ExecutionMode;
  riskLevel: 'low' | 'medium' | 'high';
  failureClass?: FailureClass | null;
  retryCount: number;
  discussGateHit: boolean;
  verificationSeverity: 'none' | 'smoke' | 'standard' | 'critical';
  taskComplexity: 'low' | 'medium' | 'medium-high' | 'high';
  providerInstability: boolean;
  replanCount: number;
}

export interface EscalationResult {
  escalated: boolean;
  from: ExecutionMode;
  to: ExecutionMode;
  reason: string;
  triggers: string[];
}

/**
 * Phase 5A.1: Rich escalation with multiple inputs.
 * Falls back to shouldEscalateMode for backward compat.
 */
export function shouldEscalateModeRich(input: EscalationInput): EscalationResult {
  const triggers: string[] = [];

  // Quick + high risk → escalate to Think
  if (input.currentMode === 'quick' && input.riskLevel === 'high') {
    triggers.push('high_risk_task');
  }

  // Quick + discuss gate hit → Think (worker wasn't confident enough for Quick)
  if (input.currentMode === 'quick' && input.discussGateHit) {
    triggers.push('discuss_gate_in_quick');
  }

  // Quick + medium-high or high complexity → Think (too complex for Quick path)
  if (
    input.currentMode === 'quick'
    && (input.taskComplexity === 'medium-high' || input.taskComplexity === 'high')
  ) {
    triggers.push('high_complexity_in_quick');
  }

  // Think → Auto: repeated failures suggest this needs full orchestration
  if (
    input.currentMode === 'think'
    && input.retryCount >= 2
    && input.riskLevel !== 'low'
  ) {
    triggers.push('repeated_failure_in_think');
  }

  // Think → Auto: critical verification failure needs full review + repair
  if (input.currentMode === 'think' && input.verificationSeverity === 'critical') {
    triggers.push('critical_verify_in_think');
  }

  // Provider instability in Quick → Think (unreliable provider needs more oversight)
  if (input.currentMode === 'quick' && input.providerInstability) {
    triggers.push('provider_instability_in_quick');
  }

  // Any mode: planner failure → at least Think
  if (input.failureClass === 'planner' && input.currentMode === 'quick') {
    triggers.push('planner_failure_in_quick');
  }

  if (triggers.length === 0) {
    return { escalated: false, from: input.currentMode, to: input.currentMode, reason: '', triggers: [] };
  }

  // Determine target
  let target: ExecutionMode = input.currentMode;
  if (input.currentMode === 'quick') {
    target = 'think';
  } else if (input.currentMode === 'think') {
    target = 'auto';
  }
  // Auto never escalates

  const reason = `Mode escalated ${input.currentMode} → ${target}: ${triggers.join(', ')}`;

  return {
    escalated: true,
    from: input.currentMode,
    to: target,
    reason,
    triggers,
  };
}

/**
 * Legacy backward-compatible escalation function.
 * Delegates to the rich version internally.
 */
export function shouldEscalateMode(
  current: ExecutionMode,
  riskLevel: 'low' | 'medium' | 'high',
): { escalated: boolean; from: ExecutionMode; to: ExecutionMode; reason: string } {
  const rich = shouldEscalateModeRich({
    currentMode: current,
    riskLevel,
    failureClass: null,
    retryCount: 0,
    discussGateHit: false,
    verificationSeverity: 'none',
    taskComplexity: 'low',
    providerInstability: false,
    replanCount: 0,
  });
  return {
    escalated: rich.escalated,
    from: rich.from,
    to: rich.to,
    reason: rich.reason,
  };
}
