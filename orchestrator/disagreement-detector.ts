import type { FindingSeverity, ReviewFinding } from './types.js';

/**
 * CommitteeMemberReview — 统一审查成员输出 schema
 *
 * 所有审查成员 (primary/challenger) 必须输出此格式：
 * - model: 模型 ID (如 "kimi-k2.5")
 * - passed: boolean — true=通过，false=需要修复
 * - confidence: 0-1 — 置信度分数
 * - findings: ReviewFinding[] — 发现的问题列表
 */
export interface CommitteeMemberReview {
  model: string;
  passed: boolean;
  confidence: number;
  findings: ReviewFinding[];
}

/**
 * 审查成员 JSON 输出模板 (用于 prompt 中要求模型输出)
 *
 * 示例：
 * {
 *   "passed": false,
 *   "confidence": 0.82,
 *   "summary": "Brief explanation of the decision",
 *   "flagged_issues": [
 *     {
 *       "severity": "red",
 *       "file": "src/app.ts:10",
 *       "description": "Must fix this issue"
 *     }
 *   ]
 * }
 */
export interface CommitteeMemberJsonOutput {
  passed: boolean;
  confidence: number;
  summary?: string;
  flagged_issues?: Array<{
    severity: FindingSeverity;
    file: string;
    description: string;
  }>;
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

  // Flag 1: conclusion_opposite — 一个说 pass，一个说 fail
  if (passedValues.size > 1) {
    flags.add('conclusion_opposite');
  }

  // Flag 2: severity_diff_ge_2 — 同一位置 severity 相差≥2 级 (green→red)
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

  // Flag 3: deterministic_vs_opinion — 确定性层失败但审查员说 pass
  if (options.deterministic_failed && reviews.some((review) => review.passed)) {
    flags.add('deterministic_vs_opinion');
  }

  // Flag 4: fix_conflict — 两个审查员对同一问题给出冲突的修复建议
  const byIssue = new Map<string, string[]>();
  for (const review of reviews) {
    for (const finding of review.findings) {
      const issueKey = `${finding.file}:${finding.issue}`;
      const fixes = byIssue.get(issueKey) || [];
      if (finding.decision_reason) {
        fixes.push(finding.decision_reason);
      }
      byIssue.set(issueKey, fixes);
    }
  }

  for (const reasons of byIssue.values()) {
    if (reasons.length >= 2) {
      // 简单启发式：如果两个 reason 长度差异大且无明显包含关系，视为冲突
      const [a, b] = reasons;
      if (a !== b && !a.includes(b) && !b.includes(a)) {
        flags.add('fix_conflict');
        break;
      }
    }
  }

  return {
    has_disagreement: flags.size > 0,
    flags: [...flags],
  };
}
