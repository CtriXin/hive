import type {
  CircuitBreakerState,
  ProviderFailureSubtype,
  ProviderHealthStoreData,
  ProviderResilienceDecision,
  ReviewResult,
} from './types.js';

export interface ProviderRouteSurface {
  source: 'review_result' | 'provider_health';
  task_id?: string;
  provider?: string;
  breaker?: CircuitBreakerState;
  requested_model?: string;
  requested_provider?: string;
  actual_model?: string;
  actual_provider?: string;
  failure_subtype?: ProviderFailureSubtype;
  fallback_used: boolean;
}

function formatEndpointLabel(model?: string, provider?: string): string {
  const safeModel = model || '-';
  if (!provider) return safeModel;
  return `${safeModel}@${provider}`;
}

function isRouteSignal(review: ReviewResult): boolean {
  return Boolean(
    review.provider_fallback_used
      || review.provider_failure_subtype
      || (review.requested_model && review.actual_model && review.requested_model !== review.actual_model)
      || (review.requested_provider && review.actual_provider && review.requested_provider !== review.actual_provider),
  );
}

export function extractLatestProviderRoute(args: {
  reviewResults?: ReviewResult[];
  providerHealth?: ProviderHealthStoreData | null;
}): ProviderRouteSurface | undefined {
  const latestReview = args.reviewResults
    ?.slice()
    .reverse()
    .find(isRouteSignal);
  if (latestReview) {
    return {
      source: 'review_result',
      task_id: latestReview.taskId,
      requested_model: latestReview.requested_model,
      requested_provider: latestReview.requested_provider,
      actual_model: latestReview.actual_model,
      actual_provider: latestReview.actual_provider,
      failure_subtype: latestReview.provider_failure_subtype,
      fallback_used: latestReview.provider_fallback_used === true,
    };
  }

  const latestProviderFailure = Object.entries(args.providerHealth?.providers || {})
    .filter(([, state]) => state.last_failure_at > 0 || state.last_failure_subtype)
    .sort((a, b) => (a[1].last_failure_at || 0) - (b[1].last_failure_at || 0))
    .at(-1);
  if (!latestProviderFailure) return undefined;

  const [provider, state] = latestProviderFailure;
  return {
    source: 'provider_health',
    provider,
    breaker: state.breaker,
    failure_subtype: state.last_failure_subtype,
    fallback_used: false,
  };
}

export function formatProviderRoute(route?: ProviderRouteSurface): string | undefined {
  if (!route) return undefined;

  if (route.source === 'review_result') {
    const requested = formatEndpointLabel(route.requested_model, route.requested_provider);
    const actual = formatEndpointLabel(route.actual_model, route.actual_provider);
    const suffix = route.failure_subtype ? ` | ${route.failure_subtype}` : '';
    return `${route.task_id || 'task'} | ${requested} -> ${actual}${route.fallback_used ? ' [fallback]' : ''}${suffix}`;
  }

  const breaker = route.breaker ? ` | ${route.breaker}` : '';
  const subtype = route.failure_subtype ? ` | ${route.failure_subtype}` : '';
  return `${route.provider || '-'}${breaker}${subtype}`;
}

export function summarizeProviderHealth(providerHealth?: ProviderHealthStoreData | null): string | undefined {
  const entries = Object.entries(providerHealth?.providers || {});
  if (entries.length === 0) return undefined;

  const counts = entries.reduce(
    (acc, [, state]) => {
      acc[state.breaker] = (acc[state.breaker] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const parts = [
    `${entries.length} total`,
    `${counts.healthy || 0} healthy`,
  ];
  if ((counts.degraded || 0) > 0) parts.push(`${counts.degraded} degraded`);
  if ((counts.open || 0) > 0) parts.push(`${counts.open} open`);
  if ((counts.probing || 0) > 0) parts.push(`${counts.probing} probing`);
  return parts.join(' | ');
}

export function latestProviderDecision(
  providerHealth?: ProviderHealthStoreData | null,
): ProviderResilienceDecision | undefined {
  return providerHealth?.decisions?.slice().sort((a, b) => a.timestamp - b.timestamp).at(-1);
}

export function formatProviderDecision(
  decision?: ProviderResilienceDecision,
): string | undefined {
  if (!decision) return undefined;
  const fallback = decision.fallback_provider ? ` -> ${decision.fallback_provider}` : '';
  return `${decision.provider} | ${decision.failure_subtype} -> ${decision.action}${fallback} | ${decision.action_reason}`;
}
