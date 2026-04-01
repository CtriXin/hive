// orchestrator/reviewer.ts — 4-stage review cascade (cross-review → a2a → arbitration → final)
import type {
  WorkerResult, SubTask, TaskPlan, ReviewResult, ReviewFinding,
  CrossReviewResult, A2aReviewResult, FindingSeverity, HiveConfig,
  StageTokenUsage,
} from './types.js';
import { loadConfig, resolveFallback, resolveTierModel, type FailureType } from './hive-config.js';
import { runA2aReview } from './a2a-bridge.js';
import { ModelRegistry, type LegacyModelView } from './model-registry.js';
import { buildTaskFingerprint } from './task-fingerprint.js';
import {
  loadReviewPolicy, looksLikeInfrastructureFailure, classifyReviewError,
  shouldAutoPass, isComplexityAtOrBelow, normalizeProviderId, normalizeSeverity,
  getWorktreeFullDiff, truncateDiff, extractJsonObject, queryModelText,
  type ReviewPolicy,
} from './review-utils.js';

// ── Stage 1: Cross-review ──

interface CrossReviewWithTokens extends CrossReviewResult {
  tokenUsage: { input: number; output: number };
}

async function runCrossReview(
  workerResult: WorkerResult, task: SubTask,
  reviewerModel: string, reviewerProvider: string | undefined,
  fallbackRegistry: ModelRegistry, hiveConfig: HiveConfig,
): Promise<CrossReviewWithTokens> {
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
    let qr;
    try {
      qr = await queryModelText(prompt, workerResult.worktreePath, reviewerModel, reviewerProvider, 2);
    } catch (err: any) {
      const fallbackModel = resolveFallback(reviewerModel, classifyReviewError(err), task, hiveConfig, fallbackRegistry);
      const fallbackProvider = normalizeProviderId(fallbackRegistry.getModel(fallbackModel));
      qr = await queryModelText(prompt, workerResult.worktreePath, fallbackModel, fallbackProvider, 2);
    }

    const jsonPayload = extractJsonObject(qr.text);
    if (!jsonPayload) {
      return {
        passed: false, confidence: 0,
        flagged_issues: [{ severity: 'red', file: 'review-response', issue: 'Could not parse review response' }],
        reviewer_model: reviewerModel,
        tokenUsage: qr.tokenUsage,
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
      tokenUsage: qr.tokenUsage,
    };
  } catch (err: any) {
    console.error(`    ❌ Cross-review failed: ${err.message?.slice(0, 100)}`);
    return {
      passed: false, confidence: 0,
      flagged_issues: [{ severity: 'red', file: 'review-response', issue: `Review failed: ${err.message?.slice(0, 100)}` }],
      reviewer_model: reviewerModel,
      tokenUsage: { input: 0, output: 0 },
    };
  }
}

// ── Stage 3: Arbitration ──

interface ArbitrationResult {
  findings: ReviewFinding[];
  passed: boolean;
  fixInstructions?: string;
  infraFailure?: boolean;
  model: string;
  tokenUsage: { input: number; output: number };
}

async function runArbitration(
  workerResult: WorkerResult, task: SubTask,
  a2aResult: A2aReviewResult, fallbackRegistry: ModelRegistry, hiveConfig: HiveConfig,
): Promise<ArbitrationResult> {
  const redFindings = a2aResult.all_findings.filter((f) => f.severity === 'red');
  const disputedFiles = [...new Set(redFindings.map((f) => f.file.split(':')[0]))];
  const diff = getWorktreeFullDiff(workerResult.worktreePath);

  const prompt = `You are the final arbiter in a code review. The a2a review found RED (blocking) issues.

TASK: ${task.description}

DISPUTED RED FINDINGS (only these need your judgment):
${redFindings.map((f) => `- [${f.lens}] ${f.file}: ${f.issue}`).join('\n')}

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

  const arbitrationModel = resolveTierModel(
    hiveConfig.tiers.reviewer.arbitration.model,
    () => fallbackRegistry.selectForArbitration(),
    fallbackRegistry,
    'review',
  );
  console.log(`    ⚖️ Arbitration model: ${arbitrationModel}`);

  let qr;
  try {
    qr = await queryModelText(prompt, workerResult.worktreePath, arbitrationModel, undefined, 1);
  } catch (err: any) {
    try {
      const fallbackModel = resolveFallback(arbitrationModel, classifyReviewError(err), task, hiveConfig, fallbackRegistry);
      const fbProvider = normalizeProviderId(fallbackRegistry.getModel(fallbackModel));
      qr = fbProvider
        ? await queryModelText(prompt, workerResult.worktreePath, fallbackModel, fbProvider, 2)
        : await queryModelText(prompt, workerResult.worktreePath, fallbackModel, undefined, 1);
    } catch (fbErr: any) {
      console.error(`    ❌ Arbitration failed: ${fbErr.message?.slice(0, 100)}`);
      return {
        findings: redFindings.map((f, i) => ({
          ...f, id: i + 1, lens: 'sonnet', decision: 'flag', decision_reason: 'Arbitration infrastructure failure',
        })),
        passed: false, infraFailure: true,
        model: arbitrationModel, tokenUsage: { input: 0, output: 0 },
      };
    }
  }

  try {
    const jsonPayload = extractJsonObject(qr.text);
    if (!jsonPayload) throw new Error('No JSON in response');
    const parsed = JSON.parse(jsonPayload);
    const decision = parsed.decision || 'accept';

    const findings: ReviewFinding[] = (parsed.confirmed_findings || []).map((f: any, i: number) => ({
      id: i + 1,
      severity: (f.severity || 'red') as FindingSeverity,
      lens: 'sonnet', file: f.file || 'unknown',
      line: parseInt(f.file?.split(':')[1]) || undefined,
      issue: f.issue || 'Issue confirmed by arbitration',
      decision: decision === 'reject' ? 'dismiss' : 'flag',
      decision_reason: parsed.rationale,
    }));

    return {
      findings, passed: decision === 'reject' || decision === 'modify',
      fixInstructions: decision === 'accept' ? parsed.fix_instructions : undefined,
      model: arbitrationModel, tokenUsage: qr.tokenUsage,
    };
  } catch {
    console.error('    ⚠️ Could not parse arbitration, defaulting to fail');
    return {
      findings: redFindings.map((f, i) => ({
        ...f, id: i + 1, lens: 'sonnet', decision: 'flag',
        decision_reason: 'Arbitration parse failed, defaulting to accept original findings',
      })),
      passed: false,
      model: arbitrationModel, tokenUsage: qr.tokenUsage,
    };
  }
}

// ── Stage 4: Final review (rare) ──

interface FinalReviewResult {
  findings: ReviewFinding[];
  passed: boolean;
  infraFailure?: boolean;
  model: string;
  tokenUsage: { input: number; output: number };
}

async function runFinalReview(
  workerResult: WorkerResult, task: SubTask,
  previousFindings: ReviewFinding[], fallbackRegistry: ModelRegistry, hiveConfig: HiveConfig,
): Promise<FinalReviewResult> {
  const diff = getWorktreeFullDiff(workerResult.worktreePath);

  const prompt = `You are the final authority on code quality. This code has been through multiple review stages.

TASK: ${task.description}
COMPLEXITY: ${task.complexity}

PREVIOUS REVIEW FINDINGS:
${previousFindings.map((f) => `- [${f.severity}] ${f.file}: ${f.issue}`).join('\n')}

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

  const finalReviewModel = resolveTierModel(
    hiveConfig.tiers.reviewer.final_review.model,
    () => fallbackRegistry.selectForFinalReview(),
    fallbackRegistry,
    'review',
  );
  console.log(`    🔬 Final review model: ${finalReviewModel}`);

  let qr;
  try {
    qr = await queryModelText(prompt, workerResult.worktreePath, finalReviewModel, undefined, 1);
  } catch (err: any) {
    try {
      const fallbackModel = resolveFallback(finalReviewModel, classifyReviewError(err), task, hiveConfig, fallbackRegistry);
      const fbProvider = normalizeProviderId(fallbackRegistry.getModel(fallbackModel));
      qr = fbProvider
        ? await queryModelText(prompt, workerResult.worktreePath, fallbackModel, fbProvider, 2)
        : await queryModelText(prompt, workerResult.worktreePath, fallbackModel, undefined, 1);
    } catch (fbErr: any) {
      console.error(`    ❌ Final review failed: ${fbErr.message?.slice(0, 100)}`);
      return {
        findings: previousFindings, passed: false, infraFailure: true,
        model: finalReviewModel, tokenUsage: { input: 0, output: 0 },
      };
    }
  }

  try {
    const jsonPayload = extractJsonObject(qr.text);
    if (!jsonPayload) throw new Error('No JSON in response');
    const parsed = JSON.parse(jsonPayload);
    const passed = parsed.passed === true;

    const findings: ReviewFinding[] = (parsed.override_findings || []).map((f: any, i: number) => ({
      id: i + 1, severity: (f.severity || 'yellow') as FindingSeverity,
      lens: 'opus', file: f.file || 'unknown',
      line: parseInt(f.file?.split(':')[1]) || undefined,
      issue: f.issue || 'Finding from final review',
      decision: passed ? 'dismiss' : 'flag', decision_reason: parsed.rationale,
    }));

    return { findings, passed, model: finalReviewModel, tokenUsage: qr.tokenUsage };
  } catch {
    console.error('    ⚠️ Could not parse final review, defaulting to previous findings');
    return {
      findings: previousFindings, passed: false,
      model: finalReviewModel, tokenUsage: qr.tokenUsage,
    };
  }
}

// ── Main review cascade ──

export async function reviewCascade(
  workerResult: WorkerResult, task: SubTask,
  _plan: TaskPlan, registry: ModelRegistry,
): Promise<ReviewResult> {
  const startTime = Date.now();
  const findings: ReviewFinding[] = [];
  const tokenStages: StageTokenUsage[] = [];
  let iterations = 0;
  const fingerprint = buildTaskFingerprint(task);
  const reviewPolicy = loadReviewPolicy();
  const hiveConfig = loadConfig(workerResult.worktreePath);

  const finalizeReview = (
    result: ReviewResult,
    opts: { skipScoreUpdate?: boolean; infraFailure?: boolean } = {},
  ): ReviewResult => {
    const workerInfra = !workerResult.success
      && workerResult.changedFiles.length === 0
      && workerResult.output.some((m) => looksLikeInfrastructureFailure(m.content));
    const reviewInfra = result.findings.some((f) =>
      f.issue.startsWith('Review failed:') && looksLikeInfrastructureFailure(f.issue),
    );

    if (!opts.skipScoreUpdate && !opts.infraFailure && !workerInfra && !reviewInfra) {
      registry.updateScore(
        workerResult.model, result.passed, result.iterations,
        task.complexity, fingerprint.role, fingerprint.needs_fast_turnaround, fingerprint.needs_strict_boundary,
      );
    }
    result.token_stages = tokenStages;
    return result;
  };

  console.log(`\n📋 Starting review for ${workerResult.taskId}`);

  // Auto-pass check
  if (shouldAutoPass(task, workerResult.changedFiles, reviewPolicy)) {
    console.log('    ✅ Auto-pass: docs/comments only');
    return finalizeReview({
      taskId: workerResult.taskId, final_stage: 'cross-review', passed: true,
      findings: [], iterations: 0, duration_ms: Date.now() - startTime,
    }, { skipScoreUpdate: true });
  }

  // Stage 1: Cross-review
  const reviewerModel = resolveTierModel(
    hiveConfig.tiers.reviewer.cross_review.model,
    () => registry.selectCrossReviewer(workerResult.model),
    registry,
    'review',
  );
  const reviewerProvider = normalizeProviderId(registry.getModel(reviewerModel));
  const crossResult = await runCrossReview(workerResult, task, reviewerModel, reviewerProvider, registry, hiveConfig);

  tokenStages.push({
    stage: `cross-review:${workerResult.taskId}`,
    model: reviewerModel,
    input_tokens: crossResult.tokenUsage.input,
    output_tokens: crossResult.tokenUsage.output,
  });

  findings.push(...crossResult.flagged_issues.map<ReviewFinding>((issue, i) => ({
    id: i + 1, severity: issue.severity, lens: 'cross-review',
    file: issue.file, line: issue.line, issue: issue.issue,
    decision: crossResult.passed ? 'dismiss' : 'flag',
    decision_reason: `Confidence: ${crossResult.confidence}`,
  })));

  const canSkip = crossResult.passed
    && crossResult.confidence >= reviewPolicy.cross_review.min_confidence_to_skip
    && isComplexityAtOrBelow(task.complexity, reviewPolicy.cross_review.max_complexity_for_skip);

  if (canSkip) {
    console.log(`    ✅ Cross-review passed with high confidence, skipping a2a`);
    return finalizeReview({
      taskId: workerResult.taskId, final_stage: 'cross-review', passed: true,
      findings, iterations: 1, duration_ms: Date.now() - startTime,
    });
  }

  // Stage 2: a2a 3-lens review
  const a2aResult = await runA2aReview(workerResult, task);
  findings.push(...a2aResult.all_findings.map((f, i) => ({ ...f, id: findings.length + i + 1 })));

  // a2a token tracking: discuss-lib doesn't expose token usage yet, record zero
  tokenStages.push({
    stage: `a2a:${workerResult.taskId}`,
    model: 'a2a-lenses',
    input_tokens: 0,
    output_tokens: 0,
  });

  if (a2aResult.verdict === 'PASS') {
    console.log('    ✅ a2a review: PASS');
    return finalizeReview({
      taskId: workerResult.taskId, final_stage: 'a2a-lenses', passed: true,
      verdict: a2aResult.verdict, findings, iterations: 1, duration_ms: Date.now() - startTime,
    });
  }

  if (a2aResult.verdict === 'REJECT') {
    console.log('    ❌ a2a review: REJECT — sending back to worker');
    return finalizeReview({
      taskId: workerResult.taskId, final_stage: 'a2a-lenses', passed: false,
      verdict: a2aResult.verdict, findings, iterations: 1, duration_ms: Date.now() - startTime,
    });
  }

  // CONTESTED → Stage 3: Arbitration
  iterations = 2;
  const arbitration = await runArbitration(workerResult, task, a2aResult, registry, hiveConfig);

  tokenStages.push({
    stage: `arbitration:${workerResult.taskId}`,
    model: arbitration.model,
    input_tokens: arbitration.tokenUsage.input,
    output_tokens: arbitration.tokenUsage.output,
  });

  if (arbitration.passed) {
    console.log('    ✅ Arbitration: passed');
    findings.push(...arbitration.findings.map((f, i) => ({ ...f, id: findings.length + i + 1 })));
    return finalizeReview({
      taskId: workerResult.taskId, final_stage: 'sonnet', passed: true,
      verdict: 'PASS', findings, iterations, duration_ms: Date.now() - startTime,
    });
  }

  if (arbitration.fixInstructions) {
    console.log('    ⚠️ Arbitration requests fixes');
    findings.push(...arbitration.findings.map((f, i) => ({ ...f, id: findings.length + i + 1 })));
    return finalizeReview({
      taskId: workerResult.taskId, final_stage: 'sonnet', passed: false,
      verdict: 'REJECT', findings, iterations, duration_ms: Date.now() - startTime,
    });
  }

  // Stage 4: Final review (rare)
  console.log('    🚀 Escalating to final review...');
  const finalResult = await runFinalReview(workerResult, task, findings, registry, hiveConfig);
  findings.push(...finalResult.findings.map((f, i) => ({ ...f, id: findings.length + i + 1 })));

  tokenStages.push({
    stage: `final-review:${workerResult.taskId}`,
    model: finalResult.model,
    input_tokens: finalResult.tokenUsage.input,
    output_tokens: finalResult.tokenUsage.output,
  });

  console.log(`    ${finalResult.passed ? '✅' : '❌'} Final review: ${finalResult.passed ? 'passed' : 'failed'}`);

  return finalizeReview({
    taskId: workerResult.taskId, final_stage: 'opus',
    passed: finalResult.passed, verdict: finalResult.passed ? 'PASS' : 'BLOCKED',
    findings, iterations, duration_ms: Date.now() - startTime,
  }, { infraFailure: arbitration.infraFailure || finalResult.infraFailure });
}

export type { ReviewResult, ReviewFinding };
