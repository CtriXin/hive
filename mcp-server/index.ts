import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { execSync } from 'child_process';
import type { TaskPlan, TranslationResult, OrchestratorResult, PlanDiscussResult, StageTokenUsage, TokenBreakdown } from '../orchestrator/types.js';
import type { DiscussPlanDiag } from '../orchestrator/discuss-bridge.js';
import { buildPlanFromClaudeOutput, PLAN_PROMPT_TEMPLATE } from '../orchestrator/planner.js';
import { translateToEnglish } from '../orchestrator/translator.js';
import { reportResults } from '../orchestrator/reporter.js';
import { spawnWorker, dispatchBatch } from '../orchestrator/dispatcher.js';
import { reviewCascade } from '../orchestrator/reviewer.js';
import { ModelRegistry } from '../orchestrator/model-registry.js';
import { checkProviderHealth, getAllProviders, resolveProviderForModel, quickPing } from '../orchestrator/provider-resolver.js';
import { isMmsAvailable, loadMmsRoutes } from '../orchestrator/mms-routes-loader.js';
import { getBudgetStatus, getBudgetWarning, loadConfig, recordSpending, resolveTierModel, resolveFallback } from '../orchestrator/hive-config.js';
import fs from 'fs';

const server = new McpServer({
  name: 'hive-mcp',
  version: '1.0.0',
});

// ── Planner context collection ──

function collectFileTree(cwd: string, maxLines = 80): string {
  try {
    const raw = execSync(
      `find . -type f -name "*.ts" -o -name "*.js" -o -name "*.json" | grep -v node_modules | grep -v dist | grep -v .git | sort | head -${maxLines}`,
      { cwd, encoding: 'utf-8', timeout: 5000 },
    );
    return raw.trim();
  } catch {
    return '(file tree unavailable)';
  }
}

function collectKeyTypes(cwd: string, maxLines = 50): string {
  try {
    const raw = execSync(
      `grep -rn "^export \\(interface\\|type\\|enum\\)" --include="*.ts" . | grep -v node_modules | grep -v dist | head -${maxLines}`,
      { cwd, encoding: 'utf-8', timeout: 5000 },
    );
    return raw.trim();
  } catch {
    return '(type signatures unavailable)';
  }
}

function buildPlannerContext(cwd: string): string {
  const fileTree = collectFileTree(cwd);
  const keyTypes = collectKeyTypes(cwd);
  return `\n## Codebase Context (auto-collected)\n### File tree\n\`\`\`\n${fileTree}\n\`\`\`\n### Exported types\n\`\`\`\n${keyTypes}\n\`\`\`\n`;
}

function parseJsonBlock<T>(raw: string): T {
  // Try fenced code block first
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    try { return JSON.parse(fencedMatch[1].trim()) as T; } catch { /* fall through */ }
  }

  // Try to find the outermost { ... } containing "goal" and "tasks"
  const braceStart = raw.indexOf('{');
  if (braceStart >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = braceStart; i < raw.length; i++) {
      const c = raw[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(braceStart, i + 1);
          try { return JSON.parse(candidate) as T; } catch { /* fall through */ }
          break;
        }
      }
    }
  }

  throw new Error('Planner did not return valid JSON');
}

interface PlannerRunResult {
  text: string;
  diagnostics: {
    modelId: string;
    agentModel: string;
    resolvedBaseUrl: string | null;
    providerResolveFailed: string | null;
    maxTurns: number;
    messageCount: number;
    rawLength: number;
    messages: string[];
  };
}

async function runClaudePlanner(prompt: string, cwd: string, modelId: string): Promise<PlannerRunResult> {
  const { safeQuery, extractTextFromMessages } = await import('../orchestrator/sdk-query-safe.js');
  const { buildSdkEnv } = await import('../orchestrator/project-paths.js');

  // Use original model ID — MMS gateway requires exact model name
  const agentModel = modelId;

  let env: Record<string, string>;
  let resolvedBaseUrl: string | null = null;
  let providerResolveFailed: string | null = null;

  try {
    const resolved = resolveProviderForModel(modelId);
    resolvedBaseUrl = resolved.baseUrl;
    env = buildSdkEnv(agentModel, resolved.baseUrl, resolved.apiKey);
  } catch (err: any) {
    providerResolveFailed = err.message;
    env = buildSdkEnv(agentModel);
  }

  const maxTurns = 3;
  const result = await safeQuery({
    prompt,
    options: { cwd, maxTurns, env },
  });

  const text = extractTextFromMessages(result.messages);

  // Diagnostics: summarize message types and content preview
  const msgSummary = result.messages.map((m: any, i: number) => {
    const type = m.type || '?';
    let preview = '';
    if (type === 'assistant') {
      const content = m.message?.content;
      if (Array.isArray(content)) {
        preview = content.map((b: any) => `${b.type}(${(b.text || b.name || '').slice(0, 40)})`).join('+');
      } else if (typeof content === 'string') {
        preview = content.slice(0, 60);
      }
    } else if (type === 'result') {
      preview = JSON.stringify(m).slice(0, 80);
    }
    return `[${i}] ${type}: ${preview || '(no text)'}`;
  });

  return {
    text,
    diagnostics: {
      modelId,
      agentModel,
      resolvedBaseUrl,
      providerResolveFailed,
      maxTurns,
      messageCount: result.messages.length,
      rawLength: text.length,
      messages: msgSummary,
    },
  };
}

// 工具 1: plan_tasks - 接受中文或英文输入
server.tool(
  'plan_tasks',
  'Plan tasks from a goal.',
  {
    goal: z.string().describe('Goal in Chinese or English'),
    cwd: z.string().describe('Working directory').optional(),
  },
  async ({ goal, cwd }) => {
    const registry = new ModelRegistry();
    const effectiveCwd = cwd || process.cwd();
    const config = loadConfig(effectiveCwd);
    const plannerModel = resolveTierModel(
      config.tiers.planner.model,
      () => registry.selectForPlanning(),
      registry,
      'planning',
    );

    // 检测语言（ASCII > 70% → 英文，否则中文）
    const asciiRatio = goal.split('').filter(c => c.charCodeAt(0) < 128).length / goal.length;
    let englishGoal = goal;
    let translationResult: TranslationResult | null = null;

    if (asciiRatio <= 0.7) {
      // 中文输入，需要翻译
      const translatorModel = resolveTierModel(
        config.tiers.translator.model,
        () => registry.selectTranslator(),
        registry,
        'translation',
      );
      const modelInfo = registry.get(translatorModel);
      if (!modelInfo) {
        return { content: [{ type: 'text', text: `No suitable translator model found` }] };
      }

      translationResult = await translateToEnglish(goal, translatorModel, modelInfo.provider);
      englishGoal = translationResult.english;
    }

    // 构建 Claude prompt（注入代码库上下文）
    const plannerContext = buildPlannerContext(effectiveCwd);
    const claudePrompt = `${PLAN_PROMPT_TEMPLATE}${plannerContext}\nUser goal: ${englishGoal}`;
    let plannerOutput = '';
    let plan: TaskPlan | null = null;
    let plannerFallbackPrompt: string | null = null;

    let plannerDiagnostics: PlannerRunResult['diagnostics'] | null = null;
    let plannerError: string | null = null;
    try {
      const plannerResult = await runClaudePlanner(claudePrompt, effectiveCwd, plannerModel);
      plannerOutput = plannerResult.text;
      plannerDiagnostics = plannerResult.diagnostics;
      const parsedPlannerOutput = parseJsonBlock<{ goal: string; tasks: unknown[] }>(plannerOutput);
      plan = buildPlanFromClaudeOutput(parsedPlannerOutput);
      plan.cwd = effectiveCwd;
    } catch (err: any) {
      plannerError = err.message;
      plannerFallbackPrompt = claudePrompt;
    }

    if (plan) {
      for (const task of plan.tasks) {
        task.assigned_model = registry.assignModel(task);
        task.assignment_reason = `Assigned by registry for ${task.complexity} ${task.category} task`;
      }
    }

    // Plan discuss (when configured)
    let planDiscussResult: PlanDiscussResult | null = null;
    let discussDiag: DiscussPlanDiag | null = null;
    const discussMode = config.tiers.discuss?.mode || 'auto';
    let discussSkipReason: string | null = null;
    if (!plan) {
      discussSkipReason = 'no plan generated';
    } else if (discussMode !== 'always') {
      discussSkipReason = `discuss.mode="${discussMode}" (need "always")`;
    } else {
      const { discussPlan } = await import('../orchestrator/discuss-bridge.js');
      const dr = await discussPlan(plan, plannerModel, config, registry);
      planDiscussResult = dr.result;
      discussDiag = dr.diag;
    }

    const budgetWarning = getBudgetWarning(config);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          plan,
          plan_discuss: planDiscussResult,
          discuss_debug: planDiscussResult ? undefined : {
            mode: discussMode,
            skip_reason: discussSkipReason,
            config_tiers_discuss: config.tiers.discuss,
            discuss_diag: discussDiag,
          },
          translation: translationResult,
          planner_model: plannerModel,
          planner_prompt: plannerFallbackPrompt,
          planner_diagnostics: plannerDiagnostics,
          planner_error: plannerError,
          planner_raw_output: plan ? undefined : plannerOutput?.slice(0, 500),
          budget_warning: budgetWarning,
        }, null, 2),
      }],
    };
  }
);

// 工具 2: execute_plan
server.tool(
  'execute_plan',
  'Execute a task plan.',
  {
    plan_json: z.string().describe('TaskPlan JSON'),
    report_language: z.enum(['zh', 'en']).default('zh'),
    resume_plan_id: z.string().describe('Plan ID to resume from checkpoint').optional(),
  },
  async ({ plan_json, report_language, resume_plan_id }) => {
    const plan: TaskPlan = JSON.parse(plan_json);
    const registry = new ModelRegistry();
    const config = loadConfig(plan.cwd);

    const dispatchResult = await dispatchBatch(plan, registry, resume_plan_id, { recordBudget: false });

    // 执行 review cascade
    const reviewResults = await Promise.all(
      dispatchResult.worker_results.map((workerResult) => {
        const task = plan.tasks.find((item) => item.id === workerResult.taskId);
        if (!task) {
          throw new Error(`Task not found for worker result: ${workerResult.taskId}`);
        }
        return reviewCascade(workerResult, task, plan, registry);
      }),
    );

    // Auto-merge: commit and merge passed worktrees
    const { commitAndMergeWorktree } = await import('../orchestrator/worktree-manager.js');
    const mergeResults: Array<{ taskId: string; merged: boolean; error?: string }> = [];
    for (const review of reviewResults) {
      const wr = dispatchResult.worker_results.find(w => w.taskId === review.taskId);
      if (!wr?.branch) continue; // no worktree used
      if (review.passed) {
        const task = plan.tasks.find(t => t.id === wr.taskId);
        const msg = `task ${wr.taskId}: ${task?.description.slice(0, 80) || wr.taskId}`;
        const mr = commitAndMergeWorktree(wr.worktreePath, wr.branch, msg);
        mergeResults.push({ taskId: wr.taskId, ...mr });
      } else {
        mergeResults.push({ taskId: wr.taskId, merged: false, error: 'review not passed — worktree kept for inspection' });
      }
    }

    const orchestratorResult: OrchestratorResult = {
      plan,
      worker_results: dispatchResult.worker_results,
      review_results: reviewResults,
      score_updates: [],
      total_duration_ms: dispatchResult.worker_results.reduce((sum, worker) => sum + worker.duration_ms, 0),
      cost_estimate: (() => {
        let opusTok = 0, sonnetTok = 0, haikuTok = 0, domesticTok = 0, costUsd = 0;
        for (const wr of dispatchResult.worker_results) {
          const total = wr.token_usage.input + wr.token_usage.output;
          const cap = registry.get(wr.model);
          if (wr.model.includes('opus')) opusTok += total;
          else if (wr.model.includes('sonnet')) sonnetTok += total;
          else if (wr.model.includes('haiku')) haikuTok += total;
          else domesticTok += total;
          if (cap) {
            costUsd += (wr.token_usage.input * (cap.cost_per_mtok_input || 0)
                      + wr.token_usage.output * (cap.cost_per_mtok_output || 0)) / 1_000_000;
          }
        }
        return { opus_tokens: opusTok, sonnet_tokens: sonnetTok, haiku_tokens: haikuTok, domestic_tokens: domesticTok, estimated_cost_usd: costUsd };
      })()
    };

    // Build token breakdown
    const stages: StageTokenUsage[] = [];

    // Worker stages
    for (const wr of dispatchResult.worker_results) {
      stages.push({
        stage: `worker:${wr.taskId}`,
        model: wr.model,
        input_tokens: wr.token_usage.input,
        output_tokens: wr.token_usage.output,
      });
    }

    // Review stages (collected by reviewCascade)
    for (const rr of reviewResults) {
      if (rr.token_stages) stages.push(...rr.token_stages);
    }

    // Calculate totals and claude savings
    const totalInput = stages.reduce((s, t) => s + t.input_tokens, 0);
    const totalOutput = stages.reduce((s, t) => s + t.output_tokens, 0);

    // Actual cost from domestic models
    let actualCost = 0;
    for (const st of stages) {
      const cap = registry.get(st.model);
      if (cap) {
        actualCost += (st.input_tokens * (cap.cost_per_mtok_input || 0)
                     + st.output_tokens * (cap.cost_per_mtok_output || 0)) / 1_000_000;
      }
    }

    // Claude equivalent: what it would cost using Sonnet for everything
    const sonnetTier = registry.getClaudeTier('sonnet');
    const sonnetCostPer1k = sonnetTier?.cost_per_1k || 0.003;
    const claudeEquivalent = (totalInput + totalOutput) * sonnetCostPer1k / 1000;

    orchestratorResult.token_breakdown = {
      stages,
      total_input: totalInput,
      total_output: totalOutput,
      actual_cost_usd: actualCost,
      claude_equivalent_usd: claudeEquivalent,
      savings_usd: claudeEquivalent - actualCost,
    };
    const budgetStatus = recordSpending(plan.cwd, actualCost);
    orchestratorResult.budget_status = budgetStatus ?? undefined;
    orchestratorResult.budget_warning = budgetStatus?.warning ?? null;

    // Persist final result to disk
    const { saveFinalResult } = await import('../orchestrator/result-store.js');
    saveFinalResult(plan.id, plan.cwd, orchestratorResult);

    // Resolve reporter model from tiers config
    const reporterModel = resolveTierModel(
      config.tiers.reporter.model,
      () => registry.selectForReporter(),
      registry,
      'general',
    );
    const reporterInfo = registry.get(reporterModel);
    const reporterProvider = reporterInfo?.provider || reporterModel;

    const report = await reportResults(
      orchestratorResult,
      reporterModel,
      reporterProvider,
      { language: report_language, format: 'summary', target: 'stdout' }
    );

    // Append merge summary
    const mergeSummary = mergeResults.length > 0
      ? '\n\n## Worktree Merge\n' + mergeResults.map(m =>
          `- ${m.taskId}: ${m.merged ? '✅ merged' : `❌ ${m.error}`}`
        ).join('\n')
      : '';
    const budgetSummary = orchestratorResult.budget_status
      ? `\n\n## Budget\n- Spent: $${orchestratorResult.budget_status.current_spent_usd.toFixed(4)} / $${orchestratorResult.budget_status.monthly_limit_usd.toFixed(2)}\n- Remaining: $${orchestratorResult.budget_status.remaining_usd.toFixed(4)}\n${orchestratorResult.budget_warning ? `- Warning: ${orchestratorResult.budget_warning}\n` : ''}`
      : '';

    return { content: [{ type: 'text', text: report + mergeSummary + budgetSummary }] };
  }
);

// 工具 3: dispatch_single
server.tool(
  'dispatch_single',
  'Dispatch one task.',
  {
    task_id: z.string().describe('Task ID'),
    prompt: z.string().describe('Full task prompt with context'),
    model: z.string().describe('Model ID'),
    provider: z.string().describe('Provider ID').optional(),
    cwd: z.string().describe('Working directory').optional(),
    worktree: z.boolean().describe('Run in isolated git worktree').default(false),
    discuss_threshold: z.number().describe('Confidence threshold for discussion trigger').default(0.7),
  },
  async ({ task_id, prompt, model, provider, cwd, worktree, discuss_threshold }) => {
    if (!prompt || prompt.trim().length < 5) {
      return {
        content: [{ type: 'text', text: '## dispatch_single error\n\n**error**: prompt is empty or too short. Provide a full task description with context.' }],
        isError: true,
      };
    }

    try {
      // Preflight: quickPing before spawning
      let actualModel = model;
      let preflightFallback: string | null = null;
      const ping = await quickPing(model);
      if (!ping.ok) {
        const registry = new ModelRegistry();
        const config = loadConfig(cwd || process.cwd());
        const fb = resolveFallback(model, 'server_error', {
          id: task_id, description: prompt.slice(0, 200), complexity: 'medium',
          category: 'general', assigned_model: model, assignment_reason: '',
          estimated_files: [], acceptance_criteria: [],
          discuss_threshold: discuss_threshold, depends_on: [], review_scale: 'auto',
        }, config, registry);
        console.log(`  🔄 Preflight: ${model} unhealthy (${ping.error}), using ${fb}`);
        preflightFallback = `${model} → ${fb} (${ping.error})`;
        actualModel = fb;
      }

      const result = await spawnWorker({
        taskId: task_id,
        model: actualModel,
        provider: provider || '',
        prompt,
        cwd: cwd || process.cwd(),
        worktree: worktree ?? false,
        contextInputs: [],
        discussThreshold: discuss_threshold,
        maxTurns: 25,
      });

      // Record spending for single dispatch
      const spendRegistry = new ModelRegistry();
      const cap = spendRegistry.get(result.model);
      if (cap) {
        const cost = (result.token_usage.input * (cap.cost_per_mtok_input || 0)
                    + result.token_usage.output * (cap.cost_per_mtok_output || 0)) / 1_000_000;
        if (cost > 0) {
          const { recordSpending } = await import('../orchestrator/hive-config.js');
          recordSpending(cwd || process.cwd(), cost);
        }
      }

      const output = { ...result, preflight_fallback: preflightFallback };
      return { content: [{ type: 'text', text: JSON.stringify(output) }] };
    } catch (err: any) {
      return {
        content: [{
          type: 'text',
          text: `## dispatch_single error\n\n**model**: ${model}\n**task_id**: ${task_id}\n**error**: ${err.message}\n**stack**: ${err.stack?.split('\n').slice(0, 5).join('\n')}`,
        }],
        isError: true,
      };
    }
  }
);

// 工具 4: diagnostics — 合并 health_check / debug_env / model_scores / translate / ping_model
import { buildSdkEnv } from '../orchestrator/project-paths.js';
import { resolveModelRoute } from '../orchestrator/mms-routes-loader.js';
import Anthropic from '@anthropic-ai/sdk';

// ── Shared URL helpers ──
function stripTrailingV1(url: string): string {
  return url.replace(/\/v1\/?$/, '');
}

server.tool(
  'diagnostics',
  'Run diagnostic actions.',
  {
    action: z.enum(['health', 'env', 'scores', 'translate', 'ping']).describe('Action'),
    input: z.string().optional().describe('For translate: text; for ping: model ID'),
  },
  async ({ action, input }) => {
    if (action === 'health') {
      let healthText = '## Provider Health Check\n\n';

      // MMS routes check
      const mmsAvailable = isMmsAvailable();
      healthText += `**MMS routes**: ${mmsAvailable ? 'loaded' : 'not found'}\n`;
      healthText += `**Resolution**: MMS routes → providers.json fallback\n\n`;

      if (mmsAvailable) {
        const table = loadMmsRoutes()!;
        const modelIds = Object.keys(table.routes);
        healthText += `### MMS Models (${modelIds.length})\n`;
        for (const modelId of modelIds) {
          const route = table.routes[modelId];
          const urlPreview = route.anthropic_base_url.replace(/https?:\/\//, '').slice(0, 40);
          const hasKey = route.api_key ? 'key-set' : 'NO-KEY';
          healthText += `- ${modelId}: ${urlPreview} (${hasKey}, p${route.priority})\n`;
        }
        healthText += '\n';

        // Live ping: 1 representative per provider_id + all tier-critical models
        const config = loadConfig(process.cwd());
        const tierModels = new Set<string>();
        // Collect models referenced in tiers config
        const tm = config.tiers;
        for (const m of [tm.planner?.model, tm.translator?.model, tm.reporter?.model,
          tm.executor?.model, tm.reviewer?.cross_review?.model,
          tm.reviewer?.arbitration?.model, tm.reviewer?.final_review?.model]) {
          if (m && m !== 'auto') tierModels.add(m);
        }
        const dm = tm.discuss?.model;
        if (dm) { for (const m of (Array.isArray(dm) ? dm : [dm])) { if (m !== 'auto') tierModels.add(m); } }
        // Also add default_worker and fallback
        if (config.default_worker) tierModels.add(config.default_worker);

        const seenProviders = new Set<string>();
        const pingTargets: Array<{ modelId: string; route: typeof table.routes[string]; reason: string }> = [];
        // First: add tier-critical models (always ping these)
        for (const id of tierModels) {
          const route = table.routes[id];
          if (!route) continue;
          pingTargets.push({ modelId: id, route, reason: 'tier' });
          const pKey = route.provider_id || route.anthropic_base_url;
          seenProviders.add(pKey);
        }
        // Then: add 1 representative per remaining provider_id
        for (const [id, route] of Object.entries(table.routes)) {
          if (id.startsWith('claude-')) continue;
          const pKey = route.provider_id || route.anthropic_base_url;
          if (seenProviders.has(pKey)) continue;
          seenProviders.add(pKey);
          pingTargets.push({ modelId: id, route, reason: 'provider-rep' });
        }

        healthText += `### Live Ping (${pingTargets.length} providers, 15s timeout)\n`;
        const PING_TIMEOUT = 15_000;
        const pingResults = await Promise.all(
          pingTargets.map(async ({ modelId, route }) => {
            const urlShort = route.anthropic_base_url.replace(/https?:\/\//, '').slice(0, 50);
            const start = Date.now();
            try {
              const resp = await fetch(stripTrailingV1(route.anthropic_base_url) + '/v1/messages', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-api-key': route.api_key,
                  'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                  model: modelId,
                  max_tokens: 5,
                  stream: true,
                  messages: [{ role: 'user', content: 'ping' }],
                }),
                signal: AbortSignal.timeout(PING_TIMEOUT),
              });
              const elapsed = Date.now() - start;
              // 200/201 = healthy, 4xx = endpoint exists but model/auth issue
              const ok = resp.status >= 200 && resp.status < 300;
              const icon = ok ? '✅' : resp.status < 500 ? '⚠️' : '❌';
              return { modelId, url: urlShort, status: `${icon} ${resp.status} (${elapsed}ms)`, provider: route.provider_id || '?' };
            } catch (err: any) {
              const elapsed = Date.now() - start;
              const reason = elapsed >= PING_TIMEOUT ? 'TIMEOUT' : err.message?.slice(0, 50);
              return { modelId, url: urlShort, status: `❌ ${reason} (${elapsed}ms)`, provider: route.provider_id || '?' };
            }
          }),
        );

        for (const r of pingResults) {
          healthText += `- **${r.modelId}** → ${r.url} [${r.provider}] ${r.status}\n`;
        }
        healthText += '\n';
      }

      // Static providers check
      const providers = Object.keys(getAllProviders());
      if (providers.length > 0) {
        healthText += `### Static Providers (${providers.length})\n`;
        for (const provider of providers) {
          const healthy = await checkProviderHealth(provider);
          healthText += `- ${provider}: ${healthy ? 'OK' : 'UNAVAILABLE'}\n`;
        }
      }

      return { content: [{ type: 'text', text: healthText }] };
    }

    if (action === 'env') {
      const keys = [
        'HOME', 'USER', 'PATH',
        'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
        'MMS_ROUTES_PATH',
      ];
      let text = '## MCP Server Environment\n\n';
      text += `**pid**: ${process.pid}\n`;
      text += `**cwd**: ${process.cwd()}\n`;
      text += `**node**: ${process.version}\n\n`;

      text += '### Key Env Vars\n';
      for (const key of keys) {
        const val = process.env[key];
        if (!val) {
          text += `- ${key}: (not set)\n`;
        } else if (key.includes('TOKEN') || key.includes('KEY')) {
          text += `- ${key}: ${val.slice(0, 6)}...${val.slice(-4)} (${val.length} chars)\n`;
        } else if (key === 'PATH') {
          text += `- ${key}: ${val.slice(0, 80)}...\n`;
        } else {
          text += `- ${key}: ${val}\n`;
        }
      }

      text += '\n### MMS Routes File\n';
      const mmsTable = loadMmsRoutes();
      if (mmsTable) {
        text += `- Loaded: ${Object.keys(mmsTable.routes).length} models\n`;
        text += `- Models: ${Object.keys(mmsTable.routes).join(', ')}\n`;
      } else {
        text += '- NOT FOUND\n';
      }

      return { content: [{ type: 'text', text }] };
    }

    if (action === 'scores') {
      const registry = new ModelRegistry();
      const models = registry.getResolvable() as any[];

      let scoresText = "## Model Capability Scores\n";
      scoresText += "| Model | Coding | Reasoning | Chinese | Pass Rate |\n";
      scoresText += "|-------|--------|-----------|---------|-----------|\n";
      for (const model of models) {
        scoresText += `| ${model.id} | ${model.coding.toFixed(2)} | ${model.reasoning.toFixed(2)} | ${model.chinese.toFixed(2)} | ${model.pass_rate.toFixed(2)} |\n`;
      }

      return { content: [{ type: 'text', text: scoresText }] };
    }

    if (action === 'translate') {
      const registry = new ModelRegistry();
      const translatorModel = registry.selectTranslator();
      const modelInfo = registry.get(translatorModel);
      if (!modelInfo) {
        return { content: [{ type: 'text', text: `Unknown model: ${translatorModel}` }] };
      }
      const result = await translateToEnglish(input || '', translatorModel, modelInfo.provider);
      return {
        content: [{
          type: 'text',
          text: `## Translation (${result.translator_model}, confidence: ${result.confidence.toFixed(2)})\n\n${result.english}\n\n_Duration: ${result.duration_ms}ms_`,
        }],
      };
    }

    // action === 'ping'
    const pingModel = input || '';
    const pingPrompt = 'Reply with exactly: PONG';
    const startTime = Date.now();
    try {
      const mmsRoute = resolveModelRoute(pingModel);
      const baseUrl = mmsRoute?.anthropic_base_url
        || process.env.ANTHROPIC_BASE_URL || '';
      const apiKey = mmsRoute?.api_key
        || process.env.ANTHROPIC_AUTH_TOKEN || '';

      const client = new Anthropic({
        apiKey: apiKey || 'dummy',
        baseURL: stripTrailingV1(baseUrl) || undefined,
      });

      const response = await client.messages.create({
        model: pingModel,
        max_tokens: 256,
        messages: [{ role: 'user', content: pingPrompt }],
        stream: true,
      });

      let output = '';
      for await (const event of response) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          output += event.delta.text;
        }
      }

      const duration = Date.now() - startTime;
      const debug = {
        baseUrl: baseUrl?.slice(0, 50),
        tokenPrefix: apiKey?.slice(0, 8),
        source: mmsRoute ? 'mms-route' : 'process-env',
      };

      return {
        content: [{
          type: 'text',
          text: `## ping_model OK\n\n**model**: ${pingModel}\n**duration**: ${duration}ms\n**response**: ${output.slice(0, 500)}\n\n**routing debug**: ${JSON.stringify(debug, null, 2)}`,
        }],
      };
    } catch (err: any) {
      const duration = Date.now() - startTime;
      return {
        content: [{
          type: 'text',
          text: `## ping_model FAILED\n\n**model**: ${pingModel}\n**duration**: ${duration}ms\n**error**: ${err.message}`,
        }],
        isError: true,
      };
    }
  }
);

// 工具 5: report
server.tool(
  'report',
  'Generate report.',
  {
    result_json: z.string().describe('OrchestratorResult JSON'),
    format: z.enum(['summary', 'detailed']).default('summary'),
  },
  async ({ result_json, format }) => {
    const result = JSON.parse(result_json);
    const config = loadConfig(process.cwd());
    const registry = new ModelRegistry();
    const reporterModel = resolveTierModel(
      config.tiers.reporter.model,
      () => registry.selectForReporter(),
      registry,
      'general',
    );
    const reporterInfo = registry.get(reporterModel);
    const reporterProvider = reporterInfo?.provider || reporterModel;

    const report = await reportResults(result, reporterModel, reporterProvider, {
      language: 'zh', format, target: 'stdout',
    });
    return { content: [{ type: 'text', text: report }] };
  }
);

// ── Autoloop tools ──

server.tool(
  'run_goal',
  'Run a full autonomous loop: plan → dispatch → review → verify → repair/replan → done.',
  {
    goal: z.string().describe('Goal in Chinese or English'),
    cwd: z.string().describe('Working directory').optional(),
    mode: z.enum(['safe', 'balanced', 'aggressive']).default('safe'),
    max_rounds: z.number().describe('Max loop rounds').default(6),
    auto_merge: z.boolean().describe('Auto-merge passed worktrees').default(false),
  },
  async ({ goal, cwd, mode, max_rounds, auto_merge }) => {
    const { runGoal } = await import('../orchestrator/driver.js');
    const effectiveCwd = cwd || process.cwd();
    try {
      const execution = await runGoal({
        goal, cwd: effectiveCwd, mode,
        maxRounds: max_rounds, allowAutoMerge: auto_merge,
      });
      const { spec, state, plan } = execution;
      const taskSummary = plan
        ? plan.tasks.map(t => `- ${t.id}: ${t.description.slice(0, 80)} [${t.assigned_model}]${t.verification_profile ? ` {rule:${t.verification_profile}}` : ''}`).join('\n')
        : '(no plan)';
      const verificationSummary = state.verification_results
        .map(v => `- [${v.passed ? '✅' : '❌'}] ${v.target.label}${v.failure_class ? ` (${v.failure_class})` : ''}`)
        .join('\n');
      const taskVerificationSummary = Object.entries(state.task_verification_results || {})
        .filter(([, results]) => results.length > 0)
        .map(([taskId, results]) => {
          const failed = results.filter((result) => result.target.must_pass && !result.passed).length;
          return `- ${taskId}: ${results.length} checks${failed > 0 ? `, ${failed} failed` : ''}`;
        })
        .join('\n');
      let text = `## Run Complete: ${spec.id}\n\n`;
      text += `**Status**: ${state.status}\n`;
      text += `**Rounds**: ${state.round}/${spec.max_rounds}\n`;
      text += `**Mode**: ${spec.mode}\n\n`;
      text += `### Tasks\n${taskSummary}\n\n`;
      if (verificationSummary) text += `### Verification\n${verificationSummary}\n\n`;
      if (taskVerificationSummary) text += `### Task Verification\n${taskVerificationSummary}\n\n`;
      if (execution.result?.token_breakdown) {
        text += `### Cost\n`;
        text += `- Actual: $${execution.result.token_breakdown.actual_cost_usd.toFixed(4)}\n`;
        text += `- Claude equivalent: $${execution.result.token_breakdown.claude_equivalent_usd.toFixed(4)}\n`;
        text += `- Savings: $${execution.result.token_breakdown.savings_usd.toFixed(4)}\n\n`;
      }
      if (state.budget_status) {
        text += `### Budget\n`;
        text += `- Spent: $${state.budget_status.current_spent_usd.toFixed(4)} / $${state.budget_status.monthly_limit_usd.toFixed(2)}\n`;
        text += `- Remaining: $${state.budget_status.remaining_usd.toFixed(4)}\n`;
        if (state.budget_warning) {
          text += `- Warning: ${state.budget_warning}\n`;
        }
        text += `\n`;
      }
      text += `### Next Action\n**${state.next_action?.kind}**: ${state.next_action?.reason}\n\n`;
      if (state.final_summary) text += `### Summary\n${state.final_summary}\n`;
      return { content: [{ type: 'text', text }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `## run_goal error\n\n**error**: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'resume_run',
  'Resume a saved run. Default: read-only restore. Set execute=true to re-enter the loop.',
  {
    run_id: z.string().describe('Run ID (e.g. run-1775011220354)'),
    cwd: z.string().describe('Working directory').optional(),
    execute: z.boolean().describe('Re-enter execution loop').default(false),
  },
  async ({ run_id, cwd, execute }) => {
    const { resumeRun } = await import('../orchestrator/driver.js');
    const execution = await resumeRun(cwd || process.cwd(), run_id, { execute });
    if (!execution) {
      return { content: [{ type: 'text', text: `## resume_run error\n\nRun not found: ${run_id}` }], isError: true };
    }
    const { spec, state } = execution;
    let text = `## Run ${execute ? 'Resumed' : 'Restored'}: ${spec.id}\n\n`;
    text += `**Status**: ${state.status}\n**Rounds**: ${state.round}/${spec.max_rounds}\n**Goal**: ${spec.goal}\n\n`;
    const taskVerificationSummary = Object.entries(state.task_verification_results || {})
      .filter(([, results]) => results.length > 0)
      .map(([taskId, results]) => {
        const failed = results.filter((result) => result.target.must_pass && !result.passed).length;
        return `- ${taskId}: ${results.length} checks${failed > 0 ? `, ${failed} failed` : ''}`;
      })
      .join('\n');
    if (taskVerificationSummary) {
      text += `### Task Verification\n${taskVerificationSummary}\n\n`;
    }
    text += `### Next Action\n**${state.next_action?.kind}**: ${state.next_action?.reason}\n`;
    if (state.final_summary) text += `\n### Summary\n${state.final_summary}\n`;
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'run_status',
  'List all runs or get details of a specific run.',
  {
    run_id: z.string().describe('Specific run ID to inspect').optional(),
    cwd: z.string().describe('Working directory').optional(),
  },
  async ({ run_id, cwd }) => {
    const { listRuns, loadRunPlan, loadRunResult, loadRunSpec, loadRunState } = await import('../orchestrator/run-store.js');
    const effectiveCwd = cwd || process.cwd();
    if (run_id) {
      const spec = loadRunSpec(effectiveCwd, run_id);
      const state = loadRunState(effectiveCwd, run_id);
      if (!spec || !state) {
        return { content: [{ type: 'text', text: `## run_status error\n\nRun not found: ${run_id}` }], isError: true };
      }
      const plan = loadRunPlan(effectiveCwd, run_id);
      const result = loadRunResult(effectiveCwd, run_id);
      let text = `## Run: ${run_id}\n\n`;
      text += `**Status**: ${state.status}\n**Goal**: ${spec.goal}\n**Mode**: ${spec.mode}\n`;
      text += `**Rounds**: ${state.round}/${spec.max_rounds}\n`;
      text += `**Plan tasks**: ${plan?.tasks.length || 0}\n`;
      text += `**Completed**: ${state.completed_task_ids.join(', ') || 'none'}\n`;
      text += `**Failed**: ${state.failed_task_ids.join(', ') || 'none'}\n`;
      text += `**Merged**: ${state.merged_task_ids?.join(', ') || 'none'}\n`;
      text += `**Result saved**: ${result ? 'yes' : 'no'}\n`;
      const profiledTasks = plan?.tasks.filter((task) => task.verification_profile) || [];
      if (profiledTasks.length > 0) {
        text += `**Task rules**: ${profiledTasks.map((task) => `${task.id}:${task.verification_profile}`).join(', ')}\n`;
      }
      if (result?.token_breakdown) {
        text += `**Actual cost**: $${result.token_breakdown.actual_cost_usd.toFixed(4)}\n`;
        text += `**Savings vs Claude**: $${result.token_breakdown.savings_usd.toFixed(4)}\n`;
      }
      if (state.budget_status) {
        text += `**Budget spent**: $${state.budget_status.current_spent_usd.toFixed(4)} / $${state.budget_status.monthly_limit_usd.toFixed(2)}\n`;
        text += `**Budget remaining**: $${state.budget_status.remaining_usd.toFixed(4)}\n`;
      } else {
        const budgetStatus = getBudgetStatus(loadConfig(effectiveCwd));
        if (budgetStatus) {
          text += `**Budget spent**: $${budgetStatus.current_spent_usd.toFixed(4)} / $${budgetStatus.monthly_limit_usd.toFixed(2)}\n`;
          text += `**Budget remaining**: $${budgetStatus.remaining_usd.toFixed(4)}\n`;
        }
      }
      if (state.budget_warning) {
        text += `**Budget warning**: ${state.budget_warning}\n`;
      }
      if (state.final_summary) text += `\n**Summary**: ${state.final_summary}\n`;
      const taskVerificationSummary = Object.entries(state.task_verification_results || {})
        .filter(([, results]) => results.length > 0)
        .map(([taskId, results]) => {
          const failed = results.filter((result) => result.target.must_pass && !result.passed).length;
          return `- ${taskId}: ${results.length} checks${failed > 0 ? `, ${failed} failed` : ''}`;
        })
        .join('\n');
      if (taskVerificationSummary) {
        text += `\n### Task Verification\n${taskVerificationSummary}\n`;
      }
      text += `\n### Next Action\n**${state.next_action?.kind}**: ${state.next_action?.reason}\n`;
      return { content: [{ type: 'text', text }] };
    }
    const runs = listRuns(effectiveCwd);
    if (runs.length === 0) {
      return { content: [{ type: 'text', text: '## Runs\n\nNo runs found.' }] };
    }
    let text = `## Runs (${runs.length})\n\n| ID | Status | Goal |\n|-----|--------|------|\n`;
    for (const run of runs) {
      text += `| ${run.id} | ${run.state?.status || '?'} | ${run.spec?.goal?.slice(0, 60) || '(no goal)'} |\n`;
    }
    return { content: [{ type: 'text', text }] };
  },
);

export default server;

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isMainModule = process.argv[1]?.includes('mcp-server/index');
if (isMainModule) {
  main().catch((error) => {
    console.error('Hive MCP server failed:', error);
    process.exit(1);
  });
}
