// ═══════════════════════════════════════════════════════════════════
// orchestrator/reviewer.ts — 4-stage review cascade (cross-review → a2a → Sonnet → Opus)
// ═══════════════════════════════════════════════════════════════════

import { query } from '@anthropic-ai/claude-code';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import type {
  WorkerResult, SubTask, TaskPlan, ReviewResult, ReviewFinding,
  CrossReviewResult, A2aReviewResult, A2aVerdict,
  FindingSeverity, Complexity, HiveConfig,
} from './types.js';
import { loadConfig, resolveFallback, type FailureType } from './hive-config.js';
import { runA2aReview } from './a2a-bridge.js';
import {
  getAllProviders,
  isGatewayMode,
  resolveProvider as resolveConfiguredProvider,
} from './provider-resolver.js';
import { ModelRegistry, type LegacyModelView } from './model-registry.js';
import { buildTaskFingerprint } from './task-fingerprint.js';
import type { TaskFingerprint } from './task-fingerprint.js';
import { resolveProjectPath } from './project-paths.js';

// Review policy defaults (fallback if config/review-policy.json missing)
const DEFAULT_REVIEW_POLICY = {
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

interface ReviewPolicy {
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

const INFRA_FAILURE_PATTERNS = [
  'rate limit',
  'overloaded',
  'timeout',
  'econnrefused',
  'network',
  'provider',
  'api key',
  'auth',
  'connection reset',
  'socket hang up',
  'service unavailable',
  '502',
  '503',
  '504',
  '429',
];

let reviewPolicyCache:
  | { path: string; mtimeMs: number | null; value: ReviewPolicy }
  | null = null;

// Load review policy from config or use defaults
function loadReviewPolicy(): ReviewPolicy {
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
    } catch {
      return DEFAULT_REVIEW_POLICY;
    }
  }
  return DEFAULT_REVIEW_POLICY;
}

function getFileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function looksLikeInfrastructureFailure(text: string): boolean {
  const lower = text.toLowerCase();
  return INFRA_FAILURE_PATTERNS.some((pattern) => lower.includes(pattern));
}

// Check if task qualifies for auto-pass (docs/comments only)
function shouldAutoPass(task: SubTask, changedFiles: string[], policy: ReviewPolicy): boolean {
  const allInAutoPass = changedFiles.every(f => {
    const ext = path.extname(f).toLowerCase();
    const isDoc = ext === '.md' || ext === '.txt' || ext === '.rst';
    const isCommentOnly = f.includes('comment');
    const isI18n = f.includes('locale') || f.includes('i18n') || f.includes('translation');
    const isFormatting = f.includes('format') || f.includes('lint');
    return isDoc || isCommentOnly || isI18n || isFormatting;
  });

  if (allInAutoPass && task.category && policy.auto_pass_categories.includes(task.category)) {
    return true;
  }
  return false;
}

function normalizeProviderId(modelView: LegacyModelView | undefined): string | undefined {
  return modelView?.provider;
}

const COMPLEXITY_RANK: Record<Complexity, number> = {
  low: 0,
  medium: 1,
  'medium-high': 2,
  high: 3,
};

function isComplexityAtOrBelow(
  complexity: Complexity,
  threshold: string,
): boolean {
  const normalized = (['low', 'medium', 'medium-high', 'high'] as const).includes(
    threshold as Complexity,
  )
    ? threshold as Complexity
    : 'medium';
  return COMPLEXITY_RANK[complexity] <= COMPLEXITY_RANK[normalized];
}

function normalizeSeverity(input: unknown): FindingSeverity {
  return input === 'red' || input === 'green' || input === 'yellow'
    ? input
    : 'yellow';
}

// Get git diff from worktree (self-contained, no external dependency)
function getWorktreeFullDiff(worktreePath: string): string {
  try {
    return execSync('git diff HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch {
    return '';
  }
}

function truncateDiff(diff: string, limit: number): string {
  if (diff.length <= limit) {
    return diff;
  }
  return `${diff.slice(0, limit)}\n\n[DIFF TRUNCATED: showing first ${limit} characters of ${diff.length}]`;
}

function extractJsonObject(rawOutput: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < rawOutput.length; i += 1) {
    const char = rawOutput[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return rawOutput.slice(start, i + 1);
      }
    }
  }

  return null;
}

async function collectAssistantText(
  messages: AsyncIterable<any>,
  timeoutMs: number,
): Promise<string> {
  return await Promise.race([
    (async () => {
      let output = '';
      for await (const msg of messages) {
        if (msg.type === 'assistant') {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            output += content.map((block) => block.type === 'text' ? block.text : '').join('');
          } else if (typeof content === 'string') {
            output += content;
          }
        }
      }
      return output;
    })(),
    new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error(`Review model timeout after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

function classifyReviewError(err: any): FailureType {
  if (err?.status === 429 || err?.message?.includes('overloaded') || err?.message?.includes('rate')) {
    return 'rate_limit';
  }
  if (err?.status >= 500 || err?.message?.includes('timeout') || err?.message?.includes('ECONNREFUSED')) {
    return 'server_error';
  }
  return 'quality_fail';
}

async function queryModelText(
  prompt: string,
  cwd: string,
  modelId: string,
  providerId?: string,
  maxTurns = 2,
  timeoutMs = 30000,
): Promise<string> {
  let env: Record<string, string>;
  if (providerId) {
    const resolved = resolveConfiguredProvider(providerId);
    env = {
      ANTHROPIC_BASE_URL: resolved.baseUrl,
      ANTHROPIC_AUTH_TOKEN: resolved.apiKey,
      ANTHROPIC_MODEL: modelId,
    };
  } else if (isGatewayMode()) {
    const gatewayProvider = Object.keys(getAllProviders())[0];
    if (!gatewayProvider) {
      throw new Error('Gateway mode enabled but no providers are configured');
    }
    const resolved = resolveConfiguredProvider(gatewayProvider);
    env = {
      ANTHROPIC_BASE_URL: resolved.baseUrl,
      ANTHROPIC_AUTH_TOKEN: resolved.apiKey,
      ANTHROPIC_MODEL: modelId,
    };
  } else {
    env = {
      ANTHROPIC_MODEL: modelId,
    };
  }

  const messages = query({
    prompt,
    options: {
      cwd,
      env,
      maxTurns,
    },
  });

  return collectAssistantText(messages, timeoutMs);
}

// Stage 1: Cross-review — one domestic model reviews another's work
async function runCrossReview(
  workerResult: WorkerResult,
  task: SubTask,
  reviewerModel: string,
  reviewerProvider: string | undefined,
  fallbackRegistry: ModelRegistry,
  hiveConfig: HiveConfig,
): Promise<CrossReviewResult> {
  const diff = getWorktreeFullDiff(workerResult.worktreePath);

  const prompt = `You are reviewing code changes from another AI model. Be thorough but constructive.

TASK: ${task.description}
CATEGORY: ${task.category}
COMPLEXITY: ${task.complexity}

DIFF:
\`\`\`
${truncateDiff(diff, 10000)}
\`\`\`

Review the code above. Output EXACTLY this JSON:
{
  "passed": true|false,
  "confidence": 0.0-1.0,
  "flagged_issues": [
    {"severity": "red|yellow|green", "file": "path:line", "description": "brief issue description"}
  ],
  "summary": "1-2 sentence overall assessment"
}

Rules:
- passed=true if no red issues and confidence >= 0.85
- Be critical but fair — this will be reviewed again if issues found
- Output ONLY the JSON, no other text`;

  console.log(`    🔍 Cross-review: ${workerResult.model} → ${reviewerModel}`);

  try {
    let rawOutput: string;
    try {
      rawOutput = await queryModelText(prompt, workerResult.worktreePath, reviewerModel, reviewerProvider, 2);
    } catch (err: any) {
      const fallbackModel = resolveFallback(
        reviewerModel,
        classifyReviewError(err),
        task,
        hiveConfig,
        fallbackRegistry,
      );
      const fallbackProvider = normalizeProviderId(fallbackRegistry.getModel(fallbackModel));
      rawOutput = await queryModelText(prompt, workerResult.worktreePath, fallbackModel, fallbackProvider, 2);
    }

    // Parse JSON response
    const jsonPayload = extractJsonObject(rawOutput);
    if (!jsonPayload) {
      return {
        passed: false,
        confidence: 0,
        flagged_issues: [{
          severity: 'red',
          file: 'review-response',
          issue: 'Could not parse review response',
        }],
        reviewer_model: reviewerModel,
      };
    }

    const parsed = JSON.parse(jsonPayload);
    return {
      passed: parsed.passed === true,
      confidence: Math.max(0, Math.min(1, parsed.confidence || 0)),
      flagged_issues: (parsed.flagged_issues || []).map((item: any) => {
        if (typeof item === 'string') {
          const [location, ...rest] = item.split(':');
          const maybeLine = Number.parseInt(rest[0] ?? '', 10);
          return {
            severity: 'yellow' as const,
            file: location || 'unknown',
            line: Number.isFinite(maybeLine) ? maybeLine : undefined,
            issue: rest.slice(Number.isFinite(maybeLine) ? 1 : 0).join(':').trim() || item,
          };
        }

        const rawFile = typeof item?.file === 'string' ? item.file : 'unknown';
        const [filePath, lineText] = rawFile.split(':');
        const line = Number.parseInt(lineText ?? '', 10);
        return {
          severity: normalizeSeverity(item?.severity),
          file: filePath || 'unknown',
          line: Number.isFinite(line) ? line : undefined,
          issue: String(item?.description || item?.issue || 'Cross-review issue').slice(0, 300),
        };
      }),
      reviewer_model: reviewerModel,
    };
  } catch (err: any) {
    console.error(`    ❌ Cross-review failed: ${err.message?.slice(0, 100)}`);
    return {
      passed: false,
      confidence: 0,
      flagged_issues: [{
        severity: 'red',
        file: 'review-response',
        issue: `Review failed: ${err.message?.slice(0, 100)}`,
      }],
      reviewer_model: reviewerModel,
    };
  }
}

// Stage 3: Sonnet arbitration for contested findings
async function runSonnetArbitration(
  workerResult: WorkerResult,
  task: SubTask,
  a2aResult: A2aReviewResult,
  _iteration: number,
  fallbackRegistry: ModelRegistry,
  hiveConfig: HiveConfig,
): Promise<{ findings: ReviewFinding[]; passed: boolean; fixInstructions?: string; infraFailure?: boolean }> {
  const redFindings = a2aResult.all_findings.filter(f => f.severity === 'red');
  const disputedFiles = [...new Set(redFindings.map(f => f.file.split(':')[0]))];

  const diff = getWorktreeFullDiff(workerResult.worktreePath);

  const prompt = `You are the final arbiter in a code review. The a2a review found RED (blocking) issues.

TASK: ${task.description}

DISPUTED RED FINDINGS (only these need your judgment):
${redFindings.map(f => `- [${f.lens}] ${f.file}: ${f.issue}`).join('\n')}

FILES WITH DISPUTES: ${disputedFiles.join(', ')}

FULL DIFF FOR CONTEXT:
\`\`\`
${truncateDiff(diff, 8000)}
\`\`\`

Your job: Review ONLY the disputed red findings above.

Output EXACTLY this JSON:
{
  "decision": "accept|reject|modify",
  "rationale": "Why you made this decision",
  "confirmed_findings": [
    {"file": "path:line", "severity": "red|yellow", "issue": "confirmed or modified issue text"}
  ],
  "dismissed_findings": ["file:line"],
  "fix_instructions": "If rejecting, describe what needs to be fixed"
}

Rules:
- decision=accept: Red findings are valid, code needs changes
- decision=reject: Red findings are incorrect, code is acceptable
- decision=modify: Convert some red to yellow, provide guidance
- Be decisive — this is the final review stage`;

  let response: string;
  try {
    response = await queryModelText(prompt, workerResult.worktreePath, hiveConfig.review_tier, undefined, 1);
  } catch (err: any) {
    try {
      const fallbackModel = resolveFallback(
        hiveConfig.review_tier,
        classifyReviewError(err),
        task,
        hiveConfig,
        fallbackRegistry,
      );
      const fallbackProvider = normalizeProviderId(fallbackRegistry.getModel(fallbackModel));
      response = fallbackProvider
        ? await queryModelText(prompt, workerResult.worktreePath, fallbackModel, fallbackProvider, 2)
        : await queryModelText(prompt, workerResult.worktreePath, fallbackModel, undefined, 1);
    } catch (fallbackErr: any) {
      console.error(`    ❌ Sonnet arbitration failed: ${fallbackErr.message?.slice(0, 100)}`);
      return {
        findings: redFindings.map((f, i) => ({
          ...f,
          id: i + 1,
          lens: 'sonnet',
          decision: 'flag',
          decision_reason: 'Arbitration infrastructure failure',
        })),
        passed: false,
        infraFailure: true,
      };
    }
  }

  try {
    const jsonPayload = extractJsonObject(response);
    if (!jsonPayload) throw new Error('No JSON in response');

    const parsed = JSON.parse(jsonPayload);
    const decision = parsed.decision || 'accept';

    const findings: ReviewFinding[] = (parsed.confirmed_findings || []).map((f: any, i: number) => ({
      id: i + 1,
      severity: (f.severity || 'red') as FindingSeverity,
      lens: 'sonnet',
      file: f.file || 'unknown',
      line: parseInt(f.file?.split(':')[1]) || undefined,
      issue: f.issue || 'Issue confirmed by Sonnet',
      decision: decision === 'reject' ? 'dismiss' : 'flag',
      decision_reason: parsed.rationale,
    }));

    return {
      findings,
      passed: decision === 'reject' || decision === 'modify',
      fixInstructions: decision === 'accept' ? parsed.fix_instructions : undefined,
    };
  } catch (err) {
    console.error('    ⚠️ Could not parse Sonnet arbitration, defaulting to fail');
    return {
      findings: redFindings.map((f, i) => ({
        ...f,
        id: i + 1,
        lens: 'sonnet',
        decision: 'flag',
        decision_reason: 'Arbitration parse failed, defaulting to accept original findings',
      })),
      passed: false,
    };
  }
}

// Stage 4: Opus final review (rarely triggered)
async function runOpusFinalReview(
  workerResult: WorkerResult,
  task: SubTask,
  previousFindings: ReviewFinding[],
  fallbackRegistry: ModelRegistry,
  hiveConfig: HiveConfig,
): Promise<{ findings: ReviewFinding[]; passed: boolean; infraFailure?: boolean }> {
  const diff = getWorktreeFullDiff(workerResult.worktreePath);

  const prompt = `You are the final authority on code quality. This code has been through multiple review stages.

TASK: ${task.description}
COMPLEXITY: ${task.complexity}

PREVIOUS REVIEW FINDINGS:
${previousFindings.map(f => `- [${f.severity}] ${f.file}: ${f.issue}`).join('\n')}

FULL DIFF:
\`\`\`
${truncateDiff(diff, 8000)}
\`\`\`

This is the FINAL review. Make a decisive judgment.

Output EXACTLY this JSON:
{
  "passed": true|false,
  "rationale": "Your reasoning",
  "override_findings": [
    {"file": "path:line", "severity": "red|yellow|green", "issue": "your finding if any"}
  ]
}

Rules:
- passed=true: Code is acceptable despite previous findings
- passed=false: Code must be fixed before merging
- You may override any previous finding — explain why`;

  let response: string;
  try {
    response = await queryModelText(prompt, workerResult.worktreePath, hiveConfig.high_tier, undefined, 1);
  } catch (err: any) {
    try {
      const fallbackModel = resolveFallback(
        hiveConfig.high_tier,
        classifyReviewError(err),
        task,
        hiveConfig,
        fallbackRegistry,
      );
      const fallbackProvider = normalizeProviderId(fallbackRegistry.getModel(fallbackModel));
      response = fallbackProvider
        ? await queryModelText(prompt, workerResult.worktreePath, fallbackModel, fallbackProvider, 2)
        : await queryModelText(prompt, workerResult.worktreePath, fallbackModel, undefined, 1);
    } catch (fallbackErr: any) {
      console.error(`    ❌ Opus final review failed: ${fallbackErr.message?.slice(0, 100)}`);
      return { findings: previousFindings, passed: false, infraFailure: true };
    }
  }

  try {
    const jsonPayload = extractJsonObject(response);
    if (!jsonPayload) throw new Error('No JSON in response');

    const parsed = JSON.parse(jsonPayload);
    const passed = parsed.passed === true;

    const findings: ReviewFinding[] = (parsed.override_findings || []).map((f: any, i: number) => ({
      id: i + 1,
      severity: (f.severity || 'yellow') as FindingSeverity,
      lens: 'opus',
      file: f.file || 'unknown',
      line: parseInt(f.file?.split(':')[1]) || undefined,
      issue: f.issue || 'Finding from Opus final review',
      decision: passed ? 'dismiss' : 'flag',
      decision_reason: parsed.rationale,
    }));

    return { findings, passed };
  } catch (err) {
    console.error('    ⚠️ Could not parse Opus review, defaulting to previous findings');
    return { findings: previousFindings, passed: false };
  }
}

// Main review cascade
export async function reviewCascade(
  workerResult: WorkerResult,
  task: SubTask,
  _plan: TaskPlan,
  registry: ModelRegistry,
): Promise<ReviewResult> {
  const startTime = Date.now();
  const findings: ReviewFinding[] = [];
  let iterations = 0;
  const fingerprint = buildTaskFingerprint(task);
  const reviewPolicy = loadReviewPolicy();
  const hiveConfig = loadConfig(workerResult.worktreePath);
  const fallbackRegistry = registry;

  const finalizeReview = (
    result: ReviewResult,
    options: { skipScoreUpdate?: boolean; infraFailure?: boolean } = {},
  ): ReviewResult => {
    const workerInfraFailure = !workerResult.success
      && workerResult.changedFiles.length === 0
      && workerResult.output.some((message) => looksLikeInfrastructureFailure(message.content));
    const reviewInfraFailure = result.findings.some((finding) =>
      finding.issue.startsWith('Review failed:') && looksLikeInfrastructureFailure(finding.issue),
    );

    if (!options.skipScoreUpdate && !options.infraFailure && !workerInfraFailure && !reviewInfraFailure) {
      registry.updateScore(
        workerResult.model,
        result.passed,
        result.iterations,
        task.complexity,
        fingerprint.role,
        fingerprint.needs_fast_turnaround,
        fingerprint.needs_strict_boundary,
      );
    }
    return result;
  };

  console.log(`\n📋 Starting review for ${workerResult.taskId}`);

  // Check for auto-pass
  if (shouldAutoPass(task, workerResult.changedFiles, reviewPolicy)) {
    console.log('    ✅ Auto-pass: docs/comments only');
    return finalizeReview({
      taskId: workerResult.taskId,
      final_stage: 'cross-review',
      passed: true,
      findings: [],
      iterations: 0,
      duration_ms: Date.now() - startTime,
    }, { skipScoreUpdate: true });
  }

  // Stage 1: Cross-review
  const reviewerModel = registry.selectReviewer();
  const reviewerProvider = normalizeProviderId(registry.getModel(reviewerModel))
    ?? normalizeProviderId(fallbackRegistry.getModel(reviewerModel));

  const crossResult = await runCrossReview(
    workerResult,
    task,
    reviewerModel,
    reviewerProvider,
    fallbackRegistry,
    hiveConfig,
  );

  // Update findings from cross-review
  findings.push(...crossResult.flagged_issues.map<ReviewFinding>((issue, i) => ({
    id: i + 1,
    severity: issue.severity,
    lens: 'cross-review',
    file: issue.file,
    line: issue.line,
    issue: issue.issue,
    decision: crossResult.passed ? 'dismiss' : 'flag',
    decision_reason: `Confidence: ${crossResult.confidence}`,
  })));

  // Check if we can skip remaining stages
  const canSkipRemaining = crossResult.passed &&
    crossResult.confidence >= reviewPolicy.cross_review.min_confidence_to_skip &&
    isComplexityAtOrBelow(task.complexity, reviewPolicy.cross_review.max_complexity_for_skip);

  if (canSkipRemaining) {
    console.log(`    ✅ Cross-review passed with high confidence, skipping a2a`);
    return finalizeReview({
      taskId: workerResult.taskId,
      final_stage: 'cross-review',
      passed: true,
      findings,
      iterations: 1,
      duration_ms: Date.now() - startTime,
    });
  }

  // Stage 2: a2a 3-lens review
  const a2aResult = await runA2aReview(workerResult, task);

  // Add a2a findings
  findings.push(...a2aResult.all_findings.map((f, i) => ({ ...f, id: findings.length + i + 1 })));

  if (a2aResult.verdict === 'PASS') {
    console.log('    ✅ a2a review: PASS');
    return finalizeReview({
      taskId: workerResult.taskId,
      final_stage: 'a2a-lenses',
      passed: true,
      verdict: a2aResult.verdict,
      findings,
      iterations: 1,
      duration_ms: Date.now() - startTime,
    });
  }

  if (a2aResult.verdict === 'REJECT') {
    console.log('    ❌ a2a review: REJECT — sending back to worker');
    return finalizeReview({
      taskId: workerResult.taskId,
      final_stage: 'a2a-lenses',
      passed: false,
      verdict: a2aResult.verdict,
      findings,
      iterations: 1,
      duration_ms: Date.now() - startTime,
    });
  }

  // CONTESTED → Stage 3: Sonnet arbitration
  iterations = 2;

  const arbitration = await runSonnetArbitration(
    workerResult,
    task,
    a2aResult,
    1,
    fallbackRegistry,
    hiveConfig,
  );

  if (arbitration.passed) {
    console.log('    ✅ Sonnet arbitration: passed');
    findings.push(...arbitration.findings.map((finding, i) => ({ ...finding, id: findings.length + i + 1 })));
    return finalizeReview({
      taskId: workerResult.taskId,
      final_stage: 'sonnet',
      passed: true,
      verdict: 'PASS',
      findings,
      iterations,
      duration_ms: Date.now() - startTime,
    });
  }

  // Sonnet says fail — try fix iteration or escalate
  if (arbitration.fixInstructions) {
    console.log('    ⚠️ Sonnet requests fixes, would re-run');
    findings.push(...arbitration.findings.map((finding, i) => ({ ...finding, id: findings.length + i + 1 })));
    return finalizeReview({
      taskId: workerResult.taskId,
      final_stage: 'sonnet',
      passed: false,
      verdict: 'REJECT',
      findings,
      iterations,
      duration_ms: Date.now() - startTime,
    });
  }

  // Stage 4: Opus final review (rare)
  console.log('    🚀 Escalating to Opus final review...');

  const opusResult = await runOpusFinalReview(workerResult, task, findings, fallbackRegistry, hiveConfig);
  findings.push(...opusResult.findings.map((finding, i) => ({ ...finding, id: findings.length + i + 1 })));

  console.log(`    ${opusResult.passed ? '✅' : '❌'} Opus final review: ${opusResult.passed ? 'passed' : 'failed'}`);

  return finalizeReview({
    taskId: workerResult.taskId,
    final_stage: 'opus',
    passed: opusResult.passed,
    verdict: opusResult.passed ? 'PASS' : 'BLOCKED',
    findings,
    iterations,
    duration_ms: Date.now() - startTime,
  }, { infraFailure: arbitration.infraFailure || opusResult.infraFailure });
}

// Re-export types for convenience
export type { ReviewResult, ReviewFinding };
