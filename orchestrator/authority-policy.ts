import fs from 'fs';
import { resolveProjectPath } from './project-paths.js';

export type AuthorityMode = 'single' | 'pair';
export type PartialResultPolicy = 'proceed_if_min_met' | 'fail_fast';
export type EscalationTrigger =
  | 'high_complexity'
  | 'low_confidence'
  | 'failed_review'
  | 'disagreement';

export interface ReviewAuthorityPolicy {
  enabled: boolean;
  default_mode: AuthorityMode;
  max_models: number;
  primary_candidates: string[];
  fallback_order: string[];
  escalate_on: EscalationTrigger[];
  low_confidence_threshold: number;
  timeout_ms: number;
  partial_result_policy: PartialResultPolicy;
  synthesizer: string;
}

interface AuthorityPolicyFile {
  review?: Partial<ReviewAuthorityPolicy>;
}

const DEFAULT_REVIEW_AUTHORITY_POLICY: ReviewAuthorityPolicy = {
  enabled: false,
  default_mode: 'single',
  max_models: 2,
  primary_candidates: ['kimi-k2.5', 'MiniMax-M2.5', 'qwen3.5-plus', 'glm-5.1'],
  fallback_order: ['kimi-k2.5', 'MiniMax-M2.5', 'qwen3.5-plus', 'glm-5.1', 'gpt-5.4'],
  escalate_on: ['high_complexity', 'low_confidence', 'failed_review', 'disagreement'],
  low_confidence_threshold: 0.75,
  timeout_ms: 30000,
  partial_result_policy: 'proceed_if_min_met',
  synthesizer: 'gpt-5.4',
};

let authorityPolicyCache:
  | { path: string; mtimeMs: number | null; value: ReviewAuthorityPolicy }
  | null = null;

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < 0 || value > 1) return fallback;
  return value;
}

function getFileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

export function normalizeReviewAuthorityPolicy(
  input: Partial<ReviewAuthorityPolicy> | undefined,
): ReviewAuthorityPolicy {
  const raw = input || {};
  const defaultMode = raw.default_mode === 'pair'
    ? raw.default_mode
    : DEFAULT_REVIEW_AUTHORITY_POLICY.default_mode;
  const partialResultPolicy = raw.partial_result_policy === 'fail_fast'
    ? 'fail_fast'
    : DEFAULT_REVIEW_AUTHORITY_POLICY.partial_result_policy;
  const maxModels = Math.max(1, Math.min(2, Math.floor(raw.max_models ?? DEFAULT_REVIEW_AUTHORITY_POLICY.max_models)));

  return {
    enabled: raw.enabled ?? DEFAULT_REVIEW_AUTHORITY_POLICY.enabled,
    default_mode: defaultMode,
    max_models: maxModels,
    primary_candidates: Array.isArray(raw.primary_candidates) && raw.primary_candidates.length > 0
      ? raw.primary_candidates.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : DEFAULT_REVIEW_AUTHORITY_POLICY.primary_candidates,
    fallback_order: Array.isArray(raw.fallback_order) && raw.fallback_order.length > 0
      ? raw.fallback_order.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : DEFAULT_REVIEW_AUTHORITY_POLICY.fallback_order,
    escalate_on: Array.isArray(raw.escalate_on) && raw.escalate_on.length > 0
      ? raw.escalate_on.filter((value): value is EscalationTrigger => typeof value === 'string')
      : DEFAULT_REVIEW_AUTHORITY_POLICY.escalate_on,
    low_confidence_threshold: clamp01(
      Number(raw.low_confidence_threshold),
      DEFAULT_REVIEW_AUTHORITY_POLICY.low_confidence_threshold,
    ),
    timeout_ms: Math.max(1000, Math.floor(raw.timeout_ms ?? DEFAULT_REVIEW_AUTHORITY_POLICY.timeout_ms)),
    partial_result_policy: partialResultPolicy,
    synthesizer: typeof raw.synthesizer === 'string' && raw.synthesizer.length > 0
      ? raw.synthesizer
      : DEFAULT_REVIEW_AUTHORITY_POLICY.synthesizer,
  };
}

export function loadReviewAuthorityPolicy(): ReviewAuthorityPolicy {
  const policyPath = resolveProjectPath('config', 'authority-policy.json');
  const mtimeMs = getFileMtimeMs(policyPath);
  if (
    authorityPolicyCache
    && authorityPolicyCache.path === policyPath
    && authorityPolicyCache.mtimeMs === mtimeMs
  ) {
    return authorityPolicyCache.value;
  }

  let value = DEFAULT_REVIEW_AUTHORITY_POLICY;
  if (fs.existsSync(policyPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(policyPath, 'utf-8')) as AuthorityPolicyFile;
      value = normalizeReviewAuthorityPolicy(parsed.review);
    } catch {
      value = DEFAULT_REVIEW_AUTHORITY_POLICY;
    }
  }

  authorityPolicyCache = { path: policyPath, mtimeMs, value };
  return value;
}
