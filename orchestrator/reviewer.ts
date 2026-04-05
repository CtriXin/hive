// orchestrator/reviewer.ts — 4-stage review cascade (cross-review → a2a → arbitration → final)
import type {
  WorkerResult, SubTask, TaskPlan, ReviewResult, ReviewFinding,
  CrossReviewResult, A2aReviewResult, FindingSeverity, HiveConfig,
  StageTokenUsage, A2aVerdict,
} from './types.js';
import { loadConfig, resolveFallback, resolveTierModel, type FailureType } from './hive-config.js';
import { runA2aReview } from './a2a-bridge.js';
import { ModelRegistry, type LegacyModelView } from './model-registry.js';
import { buildTaskFingerprint } from './task-fingerprint.js';
import { loadReviewAuthorityPolicy, type ReviewAuthorityPolicy } from './authority-policy.js';
import { detectReviewDisagreement, type CommitteeMemberReview } from './disagreement-detector.js';
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

function crossReviewToFindings(result: CrossReviewWithTokens): ReviewFinding[] {
  return result.flagged_issues.map((issue, i) => ({
    id: i + 1,
    severity: issue.severity,
    lens: 'cross-review',
    file: issue.file,
    line: issue.line,
    issue: issue.issue,
    decision: result.passed ? 'dismiss' : 'flag',
    decision_reason: `Confidence: ${result.confidence}`,
  }));
}

function nextFindingId(findings: ReviewFinding[]): number {
  return findings.length + 1;
}

function chooseAuthorityReviewers(
  registry: ModelRegistry,
  task: SubTask,
  policy: ReviewAuthorityPolicy,
  workerModelId: string,
): string[] {
  const ranked = registry.rankModelsForTask(buildTaskFingerprint(task));
  const available = new Set(
    ranked
      .filter((candidate) => !candidate.blocked_by?.length)
      .map((candidate) => candidate.model),
  );
  const preferred = [
    ...policy.primary_candidates,
    ...policy.fallback_order,
    registry.selectReviewer(),
    registry.selectForFinalReview(),
  ];
  const selected: string[] = [];

  for (const modelId of preferred) {
    if (selected.length >= policy.max_models) break;
    if (!available.has(modelId)) continue;
    if (modelId === workerModelId) continue;
    if (selected.includes(modelId)) continue;
    selected.push(modelId);
  }

  return selected;
}

function shouldEscalateCommittee(
  task: SubTask,
  policy: ReviewAuthorityPolicy,
  primaryReview: CommitteeMemberReview,
  smokePassed?: boolean,
): boolean {
  if (policy.default_mode === 'pair') {
    return true;
  }
  // Smoke failure always escalates to pair — deterministic layer overrides
  if (smokePassed === false) {
    return true;
  }
  if (policy.escalate_on.includes('failed_review') && !primaryReview.passed) {
    return true;
  }
  if (
    policy.escalate_on.includes('high_complexity')
    && (task.complexity === 'medium-high' || task.complexity === 'high')
  ) {
    return true;
  }
  if (
    policy.escalate_on.includes('low_confidence')
    && primaryReview.confidence < policy.low_confidence_threshold
  ) {
    return true;
  }
  return false;
}

function buildSynthesizedFinding(
  findings: ReviewFinding[],
  issue: string,
  decision: 'accept' | 'dismiss' | 'flag',
  severity: FindingSeverity = 'yellow',
): ReviewFinding {
  return {
    id: nextFindingId(findings),
    severity,
    lens: 'authority-synthesis',
    file: '(committee)',
    issue,
    decision,
    decision_reason: 'Authority-layer synthesis',
  };
}

function mergeCommitteeFindings(
  reviews: CommitteeMemberReview[],
  disagreementFlags: string[],
): ReviewFinding[] {
  const merged: ReviewFinding[] = [];
  const seen = new Set<string>();

  for (const review of reviews) {
    for (const finding of review.findings) {
      const key = `${finding.file}:${finding.line ?? 0}:${finding.issue}:${finding.severity}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...finding, id: nextFindingId(merged) });
    }
  }

  if (disagreementFlags.length > 0) {
    merged.push(buildSynthesizedFinding(
      merged,
      `Committee disagreement: ${disagreementFlags.join(', ')}`,
      'flag',
      'yellow',
    ));
  }

  return merged;
}

interface SynthesizedAuthorityReview {
  passed: boolean;
  verdict: A2aVerdict;
  findings: ReviewFinding[];
  synthesisReason: string;
  synthesizedBy?: string;
  attemptedBy?: string;
  strategy?: 'model' | 'heuristic';
  tokenUsage?: { input: number; output: number };
  failedClosed?: boolean;
  infraFailure?: boolean;
}

function countFindingsBySeverity(findings: ReviewFinding[]): Record<FindingSeverity, number> {
  return findings.reduce<Record<FindingSeverity, number>>((acc, finding) => {
    acc[finding.severity] += 1;
    return acc;
  }, { red: 0, yellow: 0, green: 0 });
}

function normalizeSynthesizedFindings(
  reviews: CommitteeMemberReview[],
  finalPassed: boolean,
): ReviewFinding[] {
  const byKey = new Map<string, ReviewFinding[]>();
  for (const review of reviews) {
    for (const finding of review.findings) {
      const key = `${finding.file}:${finding.line ?? 0}:${finding.issue}`;
      const group = byKey.get(key) || [];
      group.push(finding);
      byKey.set(key, group);
    }
  }

  const merged: ReviewFinding[] = [];
  for (const group of byKey.values()) {
    const highest = [...group].sort((a, b) => {
      const rank = { green: 0, yellow: 1, red: 2 };
      return rank[b.severity] - rank[a.severity];
    })[0];
    merged.push({
      ...highest,
      id: nextFindingId(merged),
      severity: finalPassed && highest.severity === 'red' ? 'yellow' : highest.severity,
      decision: finalPassed ? 'dismiss' : 'flag',
    });
  }

  return merged;
}

function heuristicSynthesizePairReviews(
  primaryReview: CommitteeMemberReview,
  challengerReview: CommitteeMemberReview,
  disagreementFlags: string[],
  synthesisLabel: string,
  lowConfidenceThreshold: number,
): SynthesizedAuthorityReview {
  const reviews = [primaryReview, challengerReview];
  const primaryCounts = countFindingsBySeverity(primaryReview.findings);
  const challengerCounts = countFindingsBySeverity(challengerReview.findings);
  let passed: boolean;
  let synthesisReason: string;

  if (primaryReview.passed === challengerReview.passed && disagreementFlags.length === 0) {
    passed = primaryReview.passed;
    synthesisReason = 'consensus';
  } else if (primaryReview.passed !== challengerReview.passed) {
    const failingReview = primaryReview.passed ? challengerReview : primaryReview;
    const passingReview = primaryReview.passed ? primaryReview : challengerReview;
    const failingCounts = primaryReview.passed ? challengerCounts : primaryCounts;

    if (failingCounts.red > 0 && failingReview.confidence >= passingReview.confidence - 0.1) {
      passed = false;
      synthesisReason = `adopt ${failingReview.model} blocking findings`;
    } else if (
      failingCounts.red === 0
      && passingReview.confidence >= failingReview.confidence + 0.2
      && passingReview.confidence >= lowConfidenceThreshold
    ) {
      passed = true;
      synthesisReason = `adopt ${passingReview.model} higher-confidence pass`;
    } else {
      passed = false;
      synthesisReason = 'unresolved disagreement -> conservative fail';
    }
  } else if (
    primaryReview.confidence < lowConfidenceThreshold
    && challengerReview.confidence < lowConfidenceThreshold
  ) {
    passed = primaryCounts.red + challengerCounts.red === 0;
    synthesisReason = passed
      ? 'both low-confidence but no blocking findings'
      : 'both low-confidence with blocking findings';
  } else {
    const chosen = primaryReview.confidence >= challengerReview.confidence
      ? primaryReview
      : challengerReview;
    passed = chosen.passed;
    synthesisReason = `adopt ${chosen.model} higher-confidence synthesis`;
  }

  const findings = normalizeSynthesizedFindings(reviews, passed);
  findings.push(buildSynthesizedFinding(
    findings,
    `${synthesisLabel} synthesis: ${synthesisReason}`,
    passed ? 'dismiss' : 'flag',
    passed ? 'green' : 'yellow',
  ));

  return {
    passed,
    verdict: passed ? 'PASS' : 'REJECT',
    findings,
    synthesisReason,
    strategy: 'heuristic',
  };
}

function parseSynthesizedAuthorityFindings(
  parsed: any,
  passed: boolean,
  rationale: string,
  fallbackFindings: ReviewFinding[],
): ReviewFinding[] {
  const rawFindings = Array.isArray(parsed?.final_findings)
    ? parsed.final_findings
    : Array.isArray(parsed?.findings)
      ? parsed.findings
      : [];

  if (rawFindings.length === 0) {
    return fallbackFindings;
  }

  return rawFindings.map((item: any, index: number) => {
    const rawFile = typeof item?.file === 'string' ? item.file : '(committee)';
    const [filePath, lineText] = rawFile.split(':');
    const line = Number.parseInt(lineText ?? '', 10);
    const decision = item?.decision === 'accept' || item?.decision === 'dismiss' || item?.decision === 'flag'
      ? item.decision
      : passed ? 'dismiss' : 'flag';

    return {
      id: index + 1,
      severity: normalizeSeverity(item?.severity),
      lens: 'authority-synthesis',
      file: filePath || '(committee)',
      line: Number.isFinite(line) ? line : undefined,
      issue: String(item?.issue || item?.description || 'Synthesis finding').slice(0, 300),
      decision,
      decision_reason: rationale,
    };
  });
}

function buildFailClosedSynthesisResult(
  message: string,
  attemptedBy: string | undefined,
  tokenUsage?: { input: number; output: number },
): SynthesizedAuthorityReview {
  const findings: ReviewFinding[] = [];
  findings.push(buildSynthesizedFinding(findings, message, 'flag', 'red'));
  return {
    passed: false,
    verdict: 'BLOCKED',
    findings,
    synthesisReason: message,
    attemptedBy,
    tokenUsage,
    failedClosed: true,
    infraFailure: looksLikeInfrastructureFailure(message),
  };
}

async function runAuthoritySynthesis(
  workerResult: WorkerResult,
  task: SubTask,
  primaryReview: CommitteeMemberReview,
  challengerReview: CommitteeMemberReview,
  disagreementFlags: string[],
  policy: ReviewAuthorityPolicy,
  fallbackRegistry: ModelRegistry,
  hiveConfig: HiveConfig,
): Promise<SynthesizedAuthorityReview> {
  const heuristic = heuristicSynthesizePairReviews(
    primaryReview,
    challengerReview,
    disagreementFlags,
    'heuristic',
    policy.low_confidence_threshold,
  );
  const diff = getWorktreeFullDiff(workerResult.worktreePath);
  let synthesisModel = resolveTierModel(
    policy.synthesizer,
    () => fallbackRegistry.selectForFinalReview(),
    fallbackRegistry,
    'review',
  );
  let synthesisProvider = normalizeProviderId(fallbackRegistry.getModel(synthesisModel));
  let qr;

  const prompt = `You are the final synthesis reviewer for a committee-based code review.

TASK: ${task.description}
CATEGORY: ${task.category}
COMPLEXITY: ${task.complexity}

PRIMARY REVIEW:
- model: ${primaryReview.model}
- passed: ${primaryReview.passed}
- confidence: ${primaryReview.confidence}
- findings:
${primaryReview.findings.map((finding) => `  - [${finding.severity}] ${finding.file}${finding.line ? `:${finding.line}` : ''}: ${finding.issue}`).join('\n') || '  - none'}

CHALLENGER REVIEW:
- model: ${challengerReview.model}
- passed: ${challengerReview.passed}
- confidence: ${challengerReview.confidence}
- findings:
${challengerReview.findings.map((finding) => `  - [${finding.severity}] ${finding.file}${finding.line ? `:${finding.line}` : ''}: ${finding.issue}`).join('\n') || '  - none'}

DISAGREEMENT FLAGS:
${disagreementFlags.length > 0 ? disagreementFlags.map((flag) => `- ${flag}`).join('\n') : '- none'}

FULL DIFF:
\`\`\`
${truncateDiff(diff, 8000)}
\`\`\`

Return EXACTLY this JSON:
{
  "passed": true|false,
  "rationale": "brief tie-break reasoning",
  "final_findings": [
    {
      "severity": "red|yellow|green",
      "file": "path:line",
      "issue": "final normalized finding",
      "decision": "accept|dismiss|flag"
    }
  ]
}

Rules:
- make the final merge-ready review decision
- normalize duplicate or conflicting findings
- keep only findings that matter to the final verdict
- output ONLY JSON`;

  try {
    qr = await queryModelText(
      prompt,
      workerResult.worktreePath,
      synthesisModel,
      synthesisProvider,
      1,
      policy.timeout_ms,
      'final_review',
    );
  } catch (err: any) {
    try {
      const fallbackModel = resolveFallback(
        synthesisModel,
        classifyReviewError(err),
        task,
        hiveConfig,
        fallbackRegistry,
      );
      synthesisModel = fallbackModel;
      synthesisProvider = normalizeProviderId(fallbackRegistry.getModel(fallbackModel));
      qr = await queryModelText(
        prompt,
        workerResult.worktreePath,
        fallbackModel,
        synthesisProvider,
        2,
        policy.timeout_ms,
        'final_review',
      );
    } catch (fallbackErr: any) {
      if (policy.synthesis_failure_policy === 'fail_closed') {
        const message = `Review failed: Authority synthesis failed under fail_closed policy: ${fallbackErr.message?.slice(0, 100) || 'unknown error'}`;
        return buildFailClosedSynthesisResult(message, synthesisModel);
      }
      console.warn(`    ⚠️ Authority synthesis fallback to heuristic: ${fallbackErr.message?.slice(0, 100)}`);
      return heuristic;
    }
  }

  try {
    const jsonPayload = extractJsonObject(qr.text);
    if (!jsonPayload) throw new Error('No JSON in synthesis response');
    const parsed = JSON.parse(jsonPayload);
    const passed = parsed.passed === true;
    const rationale = String(parsed.rationale || parsed.summary || 'model synthesis').slice(0, 400);
    const findings = parseSynthesizedAuthorityFindings(
      parsed,
      passed,
      rationale,
      normalizeSynthesizedFindings([primaryReview, challengerReview], passed),
    );
    findings.push(buildSynthesizedFinding(
      findings,
      `${synthesisModel} synthesis: ${rationale}`,
      passed ? 'dismiss' : 'flag',
      passed ? 'green' : 'yellow',
    ));

    return {
      passed,
      verdict: passed ? 'PASS' : 'REJECT',
      findings,
      synthesisReason: rationale,
      synthesizedBy: synthesisModel,
      strategy: 'model',
      tokenUsage: qr.tokenUsage,
    };
  } catch (err: any) {
    if (policy.synthesis_failure_policy === 'fail_closed') {
      const message = `Review failed: Authority synthesis parse failed under fail_closed policy: ${err.message?.slice(0, 100) || 'invalid response'}`;
      return buildFailClosedSynthesisResult(message, synthesisModel, qr?.tokenUsage);
    }
    console.warn(`    ⚠️ Authority synthesis parse failed, falling back to heuristic: ${err.message?.slice(0, 100)}`);
    return {
      ...heuristic,
      attemptedBy: synthesisModel,
      tokenUsage: qr?.tokenUsage,
    };
  }
}

function finalizeReviewResult(
  workerResult: WorkerResult,
  task: SubTask,
  plan: TaskPlan,
  registry: ModelRegistry,
  fingerprint: ReturnType<typeof buildTaskFingerprint>,
  result: ReviewResult,
  tokenStages: StageTokenUsage[],
  opts: { skipScoreUpdate?: boolean; infraFailure?: boolean } = {},
): ReviewResult {
  const workerInfra = !workerResult.success
    && workerResult.changedFiles.length === 0
    && workerResult.output.some((m) => looksLikeInfrastructureFailure(m.content));
  const reviewInfra = result.findings.some((f) =>
    f.issue.startsWith('Review failed:') && looksLikeInfrastructureFailure(f.issue),
  );

  if (!opts.skipScoreUpdate && !opts.infraFailure && !workerInfra && !reviewInfra) {
    registry.updateScore(
      workerResult.model,
      result.passed,
      result.iterations,
      task.complexity,
      fingerprint.role,
      fingerprint.needs_fast_turnaround,
      fingerprint.needs_strict_boundary,
    );

    import('./lesson-extractor.js').then((le) => {
      const lessons = le.extractLessons(
        task.id,
        plan.id,
        workerResult.model,
        task,
        workerResult,
        result,
      );
      if (lessons.length > 0) {
        le.updateDisciplineScores(workerResult.model, lessons);
        le.persistLessons(workerResult.model, lessons);
        console.log(`    📝 ${lessons.length} lesson(s) extracted for ${workerResult.model}`);
      }
    }).catch(() => { /* lesson extraction is best-effort */ });
  }

  result.token_stages = tokenStages;
  return result;
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
  "summary": "1-2 sentence overall assessment",
  "flagged_issues": [
    {"severity": "red|yellow|green", "file": "path:line", "description": "brief issue description"}
  ]
}

Rules:
- passed=true if no red issues and confidence >= 0.85
- severity levels:
  - red: blocking issues (security, correctness, breaking changes)
  - yellow: improvements (performance, readability, minor concerns)
  - green: positive notes (optional suggestions)
- file format: "path/to/file.ts:lineNumber" or just "path/to/file.ts"
- Be critical but fair — this will be reviewed again if issues found
- Output ONLY the JSON, no other text`;

  console.log(`    🔍 Cross-review: ${workerResult.model} → ${reviewerModel}`);

  try {
    let qr;
    try {
      qr = await queryModelText(prompt, workerResult.worktreePath, reviewerModel, reviewerProvider, 2, 30000, 'cross_review');
    } catch (err: any) {
      const fallbackModel = resolveFallback(reviewerModel, classifyReviewError(err), task, hiveConfig, fallbackRegistry);
      const fallbackProvider = normalizeProviderId(fallbackRegistry.getModel(fallbackModel));
      qr = await queryModelText(prompt, workerResult.worktreePath, fallbackModel, fallbackProvider, 2, 30000, 'cross_review');
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
    qr = await queryModelText(prompt, workerResult.worktreePath, arbitrationModel, undefined, 1, 30000, 'arbitration');
  } catch (err: any) {
    try {
      const fallbackModel = resolveFallback(arbitrationModel, classifyReviewError(err), task, hiveConfig, fallbackRegistry);
      const fbProvider = normalizeProviderId(fallbackRegistry.getModel(fallbackModel));
      qr = fbProvider
        ? await queryModelText(prompt, workerResult.worktreePath, fallbackModel, fbProvider, 2, 30000, 'arbitration')
        : await queryModelText(prompt, workerResult.worktreePath, fallbackModel, undefined, 1, 30000, 'arbitration');
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
    qr = await queryModelText(prompt, workerResult.worktreePath, finalReviewModel, undefined, 1, 30000, 'final_review');
  } catch (err: any) {
    try {
      const fallbackModel = resolveFallback(finalReviewModel, classifyReviewError(err), task, hiveConfig, fallbackRegistry);
      const fbProvider = normalizeProviderId(fallbackRegistry.getModel(fallbackModel));
      qr = fbProvider
        ? await queryModelText(prompt, workerResult.worktreePath, fallbackModel, fbProvider, 2, 30000, 'final_review')
        : await queryModelText(prompt, workerResult.worktreePath, fallbackModel, undefined, 1, 30000, 'final_review');
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

async function runAuthorityReview(
  workerResult: WorkerResult,
  task: SubTask,
  plan: TaskPlan,
  registry: ModelRegistry,
  smokePassed?: boolean,
): Promise<ReviewResult> {
  const startTime = Date.now();
  const tokenStages: StageTokenUsage[] = [];
  const fingerprint = buildTaskFingerprint(task);
  const reviewPolicy = loadReviewPolicy();
  const hiveConfig = loadConfig(workerResult.worktreePath);
  const authorityPolicy = loadReviewAuthorityPolicy();

  console.log(`\n🏛️ Authority review for ${workerResult.taskId}`);

  if (workerResult.success && workerResult.changedFiles.length === 0) {
    return finalizeReviewResult(
      workerResult,
      task,
      plan,
      registry,
      fingerprint,
      {
        taskId: workerResult.taskId,
        final_stage: 'cross-review',
        passed: false,
        findings: [{
          id: 1,
          severity: 'red',
          lens: 'orchestrator',
          file: '(no files changed)',
          issue: 'Worker reported success but produced no file changes — zero output is a hard failure.',
          decision: 'flag',
          decision_reason: 'Empty diff is not accepted as a completed task.',
        }],
        iterations: 0,
        duration_ms: Date.now() - startTime,
        authority: {
          source: 'authority-layer',
          mode: 'single',
          members: [],
        },
      },
      tokenStages,
      { skipScoreUpdate: true },
    );
  }

  if (shouldAutoPass(task, workerResult.changedFiles, reviewPolicy)) {
    return finalizeReviewResult(
      workerResult,
      task,
      plan,
      registry,
      fingerprint,
      {
        taskId: workerResult.taskId,
        final_stage: 'cross-review',
        passed: true,
        findings: [],
        iterations: 0,
        duration_ms: Date.now() - startTime,
        authority: {
          source: 'authority-layer',
          mode: 'single',
          members: [],
        },
      },
      tokenStages,
      { skipScoreUpdate: true },
    );
  }

  const reviewers = chooseAuthorityReviewers(registry, task, authorityPolicy, workerResult.model);
  const primaryModel = reviewers[0] || registry.selectReviewer();
  console.log(`    [authority] mode=single primary=${primaryModel}`);
  const primaryProvider = normalizeProviderId(registry.getModel(primaryModel));
  const primaryResult = await runCrossReview(
    workerResult,
    task,
    primaryModel,
    primaryProvider,
    registry,
    hiveConfig,
  );
  const primaryFindings = crossReviewToFindings(primaryResult);
  const primaryReview: CommitteeMemberReview = {
    model: primaryModel,
    passed: primaryResult.passed,
    confidence: primaryResult.confidence,
    findings: primaryFindings,
  };

  tokenStages.push({
    stage: `authority-primary:${workerResult.taskId}`,
    model: primaryModel,
    input_tokens: primaryResult.tokenUsage.input,
    output_tokens: primaryResult.tokenUsage.output,
  });

  if (!shouldEscalateCommittee(task, authorityPolicy, primaryReview, smokePassed) || reviewers.length < 2) {
    return finalizeReviewResult(
      workerResult,
      task,
      plan,
      registry,
      fingerprint,
      {
        taskId: workerResult.taskId,
        final_stage: 'cross-review',
        passed: primaryResult.passed,
        verdict: primaryResult.passed ? 'PASS' : 'REJECT',
        findings: primaryFindings,
        iterations: 1,
        duration_ms: Date.now() - startTime,
        authority: {
          source: 'authority-layer',
          mode: 'single',
          members: [primaryModel],
        },
      },
      tokenStages,
    );
  }

  const challengerModel = reviewers[1];
  console.log(`    [authority] escalate single->pair challenger=${challengerModel}`);
  const challengerProvider = normalizeProviderId(registry.getModel(challengerModel));
  const challengerResult = await runCrossReview(
    workerResult,
    task,
    challengerModel,
    challengerProvider,
    registry,
    hiveConfig,
  );
  const challengerFindings = crossReviewToFindings(challengerResult);
  const challengerReview: CommitteeMemberReview = {
    model: challengerModel,
    passed: challengerResult.passed,
    confidence: challengerResult.confidence,
    findings: challengerFindings,
  };

  tokenStages.push({
    stage: `authority-challenger:${workerResult.taskId}`,
    model: challengerModel,
    input_tokens: challengerResult.tokenUsage.input,
    output_tokens: challengerResult.tokenUsage.output,
  });

  const disagreement = detectReviewDisagreement([primaryReview, challengerReview], {
    deterministic_failed: smokePassed === false,
  });
  const needsSynthesis = disagreement.has_disagreement
    || primaryResult.confidence < authorityPolicy.low_confidence_threshold
    || challengerResult.confidence < authorityPolicy.low_confidence_threshold;
  const synthesis = needsSynthesis
    ? await runAuthoritySynthesis(
        workerResult,
        task,
        primaryReview,
        challengerReview,
        disagreement.flags,
        authorityPolicy,
        registry,
        hiveConfig,
      )
    : null;
  const synthesisStageModel = synthesis?.synthesizedBy || synthesis?.attemptedBy;
  if (synthesis?.tokenUsage && synthesisStageModel) {
    tokenStages.push({
      stage: `authority-synthesis:${workerResult.taskId}`,
      model: synthesisStageModel,
      input_tokens: synthesis.tokenUsage.input,
      output_tokens: synthesis.tokenUsage.output,
    });
  }
  const finalFindings = synthesis
    ? synthesis.findings
    : mergeCommitteeFindings([primaryReview, challengerReview], disagreement.flags);
  const passed = synthesis
    ? synthesis.passed
    : primaryResult.passed && challengerResult.passed;
  const verdict = synthesis
    ? synthesis.verdict
    : passed ? 'PASS' : 'REJECT';

  if (needsSynthesis) {
    const synthesisLabel = synthesis?.synthesizedBy
      || (synthesis?.strategy === 'heuristic' ? 'heuristic' : undefined)
      || (synthesis?.attemptedBy ? `blocked(${synthesis.attemptedBy})` : 'unknown');
    console.log(`    [authority] synthesize by=${synthesisLabel} disagreement=${disagreement.flags.join(',') || 'low_confidence'}`);
  }

  return finalizeReviewResult(
    workerResult,
    task,
    plan,
    registry,
    fingerprint,
    {
        taskId: workerResult.taskId,
        final_stage: 'cross-review',
        passed,
        verdict,
        findings: finalFindings,
        iterations: 2,
        duration_ms: Date.now() - startTime,
      authority: {
        source: 'authority-layer',
        mode: 'pair',
        members: [primaryModel, challengerModel],
        disagreement_flags: disagreement.flags,
        synthesized_by: synthesis?.synthesizedBy,
        synthesis_strategy: synthesis?.strategy,
        synthesis_attempted_by: synthesis?.attemptedBy,
      },
    },
    tokenStages,
    {
      skipScoreUpdate: synthesis?.failedClosed,
      infraFailure: synthesis?.infraFailure,
    },
  );
}

export async function runReview(
  workerResult: WorkerResult,
  task: SubTask,
  plan: TaskPlan,
  registry: ModelRegistry,
  smokePassed?: boolean,  // true = smoke 通过，false = smoke 失败，undefined = 未运行/不适用
): Promise<ReviewResult> {
  const authorityPolicy = loadReviewAuthorityPolicy();
  if (!authorityPolicy.enabled) {
    return reviewCascade(workerResult, task, plan, registry);
  }
  try {
    return await runAuthorityReview(workerResult, task, plan, registry, smokePassed);
  } catch (err: any) {
    console.warn(`    ⚠️ Authority review failed, falling back to legacy cascade: ${err?.message || err}`);
    return reviewCascade(workerResult, task, plan, registry);
  }
}

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

  console.log(`\n📋 Starting review for ${workerResult.taskId}`);

  if (workerResult.success && workerResult.changedFiles.length === 0) {
    console.log('    🔴 No-op detected: worker reported success but produced no diff');
    return finalizeReviewResult(workerResult, task, _plan, registry, fingerprint, {
      taskId: workerResult.taskId,
      final_stage: 'cross-review',
      passed: false,
      findings: [{
        id: 1,
        severity: 'red',
        lens: 'orchestrator',
        file: '(no files changed)',
        issue: 'Worker reported success but produced no file changes — zero output is a hard failure.',
        decision: 'flag',
        decision_reason: 'Empty diff is not accepted as a completed task.',
      }],
      iterations: 0,
      duration_ms: Date.now() - startTime,
      authority: {
        source: 'legacy-cascade',
        mode: 'single',
        members: [],
      },
    }, tokenStages, { skipScoreUpdate: true });
  }

  // Auto-pass check
  if (shouldAutoPass(task, workerResult.changedFiles, reviewPolicy)) {
    console.log('    ✅ Auto-pass: docs/comments only');
    return finalizeReviewResult(workerResult, task, _plan, registry, fingerprint, {
      taskId: workerResult.taskId, final_stage: 'cross-review', passed: true,
      findings: [], iterations: 0, duration_ms: Date.now() - startTime,
      authority: {
        source: 'legacy-cascade',
        mode: 'single',
        members: [],
      },
    }, tokenStages, { skipScoreUpdate: true });
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

  findings.push(...crossReviewToFindings(crossResult));

  const canSkip = crossResult.passed
    && crossResult.confidence >= reviewPolicy.cross_review.min_confidence_to_skip
    && isComplexityAtOrBelow(task.complexity, reviewPolicy.cross_review.max_complexity_for_skip);

  if (canSkip) {
    console.log(`    ✅ Cross-review passed with high confidence, skipping a2a`);
    return finalizeReviewResult(workerResult, task, _plan, registry, fingerprint, {
      taskId: workerResult.taskId, final_stage: 'cross-review', passed: true,
      findings, iterations: 1, duration_ms: Date.now() - startTime,
      authority: {
        source: 'legacy-cascade',
        mode: 'single',
        members: [reviewerModel],
      },
    }, tokenStages);
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
    return finalizeReviewResult(workerResult, task, _plan, registry, fingerprint, {
      taskId: workerResult.taskId, final_stage: 'a2a-lenses', passed: true,
      verdict: a2aResult.verdict, findings, iterations: 1, duration_ms: Date.now() - startTime,
      authority: {
        source: 'legacy-cascade',
        mode: 'single',
        members: [reviewerModel],
      },
    }, tokenStages);
  }

  if (a2aResult.verdict === 'REJECT') {
    console.log('    ❌ a2a review: REJECT — sending back to worker');
    return finalizeReviewResult(workerResult, task, _plan, registry, fingerprint, {
      taskId: workerResult.taskId, final_stage: 'a2a-lenses', passed: false,
      verdict: a2aResult.verdict, findings, iterations: 1, duration_ms: Date.now() - startTime,
      authority: {
        source: 'legacy-cascade',
        mode: 'single',
        members: [reviewerModel],
      },
    }, tokenStages);
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
    return finalizeReviewResult(workerResult, task, _plan, registry, fingerprint, {
      taskId: workerResult.taskId, final_stage: 'sonnet', passed: true,
      verdict: 'PASS', findings, iterations, duration_ms: Date.now() - startTime,
      authority: {
        source: 'legacy-cascade',
        mode: 'single',
        members: [reviewerModel, arbitration.model],
      },
    }, tokenStages);
  }

  if (arbitration.fixInstructions) {
    console.log('    ⚠️ Arbitration requests fixes');
    findings.push(...arbitration.findings.map((f, i) => ({ ...f, id: findings.length + i + 1 })));
    return finalizeReviewResult(workerResult, task, _plan, registry, fingerprint, {
      taskId: workerResult.taskId, final_stage: 'sonnet', passed: false,
      verdict: 'REJECT', findings, iterations, duration_ms: Date.now() - startTime,
      authority: {
        source: 'legacy-cascade',
        mode: 'single',
        members: [reviewerModel, arbitration.model],
      },
    }, tokenStages);
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

  return finalizeReviewResult(workerResult, task, _plan, registry, fingerprint, {
    taskId: workerResult.taskId, final_stage: 'opus',
    passed: finalResult.passed, verdict: finalResult.passed ? 'PASS' : 'BLOCKED',
    findings, iterations, duration_ms: Date.now() - startTime,
    authority: {
      source: 'legacy-cascade',
      mode: 'single',
      members: [reviewerModel, arbitration.model, finalResult.model],
    },
  }, tokenStages, { infraFailure: arbitration.infraFailure || finalResult.infraFailure });
}

export type { ReviewResult, ReviewFinding };
