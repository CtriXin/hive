import { describe, expect, it } from 'vitest';
import { enforceRoutingOverride, enforceDiscussGate } from '../orchestrator/routing-enforcement.js';
import type { SubTask, RoutingOverridePolicy } from '../orchestrator/types.js';
import type { RoutingDecision, ScoredCandidate, ModelCapabilityProfile } from '../orchestrator/capability-router.js';

// ═══════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════

const makeTask = (overrides: Partial<SubTask> = {}): SubTask => ({
  id: 'task-a',
  description: 'Test task',
  complexity: 'medium',
  category: 'implementation',
  assigned_model: 'qwen3.5-plus',
  assignment_reason: 'default plan model selection',
  estimated_files: [],
  acceptance_criteria: [],
  discuss_threshold: 0.6,
  depends_on: [],
  review_scale: 'auto',
  ...overrides,
});

const makeCandidates = (overrides: Partial<ScoredCandidate>[] = []): ScoredCandidate[] => {
  const defaults: ScoredCandidate[] = [
    { model: 'kimi-k2.5', provider: 'kimi', score: 0.82, reasons: ['base implementation: 0.900'], deprioritized: false },
    { model: 'qwen3.5-plus', provider: 'qwen', score: 0.60, reasons: ['base implementation: 0.600'], deprioritized: false },
  ];
  for (const [i, o] of overrides.entries()) {
    Object.assign(defaults[i], o);
  }
  return defaults;
};

const makeRoutingDecision = (overrides: Partial<RoutingDecision> = {}): RoutingDecision => ({
  selectedModel: 'kimi-k2.5',
  selectedProvider: 'kimi',
  selectionMethod: 'scored',
  candidates: makeCandidates(),
  reasons: ['kimi-k2.5 selected'],
  timestamp: Date.now(),
  ...overrides,
});

const profiles: Record<string, ModelCapabilityProfile> = {
  'kimi-k2.5': {
    scores: {} as any,
    domain_tags: [],
    avoid_tags: [],
  },
  'qwen3.5-plus': {
    scores: {} as any,
    domain_tags: [],
    avoid_tags: [],
  },
};

// ═══════════════════════════════════════════════════════════════════
// Routing Override Tests
// ═══════════════════════════════════════════════════════════════════

describe('routing override: high confidence score', () => {
  it('overrides planner when scored with sufficient gap', () => {
    const result = enforceRoutingOverride({
      task: makeTask(),
      routerDecision: makeRoutingDecision(),
      isRepair: false,
      plannerProviderCooledDown: false,
      routerSelectedProviderCooledDown: false,
      profiles,
    });

    expect(result.override_applied).toBe(true);
    expect(result.effective_model).toBe('kimi-k2.5');
    expect(result.policy).toBe('high_confidence_score');
    expect(result.override_reason).toContain('confidence gap');
  });

  it('does NOT override when score gap below threshold', () => {
    const result = enforceRoutingOverride({
      task: makeTask(),
      routerDecision: makeRoutingDecision({
        candidates: [
          { model: 'kimi-k2.5', provider: 'kimi', score: 0.65, reasons: [], deprioritized: false },
          { model: 'qwen3.5-plus', provider: 'qwen', score: 0.60, reasons: [], deprioritized: false },
        ],
      }),
      isRepair: false,
      plannerProviderCooledDown: false,
      routerSelectedProviderCooledDown: false,
      profiles,
    });

    expect(result.override_applied).toBe(false);
    expect(result.effective_model).toBe('qwen3.5-plus');
    expect(result.policy).toBe('suggest_only');
  });
});

describe('routing override: provider cooldown', () => {
  it('overrides when planner provider is in cooldown', () => {
    const result = enforceRoutingOverride({
      task: makeTask(),
      routerDecision: makeRoutingDecision({
        candidates: [
          { model: 'qwen3.5-plus', provider: 'qwen', score: 0.90, reasons: [], deprioritized: false },
          { model: 'kimi-k2.5', provider: 'kimi', score: 0.85, reasons: [], deprioritized: false },
        ],
      }),
      isRepair: false,
      plannerProviderCooledDown: true,
      routerSelectedProviderCooledDown: false,
      profiles,
    });

    expect(result.override_applied).toBe(true);
    expect(result.policy).toBe('provider_cooldown');
    expect(result.override_reason).toContain('cooldown');
  });

  it('does NOT use heuristic method to override', () => {
    const result = enforceRoutingOverride({
      task: makeTask(),
      routerDecision: makeRoutingDecision({ selectionMethod: 'heuristic' }),
      isRepair: false,
      plannerProviderCooledDown: false,
      routerSelectedProviderCooledDown: false,
      profiles,
    });

    expect(result.override_applied).toBe(false);
    expect(result.policy).toBe('conservative_keep');
  });
});

describe('routing override: repair round', () => {
  it('overrides in repair round', () => {
    const result = enforceRoutingOverride({
      task: makeTask(),
      routerDecision: makeRoutingDecision(),
      isRepair: true,
      plannerProviderCooledDown: false,
      routerSelectedProviderCooledDown: false,
      profiles,
    });

    expect(result.override_applied).toBe(true);
    expect(result.policy).toBe('repair_round_boost');
  });
});

describe('routing override: fallback', () => {
  it('applies best available in fallback mode', () => {
    const result = enforceRoutingOverride({
      task: makeTask(),
      routerDecision: makeRoutingDecision({ selectionMethod: 'fallback' }),
      isRepair: false,
      plannerProviderCooledDown: false,
      routerSelectedProviderCooledDown: false,
      profiles,
    });

    expect(result.override_applied).toBe(true);
    expect(result.policy).toBe('fallback_best_available');
    expect(result.effective_model).toBe('kimi-k2.5');
  });
});

describe('routing override: conservative keep', () => {
  it('keeps planner when router agrees', () => {
    const result = enforceRoutingOverride({
      task: makeTask({ assigned_model: 'kimi-k2.5' }),
      routerDecision: makeRoutingDecision({
        selectedModel: 'kimi-k2.5',
        candidates: [
          { model: 'kimi-k2.5', provider: 'kimi', score: 0.90, reasons: [], deprioritized: false },
          { model: 'qwen3.5-plus', provider: 'qwen', score: 0.60, reasons: [], deprioritized: false },
        ],
      }),
      isRepair: false,
      plannerProviderCooledDown: false,
      routerSelectedProviderCooledDown: false,
      profiles,
    });

    expect(result.override_applied).toBe(false);
    expect(result.override_reason).toContain('agrees');
    expect(result.policy).toBe('conservative_keep');
  });
});

describe('routing enforcement: dispatch record completeness', () => {
  it('includes planner_assigned, router_selected, effective, override, reason', () => {
    const result = enforceRoutingOverride({
      task: makeTask(),
      routerDecision: makeRoutingDecision(),
      isRepair: false,
      plannerProviderCooledDown: false,
      routerSelectedProviderCooledDown: false,
      profiles,
    });

    expect(result.planner_assigned_model).toBe('qwen3.5-plus');
    expect(result.router_selected_model).toBe('kimi-k2.5');
    expect(result.effective_model).toBeTruthy();
    expect(typeof result.override_applied).toBe('boolean');
    expect(result.override_reason.length).toBeGreaterThan(0);
    expect(result.policy).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Discuss Gate Enforcement Tests
// ═══════════════════════════════════════════════════════════════════

import type { DiscussGateResult, EscalationTarget } from '../orchestrator/discuss-gate.js';

const makeGateResult = (overrides: Partial<DiscussGateResult> = {}): DiscussGateResult => ({
  discuss_required: false,
  trigger_reason: '',
  trigger_policy: 'none',
  escalation_target: { type: 'none', recommendation: 'No escalation needed' },
  ...overrides,
});

const makeEscalation = (overrides: Partial<EscalationTarget> = {}): EscalationTarget => ({
  type: 'none',
  recommendation: '',
  ...overrides,
});

describe('discuss gate enforcement: no trigger', () => {
  it('returns none when gate not triggered', () => {
    const result = enforceDiscussGate({
      gateResult: makeGateResult(),
      routerCandidates: [],
      isRepair: false,
    });

    expect(result.discuss_required).toBe(false);
    expect(result.enforcement_action).toBe('none');
    expect(result.effective_path).toBe('direct');
    expect(result.dispatch_blocked).toBe(false);
  });
});

describe('discuss gate enforcement: confidence threshold', () => {
  it('reroutes for low confidence', () => {
    const result = enforceDiscussGate({
      gateResult: makeGateResult({
        discuss_required: true,
        trigger_reason: 'Worker confidence 0.40 below threshold',
        trigger_policy: 'confidence_threshold',
        escalation_target: makeEscalation({
          type: 'authority',
          authority: 'sonnet',
          recommendation: 'Low confidence—escalate to Sonnet',
        }),
      }),
      routerCandidates: [],
      isRepair: false,
    });

    expect(result.discuss_required).toBe(true);
    expect(result.enforcement_action).toBe('reroute');
    expect(result.effective_path).toBe('rerouted');
    expect(result.dispatch_blocked).toBe(false);
    expect(result.escalation_target).toBe('claude-sonnet');
  });
});

describe('discuss gate enforcement: high complexity repair', () => {
  it('escalates to Opus for high complexity + retry >= 2', () => {
    const result = enforceDiscussGate({
      gateResult: makeGateResult({
        discuss_required: true,
        trigger_reason: 'High complexity repair',
        trigger_policy: 'high_complexity_repair',
        escalation_target: makeEscalation({
          type: 'authority',
          authority: 'opus',
          recommendation: 'High complexity repair—escalate to Opus',
        }),
      }),
      routerCandidates: [],
      isRepair: true,
    });

    expect(result.discuss_required).toBe(true);
    expect(result.enforcement_action).toBe('escalate');
    expect(result.effective_path).toBe('escalated');
    expect(result.dispatch_blocked).toBe(false);
    expect(result.escalation_target).toBe('claude-opus');
  });

  it('reroutes for medium-high complexity repair', () => {
    const result = enforceDiscussGate({
      gateResult: makeGateResult({
        discuss_required: true,
        trigger_reason: 'High complexity repair',
        trigger_policy: 'high_complexity_repair',
        escalation_target: makeEscalation({
          type: 'model',
          model: 'kimi-k2.5',
          recommendation: 'Complex task repair—discuss with partner',
        }),
      }),
      routerCandidates: [],
      isRepair: true,
    });

    expect(result.enforcement_action).toBe('reroute');
    expect(result.effective_path).toBe('rerouted');
    expect(result.escalation_target).toBe('kimi-k2.5');
  });
});

describe('discuss gate enforcement: high risk failure class', () => {
  it('escalates for planner failure', () => {
    const result = enforceDiscussGate({
      gateResult: makeGateResult({
        discuss_required: true,
        trigger_reason: 'High-risk failure class: planner',
        trigger_policy: 'high_risk_failure_class',
        escalation_target: makeEscalation({
          type: 'authority',
          authority: 'opus',
          recommendation: 'Planner failure—escalate to Opus',
        }),
      }),
      routerCandidates: [],
      isRepair: false,
    });

    expect(result.enforcement_action).toBe('escalate');
    expect(result.effective_path).toBe('escalated');
    expect(result.escalation_target).toBe('claude-opus');
  });

  it('reroutes for context failure', () => {
    const result = enforceDiscussGate({
      gateResult: makeGateResult({
        discuss_required: true,
        trigger_reason: 'High-risk failure class: context',
        trigger_policy: 'high_risk_failure_class',
        escalation_target: makeEscalation({
          type: 'authority',
          authority: 'cross_model',
          recommendation: 'Context misunderstanding—cross-model discussion',
        }),
      }),
      routerCandidates: [],
      isRepair: false,
    });

    expect(result.enforcement_action).toBe('reroute');
    expect(result.effective_path).toBe('rerouted');
    expect(result.escalation_target).toBe('cross_model_discuss');
  });

  it('reroutes for scope failure', () => {
    const result = enforceDiscussGate({
      gateResult: makeGateResult({
        discuss_required: true,
        trigger_reason: 'High-risk failure class: scope',
        trigger_policy: 'high_risk_failure_class',
        escalation_target: makeEscalation({
          type: 'authority',
          authority: 'sonnet',
          recommendation: 'Scope violation—Sonnet review',
        }),
      }),
      routerCandidates: [],
      isRepair: false,
    });

    expect(result.enforcement_action).toBe('reroute');
    expect(result.escalation_target).toBe('claude-sonnet');
  });
});

describe('discuss gate enforcement: unstable retries', () => {
  it('blocks for retry >= 5 with Opus authority', () => {
    const result = enforceDiscussGate({
      gateResult: makeGateResult({
        discuss_required: true,
        trigger_reason: 'Persistent instability',
        trigger_policy: 'unstable_retries',
        escalation_target: makeEscalation({
          type: 'authority',
          authority: 'opus',
          recommendation: 'Opus arbitration required',
        }),
      }),
      routerCandidates: [],
      isRepair: true,
    });

    expect(result.enforcement_action).toBe('block');
    expect(result.effective_path).toBe('blocked');
    expect(result.dispatch_blocked).toBe(true);
    expect(result.escalation_target).toBe('claude-opus');
  });

  it('reroutes for 3-4 retries', () => {
    const result = enforceDiscussGate({
      gateResult: makeGateResult({
        discuss_required: true,
        trigger_reason: 'Multiple retries',
        trigger_policy: 'unstable_retries',
        escalation_target: makeEscalation({
          type: 'authority',
          authority: 'cross_model',
          recommendation: 'Cross-model analysis needed',
        }),
      }),
      routerCandidates: [],
      isRepair: true,
    });

    expect(result.enforcement_action).toBe('reroute');
    expect(result.dispatch_blocked).toBe(false);
  });
});

describe('discuss gate enforcement: capability mismatch', () => {
  it('reroutes to capable model', () => {
    const result = enforceDiscussGate({
      gateResult: makeGateResult({
        discuss_required: true,
        trigger_reason: 'Task complexity high exceeds model max medium',
        trigger_policy: 'capability_mismatch',
        escalation_target: makeEscalation({
          type: 'model',
          model: 'kimi-k2.5',
          recommendation: 'Capability mismatch—escalate',
        }),
      }),
      routerCandidates: [],
      isRepair: false,
    });

    expect(result.enforcement_action).toBe('reroute');
    expect(result.effective_path).toBe('rerouted');
    expect(result.escalation_target).toBe('kimi-k2.5');
  });
});
