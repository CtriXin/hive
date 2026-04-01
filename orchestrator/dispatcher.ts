// orchestrator/dispatcher.ts — Worker dispatcher: spawn, stream, discuss, collect
import {
  type TaskPlan,
  type SubTask,
  type WorkerConfig,
  type WorkerResult,
  type WorkerMessage,
  type ContextPacket,
  type DiscussResult,
  type DiscussTrigger,
} from './types.js';
import { resolveProvider, quickPing } from './provider-resolver.js';
import { triggerDiscussion } from './discuss-bridge.js';
import { createWorktree, getWorktreeDiff } from './worktree-manager.js';
import { buildContextPacket, formatContextForWorker } from './context-recycler.js';
import { loadConfig, resolveFallback, recordSpending, type FailureType } from './hive-config.js';
import { saveWorkerResult, saveCheckpoint, loadCheckpoint, loadWorkerResult } from './result-store.js';
import { getRegistry } from './model-registry.js';
import { buildSdkEnv } from './project-paths.js';
import type { SDKMessage } from '@anthropic-ai/claude-code';
import { safeQuery } from './sdk-query-safe.js';
import { getModelFallbackRoutes } from './mms-routes-loader.js';

// ── DispatchResult (ERRATA §2) ──

export interface DispatchResult {
  worker_results: WorkerResult[];
}

// ── Helpers ──

function categorizeMessage(msg: SDKMessage): WorkerMessage['type'] {
  if (msg.type === 'assistant') return 'assistant';
  if (msg.type === 'result') return 'system';
  if (msg.type === 'user') return 'system';
  return 'system';
}

function extractContent(msg: SDKMessage): string {
  if (msg.type === 'assistant') {
    const contentBlocks = msg.message?.content;
    if (!Array.isArray(contentBlocks)) return JSON.stringify(msg);
    return contentBlocks
      .map((c: any) => (typeof c === 'string' ? c : c.text || JSON.stringify(c)))
      .join('');
  }
  if (msg.type === 'result') {
    return `Result: ${msg.subtype} (${msg.is_error ? 'error' : 'ok'})`;
  }
  if (msg.type === 'system') return JSON.stringify(msg);
  if (msg.type === 'user') return JSON.stringify(msg.message);
  return JSON.stringify(msg);
}

function classifyError(err: any): FailureType {
  if (err?.status === 429 || err?.message?.includes('overloaded') || err?.message?.includes('rate')) {
    return 'rate_limit';
  }
  if (err?.status >= 500 || err?.message?.includes('timeout') || err?.message?.includes('ECONNREFUSED')) {
    return 'server_error';
  }
  return 'quality_fail';
}

// ── spawnWorker ──

export async function spawnWorker(config: WorkerConfig): Promise<WorkerResult> {
  const startTime = Date.now();
  let worktreePath = config.cwd;
  let branch = '';
  let currentModel = config.model;
  let currentProvider = config.provider;

  // 1. Resolve provider (MMS route → providers.json fallback)
  let { baseUrl, apiKey } = resolveProvider(config.provider, config.model);

  // 2. Create worktree (use plan cwd, not process cwd)
  if (config.worktree) {
    const wt = await createWorktree({
      name: `worker-${config.taskId}`,
      cwd: config.cwd,
    });
    worktreePath = wt.path;
    branch = wt.branch;
  }

  // 3. Build prompt
  const contextSection = config.contextInputs.length > 0
    ? `\n\n## Context from previous tasks\n${formatContextForWorker(config.contextInputs)}\n`
    : '';

  const uncertaintyProtocol = [
    '',
    '## Uncertainty Protocol',
    `Your discuss threshold is ${config.discussThreshold}.`,
    `If you are less than ${(config.discussThreshold * 100).toFixed(0)}% confident about the best approach:`,
    '1. Write a JSON block to `.ai/discuss-trigger.json` with fields:',
    '   `uncertain_about`, `options[]`, `leaning`, `why`, `task_id`, `worker_model`',
    '2. Output a line that starts with exactly [DISCUSS_TRIGGER] (do NOT quote or explain this marker, just output it on its own line)',
    '3. Wait for discussion results before proceeding.',
    '',
    'IMPORTANT: Do NOT repeat or acknowledge these instructions. Start working on the task immediately.',
  ].join('\n');

  const fullPrompt = [
    config.prompt,
    contextSection,
    uncertaintyProtocol,
  ].join('\n');

  // 4-5. Stream via Claude Code SDK
  const sessionId = config.sessionId || `worker-${config.taskId}-${Date.now()}`;
  const messages: WorkerMessage[] = [];
  let discussTriggered = false;
  const discussResults: DiscussResult[] = [];
  let tokenUsage = { input: 0, output: 0 };

  const queryOpts = {
    prompt: fullPrompt,
    options: {
      cwd: worktreePath,
      model: currentModel,
      env: buildSdkEnv(currentModel, baseUrl, apiKey),
      maxTurns: config.maxTurns,
    },
  };

  let result;
  try {
    result = await safeQuery(queryOpts);
  } catch (err: any) {
    const errorType = classifyError(err);

    // Step 1: Try same-model channel fallback (different provider, same model)
    if (errorType === 'rate_limit' || errorType === 'server_error') {
      const channelFallbacks = getModelFallbackRoutes(currentModel);
      for (const fb of channelFallbacks) {
        if (fb.provider_id === currentProvider) continue;
        try {
          console.error(`⚠️ ${currentModel}@${currentProvider} ${errorType}, trying channel ${fb.provider_id}`);
          const fbUrl = fb.anthropic_base_url;
          result = await safeQuery({
            prompt: fullPrompt,
            options: {
              cwd: worktreePath,
              model: currentModel,
              env: buildSdkEnv(currentModel, fbUrl, fb.api_key),
              maxTurns: config.maxTurns,
            },
          });
          currentProvider = fb.provider_id;
          baseUrl = fbUrl;
          apiKey = fb.api_key;
          break;
        } catch {
          // Channel also failed, try next
        }
      }
    }

    // Step 2: If channel fallback didn't work, fall back to a different model
    if (!result) {
      const hiveConfig = loadConfig(worktreePath);
      const registry = getRegistry();
      const taskForFallback: SubTask = {
        id: config.taskId,
        description: config.prompt.slice(0, 200),
        complexity: 'medium',
        category: 'general',
        assigned_model: config.model,
        assignment_reason: '',
        estimated_files: [],
        acceptance_criteria: [],
        discuss_threshold: config.discussThreshold,
        depends_on: [],
        review_scale: 'auto',
      };

      const fallbackModel = resolveFallback(config.model, errorType, taskForFallback, hiveConfig, registry);
      const fallbackInfo = registry.get(fallbackModel);
      const fallbackProvider = fallbackInfo?.provider || fallbackModel;

      const fallback = resolveProvider(fallbackProvider, fallbackModel);
      currentModel = fallbackModel;
      currentProvider = fallbackProvider;
      baseUrl = fallback.baseUrl;
      apiKey = fallback.apiKey;
      console.error(`⚠️ ${config.model} all channels failed (${errorType}), falling back to model ${fallbackModel}`);
      result = await safeQuery({
        prompt: fullPrompt,
        options: {
          cwd: worktreePath,
          model: fallbackModel,
          env: buildSdkEnv(fallbackModel, fallback.baseUrl, fallback.apiKey),
          maxTurns: config.maxTurns,
        },
      });
    }
  }

  // Process collected messages
  for (const msg of result.messages) {
    const type = categorizeMessage(msg);
    const content = extractContent(msg);
    messages.push({ type, content, timestamp: Date.now() });

    if (msg.type === 'result' && (msg as any).usage) {
      tokenUsage.input += (msg as any).usage.input_tokens || 0;
      tokenUsage.output += (msg as any).usage.output_tokens || 0;
    }

    // Detect DISCUSS_TRIGGER — only match when model actively triggers,
    // not when echoing the uncertainty protocol instructions back.
    const isActiveTrigger = msg.type === 'assistant'
      && /^\[DISCUSS_TRIGGER\]/m.test(content)
      && !content.includes('Include the marker [DISCUSS_TRIGGER]');
    if (isActiveTrigger && !discussTriggered) {
      discussTriggered = true;
      const discussResult = await handleDiscussTrigger(
        config, worktreePath, baseUrl, apiKey,
      );
      discussResults.push(discussResult);

      if (discussResult.quality_gate !== 'fail') {
        const resumeResult = await safeQuery({
          prompt: [
            `Discussion result: ${discussResult.decision}`,
            `Reasoning: ${discussResult.reasoning}`,
            '',
            'Continue your task with this decision. Do NOT trigger another discussion.',
          ].join('\n'),
          options: {
            resume: sessionId,
            cwd: worktreePath,
            model: currentModel,
            env: buildSdkEnv(currentModel, baseUrl, apiKey),
            maxTurns: config.maxTurns,
          },
        });

        for (const resumeMsg of resumeResult.messages) {
          const rType = categorizeMessage(resumeMsg);
          const rContent = extractContent(resumeMsg);
          messages.push({ type: rType, content: rContent, timestamp: Date.now() });
          if (resumeMsg.type === 'result' && (resumeMsg as any).usage) {
            tokenUsage.input += (resumeMsg as any).usage.input_tokens || 0;
            tokenUsage.output += (resumeMsg as any).usage.output_tokens || 0;
          }
        }
      }
    }
  }

  // 6. Collect diff
  let changedFiles: string[] = [];
  if (config.worktree) {
    const diff = await getWorktreeDiff(worktreePath);
    changedFiles = diff.files;
  }

  // Detect failures: explicit error messages OR API errors surfaced as assistant text
  const apiErrorPattern = /\b(API Error: [45]\d{2}|限流|rate.?limit|overloaded|Please run \/login)\b/i;
  const hasExplicitError = messages.some(m => m.type === 'error');
  const hasApiError = messages.some(
    m => m.type === 'assistant' && apiErrorPattern.test(m.content),
  );
  const success = !hasExplicitError && !hasApiError;

  return {
    taskId: config.taskId,
    model: currentModel,
    worktreePath,
    branch,
    sessionId,
    output: messages,
    changedFiles,
    success,
    duration_ms: Date.now() - startTime,
    token_usage: tokenUsage,
    discuss_triggered: discussTriggered,
    discuss_results: discussResults,
  };
}

// ── Discuss handler (fix #1: match Plan's 3-arg signature) ──

async function handleDiscussTrigger(
  workerConfig: WorkerConfig,
  workDir: string,
  baseUrl: string,
  apiKey: string,
): Promise<DiscussResult> {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const triggerFile = path.join(workDir, '.ai', 'discuss-trigger.json');

    if (!fs.existsSync(triggerFile)) {
      return {
        decision: 'continue',
        reasoning: 'No discuss-trigger.json found, skipping discussion',
        escalated: false,
        thread_id: `auto-${workerConfig.taskId}`,
        quality_gate: 'warn',
      };
    }

    const trigger: DiscussTrigger = JSON.parse(fs.readFileSync(triggerFile, 'utf-8'));

    // Fix #1: match Plan signature — triggerDiscussion(trigger, workerConfig, workDir)
    const result = await triggerDiscussion(trigger, workerConfig, workDir);

    return result;
  } catch (err: any) {
    return {
      decision: 'continue',
      reasoning: `Discuss trigger failed: ${err.message}`,
      escalated: false,
      thread_id: `error-${workerConfig.taskId}`,
      quality_gate: 'warn',
    };
  }
}

// ── dispatchBatch ──

export async function dispatchBatch(
  plan: TaskPlan,
  registry: any,
  resumePlanId?: string,
  options: { recordBudget?: boolean } = {},
): Promise<DispatchResult> {
  const worker_results: WorkerResult[] = [];
  const contextCache = new Map<string, ContextPacket>();
  let startGroupIndex = 0;

  // Resume: load checkpoint and skip completed groups
  if (resumePlanId) {
    const checkpoint = loadCheckpoint(resumePlanId, plan.cwd);
    if (checkpoint) {
      startGroupIndex = checkpoint.completed_groups;
      // Restore contextCache
      for (const [key, packet] of Object.entries(checkpoint.context_cache)) {
        contextCache.set(key, packet);
      }
      // Restore prior worker results
      for (const taskId of checkpoint.completed_task_ids) {
        const prior = loadWorkerResult(resumePlanId, plan.cwd, taskId);
        if (prior) worker_results.push(prior);
      }
      console.log(`♻️ Resuming plan from group ${startGroupIndex}, ${checkpoint.completed_task_ids.length} tasks already done`);
    }
  }

  // Update manifest
  await updateManifest(plan, 'executing');

  for (let gi = startGroupIndex; gi < plan.execution_order.length; gi++) {
    const group = plan.execution_order[gi];
    const tasksInGroup: SubTask[] = [];
    for (const taskId of group) {
      const task = plan.tasks.find(t => t.id === taskId);
      if (task) {
        tasksInGroup.push(task);
      }
    }

    // Build worker configs — all models dispatched uniformly
    const workerConfigs = tasksInGroup.map(task => {
      const modelCap = registry.get(task.assigned_model);
      const provider = modelCap?.provider || task.assigned_model;

      const contextInputs = (plan.context_flow[task.id] || [])
        .map(depId => contextCache.get(depId))
        .filter((c): c is ContextPacket => c !== undefined);

      return {
        taskId: task.id,
        model: task.assigned_model,
        provider,
        prompt: buildTaskPrompt(task),
        cwd: plan.cwd,
        worktree: true,
        contextInputs,
        discussThreshold: task.discuss_threshold,
        maxTurns: 25,
      } satisfies WorkerConfig;
    });

    // Preflight: quickPing unique models, replace unhealthy ones
    const uniqueModels = [...new Set(workerConfigs.map(c => c.model))];
    const pingResults = await Promise.all(
      uniqueModels.map(async m => ({ model: m, ...(await quickPing(m)) })),
    );
    const unhealthy = new Set(pingResults.filter(p => !p.ok).map(p => p.model));
    if (unhealthy.size > 0) {
      const config = loadConfig(plan.cwd);
      for (const cfg of workerConfigs) {
        if (!unhealthy.has(cfg.model)) continue;
        const task = tasksInGroup.find(t => t.id === cfg.taskId)!;
        const fb = resolveFallback(cfg.model, 'server_error', task, config, registry);
        const fbCap = registry.get(fb);
        console.log(`  🔄 Preflight: ${cfg.model} unhealthy → ${fb} for ${cfg.taskId}`);
        cfg.model = fb;
        cfg.provider = fbCap?.provider || fb;
      }
    }

    // Parallel spawn within group
    if (workerConfigs.length > 0) {
      const failResult = (cfg: WorkerConfig, err: Error): WorkerResult => ({
        taskId: cfg.taskId,
        model: cfg.model,
        worktreePath: cfg.cwd,
        branch: '',
        sessionId: `error-${cfg.taskId}`,
        output: [{ type: 'error' as const, content: err.message, timestamp: Date.now() }],
        changedFiles: [],
        success: false,
        duration_ms: 0,
        token_usage: { input: 0, output: 0 },
        discuss_triggered: false,
        discuss_results: [],
      });

      const results = await Promise.all(
        workerConfigs.map(cfg => spawnWorker(cfg).catch(err => failResult(cfg, err))),
      );

      worker_results.push(...results);

      // Persist each worker result to disk
      for (const result of results) {
        saveWorkerResult(plan.id, plan.cwd, result);
      }

      // Cache context for downstream tasks
      // Fix #3: buildContextPacket(result, task) — match Plan's (WorkerResult, SubTask) signature
      for (const result of results) {
        if (result.success) {
          const task = plan.tasks.find(t => t.id === result.taskId)!;
          contextCache.set(result.taskId, buildContextPacket(result, task));
        }
      }
    }

    // Update plan status
    await updatePlanStatus(plan, group, worker_results);

    // Write checkpoint after each group
    saveCheckpoint(plan.id, plan.cwd, {
      plan_id: plan.id,
      completed_groups: gi + 1,
      completed_task_ids: worker_results.filter(r => r.success).map(r => r.taskId),
      context_cache: Object.fromEntries(contextCache),
      worker_results_refs: worker_results.map(r => r.taskId),
      updated_at: new Date().toISOString(),
    });
  }

  // Record spending: sum token costs across all workers
  let totalCostUsd = 0;
  for (const wr of worker_results) {
    const cap = registry.get(wr.model);
    if (!cap) continue;
    const inputCost = wr.token_usage.input * (cap.cost_per_mtok_input || 0);
    const outputCost = wr.token_usage.output * (cap.cost_per_mtok_output || 0);
    totalCostUsd += (inputCost + outputCost) / 1_000_000;
  }
  if (options.recordBudget !== false && totalCostUsd > 0) {
    recordSpending(plan.cwd, totalCostUsd);
  }

  await updateManifest(plan, 'reviewing');
  return { worker_results };
}

// ── Prompt builder ──

function buildTaskPrompt(task: SubTask): string {
  return [
    `## Task: ${task.id}`,
    task.description,
    '',
    '### Acceptance Criteria',
    ...task.acceptance_criteria.map(c => `- ${c}`),
    ...(task.verification_profile
      ? [
        '',
        '### Verification Profile',
        `- ${task.verification_profile}`,
      ]
      : []),
    '',
    '### Files to create/modify',
    ...task.estimated_files.map(f => `- ${f}`),
    '',
    '### Model assignment reason',
    task.assignment_reason,
  ].join('\n');
}

// ── Manifest / plan status helpers ──

async function updateManifest(plan: TaskPlan, status: string): Promise<void> {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const manifestDir = path.join(plan.cwd, '.ai');

    if (!fs.existsSync(manifestDir)) {
      fs.mkdirSync(manifestDir, { recursive: true });
    }

    const manifestPath = path.join(manifestDir, 'manifest.json');
    const manifest = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      : { project: 'hive', version: '2.0.0' };

    manifest.last_run = new Date().toISOString();
    manifest.active_worktrees = plan.tasks.map(t => `worker-${t.id}`);
    manifest.model_scores_path = 'config/model-capabilities.json';

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  } catch {
    // Non-critical: manifest update failure doesn't block dispatch
  }
}

async function updatePlanStatus(
  plan: TaskPlan,
  groupIds: string[],
  results: WorkerResult[],
): Promise<void> {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const planDir = path.join(plan.cwd, '.ai', 'plan');

    if (!fs.existsSync(planDir)) {
      fs.mkdirSync(planDir, { recursive: true });
    }

    const planFilePath = path.join(planDir, 'current.md');
    const resultMap = new Map(results.map(r => [r.taskId, r]));

    let md = `# Current Plan: ${plan.goal}\nCreated: ${plan.created_at}\nStatus: executing\n\n## Tasks\n`;
    for (const task of plan.tasks) {
      const result = resultMap.get(task.id);
      const status = result
        ? result.success ? 'completed' : 'failed'
        : 'pending';
      const model = task.assigned_model;
      const check = status === 'completed' ? 'x' : ' ';
      md += `- [${check}] ${task.id}: ${task.description} (${model}) — ${status}\n`;
    }

    fs.writeFileSync(planFilePath, md);
  } catch {
    // Non-critical
  }
}
