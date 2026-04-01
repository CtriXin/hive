// ═══════════════════════════════════════════════════════════════════
// discuss-lib/cross-review.ts — One model reviews another's code
// ═══════════════════════════════════════════════════════════════════
// Extracted from hive/orchestrator/reviewer.ts Stage 1

import { execSync } from 'child_process';
import type { ModelCaller } from './model-caller.js';
import type { CrossReviewResult, CrossReviewOptions, DiscussConfig } from './types.js';
import { extractJsonObject, normalizeSeverity } from './json-utils.js';
import { resolveModelRoute } from './config.js';

function getWorktreeFullDiff(worktreePath: string): string {
  try {
    return execSync('git diff HEAD', {
      cwd: worktreePath, encoding: 'utf-8', stdio: 'pipe',
    });
  } catch {
    return '';
  }
}

function truncateDiff(diff: string, limit: number): string {
  if (diff.length <= limit) return diff;
  return `${diff.slice(0, limit)}\n\n[DIFF TRUNCATED: showing first ${limit} characters of ${diff.length}]`;
}

/**
 * Run a cross-model code review.
 *
 * One model reviews code changes from another. Returns structured findings
 * with severity and confidence.
 */
export async function runCrossReview(
  worktreePath: string,
  taskDescription: string,
  taskCategory: string,
  taskComplexity: string,
  workerModel: string,
  caller: ModelCaller,
  options: CrossReviewOptions,
  config?: Partial<DiscussConfig>,
): Promise<CrossReviewResult> {
  const { reviewerModelId, cwd } = options;
  const { baseUrl, apiKey } = resolveModelRoute(reviewerModelId, config);

  const diff = getWorktreeFullDiff(worktreePath);

  const prompt = `You are reviewing code changes from another AI model. Be thorough but constructive.

TASK: ${taskDescription}
CATEGORY: ${taskCategory}
COMPLEXITY: ${taskComplexity}

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

  try {
    const rawOutput = await caller.queryText(prompt, {
      modelId: reviewerModelId,
      baseUrl,
      apiKey,
      cwd: cwd || worktreePath,
      maxTurns: 2,
      timeoutMs: 30_000,
    });

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
        reviewer_model: reviewerModelId,
      };
    }

    const parsed = JSON.parse(jsonPayload);
    return {
      passed: parsed.passed === true,
      confidence: Math.max(0, Math.min(1, parsed.confidence || 0)),
      flagged_issues: (parsed.flagged_issues || []).map((item: any) => {
        if (typeof item === 'string') {
          return { severity: 'yellow' as const, file: 'unknown', issue: item };
        }
        const rawFile = typeof item?.file === 'string' ? item.file : 'unknown';
        const [filePath, lineText] = rawFile.split(':');
        const line = parseInt(lineText ?? '', 10);
        return {
          severity: normalizeSeverity(item?.severity),
          file: filePath || 'unknown',
          line: Number.isFinite(line) ? line : undefined,
          issue: String(item?.description || item?.issue || 'Cross-review issue').slice(0, 300),
        };
      }),
      reviewer_model: reviewerModelId,
    };
  } catch (err: any) {
    return {
      passed: false,
      confidence: 0,
      flagged_issues: [{
        severity: 'red',
        file: 'review-response',
        issue: `Review failed: ${err.message?.slice(0, 100)}`,
      }],
      reviewer_model: reviewerModelId,
    };
  }
}
