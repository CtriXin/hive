// orchestrator/review-utils.ts — Shared utilities for review cascade
// Shared primitives (extractJsonObject, normalizeSeverity, etc.) re-exported from discuss-lib.
// Hive-specific functions (infra failure detection, auto-pass, review policy) kept here.
import fs from 'fs';
import type { SubTask, FindingSeverity, Complexity } from './types.js';
import type { FailureType } from './hive-config.js';
import {
  resolveProvider as resolveConfiguredProvider,
  resolveProviderForModel,
} from './provider-resolver.js';
import type { LegacyModelView } from './model-registry.js';
import { resolveProjectPath, buildSdkEnv } from './project-paths.js';
import { safeQuery, extractTextFromMessages, extractTokenUsage } from './sdk-query-safe.js';

// ── Re-export shared primitives from discuss-lib ──

export {
  extractJsonObject,
  normalizeSeverity,
} from './discuss-lib/index.js';

export {
  getWorktreeFullDiff,
} from './discuss-lib/index.js';

// truncateDiff: discuss-lib has it inside cross-review (not exported).
// Keep our own thin version here.
export function truncateDiff(diff: string, limit: number): string {
  if (diff.length <= limit) return diff;
  return `${diff.slice(0, limit)}\n\n[DIFF TRUNCATED: showing first ${limit} characters of ${diff.length}]`;
}

// ── Review policy (hive-only) ──

export interface ReviewPolicy {
  auto_pass_categories: string[];
  cross_review: {
    min_confidence_to_skip: number;
    min_pass_rate_for_skip: number;
    max_complexity_for_skip: string;
  };
  a2a: {
    max_reject_iterations: number;
    contested_threshold: string;
  };
  arbitration: {
    sonnet_max_iterations: number;
  };
}

const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  auto_pass_categories: ['docs', 'comments', 'formatting', 'i18n'],
  cross_review: {
    min_confidence_to_skip: 0.85,
    min_pass_rate_for_skip: 0.90,
    max_complexity_for_skip: 'medium',
  },
  a2a: {
    max_reject_iterations: 1,
    contested_threshold: 'CONTESTED',
  },
  arbitration: {
    sonnet_max_iterations: 1,
  },
};

let reviewPolicyCache:
  | { path: string; mtimeMs: number | null; value: ReviewPolicy }
  | null = null;

function getFileMtimeMs(filePath: string): number | null {
  try { return fs.statSync(filePath).mtimeMs; } catch { return null; }
}

export function loadReviewPolicy(): ReviewPolicy {
  const policyPath = resolveProjectPath('config', 'review-policy.json');
  const mtimeMs = getFileMtimeMs(policyPath);
  if (reviewPolicyCache && reviewPolicyCache.path === policyPath && reviewPolicyCache.mtimeMs === mtimeMs) {
    return reviewPolicyCache.value;
  }
  if (fs.existsSync(policyPath)) {
    try {
      const content = fs.readFileSync(policyPath, 'utf-8');
      const value = { ...DEFAULT_REVIEW_POLICY, ...JSON.parse(content) };
      reviewPolicyCache = { path: policyPath, mtimeMs, value };
      return value;
    } catch { /* fall through */ }
  }
  return DEFAULT_REVIEW_POLICY;
}

// ── Infrastructure failure detection (hive-only) ──

const INFRA_FAILURE_PATTERNS = [
  'rate limit', 'overloaded', 'timeout', 'econnrefused', 'network',
  'provider', 'api key', 'auth', 'connection reset', 'socket hang up',
  'service unavailable', '502', '503', '504', '429',
];

export function looksLikeInfrastructureFailure(text: string): boolean {
  const lower = text.toLowerCase();
  return INFRA_FAILURE_PATTERNS.some((p) => lower.includes(p));
}

export function classifyReviewError(err: any): FailureType {
  if (err?.status === 429 || err?.message?.includes('overloaded') || err?.message?.includes('rate')) return 'rate_limit';
  if (err?.status >= 500 || err?.message?.includes('timeout') || err?.message?.includes('ECONNREFUSED')) return 'server_error';
  return 'quality_fail';
}

// ── Auto-pass check (hive-only) ──

export function shouldAutoPass(
  task: SubTask, changedFiles: string[], policy: ReviewPolicy,
): boolean {
  // Guard: empty changedFiles must never auto-pass ([].every() is vacuously true)
  if (changedFiles.length === 0) return false;
  const allOk = changedFiles.every((f) => {
    const ext = f.split('.').pop()?.toLowerCase() ?? '';
    return ['md', 'txt', 'rst'].includes(ext)
      || f.includes('comment') || f.includes('locale') || f.includes('i18n')
      || f.includes('translation') || f.includes('format') || f.includes('lint');
  });
  return allOk && !!task.category && policy.auto_pass_categories.includes(task.category);
}

// ── Complexity comparison (hive-only) ──

const COMPLEXITY_RANK: Record<Complexity, number> = {
  low: 0, medium: 1, 'medium-high': 2, high: 3,
};

export function isComplexityAtOrBelow(complexity: Complexity, threshold: string): boolean {
  const norm = (['low', 'medium', 'medium-high', 'high'] as const).includes(threshold as Complexity)
    ? threshold as Complexity : 'medium';
  return COMPLEXITY_RANK[complexity] <= COMPLEXITY_RANK[norm];
}

// ── Misc helpers (hive-only) ──

export function normalizeProviderId(modelView: LegacyModelView | undefined): string | undefined {
  return modelView?.provider;
}

// ── Model query helper (hive-only, uses provider-resolver) ──

export interface QueryModelResult {
  text: string;
  tokenUsage: { input: number; output: number };
}

export async function queryModelText(
  prompt: string, cwd: string, modelId: string,
  providerId?: string, maxTurns = 2, timeoutMs = 30000,
): Promise<QueryModelResult> {
  let env: Record<string, string>;
  if (providerId) {
    const resolved = resolveConfiguredProvider(providerId, modelId);
    env = buildSdkEnv(modelId, resolved.baseUrl, resolved.apiKey);
  } else {
    const resolved = resolveProviderForModel(modelId);
    env = buildSdkEnv(modelId, resolved.baseUrl, resolved.apiKey);
  }

  const result = await Promise.race([
    safeQuery({ prompt, options: { cwd, env, maxTurns } }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Review model timeout after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);

  return {
    text: extractTextFromMessages(result.messages),
    tokenUsage: extractTokenUsage(result.messages),
  };
}
