// orchestrator/routing-enforcement.ts — Router override policy
import type {
  SubTask,
  RoutingOverridePolicy,
  RoutingEnforcementResult,
} from './types.js';
import type {
  RoutingDecision,
  ScoredCandidate,
  ModelCapabilityProfile,
} from './capability-router.js';

const OVERRIDE_SCORE_GAP = 0.15;

export interface RoutingEnforcementInput {
  task: SubTask;
  routerDecision: RoutingDecision;
  isRepair: boolean;
  plannerProviderCooledDown: boolean;
  routerSelectedProviderCooledDown: boolean;
  profiles: Record<string, ModelCapabilityProfile>;
}

/**
 * Decide whether to override planner assignment with router selection.
 * Returns a RoutingEnforcementResult with the effective model and reason.
 */
export function enforceRoutingOverride(
  input: RoutingEnforcementInput,
): RoutingEnforcementResult {
  const plannerModel = input.task.assigned_model;
  const routerModel = input.routerDecision.selectedModel;
  const { selectionMethod } = input.routerDecision;

  // Heuristic: not enough data to justify override
  if (selectionMethod === 'heuristic') {
    return makeResult(plannerModel, routerModel, false, 'insufficient scoring data', 'conservative_keep');
  }

  // Fallback: all providers deprioritized, take best available
  if (selectionMethod === 'fallback') {
    return makeResult(routerModel, routerModel, true, 'all providers unhealthy, using best available', 'fallback_best_available');
  }

  // Scored: check conditions
  if (selectionMethod === 'scored') {
    // Planner provider in cooldown → override
    if (input.plannerProviderCooledDown) {
      return makeResult(plannerModel, routerModel, true, 'planner provider in cooldown', 'provider_cooldown');
    }

    // Repair round → prefer router selection
    if (input.isRepair) {
      return makeResult(plannerModel, routerModel, true, 'repair round capability boost', 'repair_round_boost');
    }

    // High confidence score gap → override
    const topScore = input.routerDecision.candidates[0]?.score ?? 0;
    const plannerCandidate = input.routerDecision.candidates.find(
      (c) => c.model === plannerModel,
    );
    const plannerScore = plannerCandidate?.score ?? 0;

    if (topScore - plannerScore >= OVERRIDE_SCORE_GAP) {
      // Check router didn't pick a weaker model for task complexity
      if (!routerModelExceedsComplexity(routerModel, input.task.complexity, input.profiles)) {
        return makeResult(plannerModel, routerModel, true, `scored confidence gap ${(topScore - plannerScore).toFixed(2)}`, 'high_confidence_score');
      }
    }

    // Router disagrees but gap too small → suggest only
    if (plannerModel !== routerModel) {
      return makeResult(plannerModel, routerModel, false, 'score gap below override threshold', 'suggest_only');
    }

    // Router agrees with planner → no override needed
    return makeResult(plannerModel, routerModel, false, 'router agrees with planner', 'conservative_keep');
  }

  // Unknown method → conservative
  return makeResult(plannerModel, routerModel, false, 'unknown selection method', 'conservative_keep');
}

function makeResult(
  plannerModel: string,
  routerModel: string,
  override: boolean,
  reason: string,
  policy: RoutingOverridePolicy,
): RoutingEnforcementResult {
  return {
    planner_assigned_model: plannerModel,
    router_selected_model: routerModel,
    effective_model: override ? routerModel : plannerModel,
    override_applied: override,
    override_reason: reason,
    policy,
  };
}

function routerModelExceedsComplexity(
  modelId: string,
  taskComplexity: string,
  profiles: Record<string, ModelCapabilityProfile>,
): boolean {
  const profile = profiles[modelId];
  if (!profile) return false;
  const complexityOrder = ['low', 'medium', 'medium-high', 'high'] as const;
  const taskLevel = complexityOrder.indexOf(taskComplexity as typeof complexityOrder[number]);
  const maxComplexity = (profile as any).max_complexity;
  if (!maxComplexity) return false;
  const modelLevel = complexityOrder.indexOf(maxComplexity as typeof complexityOrder[number]);
  return taskLevel > modelLevel;
}

/**
 * Determine enforcement action for a discuss gate result.
 * Maps trigger policy → concrete dispatch consequence.
 */
import type {
  DiscussGateResult,
  DiscussTriggerPolicy,
  EscalationTarget,
} from './discuss-gate.js';

export interface DiscussEnforcementInput {
  gateResult: DiscussGateResult;
  routerCandidates: ScoredCandidate[];
  isRepair: boolean;
}

export function enforceDiscussGate(
  input: DiscussEnforcementInput,
): import('./types.js').DiscussEnforcementResult {
  const { gateResult } = input;

  if (!gateResult.discuss_required) {
    return {
      discuss_required: false,
      enforcement_action: 'none',
      effective_path: 'direct',
      dispatch_blocked: false,
      escalation_target: '',
    };
  }

  const action = mapPolicyToAction(gateResult.trigger_policy, gateResult.escalation_target, input);

  return {
    discuss_required: true,
    enforcement_action: action.enforcement_action,
    effective_path: action.effective_path,
    dispatch_blocked: action.dispatch_blocked,
    escalation_target: action.escalation_target,
  };
}

interface ActionMapping {
  enforcement_action: import('./types.js').DiscussEnforcementAction;
  effective_path: import('./types.js').DispatchEffectivePath;
  dispatch_blocked: boolean;
  escalation_target: string;
}

function mapPolicyToAction(
  policy: DiscussTriggerPolicy,
  escalation: EscalationTarget,
  _input: DiscussEnforcementInput,
): ActionMapping {
  const target = resolveEscalationTarget(escalation);

  switch (policy) {
    case 'confidence_threshold':
      return {
        enforcement_action: 'reroute',
        effective_path: 'rerouted',
        dispatch_blocked: false,
        escalation_target: target,
      };

    case 'high_complexity_repair':
      if (escalation.authority === 'opus') {
        return {
          enforcement_action: 'escalate',
          effective_path: 'escalated',
          dispatch_blocked: false,
          escalation_target: target,
        };
      }
      return {
        enforcement_action: 'reroute',
        effective_path: 'rerouted',
        dispatch_blocked: false,
        escalation_target: target,
      };

    case 'high_risk_failure_class':
      if (escalation.authority === 'opus') {
        return {
          enforcement_action: 'escalate',
          effective_path: 'escalated',
          dispatch_blocked: false,
          escalation_target: target,
        };
      }
      return {
        enforcement_action: 'reroute',
        effective_path: 'rerouted',
        dispatch_blocked: false,
        escalation_target: target,
      };

    case 'unstable_retries':
      if (escalation.authority === 'opus') {
        return {
          enforcement_action: 'block',
          effective_path: 'blocked',
          dispatch_blocked: true,
          escalation_target: target,
        };
      }
      return {
        enforcement_action: 'reroute',
        effective_path: 'rerouted',
        dispatch_blocked: false,
        escalation_target: target,
      };

    case 'capability_mismatch':
      return {
        enforcement_action: 'reroute',
        effective_path: 'rerouted',
        dispatch_blocked: false,
        escalation_target: target,
      };

    default:
      return {
        enforcement_action: 'none',
        effective_path: 'direct',
        dispatch_blocked: false,
        escalation_target: '',
      };
  }
}

function resolveEscalationTarget(escalation: EscalationTarget): string {
  if (escalation.type === 'model' && escalation.model) return escalation.model;
  if (escalation.type === 'authority') {
    if (escalation.authority === 'opus') return 'claude-opus';
    if (escalation.authority === 'sonnet') return 'claude-sonnet';
    if (escalation.authority === 'cross_model') return 'cross_model_discuss';
  }
  return '';
}
