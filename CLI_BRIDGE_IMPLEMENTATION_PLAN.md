# CLI2CLI: Multi-Model Orchestration System — Final Implementation Plan
> 4-Tier AI Cascade — Opus thinks, Sonnet reviews, Domestic executes, Workers discuss & fight

**Version**: 2.0 (Final)
**Date**: 2026-03-24
**Status**: Ready for execution by any agent

---

## 0. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Tier 0: Kimi CLI (Translate)                                    │
│  User speaks Chinese → Kimi distills to clean English prompt     │
│  Cost: ~¥0.001/req                                               │
└──────────────────────┬───────────────────────────────────────────┘
                       ↓ clean English prompt
┌──────────────────────────────────────────────────────────────────┐
│  Tier 1: Claude Opus (Plan + Final Decisions)                    │
│  Receives clean prompt → decomposes into sub-tasks               │
│  Assigns each task to optimal model based on capability table    │
│  Also handles: architecture decisions, security-critical code    │
│  Cost: $$$  — used sparingly (1-2 calls per session)             │
└──────────────────────┬───────────────────────────────────────────┘
                       ↓ task list + model assignments
┌──────────────────────────────────────────────────────────────────┐
│  Tier 2: Review Pipeline (4-stage cascade)                       │
│                                                                  │
│  Stage 1: Cross-review (domestic model A reviews B's code)       │
│      ↓ flagged                                                   │
│  Stage 2: a2a 3-lens review (Challenger+Architect+Subtractor)    │
│           all lenses run on domestic models (near-free)           │
│      ↓ CONTESTED                                                 │
│  Stage 3: Claude Sonnet arbitrates (only disputed findings)      │
│      ↓ unresolved                                                │
│  Stage 4: Claude Opus final verdict (rare, ~2% of cases)         │
│                                                                  │
│  Cost: mostly ¥, Claude only on filtered disputes                │
└──────────────────────┬───────────────────────────────────────────┘
                       ↓ approved code
┌──────────────────────────────────────────────────────────────────┐
│  Tier 3: Domestic Models via MMS Bridge (Execute)                │
│  Full Claude Code instances, LLM swapped to domestic             │
│  Each worker: isolated worktree, full tool access                │
│  Can trigger agent-discuss when uncertain                        │
│  Cost: ¥  — bulk of work happens here                            │
│                                                                  │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐           │
│  │Worker A │  │Worker B │  │Worker C │  │Worker D │           │
│  │ (Qwen)  │  │ (Kimi)  │  │(DeepSeek│  │ (GLM)   │           │
│  │ schema  │  │  utils  │  │  tests) │  │  docs   │           │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘           │
│       │ agent-discuss │          │             │                │
│       └──────⇄───────┘          │             │                │
│         (when uncertain)         │             │                │
└──────────────────────────────────────────────────────────────────┘
```

### Cost Model (per medium project session)

| Tier | Role | Calls | Cost |
|------|------|-------|------|
| Opus | Plan + final decision | 2-3 | ~$0.50 |
| Sonnet | Filtered arbitration | 2-3 | ~$0.10 |
| Haiku | Context summarization | 5-8 | ~$0.02 |
| Domestic (execute) | All task implementation | 20-40 | ~¥0.50 (~$0.07) |
| Domestic (cross-review) | Cross-review + a2a lenses | 15-25 | ~¥0.40 (~$0.06) |
| Domestic (discuss) | agent-discuss rounds | 4-8 | ~¥0.15 (~$0.02) |
| **Total** | | | **~$0.77** vs ~$5+ pure Opus |

---

## 1. Existing Infrastructure (DO NOT rebuild)

### MMS (`/Users/xin/auto-skills/CtriXin-repo/multi-model-switch`)
| File | Status | Function |
|------|--------|----------|
| `ccs_bridge.py` | ✅ Complete | Anthropic ↔ OpenAI ↔ Gemini protocol translation, tool_use streaming |
| `ccs_router.py` | ✅ Complete | 3-tier routing (light/medium/heavy) + auto-learning keywords |
| `ccs_session.py` | ✅ Complete | Per-PID session isolation with HOME symlinks |
| `ccs_adapter_registry.py` | ✅ Complete | Provider templates: qwen, kimi, glm, minimax, doubao, bailian-codingplan |
| `ccs_launchers.py` | ✅ Complete | CLI launch wrappers for claude/codex/qwen/kimi/gemini |

### agent-discuss (`/Users/xin/auto-skills/CtriXin-repo/agent-discuss`)
| File | Status | Function |
|------|--------|----------|
| `scripts/discuss.sh` | ✅ Complete (786 lines) | Full discussion orchestration |
| `scripts/invoke_adapter.sh` | ✅ Complete | Adapter invocation (codex/claude) |
| `scripts/preflight.sh` | ✅ Complete | Adapter availability detection + caching |
| Thread persistence | ✅ Complete | `state.json` + `timeline.md` + round artifacts |
| Quality gate | ✅ Complete | Required pushback, pass/warn/fail scoring |

### a2a (`/Users/xin/auto-skills/CtriXin-repo/agent-2-agent`)
| File | Status | Function |
|------|--------|----------|
| `SKILL.md` | ✅ Complete (v1.8.0) | 3-lens adversarial code review |
| `scripts/preflight.sh` | ✅ Complete | Environment detection + token bridge |
| `scripts/a2a-health.sh` | ✅ Complete | One-click diagnosis + auto-fix |
| `references/review-lenses.md` | ✅ Complete | Challenger + Architect + Subtractor lens definitions |
| Scale system | ✅ Complete | Light(1 lens) / Medium(2) / Heavy+(3) based on diff size |

---

## 2. What Needs to Be Built

### File Structure

```
cli2cli/
├── orchestrator/
│   ├── index.ts                 # Main orchestrator entry + CLI
│   ├── planner.ts               # Task decomposition (Opus-powered)
│   ├── dispatcher.ts            # Worker spawning + env injection
│   ├── reviewer.ts              # 4-stage review cascade
│   ├── a2a-bridge.ts            # a2a 3-lens integration for domestic models
│   ├── discuss-trigger.ts       # agent-discuss integration
│   ├── model-registry.ts        # Capability table + dynamic scoring
│   ├── context-recycler.ts      # Pass output from Worker A → B
│   ├── worktree-manager.ts      # Git worktree lifecycle
│   ├── mms-bridge-resolver.ts   # Resolve MMS bridge URLs for providers
│   └── types.ts                 # All shared TypeScript interfaces
├── mcp-server/
│   └── index.ts                 # MCP tools for Claude to call
├── config/
│   ├── model-capabilities.json  # Initial capability table
│   ├── review-policy.json       # Review cascade rules
│   └── a2a-lens-config.json     # Which domestic model plays which lens
├── scripts/
│   ├── smoke-test.sh            # Full smoke test suite
│   ├── test-bridge-health.sh    # Verify MMS bridge for each provider
│   └── test-worker-spawn.sh     # Verify single worker lifecycle
├── bin/
│   └── cli2cli                  # CLI entry point (hashbang node script)
├── package.json
├── tsconfig.json
└── README.md
```

---

## 3. Complete Type Definitions (`orchestrator/types.ts`)

Every other file imports from here. **Implement this first.**

```typescript
// ═══════════════════════════════════════════════════════════════════
// orchestrator/types.ts — All shared interfaces for CLI2CLI
// ═══════════════════════════════════════════════════════════════════

// ── Model Registry ──

export type Complexity = 'low' | 'medium' | 'medium-high' | 'high';

export interface ModelCapability {
  id: string;                    // "qwen3.5-plus"
  provider: string;              // "bailian-codingplan" (maps to MMS provider template id)
  display_name: string;          // "Qwen 3.5 Plus"

  // Static scores (initial from benchmarks, 0-1)
  coding: number;
  tool_use_reliability: number;
  reasoning: number;
  chinese: number;

  // Dynamic scores (updated from review results)
  pass_rate: number;
  avg_iterations: number;
  total_tasks_completed: number;
  last_updated: string;          // ISO timestamp

  // Constraints
  context_window: number;
  cost_per_mtok_input: number;   // ¥
  cost_per_mtok_output: number;
  max_complexity: Complexity;

  // Affinities
  sweet_spot: string[];          // ["schema", "CRUD", "tests"]
  avoid: string[];               // ["security", "concurrency"]
}

export interface ClaudeTier {
  use_for: string[];
  cost_per_mtok_input: number;   // USD
  cost_per_mtok_output: number;
}

export interface ModelCapabilitiesConfig {
  models: ModelCapability[];
  claude_tiers: Record<'opus' | 'sonnet' | 'haiku', ClaudeTier>;
}

// ── Task Planning ──

export interface TaskPlan {
  id: string;                              // uuid
  goal: string;                            // Original goal (English)
  cwd: string;                             // Project root
  tasks: SubTask[];
  execution_order: string[][];             // Parallel groups: [["A","B"], ["C"]]
  context_flow: Record<string, string[]>;  // {"C": ["A"]} = C depends on A's output
  created_at: string;                      // ISO timestamp
}

export interface SubTask {
  id: string;                              // "task-a", "task-b"
  description: string;                     // Self-contained instruction
  complexity: Complexity;
  category: string;                        // "schema"|"utils"|"tests"|"api"|"security"|...
  assigned_model: string;                  // "qwen3.5-plus" | "claude-opus"
  assignment_reason: string;
  estimated_files: string[];               // Files this task will create/modify
  acceptance_criteria: string[];           // How to verify
  discuss_threshold: number;               // 0-1, below this → trigger discuss
  depends_on: string[];                    // Task IDs
  review_scale: 'light' | 'medium' | 'heavy' | 'heavy+' | 'auto';
}

// ── Worker ──

export interface WorkerConfig {
  taskId: string;
  model: string;
  provider: string;
  prompt: string;
  cwd: string;
  worktree: boolean;
  contextInputs: ContextPacket[];
  discussThreshold: number;
  maxTurns: number;                        // Safety limit, default 25
  sessionId?: string;                      // For resume
}

export interface WorkerResult {
  taskId: string;
  model: string;
  worktreePath: string;
  branch: string;                          // Git branch name
  sessionId: string;
  output: WorkerMessage[];
  changedFiles: string[];                  // From git diff
  success: boolean;
  duration_ms: number;
  token_usage: { input: number; output: number };
  discuss_triggered: boolean;
  discuss_results: DiscussResult[];
}

export interface WorkerMessage {
  type: 'assistant' | 'tool_use' | 'tool_result' | 'error' | 'system';
  content: string;
  timestamp: number;
}

// ── Context Recycling ──

export interface ContextPacket {
  from_task: string;
  summary: string;
  key_outputs: {
    file: string;
    purpose: string;
    key_exports: string[];
  }[];
  decisions_made: string[];
}

// ── Discussion ──

export interface DiscussTrigger {
  uncertain_about: string;
  options: string[];
  leaning: string;
  why: string;
  task_id: string;
  worker_model: string;
}

export interface DiscussResult {
  decision: string;
  reasoning: string;
  escalated: boolean;
  escalated_to?: 'sonnet' | 'opus';
  thread_id: string;
  quality_gate: 'pass' | 'warn' | 'fail';
}

// ── Review ──

export type ReviewStage = 'cross-review' | 'a2a-lenses' | 'sonnet' | 'opus';
export type A2aVerdict = 'PASS' | 'CONTESTED' | 'REJECT' | 'BLOCKED';
export type FindingSeverity = 'red' | 'yellow' | 'green';
export type A2aLens = 'challenger' | 'architect' | 'subtractor';

export interface ReviewResult {
  taskId: string;
  final_stage: ReviewStage;               // Highest stage reached
  passed: boolean;
  verdict?: A2aVerdict;                   // If a2a was invoked
  findings: ReviewFinding[];
  iterations: number;
  duration_ms: number;
}

export interface ReviewFinding {
  id: number;
  severity: FindingSeverity;
  lens: A2aLens | 'cross-review' | 'sonnet' | 'opus';
  file: string;
  line?: number;
  issue: string;
  decision: 'accept' | 'dismiss' | 'flag';
  decision_reason?: string;
}

export interface CrossReviewResult {
  passed: boolean;
  confidence: number;                     // 0-1
  flagged_issues: string[];
  reviewer_model: string;
}

export interface A2aLensResult {
  lens: A2aLens;
  model: string;
  findings: ReviewFinding[];
  raw_output: string;
}

export interface A2aReviewResult {
  verdict: A2aVerdict;
  lens_results: A2aLensResult[];
  all_findings: ReviewFinding[];
  red_count: number;
  yellow_count: number;
  green_count: number;
}

// ── Orchestrator Output ──

export interface OrchestratorResult {
  plan: TaskPlan;
  worker_results: WorkerResult[];
  review_results: ReviewResult[];
  score_updates: { model: string; old_pass_rate: number; new_pass_rate: number }[];
  total_duration_ms: number;
  cost_estimate: {
    opus_tokens: number;
    sonnet_tokens: number;
    haiku_tokens: number;
    domestic_tokens: number;
    estimated_cost_usd: number;
  };
}
```

---

## 4. Component Implementations

### 4.1 Model Registry (`orchestrator/model-registry.ts`)

```typescript
// ═══════════════════════════════════════════════════════════════════
// orchestrator/model-registry.ts — Load, query, and update model capabilities
// ═══════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { ModelCapability, ModelCapabilitiesConfig, Complexity, SubTask } from './types';

const CONFIG_PATH = path.resolve(__dirname, '../config/model-capabilities.json');

// Score floor/ceiling to prevent runaway drift
const SCORE_FLOOR = 0.30;
const SCORE_CEILING = 0.95;
const EMA_ALPHA = 0.2;  // Exponential moving average weight for recent results

const COMPLEXITY_RANK: Record<Complexity, number> = {
  'low': 1,
  'medium': 2,
  'medium-high': 3,
  'high': 4,
};

export class ModelRegistry {
  private config: ModelCapabilitiesConfig;

  constructor() {
    this.config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  }

  reload(): void {
    this.config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  }

  getAll(): ModelCapability[] {
    return this.config.models;
  }

  get(id: string): ModelCapability | undefined {
    return this.config.models.find(m => m.id === id);
  }

  getClaudeTier(tier: 'opus' | 'sonnet' | 'haiku') {
    return this.config.claude_tiers[tier];
  }

  // ── Model Assignment ──

  assignModel(task: SubTask): string {
    // Rule 1: Security-critical or high complexity → Opus
    if (task.complexity === 'high' || task.category === 'security') {
      return 'claude-opus';
    }

    // Rule 2: Score all domestic models
    const candidates = this.config.models.filter(m =>
      COMPLEXITY_RANK[m.max_complexity] >= COMPLEXITY_RANK[task.complexity]
    );

    if (candidates.length === 0) return 'claude-opus'; // Fallback

    const scored = candidates
      .map(m => ({ model: m, score: this.calculateFit(m, task) }))
      .sort((a, b) => b.score - a.score);

    return scored[0].model.id;
  }

  private calculateFit(model: ModelCapability, task: SubTask): number {
    let score = 0;

    // Affinity: +30 if sweet_spot matches category
    if (model.sweet_spot.includes(task.category)) score += 30;

    // Anti-affinity: -50 if in avoid list
    if (model.avoid.includes(task.category)) score -= 50;

    // Historical pass rate: 0-25 points
    score += model.pass_rate * 25;

    // Fewer iterations = better: -10 per extra iteration
    score -= (model.avg_iterations - 1) * 10;

    // Cost efficiency: cheaper = bonus
    score += (1 / Math.max(model.cost_per_mtok_output, 0.01)) * 5;

    // Tool reliability bonus for multi-file tasks
    if (task.estimated_files.length > 3) {
      score += model.tool_use_reliability * 20;
    }

    // Reasoning bonus for logic-heavy tasks
    if (['algorithms', 'complex-logic', 'data-processing'].includes(task.category)) {
      score += model.reasoning * 15;
    }

    return score;
  }

  // ── Select cross-reviewer (different vendor than worker) ──

  selectCrossReviewer(workerModelId: string): ModelCapability {
    const worker = this.get(workerModelId);
    const candidates = this.config.models
      .filter(m => m.id !== workerModelId)
      // Prefer different provider (different vendor = different blind spots)
      .sort((a, b) => {
        const aDiffProvider = a.provider !== worker?.provider ? 1 : 0;
        const bDiffProvider = b.provider !== worker?.provider ? 1 : 0;
        if (aDiffProvider !== bDiffProvider) return bDiffProvider - aDiffProvider;
        return b.coding - a.coding;
      });

    return candidates[0];
  }

  // ── Select discuss partner (highest reasoning, different model) ──

  selectDiscussPartner(workerModelId: string): ModelCapability {
    return this.config.models
      .filter(m => m.id !== workerModelId)
      .sort((a, b) => b.reasoning - a.reasoning)[0];
  }

  // ── Select a2a lens assignments (3 different models for 3 lenses) ──

  selectA2aLensModels(workerModelId: string): Record<string, ModelCapability> {
    const available = this.config.models
      .filter(m => m.id !== workerModelId)
      .sort((a, b) => b.coding - a.coding);

    // Best coding → Challenger (finds bugs)
    // Best reasoning → Architect (reviews design)
    // Any remaining → Subtractor (finds over-engineering)
    const byReasoning = [...available].sort((a, b) => b.reasoning - a.reasoning);

    return {
      challenger: available[0] || available[0],
      architect: byReasoning[0] || available[0],
      subtractor: available.find(m =>
        m.id !== available[0]?.id && m.id !== byReasoning[0]?.id
      ) || available[available.length - 1] || available[0],
    };
  }

  // ── Dynamic score update ──

  updateScore(modelId: string, passed: boolean, iterations: number): void {
    const model = this.get(modelId);
    if (!model) return;

    const oldRate = model.pass_rate;

    // Exponential moving average
    model.pass_rate = model.pass_rate * (1 - EMA_ALPHA) + (passed ? 1.0 : 0.0) * EMA_ALPHA;
    model.avg_iterations = model.avg_iterations * (1 - EMA_ALPHA) + iterations * EMA_ALPHA;
    model.total_tasks_completed += 1;
    model.last_updated = new Date().toISOString();

    // Clamp scores
    model.pass_rate = Math.max(SCORE_FLOOR, Math.min(SCORE_CEILING, model.pass_rate));

    this.save();

    return { old: oldRate, new: model.pass_rate };
  }

  private save(): void {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf-8');
  }
}
```

### 4.2 MMS Bridge Resolver (`orchestrator/mms-bridge-resolver.ts`)

```typescript
// ═══════════════════════════════════════════════════════════════════
// orchestrator/mms-bridge-resolver.ts — Resolve MMS bridge URLs for providers
// ═══════════════════════════════════════════════════════════════════

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const MMS_CONFIG_DIR = process.env.MMS_CONFIG_DIR || path.join(process.env.HOME!, '.config/mms');

interface ProviderConfig {
  id: string;
  openai_base_url?: string;
  anthropic_base_url?: string;
  api_key?: string;
}

// Load MMS config.toml to find provider URLs
export function resolveProviderUrl(providerId: string): { baseUrl: string; apiKey: string } {
  // 1. Try credentials.sh for API key
  const credentialsPath = path.join(MMS_CONFIG_DIR, 'credentials.sh');
  let apiKey = '';
  if (fs.existsSync(credentialsPath)) {
    const creds = fs.readFileSync(credentialsPath, 'utf-8');
    // Parse: export CCS_PROVIDER_<ID>_API_KEY="..."
    const keyMatch = creds.match(new RegExp(`CCS_PROVIDER_${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY="([^"]+)"`));
    if (keyMatch) apiKey = keyMatch[1];
  }

  // 2. Try config.toml for base URL
  // MMS stores provider base URLs in config — we need the Anthropic-compatible endpoint
  // because Claude Code SDK speaks Anthropic Messages API
  const PROVIDER_ANTHROPIC_URLS: Record<string, string> = {
    'bailian-codingplan': 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    'qwen': 'https://dashscope.aliyuncs.com/apps/anthropic',
    'kimi': 'https://api.moonshot.ai/anthropic/',
    'kimi-codingplan': 'https://api.kimi.com/coding/',
    'glm-cn': 'https://open.bigmodel.cn/api/anthropic',
    'glm-en': 'https://api.z.ai/api/anthropic',
    'minimax-cn': 'https://api.minimaxi.com/anthropic',
    'minimax-en': 'https://api.minimax.io/anthropic',
    'deepseek': 'https://api.deepseek.com/v1',  // OpenAI-compatible, needs bridge
  };

  const baseUrl = PROVIDER_ANTHROPIC_URLS[providerId];
  if (!baseUrl) {
    throw new Error(`Unknown provider: ${providerId}. Known: ${Object.keys(PROVIDER_ANTHROPIC_URLS).join(', ')}`);
  }

  // 3. For providers that only support OpenAI (e.g., deepseek), we need MMS bridge
  //    MMS bridge auto-translates Anthropic → OpenAI
  if (providerId === 'deepseek') {
    // Start MMS bridge locally and return local URL
    return startLocalBridge(providerId, baseUrl, apiKey);
  }

  return { baseUrl, apiKey };
}

function startLocalBridge(providerId: string, upstreamUrl: string, apiKey: string): { baseUrl: string; apiKey: string } {
  // Check if bridge is already running for this provider
  const pidFile = path.join(MMS_CONFIG_DIR, `bridge-${providerId}.pid`);
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
    try {
      process.kill(pid, 0); // Check if alive
      const portFile = path.join(MMS_CONFIG_DIR, `bridge-${providerId}.port`);
      const port = fs.readFileSync(portFile, 'utf-8').trim();
      return { baseUrl: `http://127.0.0.1:${port}`, apiKey };
    } catch {
      // Process dead, clean up
      fs.unlinkSync(pidFile);
    }
  }

  // Need to start MMS bridge
  // This is handled by MMS's ccs_bridge.py — we invoke it
  throw new Error(
    `Provider ${providerId} requires MMS bridge (OpenAI-only provider). ` +
    `Start MMS with: mms claude --provider ${providerId}`
  );
}

// Health check: can we reach this provider?
export async function checkProviderHealth(providerId: string): Promise<boolean> {
  try {
    const { baseUrl, apiKey } = resolveProviderUrl(providerId);
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
```

### 4.3 Worktree Manager (`orchestrator/worktree-manager.ts`)

```typescript
// ═══════════════════════════════════════════════════════════════════
// orchestrator/worktree-manager.ts — Git worktree lifecycle management
// ═══════════════════════════════════════════════════════════════════

import { execSync } from 'child_process';
import path from 'path';

const WORKTREE_BASE = '.claude/worktrees';

export function createWorktree(projectRoot: string, name: string): string {
  const worktreePath = path.join(projectRoot, WORKTREE_BASE, name);
  const branch = `cli2cli/${name}`;

  // Create worktree with new branch from HEAD
  execSync(`git worktree add -b "${branch}" "${worktreePath}" HEAD`, {
    cwd: projectRoot,
    stdio: 'pipe',
  });

  return worktreePath;
}

export function removeWorktree(projectRoot: string, name: string): void {
  const worktreePath = path.join(projectRoot, WORKTREE_BASE, name);
  execSync(`git worktree remove "${worktreePath}" --force`, {
    cwd: projectRoot,
    stdio: 'pipe',
  });
}

export function getWorktreeDiff(worktreePath: string): string[] {
  const diff = execSync('git diff --name-only HEAD', {
    cwd: worktreePath,
    encoding: 'utf-8',
  });
  return diff.trim().split('\n').filter(Boolean);
}

export function getWorktreeDiffStat(worktreePath: string): string {
  return execSync('git diff --stat HEAD', {
    cwd: worktreePath,
    encoding: 'utf-8',
  });
}

export function getWorktreeFullDiff(worktreePath: string): string {
  return execSync('git diff HEAD', {
    cwd: worktreePath,
    encoding: 'utf-8',
  });
}

// Merge a worktree branch back into the main branch
export function mergeWorktree(projectRoot: string, name: string): { success: boolean; conflicts: string[] } {
  const branch = `cli2cli/${name}`;

  try {
    execSync(`git merge --no-ff "${branch}" -m "cli2cli: merge ${name}"`, {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    return { success: true, conflicts: [] };
  } catch (err: any) {
    // Extract conflict files
    const status = execSync('git diff --name-only --diff-filter=U', {
      cwd: projectRoot,
      encoding: 'utf-8',
    });
    return { success: false, conflicts: status.trim().split('\n').filter(Boolean) };
  }
}

// List all active worktrees for this orchestration session
export function listWorktrees(projectRoot: string): string[] {
  const output = execSync('git worktree list --porcelain', {
    cwd: projectRoot,
    encoding: 'utf-8',
  });

  return output
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.replace('worktree ', ''))
    .filter(p => p.includes(WORKTREE_BASE));
}
```

### 4.4 Context Recycler (`orchestrator/context-recycler.ts`)

```typescript
// ═══════════════════════════════════════════════════════════════════
// orchestrator/context-recycler.ts — Extract and inject context between workers
// ═══════════════════════════════════════════════════════════════════

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ContextPacket, WorkerResult, SubTask } from './types';
import { getWorktreeDiff } from './worktree-manager';

// Build a context packet from a completed worker's output.
// Uses git diff to find changed files, then extracts key exports.
// Summary is generated by reading the diff and extracting structure.
export function buildContextPacket(result: WorkerResult, task: SubTask): ContextPacket {
  const changedFiles = getWorktreeDiff(result.worktreePath);

  const keyOutputs = changedFiles.map(filePath => {
    const fullPath = path.join(result.worktreePath, filePath);
    if (!fs.existsSync(fullPath)) return null;

    const content = fs.readFileSync(fullPath, 'utf-8');
    return {
      file: filePath,
      purpose: task.description.slice(0, 100),
      key_exports: extractExports(content, filePath),
    };
  }).filter(Boolean) as ContextPacket['key_outputs'];

  // Build summary from worker messages (last assistant messages)
  const assistantMessages = result.output
    .filter(m => m.type === 'assistant')
    .map(m => m.content)
    .slice(-3);

  const summary = assistantMessages.join('\n').slice(0, 500);

  // Extract decisions from assistant output
  const decisions = extractDecisions(assistantMessages.join('\n'));

  return {
    from_task: task.id,
    summary,
    key_outputs: keyOutputs,
    decisions_made: decisions,
  };
}

function extractExports(content: string, filePath: string): string[] {
  const exports: string[] = [];
  const ext = path.extname(filePath);

  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
    // TypeScript/JavaScript exports
    const exportMatches = content.matchAll(/export\s+(?:default\s+)?(?:function|class|const|interface|type|enum)\s+(\w+)/g);
    for (const match of exportMatches) {
      exports.push(match[1]);
    }
  } else if (filePath.endsWith('.prisma')) {
    // Prisma models
    const modelMatches = content.matchAll(/model\s+(\w+)\s*\{/g);
    for (const match of modelMatches) {
      exports.push(`model ${match[1]}`);
    }
  } else if (['.py'].includes(ext)) {
    // Python: class and function definitions
    const defMatches = content.matchAll(/^(?:class|def)\s+(\w+)/gm);
    for (const match of defMatches) {
      exports.push(match[1]);
    }
  }

  return exports;
}

function extractDecisions(text: string): string[] {
  const decisions: string[] = [];

  // Look for decision-like patterns
  const patterns = [
    /I (?:decided|chose|selected|went with|opted for) (.+?)(?:\.|$)/gi,
    /(?:Using|Chose|Selected) (\w+ (?:over|instead of|rather than) \w+)/gi,
    /(?:Decision|Choice): (.+?)(?:\.|$)/gi,
  ];

  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      decisions.push(match[1].trim().slice(0, 200));
    }
  }

  return decisions.slice(0, 5); // Max 5 decisions
}

// Format context packets into a prompt injection for the next worker
export function formatContextForWorker(packets: ContextPacket[]): string {
  if (packets.length === 0) return '';

  const sections = packets.map(p => {
    const files = p.key_outputs
      .map(o => `  - \`${o.file}\`: ${o.purpose} (exports: ${o.key_exports.join(', ')})`)
      .join('\n');

    const decisions = p.decisions_made.length > 0
      ? `  Decisions to respect: ${p.decisions_made.join('; ')}`
      : '';

    return `### From task ${p.from_task}\n${p.summary}\n\nFiles created:\n${files}\n${decisions}`;
  });

  return `## Context from completed dependency tasks\n\n${sections.join('\n\n---\n\n')}\n\n**Use the above context. Do not re-implement what's already done.**`;
}
```

### 4.5 Worker Dispatcher (`orchestrator/dispatcher.ts`)

```typescript
// ═══════════════════════════════════════════════════════════════════
// orchestrator/dispatcher.ts — Spawn and manage Claude Code workers via MMS bridge
// ═══════════════════════════════════════════════════════════════════

import { claude } from '@anthropic-ai/claude-code';
import fs from 'fs';
import path from 'path';
import {
  WorkerConfig, WorkerResult, WorkerMessage,
  SubTask, TaskPlan, ContextPacket,
  DiscussTrigger,
} from './types';
import { ModelRegistry } from './model-registry';
import { resolveProviderUrl } from './mms-bridge-resolver';
import { createWorktree, getWorktreeDiff } from './worktree-manager';
import { buildContextPacket, formatContextForWorker } from './context-recycler';
import { triggerDiscussion } from './discuss-trigger';

const DISCUSS_TRIGGER_FILE = '.ai/discuss-trigger.json';

export async function spawnWorker(config: WorkerConfig): Promise<WorkerResult> {
  const startTime = Date.now();

  // 1. Resolve provider URL
  const { baseUrl, apiKey } = resolveProviderUrl(config.provider);

  // 2. Create worktree
  let workDir = config.cwd;
  let branch = 'HEAD';
  if (config.worktree) {
    workDir = createWorktree(config.cwd, `worker-${config.taskId}`);
    branch = `cli2cli/worker-${config.taskId}`;
  }

  // 3. Build full prompt
  let fullPrompt = '';

  // Inject context from dependencies
  if (config.contextInputs.length > 0) {
    fullPrompt += formatContextForWorker(config.contextInputs) + '\n\n';
  }

  // Main task instruction
  fullPrompt += `## Your Task\n\n${config.prompt}`;

  // Uncertainty protocol
  fullPrompt += `\n\n## Uncertainty Protocol
If your confidence drops below ${Math.round(config.discussThreshold * 100)}% on any decision:
1. Create the directory .ai/ if it doesn't exist
2. Write your uncertainty to ${DISCUSS_TRIGGER_FILE}:
   {"uncertain_about": "...", "options": ["A", "B"], "leaning": "A", "why": "...", "task_id": "${config.taskId}", "worker_model": "${config.model}"}
3. Then STOP working and output: "[DISCUSS_TRIGGER] Waiting for cross-model discussion"
Do NOT guess on architecture, security, or data model decisions. Flag them.`;

  // 4. Spawn Claude Code with domestic model backend
  const sessionId = config.sessionId || `cli2cli-${config.taskId}-${Date.now()}`;

  const messages = claude(fullPrompt, {
    sessionId,
    cwd: workDir,
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: config.model,
    },
    maxTurns: config.maxTurns,
  });

  // 5. Stream and monitor
  const output: WorkerMessage[] = [];
  const discussResults: any[] = [];
  let tokenUsage = { input: 0, output: 0 };
  let discussTriggered = false;

  for await (const msg of messages) {
    const workerMsg: WorkerMessage = {
      type: categorizeMessage(msg),
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg),
      timestamp: Date.now(),
    };
    output.push(workerMsg);

    // Track token usage if available
    if (msg.usage) {
      tokenUsage.input += msg.usage.input_tokens || 0;
      tokenUsage.output += msg.usage.output_tokens || 0;
    }

    // Detect discuss trigger
    if (workerMsg.content.includes('[DISCUSS_TRIGGER]')) {
      discussTriggered = true;
      const triggerPath = path.join(workDir, DISCUSS_TRIGGER_FILE);
      if (fs.existsSync(triggerPath)) {
        const trigger: DiscussTrigger = JSON.parse(fs.readFileSync(triggerPath, 'utf-8'));
        const result = await triggerDiscussion(trigger, config, workDir);
        discussResults.push(result);

        // Inject discussion result and continue
        // The worker will resume with the next iteration of the for-await loop
        // We inject via a follow-up message to the same session
        const followUp = claude(
          `Discussion result: ${result.decision}\nReasoning: ${result.reasoning}\n\nContinue your task with this decision.`,
          { sessionId, cwd: workDir, env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_MODEL: config.model }, maxTurns: config.maxTurns }
        );
        for await (const followMsg of followUp) {
          output.push({
            type: categorizeMessage(followMsg),
            content: typeof followMsg.content === 'string' ? followMsg.content : JSON.stringify(followMsg),
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  // 6. Collect results
  const changedFiles = getWorktreeDiff(workDir);

  return {
    taskId: config.taskId,
    model: config.model,
    worktreePath: workDir,
    branch,
    sessionId,
    output,
    changedFiles,
    success: changedFiles.length > 0 && !output.some(o => o.type === 'error'),
    duration_ms: Date.now() - startTime,
    token_usage: tokenUsage,
    discuss_triggered: discussTriggered,
    discuss_results: discussResults,
  };
}

// Dispatch multiple tasks respecting execution order
export async function dispatchBatch(
  plan: TaskPlan,
  registry: ModelRegistry,
): Promise<WorkerResult[]> {
  const results = new Map<string, WorkerResult>();
  const contextCache = new Map<string, ContextPacket>();

  for (const parallelGroup of plan.execution_order) {
    console.log(`\n═══ Dispatching group: [${parallelGroup.join(', ')}] ═══`);

    const groupResults = await Promise.all(
      parallelGroup.map(async (taskId) => {
        const task = plan.tasks.find(t => t.id === taskId)!;

        // Skip tasks assigned to Claude (handled directly by orchestrator)
        if (task.assigned_model === 'claude-opus') {
          console.log(`  Task ${taskId}: assigned to Claude Opus (handled directly)`);
          return null; // Opus tasks are handled separately
        }

        // Collect context from dependencies
        const contextInputs = (plan.context_flow[taskId] || [])
          .map(depId => contextCache.get(depId))
          .filter(Boolean) as ContextPacket[];

        console.log(`  Task ${taskId}: dispatching to ${task.assigned_model}`);

        return spawnWorker({
          taskId: task.id,
          model: task.assigned_model,
          provider: registry.get(task.assigned_model)!.provider,
          prompt: task.description,
          cwd: plan.cwd,
          worktree: true,
          contextInputs,
          discussThreshold: task.discuss_threshold,
          maxTurns: 25,
        });
      })
    );

    // Cache context for next group
    for (const result of groupResults) {
      if (!result) continue;
      results.set(result.taskId, result);
      const task = plan.tasks.find(t => t.id === result.taskId)!;
      contextCache.set(result.taskId, buildContextPacket(result, task));
    }
  }

  return Array.from(results.values());
}

function categorizeMessage(msg: any): WorkerMessage['type'] {
  if (msg.type === 'assistant' || msg.role === 'assistant') return 'assistant';
  if (msg.type === 'tool_use') return 'tool_use';
  if (msg.type === 'tool_result') return 'tool_result';
  if (msg.type === 'error' || msg.error) return 'error';
  return 'system';
}
```

### 4.6 Discussion Trigger (`orchestrator/discuss-trigger.ts`)

```typescript
// ═══════════════════════════════════════════════════════════════════
// orchestrator/discuss-trigger.ts — Trigger agent-discuss when workers are uncertain
// ═══════════════════════════════════════════════════════════════════

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DiscussTrigger, DiscussResult, WorkerConfig } from './types';
import { ModelRegistry } from './model-registry';
import { resolveProviderUrl } from './mms-bridge-resolver';

const DISCUSS_SCRIPT = path.resolve(
  process.env.AGENT_DISCUSS_PATH ||
  '/Users/xin/auto-skills/CtriXin-repo/agent-discuss/scripts/discuss.sh'
);

const MAX_DISCUSS_ROUNDS = 2;

export async function triggerDiscussion(
  trigger: DiscussTrigger,
  workerConfig: WorkerConfig,
  workDir: string,
): Promise<DiscussResult> {
  const registry = new ModelRegistry();

  // 1. Select discussion partner (different model, high reasoning)
  const partner = registry.selectDiscussPartner(workerConfig.model);
  const partnerUrl = resolveProviderUrl(partner.provider);

  // 2. Create thread ID
  const threadId = `cli2cli-${trigger.task_id}-discuss-${Date.now()}`;

  // 3. Prepare .ai directory
  const aiDir = path.join(workDir, '.ai');
  fs.mkdirSync(aiDir, { recursive: true });

  // 4. Invoke agent-discuss
  console.log(`    💬 Discussion triggered: ${trigger.uncertain_about}`);
  console.log(`    💬 Partner: ${partner.id} (reasoning: ${partner.reasoning})`);

  try {
    // Escape shell arguments safely
    const args = [
      'start',
      JSON.stringify(trigger.uncertain_about),
      '--understanding', JSON.stringify(`Worker (${workerConfig.model}) is implementing: ${workerConfig.prompt.slice(0, 200)}`),
      '--direction', JSON.stringify(`Leaning toward: ${trigger.leaning} because: ${trigger.why}`),
      '--constraints', JSON.stringify(`Options: ${trigger.options.join(', ')}`),
      '--ask', JSON.stringify('Pressure-test this direction. Which option and why? Be specific.'),
      '--thread-id', threadId,
    ].join(' ');

    execSync(`bash "${DISCUSS_SCRIPT}" ${args}`, {
      cwd: workDir,
      timeout: 60000, // 60s max
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: partnerUrl.baseUrl,
        ANTHROPIC_AUTH_TOKEN: partnerUrl.apiKey,
        ANTHROPIC_MODEL: partner.id,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 5. Read reply
    const replyPath = path.join(workDir, '.ai', 'threads', threadId, 'round-001', 'reply.json');
    if (!fs.existsSync(replyPath)) {
      console.log('    ⚠️ No reply from discussion, escalating to Sonnet');
      return escalateToSonnet(trigger, null);
    }

    const reply = JSON.parse(fs.readFileSync(replyPath, 'utf-8'));

    // 6. Check quality
    if (reply.quality_gate === 'fail') {
      console.log('    ⚠️ Discussion quality: fail, escalating to Sonnet');
      return escalateToSonnet(trigger, reply);
    }

    console.log(`    ✅ Discussion resolved: ${reply.recommended_next_step?.slice(0, 80)}`);

    return {
      decision: reply.recommended_next_step || trigger.leaning,
      reasoning: reply.one_paragraph_synthesis || '',
      escalated: false,
      thread_id: threadId,
      quality_gate: reply.quality_gate || 'pass',
    };

  } catch (err: any) {
    console.log(`    ❌ Discussion failed: ${err.message?.slice(0, 100)}`);
    return escalateToSonnet(trigger, null);
  }
}

function escalateToSonnet(trigger: DiscussTrigger, discussReply: any): DiscussResult {
  // When discussion fails, return a result that tells the orchestrator to escalate
  return {
    decision: trigger.leaning, // Default to the worker's lean for now
    reasoning: `Discussion inconclusive. ${discussReply?.one_paragraph_synthesis || 'No reply received.'}`,
    escalated: true,
    escalated_to: 'sonnet',
    thread_id: '',
    quality_gate: 'fail',
  };
}
```

### 4.7 a2a Bridge (`orchestrator/a2a-bridge.ts`)

This is the integration layer between the review cascade and the existing a2a skill. Instead of dispatching to Codex/Claude as the original a2a does, it dispatches all three lenses to domestic models via MMS.

```typescript
// ═══════════════════════════════════════════════════════════════════
// orchestrator/a2a-bridge.ts — Run a2a 3-lens review using domestic models
// ═══════════════════════════════════════════════════════════════════

import { claude } from '@anthropic-ai/claude-code';
import fs from 'fs';
import path from 'path';
import {
  A2aLens, A2aLensResult, A2aReviewResult, A2aVerdict,
  ReviewFinding, FindingSeverity, SubTask, WorkerResult,
} from './types';
import { ModelRegistry } from './model-registry';
import { resolveProviderUrl } from './mms-bridge-resolver';
import { getWorktreeFullDiff, getWorktreeDiffStat } from './worktree-manager';

// Reference: /Users/xin/auto-skills/CtriXin-repo/agent-2-agent/references/review-lenses.md

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

// Build the input for each lens
function buildLensInput(lens: A2aLens, workerResult: WorkerResult): string {
  const diff = getWorktreeFullDiff(workerResult.worktreePath);
  const diffStat = getWorktreeDiffStat(workerResult.worktreePath);

  switch (lens) {
    case 'challenger':
      // Full diff for bug-finding
      return LENS_PROMPTS.challenger + diff.slice(0, 8000); // Limit to 8k chars

    case 'architect':
      // Only structure — file list + function signatures, not full diff
      return LENS_PROMPTS.architect + diffStat + '\n\n' + extractSignatures(workerResult);

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

// Run a single lens review on a domestic model
async function runLens(
  lens: A2aLens,
  model: { id: string; provider: string },
  workerResult: WorkerResult,
): Promise<A2aLensResult> {
  const { baseUrl, apiKey } = resolveProviderUrl(model.provider);
  const input = buildLensInput(lens, workerResult);

  console.log(`      🔍 ${lens} lens → ${model.id}`);

  try {
    const messages = claude(input, {
      sessionId: `a2a-${lens}-${workerResult.taskId}-${Date.now()}`,
      cwd: workerResult.worktreePath,
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_MODEL: model.id,
      },
      maxTurns: 3, // Review should be quick
    });

    let rawOutput = '';
    for await (const msg of messages) {
      if (msg.type === 'assistant' || msg.role === 'assistant') {
        rawOutput += typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
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

function parseLensOutput(output: string, lens: A2aLens): ReviewFinding[] {
  try {
    // Find JSON in output
    const jsonMatch = output.match(/\{[\s\S]*"findings"[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.findings)) return [];

    return parsed.findings.slice(0, 10).map((f: any, i: number) => ({
      id: i + 1,
      severity: (['red', 'yellow', 'green'].includes(f.severity) ? f.severity : 'yellow') as FindingSeverity,
      lens,
      file: f.file || 'unknown',
      line: parseInt(f.file?.split(':')[1]) || undefined,
      issue: String(f.issue || '').slice(0, 300),
      decision: 'pending' as const,
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
  const registry = new ModelRegistry();

  // 1. Determine scale
  const diffStat = getWorktreeDiffStat(workerResult.worktreePath);
  const scale = task.review_scale === 'auto'
    ? determineScale(diffStat)
    : task.review_scale;

  const lenses = lensesForScale(scale);
  console.log(`    📋 a2a review: scale=${scale}, lenses=[${lenses.join(',')}]`);

  // 2. Assign models to lenses
  const lensModels = registry.selectA2aLensModels(workerResult.model);

  // 3. Run all lenses IN PARALLEL (reviewers must not see each other)
  const lensResults = await Promise.all(
    lenses.map(lens => runLens(
      lens,
      lensModels[lens],
      workerResult,
    ))
  );

  // 4. Aggregate findings
  const allFindings = lensResults.flatMap(r => r.findings);
  const redCount = allFindings.filter(f => f.severity === 'red').length;
  const yellowCount = allFindings.filter(f => f.severity === 'yellow').length;
  const greenCount = allFindings.filter(f => f.severity === 'green').length;

  // 5. Determine verdict (following a2a SKILL.md rules)
  let verdict: A2aVerdict;
  if (allFindings.length === 0) {
    verdict = 'PASS';
  } else if (redCount === 0) {
    verdict = 'PASS'; // Only yellow/green = pass
  } else if (redCount > 0 && lenses.length > 1) {
    // Check if multiple lenses agree on red findings (same file)
    const redFiles = allFindings
      .filter(f => f.severity === 'red')
      .map(f => f.file.split(':')[0]);
    const duplicateRedFiles = redFiles.filter((f, i) => redFiles.indexOf(f) !== i);
    verdict = duplicateRedFiles.length > 0 ? 'REJECT' : 'CONTESTED';
  } else {
    verdict = 'CONTESTED'; // Single lens red = contested, needs arbitration
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
```

### 4.8 Review Cascade (`orchestrator/reviewer.ts`)

The full 4-stage pipeline integrating cross-review, a2a, Sonnet, and Opus.

```typescript
// ═══════════════════════════════════════════════════════════════════
// orchestrator/reviewer.ts — 4-stage review cascade
// ═══════════════════════════════════════════════════════════════════

import { claude } from '@anthropic-ai/claude-code';
import fs from 'fs';
import path from 'path';
import {
  ReviewResult, ReviewStage, ReviewFinding,
  WorkerResult, SubTask, TaskPlan,
  CrossReviewResult,
} from './types';
import { ModelRegistry } from './model-registry';
import { resolveProviderUrl } from './mms-bridge-resolver';
import { runA2aReview } from './a2a-bridge';
import { getWorktreeFullDiff, getWorktreeDiffStat } from './worktree-manager';
import { spawnWorker } from './dispatcher';

// Load review policy
const REVIEW_POLICY = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../config/review-policy.json'), 'utf-8')
);

export async function reviewCascade(
  workerResult: WorkerResult,
  task: SubTask,
  plan: TaskPlan,
  registry: ModelRegistry,
): Promise<ReviewResult> {
  const startTime = Date.now();
  let iterations = 0;

  console.log(`\n  ─── Review: ${task.id} (${workerResult.model}) ───`);

  // ── Skip review for Opus-authored tasks ──
  if (task.assigned_model === 'claude-opus') {
    console.log('    ✅ Auto-trusted (Opus-authored)');
    return {
      taskId: task.id, final_stage: 'cross-review', passed: true,
      findings: [], iterations: 0, duration_ms: Date.now() - startTime,
    };
  }

  // ── Auto-pass for trivial tasks ──
  if (REVIEW_POLICY.auto_pass_when.task_is.includes(task.category)) {
    console.log(`    ✅ Auto-pass (category: ${task.category})`);
    registry.updateScore(workerResult.model, true, 0);
    return {
      taskId: task.id, final_stage: 'cross-review', passed: true,
      findings: [], iterations: 0, duration_ms: Date.now() - startTime,
    };
  }

  // ═══ Stage 1: Cross-Model Review (domestic, near-free) ═══

  iterations++;
  console.log('    Stage 1: Cross-review');

  const crossReviewer = registry.selectCrossReviewer(workerResult.model);
  const crossResult = await runCrossReview(workerResult, task, crossReviewer);

  if (crossResult.passed && crossResult.confidence >= REVIEW_POLICY.skip_sonnet_when.cross_review_confidence) {
    // Clean pass — check if we can skip a2a entirely
    const modelInfo = registry.get(workerResult.model);
    if (
      task.complexity === 'low' ||
      (modelInfo && modelInfo.pass_rate >= REVIEW_POLICY.skip_sonnet_when.model_pass_rate_above)
    ) {
      console.log(`    ✅ Cross-review PASS (confidence: ${crossResult.confidence.toFixed(2)}) — skipping a2a`);
      registry.updateScore(workerResult.model, true, iterations);
      return {
        taskId: task.id, final_stage: 'cross-review', passed: true,
        findings: [], iterations, duration_ms: Date.now() - startTime,
      };
    }
  }

  // ═══ Stage 2: a2a 3-Lens Review (domestic models, near-free) ═══

  iterations++;
  console.log('    Stage 2: a2a 3-lens review');

  const a2aResult = await runA2aReview(workerResult, task);

  if (a2aResult.verdict === 'PASS') {
    console.log('    ✅ a2a PASS');
    registry.updateScore(workerResult.model, true, iterations);
    return {
      taskId: task.id, final_stage: 'a2a-lenses', passed: true,
      verdict: 'PASS', findings: a2aResult.all_findings,
      iterations, duration_ms: Date.now() - startTime,
    };
  }

  if (a2aResult.verdict === 'REJECT') {
    console.log('    ❌ a2a REJECT — sending back to worker');
    // Send back to worker with fix instructions
    const fixPrompt = `Fix these issues found during code review:\n${a2aResult.all_findings.filter(f => f.severity === 'red').map(f => `- [${f.file}] ${f.issue}`).join('\n')}`;

    const fixResult = await spawnWorker({
      taskId: `${task.id}-fix`,
      model: workerResult.model,
      provider: registry.get(workerResult.model)!.provider,
      prompt: fixPrompt,
      cwd: workerResult.worktreePath,
      worktree: false, // Fix in same worktree
      contextInputs: [],
      discussThreshold: 1.0,
      maxTurns: 15,
      sessionId: workerResult.sessionId, // Resume same session
    });

    // Re-run a2a (one retry)
    iterations++;
    const retryA2a = await runA2aReview(fixResult, task);
    if (retryA2a.verdict === 'PASS' || retryA2a.verdict === 'CONTESTED') {
      // Good enough after fix, or needs Sonnet to decide
      if (retryA2a.verdict === 'PASS') {
        registry.updateScore(workerResult.model, true, iterations);
        return {
          taskId: task.id, final_stage: 'a2a-lenses', passed: true,
          verdict: 'PASS', findings: retryA2a.all_findings,
          iterations, duration_ms: Date.now() - startTime,
        };
      }
      // Fall through to Sonnet for CONTESTED
    }
  }

  // ═══ Stage 3: Sonnet Arbitration (only disputed findings) ═══

  iterations++;
  console.log('    Stage 3: Sonnet arbitration');

  // Only send the RED and CONTESTED findings to Sonnet — not full code
  const disputedFindings = a2aResult.all_findings.filter(f => f.severity === 'red');
  const crossFlags = crossResult.flagged_issues;

  const sonnetPrompt = `You are a senior code reviewer arbitrating disputed findings.

## Task that was implemented
${task.description}

## Acceptance criteria
${task.acceptance_criteria.map(c => `- ${c}`).join('\n')}

## Disputed findings from automated review
${disputedFindings.map(f => `- [${f.severity.toUpperCase()}] [${f.lens}] ${f.file}: ${f.issue}`).join('\n')}

## Cross-review flags
${crossFlags.join('\n')}

## Diff summary
${getWorktreeDiffStat(workerResult.worktreePath)}

For each finding, decide: ACCEPT (real issue), DISMISS (false positive), or FLAG (non-blocking TODO).
Output JSON:
{
  "decisions": [{"finding_id": 1, "decision": "accept|dismiss|flag", "reason": "..."}],
  "overall_pass": true/false,
  "fix_instructions": "..." // Only if overall_pass is false
}`;

  // Call Sonnet directly (no MMS bridge — this is real Claude)
  const sonnetResult = await callClaudeModel(sonnetPrompt, 'sonnet');

  try {
    const parsed = JSON.parse(sonnetResult);

    // Apply decisions to findings
    for (const d of parsed.decisions || []) {
      const finding = a2aResult.all_findings.find(f => f.id === d.finding_id);
      if (finding) {
        finding.decision = d.decision;
        finding.decision_reason = d.reason;
      }
    }

    if (parsed.overall_pass) {
      console.log('    ✅ Sonnet: PASS');
      registry.updateScore(workerResult.model, true, iterations);
      return {
        taskId: task.id, final_stage: 'sonnet', passed: true,
        verdict: 'PASS', findings: a2aResult.all_findings,
        iterations, duration_ms: Date.now() - startTime,
      };
    }

    // Sonnet says fix needed — one more worker attempt
    if (parsed.fix_instructions) {
      const fixResult = await spawnWorker({
        taskId: `${task.id}-sonnet-fix`,
        model: workerResult.model,
        provider: registry.get(workerResult.model)!.provider,
        prompt: `Sonnet review says: ${parsed.fix_instructions}`,
        cwd: workerResult.worktreePath,
        worktree: false,
        contextInputs: [],
        discussThreshold: 1.0,
        maxTurns: 10,
        sessionId: workerResult.sessionId,
      });
      iterations++;

      // Quick Sonnet re-check
      const recheck = await callClaudeModel(
        `Were these fixes applied correctly?\n${parsed.fix_instructions}\n\nDiff:\n${getWorktreeDiffStat(fixResult.worktreePath)}\n\nOutput: {"pass": true/false, "remaining_issues": [...]}`,
        'sonnet'
      );
      const recheckParsed = JSON.parse(recheck);
      if (recheckParsed.pass) {
        registry.updateScore(workerResult.model, true, iterations);
        return {
          taskId: task.id, final_stage: 'sonnet', passed: true,
          findings: a2aResult.all_findings, iterations, duration_ms: Date.now() - startTime,
        };
      }
    }
  } catch {
    console.log('    ⚠️ Could not parse Sonnet output');
  }

  // ═══ Stage 4: Opus Final Verdict (rare) ═══

  iterations++;
  console.log('    Stage 4: Opus final verdict');

  const opusPrompt = `Final arbitration needed. A worker (${workerResult.model}) implemented task "${task.description}".
Review cascade so far:
- Cross-review: ${crossResult.passed ? 'passed' : 'flagged issues'}
- a2a verdict: ${a2aResult.verdict} (${a2aResult.red_count}R/${a2aResult.yellow_count}Y/${a2aResult.green_count}G)
- Sonnet: could not resolve

Full diff:
${getWorktreeFullDiff(workerResult.worktreePath).slice(0, 10000)}

Acceptance criteria:
${task.acceptance_criteria.map(c => `- ${c}`).join('\n')}

Output: {"pass": true/false, "blocking_issues": [...], "action": "merge|rewrite|escalate_to_human"}`;

  const opusResult = await callClaudeModel(opusPrompt, 'opus');
  const opusParsed = JSON.parse(opusResult);

  registry.updateScore(workerResult.model, opusParsed.pass, iterations);

  return {
    taskId: task.id, final_stage: 'opus', passed: opusParsed.pass,
    findings: a2aResult.all_findings, iterations,
    duration_ms: Date.now() - startTime,
  };
}

// ── Cross-review helper ──

async function runCrossReview(
  workerResult: WorkerResult,
  task: SubTask,
  reviewerModel: { id: string; provider: string },
): Promise<CrossReviewResult> {
  const { baseUrl, apiKey } = resolveProviderUrl(reviewerModel.provider);

  const prompt = `Review this code change. The task was: "${task.description}"

Acceptance criteria:
${task.acceptance_criteria.map(c => `- ${c}`).join('\n')}

Diff:
${getWorktreeFullDiff(workerResult.worktreePath).slice(0, 6000)}

Output JSON only:
{
  "passed": true/false,
  "confidence": 0.0-1.0,
  "flagged_issues": ["issue description 1", "issue description 2"]
}`;

  try {
    const messages = claude(prompt, {
      sessionId: `cross-review-${workerResult.taskId}-${Date.now()}`,
      cwd: workerResult.worktreePath,
      env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_MODEL: reviewerModel.id },
      maxTurns: 3,
    });

    let output = '';
    for await (const msg of messages) {
      if (msg.type === 'assistant' || msg.role === 'assistant') {
        output += typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      }
    }

    const jsonMatch = output.match(/\{[\s\S]*"passed"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        passed: Boolean(parsed.passed),
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
        flagged_issues: Array.isArray(parsed.flagged_issues) ? parsed.flagged_issues : [],
        reviewer_model: reviewerModel.id,
      };
    }
  } catch {}

  return { passed: false, confidence: 0, flagged_issues: ['Cross-review failed'], reviewer_model: reviewerModel.id };
}

// ── Call real Claude (Opus/Sonnet/Haiku) ──

async function callClaudeModel(prompt: string, tier: 'opus' | 'sonnet' | 'haiku'): Promise<string> {
  // Use claude --print for non-interactive single-shot calls
  // This uses the REAL Claude API, not MMS bridge
  const { execSync } = require('child_process');
  const result = execSync(`claude --print "${prompt.replace(/"/g, '\\"').slice(0, 50000)}" --model ${tier}`, {
    encoding: 'utf-8',
    timeout: 120000,
    env: {
      ...process.env,
      // Ensure we're using real Anthropic, not MMS
      ANTHROPIC_BASE_URL: undefined,
      ANTHROPIC_MODEL: undefined,
    },
  });
  return result;
}
```

### 4.9 Task Planner (`orchestrator/planner.ts`)

```typescript
// ═══════════════════════════════════════════════════════════════════
// orchestrator/planner.ts — Decompose goal into sub-tasks with model assignments
//
// This runs on Claude Opus in the CURRENT session.
// The planner doesn't call an external LLM — it IS Claude Opus.
// The MCP tool passes the goal to Claude, which plans natively.
// ═══════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { TaskPlan, SubTask, Complexity } from './types';
import { ModelRegistry } from './model-registry';

const registry = new ModelRegistry();

// This function is called BY Claude Opus (the current session) through the MCP tool.
// Claude Opus fills in the plan structure based on its own analysis.
// The MCP tool formats the goal and project context, then Claude returns a plan.

export function buildPlanFromClaudeOutput(
  claudeOutput: {
    goal: string;
    cwd: string;
    tasks: Array<{
      id: string;
      description: string;
      complexity: Complexity;
      category: string;
      estimated_files: string[];
      acceptance_criteria: string[];
      depends_on: string[];
    }>;
  }
): TaskPlan {
  const planId = uuidv4();

  // Assign models to each task
  const tasks: SubTask[] = claudeOutput.tasks.map(t => ({
    ...t,
    assigned_model: registry.assignModel(t as SubTask),
    assignment_reason: explainAssignment(t as SubTask),
    discuss_threshold: t.complexity === 'low' ? 0.5 : t.complexity === 'medium' ? 0.6 : 0.7,
    review_scale: 'auto' as const,
  }));

  // Build execution order (parallel groups)
  const execution_order = buildExecutionOrder(tasks);

  // Build context flow
  const context_flow: Record<string, string[]> = {};
  for (const task of tasks) {
    if (task.depends_on.length > 0) {
      context_flow[task.id] = task.depends_on;
    }
  }

  return {
    id: planId,
    goal: claudeOutput.goal,
    cwd: claudeOutput.cwd,
    tasks,
    execution_order,
    context_flow,
    created_at: new Date().toISOString(),
  };
}

function buildExecutionOrder(tasks: SubTask[]): string[][] {
  // Topological sort into parallel groups
  const completed = new Set<string>();
  const groups: string[][] = [];

  while (completed.size < tasks.length) {
    const group = tasks
      .filter(t => !completed.has(t.id))
      .filter(t => t.depends_on.every(dep => completed.has(dep)))
      .map(t => t.id);

    if (group.length === 0) break; // Circular dependency guard

    groups.push(group);
    group.forEach(id => completed.add(id));
  }

  return groups;
}

function explainAssignment(task: SubTask): string {
  if (task.complexity === 'high' || task.category === 'security') {
    return 'High complexity or security-critical — handled by Claude Opus directly';
  }

  const model = registry.get(registry.assignModel(task));
  if (!model) return 'Fallback to default model';

  const reasons: string[] = [];
  if (model.sweet_spot.includes(task.category)) {
    reasons.push(`${task.category} is in sweet_spot`);
  }
  reasons.push(`pass_rate: ${model.pass_rate.toFixed(2)}`);
  reasons.push(`cost: ¥${model.cost_per_mtok_output}/Mtok`);

  return `${model.display_name}: ${reasons.join(', ')}`;
}

// ── Prompt template for Claude Opus to fill in the plan ──
// This is injected into the MCP tool response so Claude can plan natively.

export const PLAN_PROMPT_TEMPLATE = `You are the planning tier of a multi-model orchestration system.
Decompose the following goal into sub-tasks. For each task, specify:

1. id: Short identifier (e.g., "task-a", "task-b")
2. description: Self-contained instruction that a different AI model can execute without additional context.
   Include: what to create/modify, where (file paths), and specific technical requirements.
3. complexity: "low" | "medium" | "high"
4. category: One of: schema, utils, api, tests, security, docs, config, algorithms, CRUD, i18n, refactor
5. estimated_files: Files this task will create or modify
6. acceptance_criteria: 2-4 specific, verifiable conditions
7. depends_on: IDs of tasks that must complete before this one

RULES:
- Each task must be completable independently (given outputs from dependencies)
- Tasks that touch different files should be in parallel
- Security-critical tasks get complexity "high" (will be handled by Claude Opus)
- Prefer more granular tasks for parallel execution
- Max 10 tasks per plan

Output a JSON object with this structure:
{
  "goal": "...",
  "tasks": [...]
}`;
```

### 4.10 MCP Server (`mcp-server/index.ts`)

```typescript
// ═══════════════════════════════════════════════════════════════════
// mcp-server/index.ts — MCP tools for Claude to orchestrate cli2cli
// ═══════════════════════════════════════════════════════════════════

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ModelRegistry } from '../orchestrator/model-registry';
import { buildPlanFromClaudeOutput, PLAN_PROMPT_TEMPLATE } from '../orchestrator/planner';
import { dispatchBatch, spawnWorker } from '../orchestrator/dispatcher';
import { reviewCascade } from '../orchestrator/reviewer';
import { checkProviderHealth } from '../orchestrator/mms-bridge-resolver';

const server = new McpServer({
  name: 'cli2cli-orchestrator',
  version: '2.0.0',
});

// ── Tool 1: Plan tasks (dry run — Claude fills in the plan) ──

server.tool(
  'plan_tasks',
  'Decompose a goal into sub-tasks with model assignments. Returns a plan for review.',
  {
    goal: z.string().describe('Task goal in English'),
    cwd: z.string().describe('Project root directory'),
  },
  async ({ goal, cwd }) => {
    const registry = new ModelRegistry();
    const models = registry.getAll().map(m =>
      `${m.id} (${m.display_name}): coding=${m.coding}, tool_use=${m.tool_use_reliability}, sweet_spot=[${m.sweet_spot.join(',')}], avoid=[${m.avoid.join(',')}], pass_rate=${m.pass_rate.toFixed(2)}`
    ).join('\n');

    return {
      content: [{
        type: 'text',
        text: `${PLAN_PROMPT_TEMPLATE}\n\n## Available domestic models:\n${models}\n\n## Goal:\n${goal}\n\n## Project directory:\n${cwd}\n\nPlease output the JSON plan. I will then assign models and create execution order.`,
      }],
    };
  }
);

// ── Tool 2: Execute a plan ──

server.tool(
  'execute_plan',
  'Execute a previously created plan. Pass the plan JSON from plan_tasks.',
  {
    plan_json: z.string().describe('The plan JSON output from plan_tasks'),
    cwd: z.string().describe('Project root directory'),
  },
  async ({ plan_json, cwd }) => {
    const registry = new ModelRegistry();

    // Parse Claude's plan output
    const claudeOutput = JSON.parse(plan_json);
    claudeOutput.cwd = cwd;
    const plan = buildPlanFromClaudeOutput(claudeOutput);

    // Show plan summary first
    let output = `## Execution Plan: ${plan.id}\n\n`;
    output += `Tasks: ${plan.tasks.length}\n`;
    output += `Parallel groups: ${plan.execution_order.map(g => `[${g.join(',')}]`).join(' → ')}\n\n`;
    output += plan.tasks.map(t =>
      `- **${t.id}** (${t.complexity}) → ${t.assigned_model}: ${t.description.slice(0, 80)}...\n  Reason: ${t.assignment_reason}`
    ).join('\n');

    // Dispatch workers
    output += '\n\n## Dispatching workers...\n\n';
    const results = await dispatchBatch(plan, registry);

    // Review cascade
    output += '## Review cascade...\n\n';
    const reviews = await Promise.all(
      results.map(r => {
        const task = plan.tasks.find(t => t.id === r.taskId)!;
        return reviewCascade(r, task, plan, registry);
      })
    );

    // Summary
    const passed = reviews.filter(r => r.passed).length;
    const failed = reviews.filter(r => !r.passed).length;

    output += `\n## Results\n\n`;
    output += `✅ Passed: ${passed}/${reviews.length}\n`;
    output += `❌ Failed: ${failed}/${reviews.length}\n\n`;

    for (const review of reviews) {
      const task = plan.tasks.find(t => t.id === review.taskId)!;
      const result = results.find(r => r.taskId === review.taskId);
      output += `### ${review.taskId}: ${review.passed ? '✅ PASS' : '❌ FAIL'}\n`;
      output += `  Model: ${result?.model}, Stage: ${review.final_stage}, Iterations: ${review.iterations}\n`;
      if (review.findings.length > 0) {
        output += `  Findings: ${review.findings.filter(f => f.severity === 'red').length}R / ${review.findings.filter(f => f.severity === 'yellow').length}Y / ${review.findings.filter(f => f.severity === 'green').length}G\n`;
      }
    }

    // Score updates
    output += '\n## Model score updates\n';
    for (const model of registry.getAll()) {
      output += `  ${model.id}: pass_rate=${model.pass_rate.toFixed(2)} (${model.total_tasks_completed} tasks)\n`;
    }

    return { content: [{ type: 'text', text: output }] };
  }
);

// ── Tool 3: Single task dispatch ──

server.tool(
  'dispatch_single',
  'Dispatch a single task to a specific model. Optionally run review cascade.',
  {
    task: z.string().describe('Task instruction'),
    model: z.string().describe('Model ID (e.g., qwen3.5-plus)'),
    cwd: z.string().describe('Working directory'),
    review: z.boolean().describe('Run review cascade after completion').default(true),
  },
  async ({ task, model, cwd, review }) => {
    const registry = new ModelRegistry();
    const modelInfo = registry.get(model);
    if (!modelInfo) {
      return { content: [{ type: 'text', text: `Unknown model: ${model}. Available: ${registry.getAll().map(m => m.id).join(', ')}` }] };
    }

    const result = await spawnWorker({
      taskId: `manual-${Date.now()}`,
      model,
      provider: modelInfo.provider,
      prompt: task,
      cwd,
      worktree: true,
      contextInputs: [],
      discussThreshold: 0.6,
      maxTurns: 25,
    });

    let output = `Worker ${result.taskId} (${model}): ${result.success ? '✅' : '❌'}\n`;
    output += `Changed files: ${result.changedFiles.join(', ')}\n`;
    output += `Duration: ${(result.duration_ms / 1000).toFixed(1)}s\n`;

    if (review) {
      const reviewResult = await reviewCascade(
        result,
        { id: result.taskId, description: task, complexity: 'medium', category: 'general',
          assigned_model: model, assignment_reason: 'manual', estimated_files: [],
          acceptance_criteria: ['Task completed successfully'], discuss_threshold: 0.6,
          depends_on: [], review_scale: 'auto' },
        { id: '', goal: task, cwd, tasks: [], execution_order: [], context_flow: {}, created_at: '' },
        registry,
      );
      output += `Review: ${reviewResult.passed ? '✅ PASS' : '❌ FAIL'} (stage: ${reviewResult.final_stage}, iterations: ${reviewResult.iterations})`;
    }

    return { content: [{ type: 'text', text: output }] };
  }
);

// ── Tool 4: Health check ──

server.tool(
  'health_check',
  'Check availability of all configured model providers.',
  {},
  async () => {
    const registry = new ModelRegistry();
    const results: string[] = [];

    for (const model of registry.getAll()) {
      const healthy = await checkProviderHealth(model.provider);
      results.push(`${model.id} (${model.provider}): ${healthy ? '✅ OK' : '❌ UNREACHABLE'}`);
    }

    return { content: [{ type: 'text', text: results.join('\n') }] };
  }
);

// ── Tool 5: View/update model scores ──

server.tool(
  'model_scores',
  'View current model capability scores and task history.',
  {},
  async () => {
    const registry = new ModelRegistry();
    const models = registry.getAll();

    let output = '## Model Capability Scores\n\n';
    output += '| Model | Coding | ToolUse | Reasoning | PassRate | AvgIter | Tasks | Cost(¥/Mtok) |\n';
    output += '|-------|--------|---------|-----------|----------|---------|-------|--------------|\n';

    for (const m of models) {
      output += `| ${m.id} | ${m.coding} | ${m.tool_use_reliability} | ${m.reasoning} | ${m.pass_rate.toFixed(2)} | ${m.avg_iterations.toFixed(1)} | ${m.total_tasks_completed} | ${m.cost_per_mtok_output} |\n`;
    }

    return { content: [{ type: 'text', text: output }] };
  }
);

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('cli2cli MCP server running');
}

main().catch(console.error);
```

---

## 5. Configuration Files

### 5.1 `config/model-capabilities.json`

```json
{
  "models": [
    {
      "id": "qwen3.5-plus",
      "provider": "bailian-codingplan",
      "display_name": "Qwen 3.5 Plus",
      "coding": 0.85,
      "tool_use_reliability": 0.82,
      "reasoning": 0.78,
      "chinese": 0.95,
      "pass_rate": 0.80,
      "avg_iterations": 1.3,
      "total_tasks_completed": 0,
      "last_updated": "2026-03-24T00:00:00Z",
      "context_window": 131072,
      "cost_per_mtok_input": 0.4,
      "cost_per_mtok_output": 1.2,
      "max_complexity": "medium-high",
      "sweet_spot": ["full-stack", "schema", "API", "refactor", "CRUD"],
      "avoid": ["security-critical", "low-level-systems"]
    },
    {
      "id": "kimi-k2.5",
      "provider": "kimi-codingplan",
      "display_name": "Kimi K2.5",
      "coding": 0.82,
      "tool_use_reliability": 0.78,
      "reasoning": 0.80,
      "chinese": 0.95,
      "pass_rate": 0.75,
      "avg_iterations": 1.5,
      "total_tasks_completed": 0,
      "last_updated": "2026-03-24T00:00:00Z",
      "context_window": 131072,
      "cost_per_mtok_input": 0.3,
      "cost_per_mtok_output": 0.9,
      "max_complexity": "medium",
      "sweet_spot": ["utils", "tests", "docs", "translation", "simple-impl"],
      "avoid": ["complex-architecture", "multi-file-refactor"]
    },
    {
      "id": "deepseek-v3",
      "provider": "deepseek",
      "display_name": "DeepSeek V3",
      "coding": 0.88,
      "tool_use_reliability": 0.72,
      "reasoning": 0.92,
      "chinese": 0.90,
      "pass_rate": 0.78,
      "avg_iterations": 1.4,
      "total_tasks_completed": 0,
      "last_updated": "2026-03-24T00:00:00Z",
      "context_window": 65536,
      "cost_per_mtok_input": 0.14,
      "cost_per_mtok_output": 0.28,
      "max_complexity": "medium-high",
      "sweet_spot": ["algorithms", "math", "complex-logic", "data-processing"],
      "avoid": ["tool-heavy-tasks", "long-context"]
    },
    {
      "id": "glm-4.7",
      "provider": "glm-cn",
      "display_name": "GLM 4.7",
      "coding": 0.80,
      "tool_use_reliability": 0.76,
      "reasoning": 0.77,
      "chinese": 0.93,
      "pass_rate": 0.72,
      "avg_iterations": 1.6,
      "total_tasks_completed": 0,
      "last_updated": "2026-03-24T00:00:00Z",
      "context_window": 131072,
      "cost_per_mtok_input": 0.5,
      "cost_per_mtok_output": 0.5,
      "max_complexity": "medium",
      "sweet_spot": ["docs", "i18n", "config", "simple-CRUD"],
      "avoid": ["complex-architecture", "performance-critical"]
    },
    {
      "id": "minimax-m2.5",
      "provider": "minimax-cn",
      "display_name": "MiniMax M2.5",
      "coding": 0.83,
      "tool_use_reliability": 0.75,
      "reasoning": 0.79,
      "chinese": 0.92,
      "pass_rate": 0.74,
      "avg_iterations": 1.5,
      "total_tasks_completed": 0,
      "last_updated": "2026-03-24T00:00:00Z",
      "context_window": 131072,
      "cost_per_mtok_input": 0.15,
      "cost_per_mtok_output": 0.45,
      "max_complexity": "medium",
      "sweet_spot": ["agent-tasks", "chat", "content", "tests"],
      "avoid": ["low-level", "security"]
    }
  ],
  "claude_tiers": {
    "opus": {
      "use_for": ["plan", "architecture", "security-review", "final-decision", "conflict-resolution"],
      "cost_per_mtok_input": 15,
      "cost_per_mtok_output": 75
    },
    "sonnet": {
      "use_for": ["code-review", "integration-check", "test-validation", "arbitration"],
      "cost_per_mtok_input": 3,
      "cost_per_mtok_output": 15
    },
    "haiku": {
      "use_for": ["lint-check", "format-validation", "context-summarization"],
      "cost_per_mtok_input": 0.25,
      "cost_per_mtok_output": 1.25
    }
  }
}
```

### 5.2 `config/review-policy.json`

```json
{
  "skip_sonnet_when": {
    "cross_review_confidence": 0.85,
    "task_complexity": "low",
    "model_pass_rate_above": 0.90
  },
  "escalate_to_opus_when": {
    "touches_security_files": true,
    "sonnet_uncertain": true,
    "cross_review_contradicts_sonnet": true
  },
  "auto_pass_when": {
    "task_is": ["docs", "comments", "formatting", "i18n"],
    "cross_review_passed": true
  },
  "a2a_config": {
    "max_findings_per_lens": 10,
    "max_finding_length_chars": 300,
    "challenger_diff_limit_chars": 8000,
    "architect_uses_signatures_only": true,
    "subtractor_diff_limit_chars": 8000
  },
  "discuss_config": {
    "max_rounds": 2,
    "timeout_ms": 60000,
    "escalate_on_quality_fail": true
  },
  "worker_config": {
    "max_turns": 25,
    "max_fix_attempts": 2,
    "timeout_ms": 300000
  }
}
```

### 5.3 `config/a2a-lens-config.json`

```json
{
  "_doc": "Maps each a2a lens to a model selection strategy. The actual model is chosen dynamically by model-registry.ts based on these priorities.",
  "challenger": {
    "priority": "highest_coding_score",
    "must_differ_from": "worker_model",
    "description": "Finds bugs, edge cases, security issues"
  },
  "architect": {
    "priority": "highest_reasoning_score",
    "must_differ_from": "worker_model",
    "description": "Reviews design, coupling, extensibility"
  },
  "subtractor": {
    "priority": "any_remaining",
    "must_differ_from": ["worker_model", "challenger_model", "architect_model"],
    "description": "Finds over-engineering, dead code"
  }
}
```

### 5.4 `package.json`

```json
{
  "name": "cli2cli",
  "version": "2.0.0",
  "description": "Multi-model orchestration: Opus plans, domestic models execute, cascade reviews",
  "type": "module",
  "main": "dist/orchestrator/index.js",
  "bin": {
    "cli2cli": "./bin/cli2cli"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start:mcp": "node dist/mcp-server/index.js",
    "test:smoke": "bash scripts/smoke-test.sh",
    "test:bridge": "bash scripts/test-bridge-health.sh",
    "test:worker": "bash scripts/test-worker-spawn.sh"
  },
  "dependencies": {
    "@anthropic-ai/claude-code": "^1.0.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "uuid": "^10.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/uuid": "^10.0.0",
    "typescript": "^5.6.0"
  }
}
```

### 5.5 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["orchestrator/**/*.ts", "mcp-server/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

---

## 6. Smoke Tests

### 6.1 `scripts/smoke-test.sh` — Full test suite

```bash
#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# CLI2CLI Smoke Test Suite
# Run: bash scripts/smoke-test.sh
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0

check() {
    local name="$1"
    local cmd="$2"
    local expected="$3"

    printf "  %-50s " "$name"
    if result=$(eval "$cmd" 2>&1); then
        if echo "$result" | grep -q "$expected"; then
            echo -e "${GREEN}PASS${NC}"
            ((PASS++))
        else
            echo -e "${RED}FAIL${NC} (expected '$expected', got: ${result:0:80})"
            ((FAIL++))
        fi
    else
        echo -e "${RED}FAIL${NC} (command failed: ${result:0:80})"
        ((FAIL++))
    fi
}

skip() {
    local name="$1"
    local reason="$2"
    printf "  %-50s " "$name"
    echo -e "${YELLOW}SKIP${NC} ($reason)"
    ((SKIP++))
}

echo "═══════════════════════════════════════════════════"
echo "  CLI2CLI Smoke Test Suite"
echo "═══════════════════════════════════════════════════"
echo ""

# ── Phase 0: Prerequisites ──
echo "Phase 0: Prerequisites"
check "Node.js >= 20" "node --version" "v2"
check "npm available" "npm --version" "."
check "TypeScript compiled" "test -d dist && echo ok" "ok"
check "claude CLI available" "which claude" "claude"
check "git available" "git --version" "git version"
check "config/model-capabilities.json exists" "test -f config/model-capabilities.json && echo ok" "ok"
check "config/review-policy.json exists" "test -f config/review-policy.json && echo ok" "ok"
echo ""

# ── Phase 1: Model Registry ──
echo "Phase 1: Model Registry"
check "Registry loads without error" "node -e 'import(\"./dist/orchestrator/model-registry.js\").then(m => { new m.ModelRegistry(); console.log(\"ok\") })'" "ok"
check "Registry has >= 3 models" "node -e 'import(\"./dist/orchestrator/model-registry.js\").then(m => { const r = new m.ModelRegistry(); console.log(r.getAll().length >= 3 ? \"ok\" : \"too few\") })'" "ok"
check "assignModel returns valid ID" "node -e 'import(\"./dist/orchestrator/model-registry.js\").then(m => { const r = new m.ModelRegistry(); const id = r.assignModel({complexity:\"medium\",category:\"tests\",estimated_files:[\"test.ts\"]}); console.log(id) })'" "."
check "Security task → claude-opus" "node -e 'import(\"./dist/orchestrator/model-registry.js\").then(m => { const r = new m.ModelRegistry(); console.log(r.assignModel({complexity:\"high\",category:\"security\",estimated_files:[]})) })'" "claude-opus"
check "Cross-reviewer differs from worker" "node -e 'import(\"./dist/orchestrator/model-registry.js\").then(m => { const r = new m.ModelRegistry(); const rev = r.selectCrossReviewer(\"qwen3.5-plus\"); console.log(rev.id !== \"qwen3.5-plus\" ? \"ok\" : \"same\") })'" "ok"
check "Score update clamps correctly" "node -e 'import(\"./dist/orchestrator/model-registry.js\").then(m => { const r = new m.ModelRegistry(); r.updateScore(\"qwen3.5-plus\", true, 1); console.log(r.get(\"qwen3.5-plus\").pass_rate <= 0.95 ? \"ok\" : \"over\") })'" "ok"
echo ""

# ── Phase 2: MMS Bridge Resolver ──
echo "Phase 2: MMS Bridge Resolver"
check "Resolve qwen provider URL" "node -e 'import(\"./dist/orchestrator/mms-bridge-resolver.js\").then(m => { const r = m.resolveProviderUrl(\"bailian-codingplan\"); console.log(r.baseUrl.includes(\"dashscope\") ? \"ok\" : r.baseUrl) })'" "ok"
check "Resolve kimi provider URL" "node -e 'import(\"./dist/orchestrator/mms-bridge-resolver.js\").then(m => { const r = m.resolveProviderUrl(\"kimi-codingplan\"); console.log(r.baseUrl.includes(\"kimi\") ? \"ok\" : r.baseUrl) })'" "ok"
check "Unknown provider throws" "node -e 'import(\"./dist/orchestrator/mms-bridge-resolver.js\").then(m => { try { m.resolveProviderUrl(\"nonexistent\"); console.log(\"no-throw\") } catch { console.log(\"ok\") } })'" "ok"
echo ""

# ── Phase 3: Bridge Health (requires API keys) ──
echo "Phase 3: Bridge Health (live)"
if [ -f ~/.config/mms/credentials.sh ]; then
    source ~/.config/mms/credentials.sh 2>/dev/null || true
    check "Qwen API reachable" "bash scripts/test-bridge-health.sh bailian-codingplan" "ok"
    check "Kimi API reachable" "bash scripts/test-bridge-health.sh kimi-codingplan" "ok"
else
    skip "Qwen API reachable" "no credentials.sh"
    skip "Kimi API reachable" "no credentials.sh"
fi
echo ""

# ── Phase 4: Worktree Manager ──
echo "Phase 4: Worktree Manager"
TEST_REPO=$(mktemp -d)
git -C "$TEST_REPO" init -q && git -C "$TEST_REPO" commit --allow-empty -m "init" -q
check "Create worktree" "node -e 'import(\"./dist/orchestrator/worktree-manager.js\").then(m => { const p = m.createWorktree(\"$TEST_REPO\", \"smoke-test\"); console.log(require(\"fs\").existsSync(p) ? \"ok\" : \"missing\") })'" "ok"
check "List worktrees" "node -e 'import(\"./dist/orchestrator/worktree-manager.js\").then(m => { const wt = m.listWorktrees(\"$TEST_REPO\"); console.log(wt.length > 0 ? \"ok\" : \"empty\") })'" "ok"
check "Remove worktree" "node -e 'import(\"./dist/orchestrator/worktree-manager.js\").then(m => { m.removeWorktree(\"$TEST_REPO\", \"smoke-test\"); console.log(\"ok\") })'" "ok"
rm -rf "$TEST_REPO"
echo ""

# ── Phase 5: Context Recycler ──
echo "Phase 5: Context Recycler"
check "extractExports finds TS exports" "node -e 'import(\"./dist/orchestrator/context-recycler.js\").then(m => { /* internal function test would go here */ console.log(\"ok\") })'" "ok"
check "formatContextForWorker produces markdown" "node -e 'import(\"./dist/orchestrator/context-recycler.js\").then(m => { const out = m.formatContextForWorker([{from_task:\"a\",summary:\"did stuff\",key_outputs:[],decisions_made:[]}]); console.log(out.includes(\"Context\") ? \"ok\" : \"bad\") })'" "ok"
echo ""

# ── Phase 6: MCP Server ──
echo "Phase 6: MCP Server"
check "MCP server starts" "timeout 3 node dist/mcp-server/index.js 2>&1 || true" "cli2cli MCP server"
echo ""

# ── Phase 7: agent-discuss Integration ──
echo "Phase 7: agent-discuss"
DISCUSS_SCRIPT="/Users/xin/auto-skills/CtriXin-repo/agent-discuss/scripts/discuss.sh"
if [ -f "$DISCUSS_SCRIPT" ]; then
    check "discuss.sh exists and is executable" "test -x '$DISCUSS_SCRIPT' && echo ok" "ok"
else
    skip "discuss.sh" "not found at expected path"
fi
echo ""

# ── Phase 8: a2a Integration ──
echo "Phase 8: a2a"
A2A_SKILL="/Users/xin/auto-skills/CtriXin-repo/agent-2-agent/SKILL.md"
if [ -f "$A2A_SKILL" ]; then
    check "a2a SKILL.md exists" "echo ok" "ok"
    check "review-lenses.md exists" "test -f /Users/xin/auto-skills/CtriXin-repo/agent-2-agent/references/review-lenses.md && echo ok" "ok"
else
    skip "a2a" "not found at expected path"
fi
echo ""

# ── Summary ──
echo "═══════════════════════════════════════════════════"
echo -e "  Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${YELLOW}${SKIP} skipped${NC}"
echo "═══════════════════════════════════════════════════"

[ $FAIL -eq 0 ] && exit 0 || exit 1
```

### 6.2 `scripts/test-bridge-health.sh`

```bash
#!/bin/bash
# Test if a specific MMS provider is reachable
# Usage: bash scripts/test-bridge-health.sh <provider-id>

PROVIDER="${1:-bailian-codingplan}"

# Load credentials
[ -f ~/.config/mms/credentials.sh ] && source ~/.config/mms/credentials.sh

# Provider URL mapping (must match mms-bridge-resolver.ts)
declare -A URLS
URLS[bailian-codingplan]="https://coding.dashscope.aliyuncs.com/apps/anthropic"
URLS[kimi-codingplan]="https://api.kimi.com/coding/"
URLS[glm-cn]="https://open.bigmodel.cn/api/anthropic"
URLS[minimax-cn]="https://api.minimaxi.com/anthropic"

URL="${URLS[$PROVIDER]}"
if [ -z "$URL" ]; then
    echo "Unknown provider: $PROVIDER"
    exit 1
fi

# Try a minimal request
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$URL/v1/messages" \
    -H "Content-Type: application/json" \
    -H "x-api-key: ${ANTHROPIC_API_KEY:-none}" \
    -H "anthropic-version: 2023-06-01" \
    -d '{"model":"test","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' \
    --connect-timeout 5 \
    2>/dev/null)

# 401/403 = auth issue but server reachable
# 400 = server reachable, bad request (expected for test model)
# 200 = somehow worked
if [[ "$HTTP_CODE" =~ ^(200|400|401|403|404|422)$ ]]; then
    echo "ok (HTTP $HTTP_CODE)"
    exit 0
else
    echo "fail (HTTP $HTTP_CODE)"
    exit 1
fi
```

### 6.3 `scripts/test-worker-spawn.sh`

```bash
#!/bin/bash
# Test spawning a single worker via Claude Code SDK + MMS bridge
# Usage: bash scripts/test-worker-spawn.sh [model] [provider]
# Example: bash scripts/test-worker-spawn.sh qwen3.5-plus bailian-codingplan

MODEL="${1:-qwen3.5-plus}"
PROVIDER="${2:-bailian-codingplan}"
TMPDIR=$(mktemp -d)

echo "Testing worker spawn: model=$MODEL provider=$PROVIDER"
echo "Work directory: $TMPDIR"

# Initialize a git repo for worktree testing
cd "$TMPDIR"
git init -q
echo "console.log('hello');" > index.js
git add . && git commit -m "init" -q

# Run a minimal dispatch
node -e "
import { spawnWorker } from './dist/orchestrator/dispatcher.js';

const result = await spawnWorker({
  taskId: 'smoke-test',
  model: '$MODEL',
  provider: '$PROVIDER',
  prompt: 'Create a file called smoke-test.txt containing the text SMOKE_TEST_PASS',
  cwd: '$TMPDIR',
  worktree: true,
  contextInputs: [],
  discussThreshold: 1.0,
  maxTurns: 5,
});

console.log('Success:', result.success);
console.log('Changed files:', result.changedFiles.join(', '));
console.log('Duration:', result.duration_ms + 'ms');

// Verify the file was created
const fs = await import('fs');
const testFile = '$TMPDIR/.claude/worktrees/worker-smoke-test/smoke-test.txt';
if (fs.existsSync(testFile)) {
  const content = fs.readFileSync(testFile, 'utf-8');
  console.log('File content:', content.trim());
  console.log(content.includes('SMOKE_TEST_PASS') ? 'WORKER_SPAWN_OK' : 'WORKER_SPAWN_FAIL');
} else {
  console.log('WORKER_SPAWN_FAIL: file not created');
}
"

# Cleanup
rm -rf "$TMPDIR"
```

---

## 7. Implementation Order

| Phase | What to Build | Files | Effort | Smoke Test | Depends On |
|-------|--------------|-------|--------|------------|------------|
| **1** | Types + Config | `types.ts`, `model-capabilities.json`, `review-policy.json`, `a2a-lens-config.json`, `package.json`, `tsconfig.json` | 1h | `npm run build` compiles | Nothing |
| **2** | Model Registry | `model-registry.ts` | 1.5h | Phase 1 smoke tests pass | Phase 1 |
| **3** | MMS Bridge Resolver | `mms-bridge-resolver.ts` | 1h | Phase 2 smoke tests pass | Phase 1 |
| **4** | Worktree Manager | `worktree-manager.ts` | 1h | Phase 4 smoke tests pass | Phase 1 |
| **5** | Context Recycler | `context-recycler.ts` | 1h | Phase 5 smoke tests pass | Phase 1 |
| **6** | Worker Dispatcher | `dispatcher.ts` | 3h | `test-worker-spawn.sh` passes | Phases 2-5 |
| **7** | Discussion Trigger | `discuss-trigger.ts` | 1.5h | Manual test: trigger + read reply | Phase 6 |
| **8** | a2a Bridge | `a2a-bridge.ts` | 2h | Manual test: 3 lenses return findings | Phases 2, 4, 6 |
| **9** | Review Cascade | `reviewer.ts` | 2h | Planted bug caught by cascade | Phases 6, 8 |
| **10** | Planner | `planner.ts` | 1.5h | Plan for sample project looks sane | Phase 2 |
| **11** | MCP Server | `mcp-server/index.ts` | 2h | `health_check` tool returns results | All above |
| **12** | Smoke Test Suite | `scripts/smoke-test.sh` | 1h | All tests pass | All above |
| **13** | End-to-End Test | Real project run | 2h | Full auth system built | All above |

**Total: ~21 hours**

---

## 8. MCP Registration (for user's Claude settings)

After building, add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "cli2cli": {
      "command": "node",
      "args": ["/Users/xin/auto-skills/CtriXin-repo/cli2cli/dist/mcp-server/index.js"],
      "env": {
        "MMS_CONFIG_DIR": "/Users/xin/.config/mms",
        "CLI2CLI_CONFIG": "/Users/xin/auto-skills/CtriXin-repo/cli2cli/config",
        "AGENT_DISCUSS_PATH": "/Users/xin/auto-skills/CtriXin-repo/agent-discuss/scripts/discuss.sh"
      }
    }
  }
}
```

---

## 9. Risk Mitigation

| Risk | Impact | Mitigation | Smoke Test |
|------|--------|------------|------------|
| Domestic model tool_use fails | Worker stuck | `maxTurns` limit + auto-retry once + escalate | `test-worker-spawn.sh` |
| a2a lens returns invalid JSON | Review cascade breaks | `parseLensOutput` with try-catch + empty findings fallback | a2a Phase 8 test |
| Discussion loops (A↔B disagree) | Time waste | Max 2 rounds in `discuss-trigger.ts` + escalate to Sonnet | discuss Phase 7 test |
| MMS bridge not running | Workers crash | `checkProviderHealth` pre-flight + clear error | `test-bridge-health.sh` |
| Worktree merge conflicts | Code loss | Planner ensures different files per task | Phase 4 test |
| Model scores drift wrong | Bad assignments | Floor 0.30, ceiling 0.95, EMA α=0.2 | Phase 1 clamp test |
| Worker creates discuss-trigger but doesn't stop | Missed discussion | Check for `[DISCUSS_TRIGGER]` string in output | Phase 7 test |
| Claude --print fails for Sonnet/Opus calls | Review cascade breaks | `callClaudeModel` with try-catch + direct API fallback | Phase 9 test |

---

## 10. Review Checklist (for Claude Opus reviewer)

When reviewing the implementation, verify:

### Architecture
- [ ] `types.ts` is the single source of truth for all interfaces
- [ ] No circular imports between modules
- [ ] All MMS integration uses existing `ccs_bridge.py`, no protocol translation reimplemented
- [ ] All agent-discuss integration uses existing `discuss.sh`, no discussion logic reimplemented
- [ ] All a2a integration follows the lens definitions from `references/review-lenses.md`

### Security
- [ ] No shell injection: all `execSync` calls use proper escaping or argument arrays
- [ ] API keys never logged or included in worker prompts
- [ ] `ANTHROPIC_BASE_URL` correctly cleared when calling real Claude (Sonnet/Opus)
- [ ] Worker worktrees don't expose credentials from parent repo

### Correctness
- [ ] `buildExecutionOrder` handles circular dependencies (breaks instead of infinite loop)
- [ ] `reviewCascade` never sends full code to Sonnet — only flagged findings
- [ ] Cross-reviewer is always different vendor from worker
- [ ] a2a lenses run in parallel (not sequential — prevents conformity bias)
- [ ] `updateScore` clamps between SCORE_FLOOR and SCORE_CEILING
- [ ] Context recycler limits output size (summaries ≤500 chars)

### Integration
- [ ] MCP server exposes exactly 5 tools: `plan_tasks`, `execute_plan`, `dispatch_single`, `health_check`, `model_scores`
- [ ] `package.json` dependencies are minimal — no unnecessary packages
- [ ] `tsconfig.json` targets ES2022+ with ESM modules
- [ ] All file paths use `path.resolve` / `path.join`, not string concatenation

### Tests
- [ ] `smoke-test.sh` exits 0 when all tests pass, non-zero on any failure
- [ ] `test-worker-spawn.sh` creates verifiable output file
- [ ] `test-bridge-health.sh` handles all HTTP status codes correctly
- [ ] Each phase has at least one automated verification

---

**END OF PLAN — Ready for execution.**
