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
import { resolveProvider } from './provider-resolver.js';
import { triggerDiscussion } from './discuss-bridge.js';
import { createWorktree, getWorktreeDiff } from './worktree-manager.js';
import { buildContextPacket, formatContextForWorker } from './context-recycler.js';
import { loadConfig, resolveFallback, type FailureType } from './hive-config.js';
import { getRegistry } from './model-registry.js';
import type { SDKMessage } from '@anthropic-ai/claude-code';
import { query } from '@anthropic-ai/claude-code';

// ── DispatchResult (ERRATA §2) ──

export interface DispatchResult {
  worker_results: WorkerResult[];
  opus_tasks: SubTask[];
}

function requiresDirectClaudeHandling(modelId: string): boolean {
  return modelId.startsWith('claude-');
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

  // 1. Resolve provider
  let { baseUrl, apiKey } = await resolveProvider(config.provider);

  // 2. Create worktree
  if (config.worktree) {
    const wt = await createWorktree({
      name: `worker-${config.taskId}`,
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
    '2. Include the marker [DISCUSS_TRIGGER] in your next message',
    '3. Wait for discussion results before proceeding.',
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

  const originalOptions = {
    prompt: fullPrompt,
    options: {
      cwd: worktreePath,
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_MODEL: config.model,
      },
      maxTurns: config.maxTurns,
    },
  };

  let stream;
  try {
    stream = query(originalOptions);
  } catch (err: any) {
    const errorType = classifyError(err);
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

    try {
      const fallback = await resolveProvider(fallbackProvider);
      currentModel = fallbackModel;
      currentProvider = fallbackProvider;
      baseUrl = fallback.baseUrl;
      apiKey = fallback.apiKey;
      console.error(`⚠️ ${config.model} failed (${errorType}), falling back to ${fallbackModel}`);
      stream = query({
        prompt: fullPrompt,
        options: {
          cwd: worktreePath,
          env: {
            ANTHROPIC_BASE_URL: fallback.baseUrl,
            ANTHROPIC_AUTH_TOKEN: fallback.apiKey,
            ANTHROPIC_MODEL: fallbackModel,
          },
          maxTurns: config.maxTurns,
        },
      });
    } catch {
      throw err;
    }
  }

  for await (const msg of stream) {
    const type = categorizeMessage(msg);
    const content = extractContent(msg);
    messages.push({ type, content, timestamp: Date.now() });

    // Track token usage (only on result messages)
    if (msg.type === 'result' && msg.usage) {
      tokenUsage.input += msg.usage.input_tokens || 0;
      tokenUsage.output += msg.usage.output_tokens || 0;
    }

    // Detect DISCUSS_TRIGGER
    if (content.includes('[DISCUSS_TRIGGER]') && !discussTriggered) {
      discussTriggered = true;
      const discussResult = await handleDiscussTrigger(
        config,
        worktreePath,
        baseUrl,
        apiKey,
      );
      discussResults.push(discussResult);

      // Resume session with discussion result (fix #4: stable, compilable resume)
      if (discussResult.quality_gate !== 'fail') {
        const resumePrompt = [
          `Discussion result: ${discussResult.decision}`,
          `Reasoning: ${discussResult.reasoning}`,
          '',
          'Continue your task with this decision. Do NOT trigger another discussion.',
        ].join('\n');

        const resumeStream = query({
          prompt: resumePrompt,
          options: {
            resume: sessionId,
            cwd: worktreePath,
            env: {
              ANTHROPIC_BASE_URL: baseUrl,
              ANTHROPIC_AUTH_TOKEN: apiKey,
              ANTHROPIC_MODEL: currentModel,
            },
            maxTurns: config.maxTurns,
          },
        });

        for await (const resumeMsg of resumeStream) {
          const rType = categorizeMessage(resumeMsg);
          const rContent = extractContent(resumeMsg);
          messages.push({ type: rType, content: rContent, timestamp: Date.now() });

          if (resumeMsg.type === 'result' && resumeMsg.usage) {
            tokenUsage.input += resumeMsg.usage.input_tokens || 0;
            tokenUsage.output += resumeMsg.usage.output_tokens || 0;
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

  const success = !messages.some(m => m.type === 'error');

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
): Promise<DispatchResult> {
  const worker_results: WorkerResult[] = [];
  const opus_tasks: SubTask[] = [];
  const contextCache = new Map<string, ContextPacket>();

  // Update manifest
  await updateManifest(plan, 'executing');

  for (const group of plan.execution_order) {
    // Separate opus tasks from worker tasks
    const opusInGroup: SubTask[] = [];
    const workerTasksInGroup: SubTask[] = [];

    for (const taskId of group) {
      const task = plan.tasks.find(t => t.id === taskId);
      if (!task) continue;

      if (requiresDirectClaudeHandling(task.assigned_model)) {
        opusInGroup.push(task);
      } else {
        workerTasksInGroup.push(task);
      }
    }

    opus_tasks.push(...opusInGroup);

    // Build worker configs
    // Fix #2: provider from registry, not task.category
    const workerConfigs = workerTasksInGroup.map(task => {
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
  }

  await updateManifest(plan, 'reviewing');
  return { worker_results, opus_tasks };
}

// ── Prompt builder ──

function buildTaskPrompt(task: SubTask): string {
  return [
    `## Task: ${task.id}`,
    task.description,
    '',
    '### Acceptance Criteria',
    ...task.acceptance_criteria.map(c => `- ${c}`),
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
      const status = requiresDirectClaudeHandling(task.assigned_model)
        ? 'pending (opus)'
        : result
          ? result.success ? 'completed' : 'failed'
          : 'pending';
      const model = task.assigned_model;
      const check = status.includes('completed') ? 'x' : ' ';
      md += `- [${check}] ${task.id}: ${task.description} (${model}) — ${status}\n`;
    }

    fs.writeFileSync(planFilePath, md);
  } catch {
    // Non-critical
  }
}
