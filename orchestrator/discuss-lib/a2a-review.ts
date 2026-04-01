// ═══════════════════════════════════════════════════════════════════
// discuss-lib/a2a-review.ts — 3-lens adversarial code review
// ═══════════════════════════════════════════════════════════════════
// Extracted from hive/orchestrator/a2a-bridge.ts
// Lens prompts internalized from a2a review-lenses.md

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import type { ModelCaller } from './model-caller.js';
import type {
  A2aLens, A2aLensResult, A2aReviewResult, A2aVerdict,
  A2aReviewInput, A2aReviewOptions, ReviewFinding, DiscussConfig,
} from './types.js';
import { parseLensOutput } from './json-utils.js';
import { resolveModelRoute } from './config.js';

// ── Lens prompts ──

const LENS_PROMPTS: Record<A2aLens, string> = {
  challenger: `You are "The Challenger" code reviewer. Your mandate: "Prove to me this won't break."

Review the code diff below. Find:
- Edge cases: null, empty, negative, boundary values
- Async race conditions, error swallowing
- Unhandled error paths
- Security vulnerabilities (XSS, injection, auth bypass)

For each finding, output EXACTLY this JSON format:
{
  "findings": [
    {"severity": "red|yellow|green", "file": "path:line", "issue": "trigger + impact + fix suggestion (max 3 lines)"}
  ]
}

RULES:
- Max 10 findings
- Each finding <= 3 lines
- If no issues found, return: {"findings": []}
- DO NOT add explanatory text outside the JSON

DIFF:
`,

  architect: `You are "The Architect" code reviewer. Your mandate: "Will this design survive requirement changes?"

Review the file structure and signatures below (NOT the full diff). Find:
- Coupling between components that shouldn't know about each other
- Single Responsibility violations (god components/functions)
- Hidden assumptions that will break when requirements change
- Missing abstractions or unnecessary abstractions

For each finding, output EXACTLY this JSON format:
{
  "findings": [
    {"severity": "red|yellow|green", "file": "path", "issue": "current design + risk + alternative (max 3 lines)"}
  ]
}

RULES:
- Max 10 findings
- Focus on STRUCTURE, not line-by-line bugs
- If the design is sound, return: {"findings": []}
- DO NOT add explanatory text outside the JSON

FILES AND SIGNATURES:
`,

  subtractor: `You are "The Subtractor" code reviewer. Your mandate: "What happens if this code disappears?"

Review the code diff below. Find:
- Over-engineering: abstractions without second use case
- Premature configuration: config for things that could be constants
- "Just in case" code that handles impossible scenarios
- Helpers/utilities that are used only once
- Dead code or commented-out code

For each finding, output EXACTLY this JSON format:
{
  "findings": [
    {"severity": "red|yellow|green", "file": "path:line", "issue": "deletable code + deletion impact + simplification (max 3 lines)"}
  ]
}

RULES:
- Max 10 findings
- Subtractor findings are usually yellow or green (rarely red)
- If the code is lean, return: {"findings": []}
- DO NOT add explanatory text outside the JSON

DIFF:
`,
};

// ── Scale detection ──

export function determineScale(diffStat: string): 'light' | 'medium' | 'heavy' | 'heavy+' {
  const lines = diffStat.split('\n');
  const lastLine = lines[lines.length - 1] || '';
  const insertMatch = lastLine.match(/(\d+) insertion/);
  const deleteMatch = lastLine.match(/(\d+) deletion/);
  const insertions = parseInt(insertMatch?.[1] || '0');
  const deletions = parseInt(deleteMatch?.[1] || '0');
  const totalChanged = insertions + deletions;
  const newLines = insertions - deletions;

  if (totalChanged < 50) return 'light';
  if (totalChanged < 200) return 'medium';
  if (newLines <= 100) return 'heavy';
  return 'heavy+';
}

export function lensesForScale(scale: string): A2aLens[] {
  switch (scale) {
    case 'light': return ['challenger'];
    case 'medium': return ['challenger', 'architect'];
    case 'heavy': return ['challenger', 'architect'];
    case 'heavy+': return ['challenger', 'architect', 'subtractor'];
    default: return ['challenger', 'architect'];
  }
}

// ── Git helpers ──

export function getWorktreeDiffStat(worktreePath: string): string {
  try {
    return execSync('git diff --stat HEAD', {
      cwd: worktreePath, encoding: 'utf-8', stdio: 'pipe',
    });
  } catch {
    return '';
  }
}

export function getWorktreeFullDiff(worktreePath: string): string {
  try {
    return execSync('git diff HEAD', {
      cwd: worktreePath, encoding: 'utf-8', stdio: 'pipe',
    });
  } catch {
    return '';
  }
}

export function extractSignatures(worktreePath: string, changedFiles: string[]): string {
  const signatures: string[] = [];
  for (const file of changedFiles.slice(0, 10)) {
    const fullPath = path.join(worktreePath, file);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const)\s+\w+/.test(line)) {
        signatures.push(`${file}:${i + 1}  ${line.trim()}`);
      }
    }
  }
  return signatures.join('\n');
}

// ── Lens input builder ──

function buildLensInput(
  lens: A2aLens,
  diff: string,
  diffStat: string,
  signatures: string,
): string {
  switch (lens) {
    case 'challenger':
      return LENS_PROMPTS.challenger + diff.slice(0, 8000);
    case 'architect':
      return LENS_PROMPTS.architect + diffStat + '\n\n' + signatures;
    case 'subtractor':
      return LENS_PROMPTS.subtractor + diff.slice(0, 8000);
  }
}

// ── Single lens runner ──

async function runLens(
  lens: A2aLens,
  modelId: string,
  caller: ModelCaller,
  diff: string,
  diffStat: string,
  signatures: string,
  cwd: string,
  config?: Partial<DiscussConfig>,
  existingFindingsCount = 0,
): Promise<A2aLensResult> {
  const input = buildLensInput(lens, diff, diffStat, signatures);
  const { baseUrl, apiKey } = resolveModelRoute(modelId, config);

  try {
    const rawOutput = await caller.queryText(input, {
      modelId,
      baseUrl,
      apiKey,
      cwd,
      maxTurns: 3,
      timeoutMs: 180_000,
    });

    const findings = parseLensOutput(rawOutput, lens, existingFindingsCount);
    return { lens, model: modelId, findings, raw_output: rawOutput };
  } catch (err: any) {
    return { lens, model: modelId, findings: [], raw_output: `ERROR: ${err.message}` };
  }
}

// ── Main entry point ──

/**
 * Run a2a 3-lens review on a worktree.
 *
 * Caller provides ModelCaller + model list. No registry dependency.
 * Models are assigned round-robin to lenses.
 */
export async function runA2aReview(
  input: A2aReviewInput,
  caller: ModelCaller,
  options: A2aReviewOptions,
  config?: Partial<DiscussConfig>,
): Promise<A2aReviewResult> {
  const { worktreePath, changedFiles, taskDescription } = input;
  const { models } = options;

  // 1. Compute diff data once
  const diffStat = getWorktreeDiffStat(worktreePath);
  const diff = getWorktreeFullDiff(worktreePath);
  const signatures = extractSignatures(worktreePath, changedFiles);

  // 2. Determine scale and lenses
  const scale = options.scale === 'auto' || !options.scale
    ? determineScale(diffStat)
    : options.scale;
  const lenses = lensesForScale(scale);

  // 3. Assign models to lenses (round-robin from provided list)
  const assignModel = (index: number) => models[index % models.length] || models[0];

  // 4. Run all lenses in parallel
  const lensResults = await Promise.all(
    lenses.map((lens, i) =>
      runLens(lens, assignModel(i), caller, diff, diffStat, signatures, worktreePath, config),
    ),
  );

  // 5. Aggregate findings
  const allFindings = lensResults.flatMap(r => r.findings);
  const redCount = allFindings.filter(f => f.severity === 'red').length;
  const yellowCount = allFindings.filter(f => f.severity === 'yellow').length;
  const greenCount = allFindings.filter(f => f.severity === 'green').length;

  // 6. Determine verdict
  let verdict: A2aVerdict = 'CONTESTED';
  if (allFindings.length === 0 || redCount === 0) {
    verdict = 'PASS';
  } else if (lenses.length === 1) {
    verdict = 'REJECT';
  } else if (redCount > 0 && lenses.length > 1) {
    const redFiles = allFindings
      .filter(f => f.severity === 'red')
      .map(f => f.file.split(':')[0]);
    const duplicateRedFiles = redFiles.filter((f, i) => redFiles.indexOf(f) !== i);
    verdict = duplicateRedFiles.length > 0 ? 'REJECT' : 'CONTESTED';
  }

  return {
    verdict,
    lens_results: lensResults,
    all_findings: allFindings,
    red_count: redCount,
    yellow_count: yellowCount,
    green_count: greenCount,
  };
}
