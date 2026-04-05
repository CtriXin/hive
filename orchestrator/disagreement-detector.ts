import type { FindingSeverity, ReviewFinding } from './types.js';

export interface CommitteeMemberReview {
  model: string;
  passed: boolean;
  confidence: number;
  findings: ReviewFinding[];
}

export interface DisagreementDetectionOptions {
  deterministic_failed?: boolean;
}

export interface DisagreementDetectionResult {
  has_disagreement: boolean;
  flags: string[];
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  green: 0,
  yellow: 1,
  red: 2,
};

function locationKey(finding: Pick<ReviewFinding, 'file' | 'line'>): string {
  return `${finding.file}:${finding.line ?? 0}`;
}

export function detectReviewDisagreement(
  reviews: CommitteeMemberReview[],
  options: DisagreementDetectionOptions = {},
): DisagreementDetectionResult {
  const flags = new Set<string>();
  const passedValues = new Set(reviews.map((review) => review.passed));

  if (passedValues.size > 1) {
    flags.add('conclusion_opposite');
  }

  const byLocation = new Map<string, number[]>();
  for (const review of reviews) {
    for (const finding of review.findings) {
      const key = locationKey(finding);
      const values = byLocation.get(key) || [];
      values.push(SEVERITY_RANK[finding.severity]);
      byLocation.set(key, values);
    }
  }

  for (const ranks of byLocation.values()) {
    const max = Math.max(...ranks);
    const min = Math.min(...ranks);
    if (max - min >= 2) {
      flags.add('severity_diff_ge_2');
      break;
    }
  }

  if (options.deterministic_failed && reviews.some((review) => review.passed)) {
    flags.add('deterministic_vs_opinion');
  }

  return {
    has_disagreement: flags.size > 0,
    flags: [...flags],
  };
}
