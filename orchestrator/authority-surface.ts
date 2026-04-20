// orchestrator/authority-surface.ts — CLI surface for authority degradation signals
// Extracts reviewer runtime failures and mode degradation from review results.

import type { ReviewResult, ReviewerRuntimeFailure } from './types.js';

export interface AuthorityDegradationSignal {
  /** 'pair_to_single' | 'all_candidates_failed' | 'reviewer_failed_retried' */
  kind: string;
  severity: 'high' | 'medium';
  description: string;
  failed_reviewers: ReviewerRuntimeFailure[];
  actual_mode: string;
}

export interface AuthoritySurfaceResult {
  degradation?: AuthorityDegradationSignal;
  has_degradation: boolean;
}

/**
 * Scan review results for authority degradation signals.
 * Returns the most severe signal found, or none.
 */
export function extractAuthorityDegradation(
  reviewResults?: ReviewResult[] | null,
): AuthoritySurfaceResult {
  if (!reviewResults || reviewResults.length === 0) {
    return { has_degradation: false };
  }

  const withAuthority = reviewResults.filter((r) => r.authority);
  if (withAuthority.length === 0) {
    return { has_degradation: false };
  }

  // Find the most significant degradation signal
  for (const review of withAuthority) {
    const failures = review.authority?.reviewer_runtime_failures;
    if (!failures || failures.length === 0) continue;

    const mode = review.authority?.mode || 'single';

    if (mode === 'single' && failures.length > 0) {
      // Determine if this was pair→single degradation or all-candidates-failed
      const isAllFailed = review.authority?.members?.length === 0;
      const kind = isAllFailed ? 'all_candidates_failed' : 'pair_to_single';

      return {
        degradation: {
          kind,
          severity: isAllFailed ? 'high' : 'medium',
          description: isAllFailed
            ? `All reviewer candidates failed at runtime — no review executed`
            : `Review degraded: pair → single (${failures.map((f) => f.model).join(', ')} failed)`,
          failed_reviewers: failures,
          actual_mode: mode,
        },
        has_degradation: true,
      };
    }

    if (mode === 'pair' && failures.length > 0) {
      // Pair mode but some reviewers failed and were retried
      return {
        degradation: {
          kind: 'reviewer_failed_retried',
          severity: 'medium',
          description: `Reviewer retry: ${failures.map((f) => `${f.model} (${f.reason})`).join(', ')}`,
          failed_reviewers: failures,
          actual_mode: mode,
        },
        has_degradation: true,
      };
    }
  }

  return { has_degradation: false };
}

/** Format authority degradation for CLI display */
export function formatAuthorityDegradation(signal: AuthorityDegradationSignal): string[] {
  const lines: string[] = [];
  const icon = signal.severity === 'high' ? '⚠️' : '⚡';
  lines.push(`${icon} AUTHORITY: ${signal.description}`);
  for (const f of signal.failed_reviewers) {
    lines.push(`   - ${f.model}: ${f.reason}${f.error_hint ? ` | ${f.error_hint}` : ''}`);
  }
  return lines;
}
