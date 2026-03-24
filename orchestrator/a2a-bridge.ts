// ═══════════════════════════════════════════════════════════════════
// orchestrator/a2a-bridge.ts — Run a2a 3-lens review using domestic models
// ═══════════════════════════════════════════════════════════════════
// Self-contained integration layer — no external a2a project dependency

import { query } from '@anthropic-ai/claude-code';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import type {
  A2aLens, A2aLensResult, A2aReviewResult, A2aVerdict,
  ReviewFinding, FindingSeverity, SubTask, WorkerResult,
} from './types.js';
import { getRegistry } from './model-registry.js';
import { resolveProvider } from './provider-resolver.js';

// Lens prompts (internalized from a2a review-lenses.md)
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

// Determine review scale based on diff size (mirrors a2a SKILL.md logic)
function determineScale(diffStat: string): 'light' | 'medium' | 'heavy' | 'heavy+' {
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

// Which lenses to use based on scale
function lensesForScale(scale: string): A2aLens[] {
  switch (scale) {
    case 'light': return ['challenger'];
    case 'medium': return ['challenger', 'architect'];
    case 'heavy': return ['challenger', 'architect'];
    case 'heavy+': return ['challenger', 'architect', 'subtractor'];
    default: return ['challenger', 'architect'];
  }
}

// Get worktree diff stat (self-contained)
function getWorktreeDiffStat(worktreePath: string): string {
  try {
    return execSync('git diff --stat HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch {
    return '';
  }
}

// Get worktree full diff (self-contained)
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

// Build the input for each lens
function buildLensInput(
  lens: A2aLens,
  workerResult: WorkerResult,
  diff: string,
  diffStat: string,
  signatures: string,
): string {
  switch (lens) {
    case 'challenger':
      // Full diff for bug-finding
      return LENS_PROMPTS.challenger + diff.slice(0, 8000); // Limit to 8k chars

    case 'architect':
      // Only structure — file list + function signatures, not full diff
      return LENS_PROMPTS.architect + diffStat + '\n\n' + signatures;

    case 'subtractor':
      // Full diff for finding deletable code
      return LENS_PROMPTS.subtractor + diff.slice(0, 8000);
  }
}

function extractSignatures(result: WorkerResult): string {
  // Read changed files and extract function/class signatures
  const signatures: string[] = [];
  for (const file of result.changedFiles.slice(0, 10)) {
    const fullPath = path.join(result.worktreePath, file);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf-8');

    // Extract signatures (TypeScript/JavaScript)
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

// Resolve provider from config or environment
async function resolveProviderConfig(providerId: string): Promise<{ baseUrl: string; apiKey: string }> {
  try {
    const result = resolveProvider(providerId);
    return { baseUrl: result.baseUrl, apiKey: result.apiKey };
  } catch {
    // Fallback to environment variables
    const envKey = providerId.toUpperCase().replace(/-/g, '_');
    return {
      baseUrl: process.env[`${envKey}_BASE_URL`] || '',
      apiKey: process.env[`${envKey}_API_KEY`] || '',
    };
  }
}

// Run a single lens review on a domestic model
async function runLens(
  lens: A2aLens,
  model: { id: string; provider: string },
  workerResult: WorkerResult,
  diff: string,
  diffStat: string,
  signatures: string,
): Promise<A2aLensResult> {
  const input = buildLensInput(lens, workerResult, diff, diffStat, signatures);

  console.log(`      🔍 ${lens} lens → ${model.id}`);

  const { baseUrl, apiKey } = await resolveProviderConfig(model.provider);

  try {
    const messages = query({
      prompt: input,
      options: {
        cwd: workerResult.worktreePath,
        env: {
          ANTHROPIC_MODEL: model.id,
          ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
          ...(apiKey ? { ANTHROPIC_AUTH_TOKEN: apiKey } : {}),
        },
        maxTurns: 3, // Review should be quick
      }
    });

    let rawOutput = '';
    for await (const msg of messages) {
      if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          rawOutput += content.map(c => c.type === 'text' ? c.text : '').join('');
        } else if (typeof content === 'string') {
          rawOutput += content;
        }
      }
    }

    // Parse findings from JSON
    const findings = parseLensOutput(rawOutput, lens);

    return { lens, model: model.id, findings, raw_output: rawOutput };
  } catch (err: any) {
    console.log(`      ❌ ${lens} lens failed: ${err.message?.slice(0, 80)}`);
    return { lens, model: model.id, findings: [], raw_output: `ERROR: ${err.message}` };
  }
}

function extractJsonObject(rawOutput: string): string | null {
  const start = rawOutput.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < rawOutput.length; index += 1) {
    const char = rawOutput[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
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
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return rawOutput.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseLensOutput(output: string, lens: A2aLens): ReviewFinding[] {
  try {
    const jsonPayload = extractJsonObject(output);
    if (!jsonPayload) return [];

    const parsed = JSON.parse(jsonPayload);
    if (!Array.isArray(parsed.findings)) return [];

    return parsed.findings.slice(0, 10).map((f: any, i: number) => ({
      id: i + 1,
      severity: (['red', 'yellow', 'green'].includes(f.severity) ? f.severity : 'yellow') as FindingSeverity,
      lens,
      file: f.file || 'unknown',
      line: parseInt(f.file?.split(':')[1]) || undefined,
      issue: String(f.issue || '').slice(0, 300),
      decision: 'flag',
    }));
  } catch {
    return [];
  }
}

// ── Main a2a review function ──

export async function runA2aReview(
  workerResult: WorkerResult,
  task: SubTask,
): Promise<A2aReviewResult> {
  const registry = getRegistry();
  const modelIds = registry.selectA2aLensModels(workerResult.model);
  const lensModels: Record<string, { id: string; provider: string }> = {
    challenger: registry.get(modelIds[0] || workerResult.model) || { id: workerResult.model, provider: 'default' },
    architect: registry.get(modelIds[1] || modelIds[0] || workerResult.model) || { id: workerResult.model, provider: 'default' },
    subtractor: registry.get(modelIds[2] || modelIds[1] || modelIds[0] || workerResult.model) || { id: workerResult.model, provider: 'default' },
  };

  // 1. Determine scale
  const diffStat = getWorktreeDiffStat(workerResult.worktreePath);
  const diff = getWorktreeFullDiff(workerResult.worktreePath);
  const signatures = extractSignatures(workerResult);
  const scale = task.review_scale === 'auto'
    ? determineScale(diffStat)
    : task.review_scale;

  const lenses = lensesForScale(scale);
  console.log(`    📋 a2a review: scale=${scale}, lenses=[${lenses.join(',')}]`);

  // 2. Run all lenses IN PARALLEL (reviewers must not see each other)
  const lensResults = await Promise.all(
    lenses.map(lens => runLens(
      lens,
      lensModels[lens] || { id: workerResult.model, provider: 'default' },
      workerResult,
      diff,
      diffStat,
      signatures,
    ))
  );

  // 3. Aggregate findings
  const allFindings = lensResults.flatMap(r => r.findings);
  const redCount = allFindings.filter(f => f.severity === 'red').length;
  const yellowCount = allFindings.filter(f => f.severity === 'yellow').length;
  const greenCount = allFindings.filter(f => f.severity === 'green').length;

  // 4. Determine verdict (following a2a SKILL.md rules)
  let verdict: A2aVerdict = 'CONTESTED';
  if (allFindings.length === 0) {
    verdict = 'PASS';
  } else if (redCount === 0) {
    verdict = 'PASS'; // Only yellow/green = pass
  } else if (lenses.length === 1) {
    verdict = 'REJECT';
  } else if (redCount > 0 && lenses.length > 1) {
    // Check if multiple lenses agree on red findings (same file)
    const redFiles = allFindings
      .filter(f => f.severity === 'red')
      .map(f => f.file.split(':')[0]);
    const duplicateRedFiles = redFiles.filter((f, i) => redFiles.indexOf(f) !== i);
    verdict = duplicateRedFiles.length > 0 ? 'REJECT' : 'CONTESTED';
  }

  console.log(`    📋 a2a verdict: ${verdict} (${redCount}R/${yellowCount}Y/${greenCount}G)`);

  return {
    verdict,
    lens_results: lensResults,
    all_findings: allFindings,
    red_count: redCount,
    yellow_count: yellowCount,
    green_count: greenCount,
  };
}
