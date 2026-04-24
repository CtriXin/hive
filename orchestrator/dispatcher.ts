// orchestrator/dispatcher.ts — Worker dispatcher: spawn, stream, discuss, collect
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  type TaskPlan,
  type SubTask,
  type WorkerConfig,
  type WorkerResult,
  type WorkerMessage,
  type ContextPacket,
  type DiscussResult,
  type CollabStatusSnapshot,
  type BenchmarkRoutingPolicy,
  type ProviderFailureSubtype,
} from './types.js';
import { getTaskExecutionContract } from './task-contract.js';
import {
  isUnsupportedMmsTransportError,
  resolveProvider,
  quickPing,
} from './provider-resolver.js';
import { triggerDiscussion } from './discuss-bridge.js';
import { createWorktree, getWorktreeDiff } from './worktree-manager.js';
import { buildContextPacket } from './context-recycler.js';
import { ensureStageModelAllowed, loadConfig, resolveFallback, recordSpending } from './hive-config.js';
import { saveWorkerResult, saveCheckpoint, loadCheckpoint, loadWorkerResult } from './result-store.js';
import { getRegistry } from './model-registry.js';
import { buildSdkEnv } from './project-paths.js';
import { ensureModelProxy } from './model-proxy.js';
import { renderPromptPolicy, selectPromptPolicy } from './prompt-policy.js';
import type { SDKMessage } from '@anthropic-ai/claude-code';
import { safeQuery } from './sdk-query-safe.js';
import { getModelFallbackRoutes } from './mms-routes-loader.js';
import { appendWorkerTranscriptEntry, updateWorkerStatus } from './worker-status-store.js';
import { buildRoomRef } from './agentbus-adapter.js';
import { handleDiscussTrigger } from './worker-discuss-handler.js';
import { getModeContract } from './mode-policy.js';
import type { ExecutionMode } from './types.js';
import {
  classifyProviderFailure,
  decideRetryAction,
  ProviderHealthStore,
} from './provider-resilience.js';
import { buildWorkerDispatchPrompt } from './worker-dispatch-prompt.js';

// ── DispatchResult (ERRATA §2) ──

export interface DispatchResult {
  worker_results: WorkerResult[];
}

export interface DispatchRuntimeOptions {
  resumePlanId?: string;
  runId?: string;
  round?: number;
  goal?: string;
  recordBudget?: boolean;
  /** Phase 5A.2: Execution mode for lite-path detection */
  executionMode?: ExecutionMode;
  benchmarkRoutingPolicy?: BenchmarkRoutingPolicy;
  onWorkerDiscussSnapshot?: (snapshot: CollabStatusSnapshot) => void | Promise<void>;
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

function classifyError(err: any): ProviderFailureSubtype {
  return classifyProviderFailure(err);
}

/** Map new ProviderFailureSubtype back to legacy FailureType for resolveFallback compat */
function toLegacyFailureType(subtype: ProviderFailureSubtype): 'rate_limit' | 'server_error' | 'quality_fail' {
  switch (subtype) {
    case 'rate_limit':
      return 'rate_limit';
    case 'timeout':
    case 'transient_network':
    case 'server_error':
    case 'provider_unavailable':
      return 'server_error';
    case 'auth_failure':
    case 'quota_exhausted':
    case 'unknown_provider_failure':
    default:
      return 'quality_fail';
  }
}

function normalizeDispatchOptions(
  input?: string | DispatchRuntimeOptions,
): DispatchRuntimeOptions {
  if (!input) return {};
  return typeof input === 'string' ? { resumePlanId: input } : input;
}

function summarizeMessage(content: string): string | undefined {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length <= 180
    ? normalized
    : `${normalized.slice(0, 177)}...`;
}

function assertNoProviderApiError(result: { messages?: SDKMessage[] } | null | undefined): void {
  const providerErrorPattern = /\b(API Error: [45]\d{2}|限流|rate.?limit|overloaded|Please run \/login)\b/i;
  const message = (result?.messages || [])
    .map((msg) => ({
      type: categorizeMessage(msg),
      content: extractContent(msg),
    }))
    .find((item) => item.type === 'assistant' && providerErrorPattern.test(item.content));
  if (message) {
    throw new Error(message.content || 'Provider returned API error');
  }
}

function shouldFallbackToInPlaceExecution(err: unknown): boolean {
  const message = (err as Error | undefined)?.message || String(err || '');
  return /not in a git repository|no WorktreeCreate hooks are configured/i.test(message);
}

interface ExpectedFileSnapshot {
  exists: boolean;
  hash: string | null;
}

function normalizeExpectedFilePath(filePath: string): string {
  return String(filePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function snapshotExpectedFile(rootDir: string, relativePath: string): ExpectedFileSnapshot {
  const normalizedPath = normalizeExpectedFilePath(relativePath);
  if (!normalizedPath) {
    return { exists: false, hash: null };
  }

  const absolutePath = path.join(rootDir, normalizedPath);
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      return { exists: true, hash: `non-file:${stat.size}:${stat.mtimeMs}` };
    }
    const content = fs.readFileSync(absolutePath);
    return {
      exists: true,
      hash: crypto.createHash('sha1').update(content).digest('hex'),
    };
  } catch {
    return { exists: false, hash: null };
  }
}

function captureExpectedFiles(rootDir: string, expectedFiles: string[] | undefined): Map<string, ExpectedFileSnapshot> {
  const snapshots = new Map<string, ExpectedFileSnapshot>();
  for (const filePath of expectedFiles || []) {
    const normalizedPath = normalizeExpectedFilePath(filePath);
    if (!normalizedPath || snapshots.has(normalizedPath)) continue;
    snapshots.set(normalizedPath, snapshotExpectedFile(rootDir, normalizedPath));
  }
  return snapshots;
}

function detectExpectedFileChanges(
  rootDir: string,
  before: Map<string, ExpectedFileSnapshot>,
): string[] {
  const changed: string[] = [];
  for (const [filePath, previous] of before.entries()) {
    const current = snapshotExpectedFile(rootDir, filePath);
    if (current.exists !== previous.exists || current.hash !== previous.hash) {
      changed.push(filePath);
    }
  }
  return changed;
}

function mergeChangedFiles(primary: string[], extra: string[]): string[] {
  return [...new Set([...primary, ...extra].filter(Boolean))].sort();
}

function configuredRouteLabel(model: string, provider?: string): string {
  return provider ? `${model}@${provider}` : `${model}@configured-route`;
}

function attachWorkerFailureResult(error: unknown, workerResult: WorkerResult): Error {
  const wrapped = error instanceof Error ? error : new Error(String(error || 'Worker failed'));
  (wrapped as Error & { workerResult?: WorkerResult }).workerResult = workerResult;
  return wrapped;
}

// ── spawnWorker ──

function resolvePinnedProvider(
  modelId: string,
  policy?: BenchmarkRoutingPolicy,
): string | null {
  if (!policy || policy.mode !== 'fixed-provider') return null;
  return /^(gpt-|o[134]-)/i.test(modelId)
    ? policy.providerByFamily.gpt
    : policy.providerByFamily.non_gpt;
}

function buildFallbackTask(config: WorkerConfig): SubTask {
  return {
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
}

interface ResolvedWorkerFallback {
  model: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
}

function isHardPingFailure(error?: string): boolean {
  if (!error) return false;
  return /BRIDGE_REQUIRED|401|403|404|auth|forbidden|unauthorized|invalid/i.test(error);
}

async function resolveRunnableFallback(
  failedModel: string,
  failureType: 'rate_limit' | 'server_error' | 'quality_fail',
  task: SubTask,
  cwd: string,
  registry: ReturnType<typeof getRegistry>,
  options: {
    providerHealthDir?: string;
    excludeModels?: string[];
    excludeProviders?: string[];
    pingTimeoutMs?: number;
    allowSoftPingFailure?: boolean;
  } = {},
): Promise<ResolvedWorkerFallback | null> {
  const hiveConfig = loadConfig(cwd);
  const excludedModels = new Set<string>([failedModel, ...(options.excludeModels || [])]);
  const excludedProviders = new Set<string>(options.excludeProviders || []);
  const healthStore = options.providerHealthDir
    ? new ProviderHealthStore(options.providerHealthDir)
    : null;
  let softFallback: ResolvedWorkerFallback | null = null;

  const tryCandidate = async (candidate: string, attempt: number): Promise<ResolvedWorkerFallback | null> => {
    if (!candidate || excludedModels.has(candidate)) return null;
    const provider = registry.get(candidate)?.provider || candidate;
    if (excludedProviders.has(provider)) {
      excludedModels.add(candidate);
      return null;
    }

    if (healthStore) {
      const { avoid, state } = healthStore.shouldAvoid(provider);
      if (avoid) {
        healthStore.recordDecision({
          provider,
          failure_subtype: 'provider_unavailable',
          action: 'block',
          action_reason: `fallback candidate ${candidate} skipped: provider breaker ${state}`,
          dispatch_affected: true,
          backoff_ms: 0,
          attempt,
          timestamp: Date.now(),
        });
        excludedModels.add(candidate);
        excludedProviders.add(provider);
        return null;
      }
    }

    try {
      const resolved = resolveProvider(provider, candidate);
      const ping = await quickPing(candidate, options.pingTimeoutMs ?? 5000, provider);
      if (!ping.ok) {
        healthStore?.recordDecision({
          provider,
          failure_subtype: 'provider_unavailable',
          action: 'fallback',
          action_reason: `fallback candidate ${candidate} preflight failed: ${ping.error || 'unknown'}`,
          dispatch_affected: true,
          backoff_ms: 0,
          attempt,
          timestamp: Date.now(),
        });
        if (options.allowSoftPingFailure && !isHardPingFailure(ping.error)) {
          softFallback ||= {
            model: candidate,
            provider,
            baseUrl: resolved.baseUrl,
            apiKey: resolved.apiKey,
          };
          return null;
        }
        excludedModels.add(candidate);
        excludedProviders.add(provider);
        return null;
      }
      return {
        model: candidate,
        provider,
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
      };
    } catch {
      excludedModels.add(candidate);
      excludedProviders.add(provider);
      return null;
    }
  };

  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = resolveFallback(
        failedModel,
        failureType,
        task,
        hiveConfig,
        registry,
        {
          excludeModels: [...excludedModels],
          excludeProviders: [...excludedProviders],
        },
      );
      if (!candidate || excludedModels.has(candidate)) {
        break;
      }

      const resolved = await tryCandidate(candidate, attempt + 1);
      if (resolved) return resolved;
    }

    if (softFallback) {
      return softFallback;
    }
  } finally {
    healthStore?.save();
  }

  return null;
}

export async function spawnWorker(config: WorkerConfig): Promise<WorkerResult> {
  const startTime = Date.now();
  let worktreePath = config.cwd;
  let branch = '';
  let worktreeFallbackReason = '';
  let currentModel = config.model;
  let currentProvider = config.provider;
  const allowExecutorFallback = false;
  const pinnedProvider = resolvePinnedProvider(config.model, config.benchmarkRoutingPolicy);
  if (pinnedProvider) {
    currentProvider = pinnedProvider;
  }
  const sessionId = config.sessionId || `worker-${config.taskId}-${Date.now()}`;
  const assignedModel = config.assignedModel || config.model;
  const runId = config.runId;
  const planId = config.planId || runId || config.taskId;
  const round = config.round ?? 0;
  const executionContract = getTaskExecutionContract({
    description: config.taskDescription || config.prompt,
    acceptance_criteria: [],
    estimated_files: [],
    execution_contract: config.execution_contract,
  });

  ensureStageModelAllowed('executor', currentModel);

  let providerFailureSubtype: ProviderFailureSubtype | undefined;
  let providerFallbackUsed = false;
  const failedProviders = new Set<string>();
  const attemptedModels = new Set<string>([config.model]);

  // Phase 8A: Initialize provider health store for this run
  const healthStore = config.providerHealthDir
    ? new ProviderHealthStore(config.providerHealthDir)
    : null;

  // 1. Resolve provider (MMS route → providers.json fallback)
  let baseUrl: string;
  let apiKey: string;
  try {
    const resolvedProvider = resolveProvider(currentProvider, config.model);
    baseUrl = resolvedProvider.baseUrl;
    apiKey = resolvedProvider.apiKey;
    currentProvider = resolvedProvider.providerId || currentProvider;
  } catch (err) {
    if (!isUnsupportedMmsTransportError(err) || !allowExecutorFallback) {
      if (isUnsupportedMmsTransportError(err) && !allowExecutorFallback) {
        throw new Error(
          `Executor route resolution failed for configured route ${configuredRouteLabel(config.model, currentProvider)}: `
          + `${(err as Error).message}. Hive executor fallback is disabled.`,
        );
      }
      throw err;
    }
    const registry = getRegistry();
    const fallback = await resolveRunnableFallback(
      config.model,
      'server_error',
      buildFallbackTask(config),
      config.cwd,
      registry,
      {
        providerHealthDir: config.providerHealthDir,
        excludeModels: [...attemptedModels],
        allowSoftPingFailure: true,
      },
    );
    if (!fallback) {
      throw err;
    }
    ({ baseUrl, apiKey } = fallback);
    currentModel = fallback.model;
    currentProvider = fallback.provider;
    attemptedModels.add(fallback.model);
    providerFallbackUsed = true;
    healthStore?.recordDecision({
      provider: config.provider,
      failure_subtype: 'provider_unavailable',
      action: 'fallback',
      action_reason: `route requires bridge transport; fallback to ${fallback.model}`,
      dispatch_affected: true,
      fallback_provider: fallback.provider,
      backoff_ms: 0,
      attempt: 1,
      timestamp: Date.now(),
    });
  }

  const reportStatus = (
    status: 'starting' | 'running' | 'discussing' | 'completed' | 'failed',
    extra: Partial<Parameters<typeof updateWorkerStatus>[2]> = {},
  ): void => {
    if (!runId) return;
    updateWorkerStatus(config.cwd, runId, {
      task_id: config.taskId,
      status,
      plan_id: planId,
      round,
      assigned_model: assignedModel,
      active_model: currentModel,
      provider: currentProvider,
      task_description: config.taskDescription,
      session_id: sessionId,
      branch,
      worktree_path: worktreePath,
      prompt_policy_version: config.promptPolicy?.version,
      prompt_fragments: config.promptPolicy?.fragments,
      execution_contract: executionContract,
      provider_failure_subtype: providerFailureSubtype,
      provider_fallback_used: providerFallbackUsed,
      ...extra,
    });
  };

  const appendTranscript = (
    type: WorkerMessage['type'],
    content: string,
  ): void => {
    if (!runId) return;
    appendWorkerTranscriptEntry(config.cwd, runId, {
      task_id: config.taskId,
      plan_id: planId,
      session_id: sessionId,
      type,
      content,
    });
  };

  // 2. Create worktree (use plan cwd, not process cwd)
  if (config.worktree) {
    try {
      const wt = await createWorktree({
        name: `worker-${config.taskId}`,
        cwd: config.cwd,
        ...(config.fromBranch ? { fromBranch: config.fromBranch } : {}),
      });
      worktreePath = wt.path;
      branch = wt.branch;
    } catch (err) {
      if (!shouldFallbackToInPlaceExecution(err)) {
        throw err;
      }
      worktreeFallbackReason = (err as Error)?.message || 'worktree unavailable';
      worktreePath = config.cwd;
      branch = '';
      console.warn(
        `[hive] Worktree unavailable for ${config.taskId}; falling back to in-place execution at ${config.cwd}: ${worktreeFallbackReason}`,
      );
    }
  }

  const expectedFilesBefore = captureExpectedFiles(worktreePath, config.expectedFiles);

  // 3. Build prompt
  const dispatchPrompt = buildWorkerDispatchPrompt(config, worktreePath, worktreeFallbackReason);
  const fullPrompt = dispatchPrompt.prompt;

  // 4-5. Stream via Claude Code SDK
  const messages: WorkerMessage[] = [];
  let discussTriggered = false;
  const discussResults: DiscussResult[] = [];
  let workerDiscussCollab: CollabStatusSnapshot | undefined;
  let tokenUsage = { input: 0, output: 0 };
  reportStatus('starting', {
    started_at: new Date(startTime).toISOString(),
    task_summary: config.taskDescription,
    event_message: worktreeFallbackReason
      ? `Worker session started (in-place fallback: ${worktreeFallbackReason})`
      : 'Worker session started',
  });
  let workerStarted = true;
  appendTranscript('system', `Worker started for ${config.taskId}`);
  appendTranscript('system', `Dispatch prompt mode: ${dispatchPrompt.mode}${dispatchPrompt.reason ? ` (${dispatchPrompt.reason})` : ''}`);
  if (worktreeFallbackReason) {
    appendTranscript('system', `Worktree unavailable; running in place at ${config.cwd}: ${worktreeFallbackReason}`);
  }

  const handleLiveMessage = (msg: SDKMessage): void => {
    if (msg.type !== 'assistant' && msg.type !== 'result') return;
    const content = extractContent(msg);
    const preview = summarizeMessage(content);
    if (!preview) return;
    reportStatus('running', {
      task_summary: preview,
      last_message: preview,
    });
    appendTranscript(categorizeMessage(msg), content);
  };

  const queryOpts = {
    prompt: fullPrompt,
    options: {
      cwd: worktreePath,
      model: currentModel,
      env: buildSdkEnv(currentModel, baseUrl, apiKey),
      maxTurns: config.maxTurns,
    },
    onMessage: handleLiveMessage,
  };
  const recordProviderDecision = (
    provider: string,
    failureSubtype: ProviderFailureSubtype,
    action: 'immediate_retry' | 'bounded_retry' | 'backoff_retry' | 'fallback' | 'cooldown' | 'block',
    actionReason: string,
    options: {
      dispatchAffected: boolean;
      fallbackProvider?: string;
      backoffMs?: number;
      attempt?: number;
    } = { dispatchAffected: false },
  ): void => {
    healthStore?.recordDecision({
      provider,
      failure_subtype: failureSubtype,
      action,
      action_reason: actionReason,
      dispatch_affected: options.dispatchAffected,
      fallback_provider: options.fallbackProvider,
      backoff_ms: options.backoffMs || 0,
      attempt: options.attempt || 1,
      timestamp: Date.now(),
    });
  };

  let result;
  const requestedModel = config.model;
  const requestedProvider = pinnedProvider || currentProvider || config.provider;
  let lastProviderErrorMessage = '';

  try {
    // Phase 8B: Wrap all provider calls in try-finally for health store persistence
    try {
    // ── Same-provider bounded retry loop ──
    // Max 2 retries after original attempt (3 total).
    // Non-retryable failures block immediately.
    // Retry budget exhausted → proceed to channel/model fallback.
    let retryAttempt = 0;
    let primaryErrorType: ProviderFailureSubtype | undefined;

  while (!result) {
    try {
      result = await safeQuery(queryOpts);
      assertNoProviderApiError(result);
      if (healthStore) {
        healthStore.recordSuccess(currentProvider);
      }
    } catch (err: any) {
      result = undefined;
      const errorType = classifyError(err);
      lastProviderErrorMessage = err?.message || String(err || errorType);

      // First failure: record it
      if (retryAttempt === 0) {
        providerFailureSubtype = errorType;
        if (healthStore) {
          healthStore.recordFailure(currentProvider, errorType);
        }
        failedProviders.add(currentProvider);
      }

      const retryInfo = decideRetryAction(errorType, retryAttempt + 1);
      recordProviderDecision(currentProvider, errorType, retryInfo.action, retryInfo.reason, {
        dispatchAffected: retryInfo.action !== 'immediate_retry',
        backoffMs: retryInfo.backoff_ms,
        attempt: retryAttempt + 1,
      });

      // Non-retryable or block: throw immediately
      if (retryInfo.action === 'block') {
        primaryErrorType = errorType;
        throw new Error(`Provider failure [${errorType}]: ${retryInfo.reason}`);
      }

      // Retry budget exhausted: record and break to fallback
      if (retryInfo.action === 'cooldown') {
        console.error(`⛔ Provider ${currentProvider} [${errorType}]: ${retryInfo.reason} — proceeding to fallback`);
        primaryErrorType = errorType;
        break;
      }

      // Apply backoff before retry
      if (retryInfo.backoff_ms > 0) {
        const cappedDelay = Math.min(retryInfo.backoff_ms, 5000);
        console.error(`⏱️ Provider ${currentProvider} [${errorType}]: ${retryInfo.reason} — retry ${retryAttempt + 1} after ${cappedDelay}ms`);
        await new Promise((r) => setTimeout(r, cappedDelay));
      }

      retryAttempt++;
    }
  }

  // ── Channel fallback (only after same-provider retry budget exhausted) ──
  if (!result) {
    const allowChannelFallback = allowExecutorFallback && !config.benchmarkRoutingPolicy?.disable_channel_fallback;
    const allowModelFallback = allowExecutorFallback && !config.benchmarkRoutingPolicy?.disable_model_fallback;
    const fallbackErrorType = primaryErrorType ?? 'unknown_provider_failure';

    if (allowChannelFallback) {
      const channelFallbacks = getModelFallbackRoutes(currentModel);
      for (const fb of channelFallbacks) {
        if (fb.provider_id === currentProvider) continue;
        if (failedProviders.has(fb.provider_id)) continue;

        if (healthStore) {
          const { avoid } = healthStore.shouldAvoid(fb.provider_id);
          if (avoid) {
            console.error(`  ⛔ Skipping channel fallback to ${fb.provider_id} (circuit breaker open)`);
            continue;
          }
        }

        try {
          console.error(`⚠️ ${currentModel}@${currentProvider} ${fallbackErrorType}, trying channel ${fb.provider_id}`);
          const fbUrl = fb.anthropic_base_url;
          result = await safeQuery({
            prompt: fullPrompt,
            options: {
              cwd: worktreePath,
              model: currentModel,
              env: buildSdkEnv(currentModel, fbUrl, fb.api_key),
              maxTurns: config.maxTurns,
            },
            onMessage: handleLiveMessage,
          });
          assertNoProviderApiError(result);
          providerFallbackUsed = true;
          currentProvider = fb.provider_id;
          baseUrl = fbUrl;
          apiKey = fb.api_key;
          recordProviderDecision(requestedProvider, fallbackErrorType, 'fallback', `channel fallback to ${fb.provider_id}`, {
            dispatchAffected: true,
            fallbackProvider: fb.provider_id,
            attempt: retryAttempt + 1,
          });

          if (healthStore) {
            healthStore.recordSuccess(fb.provider_id);
          }
          break;
        } catch {
          if (healthStore) {
            healthStore.recordFailure(fb.provider_id, fallbackErrorType);
          }
          failedProviders.add(fb.provider_id);
        }
      }
    }

    if (!result && !allowModelFallback) {
      const failureDetail = lastProviderErrorMessage || `provider_failure=${fallbackErrorType}`;
      throw new Error(
        `Executor failed for configured route ${configuredRouteLabel(requestedModel, requestedProvider)}: `
        + `${failureDetail} (provider_failure=${fallbackErrorType}). Hive executor fallback is disabled.`,
      );
    }

    if (!result) {
      const registry = getRegistry();
      const taskForFallback = buildFallbackTask(config);
      const fallback = await resolveRunnableFallback(
        config.model,
        toLegacyFailureType(fallbackErrorType),
        taskForFallback,
        worktreePath,
        registry,
        {
          providerHealthDir: config.providerHealthDir,
          excludeModels: [...attemptedModels],
          excludeProviders: [...failedProviders],
          allowSoftPingFailure: true,
        },
      );
      if (!fallback) {
        recordProviderDecision(currentProvider, fallbackErrorType, 'block', 'model fallback blocked: no runnable executor candidate', {
          dispatchAffected: true,
          attempt: retryAttempt + 1,
        });
        throw new Error(`Model fallback blocked: no runnable executor candidate after ${config.model}@${currentProvider} failed with ${fallbackErrorType}`);
      }

      currentModel = fallback.model;
      currentProvider = fallback.provider;
      attemptedModels.add(fallback.model);
      providerFallbackUsed = true;
      ensureStageModelAllowed('executor', currentModel);
      baseUrl = fallback.baseUrl;
      apiKey = fallback.apiKey;
      recordProviderDecision(requestedProvider, fallbackErrorType, 'fallback', `model fallback to ${currentModel}`, {
        dispatchAffected: true,
        fallbackProvider: currentProvider,
        attempt: retryAttempt + 1,
      });
      console.error(`⚠️ ${config.model} all channels failed (${fallbackErrorType}), falling back to model ${currentModel}`);
      reportStatus('running', {
        active_model: currentModel,
        provider: currentProvider,
        task_summary: `Falling back to ${currentModel}`,
        event_message: `Primary provider failed with provider_failure=${fallbackErrorType}; falling back to ${currentModel}`,
      });
      appendTranscript('system', `Primary provider failed (${fallbackErrorType}); falling back to ${currentModel}`);
      result = await safeQuery({
        prompt: fullPrompt,
        options: {
          cwd: worktreePath,
          model: currentModel,
          env: buildSdkEnv(currentModel, fallback.baseUrl, fallback.apiKey),
          maxTurns: config.maxTurns,
        },
        onMessage: handleLiveMessage,
      });
      assertNoProviderApiError(result);
    }
  }
    } finally {
      healthStore?.save();
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
        reportStatus('discussing', {
          discuss_triggered: true,
          task_summary: 'Waiting for discuss result',
          last_message: summarizeMessage(content),
          event_message: 'Worker requested discuss assistance',
        });
        appendTranscript('system', 'Worker requested discuss assistance');
        const discussHandlerResult = await handleDiscussTrigger(
          config, worktreePath,
        );
        const discussResult = discussHandlerResult.result;
        if (discussHandlerResult.collab) {
          workerDiscussCollab = discussHandlerResult.collab;
        }
        discussResults.push(discussResult);
        reportStatus('running', {
          discuss_triggered: true,
          task_summary: summarizeMessage(discussResult.decision),
          event_message: `Discussion resolved with ${discussResult.quality_gate}`,
          last_message: summarizeMessage(discussResult.decision),
          discuss_conclusion: {
            quality_gate: discussResult.quality_gate,
            conclusion: discussResult.decision,
          },
        });
        appendTranscript('system', `Discuss result (${discussResult.quality_gate}): ${discussResult.decision}`);

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
            onMessage: handleLiveMessage,
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
    if (worktreePath) {
      const diff = await getWorktreeDiff(worktreePath);
      changedFiles = diff.files;
    }
    changedFiles = mergeChangedFiles(changedFiles, detectExpectedFileChanges(worktreePath, expectedFilesBefore));

    // Detect failures: explicit error messages OR API errors surfaced as assistant text
    const apiErrorPattern = /\b(API Error: [45]\d{2}|限流|rate.?limit|overloaded|Please run \/login)\b/i;
    const hasExplicitError = messages.some(m => m.type === 'error');
    const hasApiError = messages.some(
      m => m.type === 'assistant' && apiErrorPattern.test(m.content),
    );
    const success = !hasExplicitError && !hasApiError;

    reportStatus(success ? 'completed' : 'failed', {
      discuss_triggered: discussTriggered,
      changed_files_count: changedFiles.length,
      success,
      finished_at: new Date().toISOString(),
      task_summary: summarizeMessage(messages[messages.length - 1]?.content || ''),
      last_message: summarizeMessage(messages[messages.length - 1]?.content || ''),
      event_message: success ? 'Worker finished successfully' : 'Worker finished with errors',
    });
    appendTranscript(success ? 'system' : 'error', success ? 'Worker finished successfully' : 'Worker finished with errors');
    workerStarted = false;

    return {
      taskId: config.taskId,
      model: currentModel,
      runId: config.runId,
      requested_model: requestedModel,
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
      prompt_policy_version: config.promptPolicy?.version,
      prompt_fragments: config.promptPolicy?.fragments,
      execution_contract: executionContract,
      worker_discuss_collab: workerDiscussCollab,
      provider_failure_subtype: providerFailureSubtype,
      provider_fallback_used: providerFallbackUsed,
      provider: currentProvider,
      requested_provider: requestedProvider,
    };
  } catch (err) {
    if (!workerStarted) {
      throw err;
    }

    const failureMessage = (err as Error | undefined)?.message || String(err || 'Worker failed');
    let changedFiles: string[] = [];
    try {
      if (worktreePath) {
        const diff = await getWorktreeDiff(worktreePath);
        changedFiles = diff.files;
      }
    } catch {
      changedFiles = [];
    }
    changedFiles = mergeChangedFiles(changedFiles, detectExpectedFileChanges(worktreePath, expectedFilesBefore));

    messages.push({ type: 'error', content: failureMessage, timestamp: Date.now() });
    reportStatus('failed', {
      discuss_triggered: discussTriggered,
      changed_files_count: changedFiles.length,
      success: false,
      error: failureMessage,
      finished_at: new Date().toISOString(),
      task_summary: summarizeMessage(failureMessage),
      last_message: summarizeMessage(failureMessage),
      event_message: 'Worker finished with errors',
    });
    appendTranscript('error', failureMessage);
    workerStarted = false;

    const workerResult: WorkerResult = {
      taskId: config.taskId,
      model: currentModel,
      runId: config.runId,
      requested_model: requestedModel,
      requested_provider: requestedProvider,
      worktreePath,
      branch,
      sessionId,
      output: messages,
      changedFiles,
      success: false,
      duration_ms: Date.now() - startTime,
      token_usage: tokenUsage,
      discuss_triggered: discussTriggered,
      discuss_results: discussResults,
      prompt_policy_version: config.promptPolicy?.version,
      prompt_fragments: config.promptPolicy?.fragments,
      execution_contract: executionContract,
      worker_discuss_collab: workerDiscussCollab,
      provider_failure_subtype: providerFailureSubtype,
      provider_fallback_used: providerFallbackUsed,
      provider: currentProvider,
    };
    throw attachWorkerFailureResult(err, workerResult);
  }
}

// ── dispatchBatch ──

export async function dispatchBatch(
  plan: TaskPlan,
  registry: any,
  resumePlanIdOrOptions?: string | DispatchRuntimeOptions,
  options: { recordBudget?: boolean } = {},
): Promise<DispatchResult> {
  const runtime = normalizeDispatchOptions(resumePlanIdOrOptions);
  const runId = runtime.runId || plan.id;
  const round = runtime.round ?? 0;
  // Merge recordBudget: runtime option takes precedence, then legacy options param
  const shouldRecordBudget = runtime.recordBudget ?? options.recordBudget;
  const worker_results: WorkerResult[] = [];
  const contextCache = new Map<string, ContextPacket>();
  let startGroupIndex = 0;

  // Resume: load checkpoint and skip completed groups
  if (runtime.resumePlanId) {
    const checkpoint = loadCheckpoint(runtime.resumePlanId, plan.cwd);
    if (checkpoint) {
      startGroupIndex = checkpoint.completed_groups;
      // Restore contextCache
      for (const [key, packet] of Object.entries(checkpoint.context_cache)) {
        contextCache.set(key, packet);
      }
      // Restore prior worker results
      for (const taskId of checkpoint.completed_task_ids) {
        const prior = loadWorkerResult(runtime.resumePlanId, plan.cwd, taskId);
        if (prior) worker_results.push(prior);
      }
      console.log(`♻️ Resuming plan from group ${startGroupIndex}, ${checkpoint.completed_task_ids.length} tasks already done`);
    }
  }

  // Start model name proxy if any non-Claude model is used
  const hasNonClaudeModels = plan.tasks.some(
    t => !t.assigned_model.startsWith('claude-'),
  );
  if (hasNonClaudeModels) {
    await ensureModelProxy();
  }

  // Phase 5A.2: Lite-path detection via mode contract
  const executionMode = runtime.executionMode;
  const modeContract = executionMode ? getModeContract(executionMode) : null;
  const isLitePath = modeContract?.discuss_gate === 'disabled' && modeContract?.dispatch_style === 'single';
  if (isLitePath) {
    console.log(`  ⚡ Lite path active (${executionMode}): skipping routing/discuss overhead`);
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

      // Resolve upstream branch for dependent tasks
      const depIds = task.depends_on || [];
      let fromBranch: string | undefined;
      for (const depId of depIds) {
        const upstream = worker_results.find(r => r.taskId === depId && r.success && r.branch);
        if (upstream?.branch) {
          fromBranch = upstream.branch;
          break;
        }
      }

      // Phase 8A: Provider health store directory
      const providerHealthDir = runId
        ? path.join(plan.cwd, '.ai', 'runs', runId)
        : undefined;

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
        assignedModel: task.assigned_model,
        benchmarkRoutingPolicy: runtime.benchmarkRoutingPolicy,
        runId,
        planId: plan.id,
        round,
        taskDescription: task.description,
        fromBranch,
        onWorkerDiscussSnapshot: runtime.onWorkerDiscussSnapshot,
        promptPolicy: task.prompt_policy,
        execution_contract: task.execution_contract,
        expectedFiles: task.estimated_files,
        providerHealthDir,
      } satisfies WorkerConfig;
    });

    const preflightBlocked = new Map<string, Error>();
    const pingResults = await Promise.all(
      workerConfigs.map(async (cfg) => ({
        taskId: cfg.taskId,
        model: cfg.model,
        provider: cfg.provider,
        ping: await quickPing(cfg.model, 15000, cfg.provider || undefined),
      })),
    );
    for (const pingResult of pingResults) {
      if (pingResult.ping.ok) continue;
      preflightBlocked.set(
        pingResult.taskId,
        new Error(
          `Executor preflight failed for configured route ${configuredRouteLabel(pingResult.model, pingResult.provider)}: `
          + `${pingResult.ping.error || 'health check failed'}. Hive executor fallback is disabled.`,
        ),
      );
      console.log(
        `  ⛔ Preflight blocked ${pingResult.taskId}: ${configuredRouteLabel(pingResult.model, pingResult.provider)} `
        + `(${pingResult.ping.error || 'health check failed'})`,
      );
    }
    // Report queued status for each worker in the group
    for (const cfg of workerConfigs) {
      if (preflightBlocked.has(cfg.taskId)) continue;
      updateWorkerStatus(plan.cwd, runId, {
        task_id: cfg.taskId,
        status: 'queued',
        plan_id: plan.id,
        goal: runtime.goal || plan.goal,
        round,
        assigned_model: cfg.assignedModel || cfg.model,
        active_model: cfg.model,
        provider: cfg.provider,
        task_description: cfg.taskDescription,
        task_summary: cfg.taskDescription,
        prompt_policy_version: cfg.promptPolicy?.version,
        prompt_fragments: cfg.promptPolicy?.fragments,
        execution_contract: cfg.execution_contract,
        provider_fallback_used: false,
        event_message: 'Queued for worker dispatch',
      });
    }

    // Parallel spawn within group
    if (workerConfigs.length > 0) {
      const failResult = (cfg: WorkerConfig, err: Error): WorkerResult => {
        const attachedWorkerResult = (err as Error & { workerResult?: WorkerResult }).workerResult;
        if (attachedWorkerResult) {
          return attachedWorkerResult;
        }
        const failureSubtype = classifyProviderFailure(err);
        const failureReason = err.message || 'Worker crashed before returning a result';
        const eventMessage = /invalid provider url|non-claude-compatible base url|requires bridge transport/i.test(failureReason)
          ? 'Worker failed during provider route resolution'
          : 'Worker crashed before returning a result';
        const fallbackUsed = /fallback/i.test(failureReason);
        const requestedProvider = cfg.provider;
        const requestedModel = cfg.assignedModel || cfg.model;
        updateWorkerStatus(plan.cwd, runId, {
          task_id: cfg.taskId,
          status: 'failed',
          plan_id: plan.id,
          round,
          assigned_model: cfg.assignedModel || cfg.model,
          active_model: cfg.model,
          provider: cfg.provider,
          task_description: cfg.taskDescription,
          session_id: `error-${cfg.taskId}`,
          worktree_path: cfg.cwd,
          success: false,
          error: failureReason,
          prompt_policy_version: cfg.promptPolicy?.version,
          prompt_fragments: cfg.promptPolicy?.fragments,
          execution_contract: cfg.execution_contract,
          provider_failure_subtype: failureSubtype,
          provider_fallback_used: fallbackUsed,
          event_message: eventMessage,
        });
        appendWorkerTranscriptEntry(plan.cwd, runId, {
          task_id: cfg.taskId,
          plan_id: plan.id,
          session_id: `error-${cfg.taskId}`,
          type: 'error',
          content: err.message,
        });
        return {
          taskId: cfg.taskId,
          model: cfg.model,
          provider: cfg.provider,
          requested_model: requestedModel,
          requested_provider: requestedProvider,
          worktreePath: cfg.cwd,
          branch: '',
          sessionId: `error-${cfg.taskId}`,
          output: [{ type: 'error' as const, content: failureReason, timestamp: Date.now() }],
          changedFiles: [],
          success: false,
          duration_ms: 0,
          token_usage: { input: 0, output: 0 },
          discuss_triggered: false,
          discuss_results: [],
          prompt_policy_version: cfg.promptPolicy?.version,
          prompt_fragments: cfg.promptPolicy?.fragments,
          execution_contract: cfg.execution_contract,
          provider_failure_subtype: failureSubtype,
          provider_fallback_used: fallbackUsed,
        };
      };

      const results = await Promise.all(
        workerConfigs.map((cfg) => {
          const blockedError = preflightBlocked.get(cfg.taskId);
          if (blockedError) {
            return Promise.resolve(failResult(cfg, blockedError));
          }
          return spawnWorker(cfg).catch(err => failResult(cfg, err));
        }),
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
  if (shouldRecordBudget !== false && totalCostUsd > 0) {
    recordSpending(plan.cwd, totalCostUsd);
  }

  await updateManifest(plan, 'reviewing');
  return { worker_results };
}

// ── Prompt builder ──

export function buildTaskPrompt(task: SubTask): string {
  const promptPolicy = task.prompt_policy || selectPromptPolicy(task);
  const renderedPromptPolicy = renderPromptPolicy(promptPolicy);
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
    ...(renderedPromptPolicy
      ? [
        '',
        renderedPromptPolicy,
      ]
      : []),
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
