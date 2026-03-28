import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { execSync } from 'child_process';
import type { TaskPlan, TranslationResult, OrchestratorResult, PlanDiscussResult } from '../orchestrator/types.js';
import type { DiscussPlanDiag } from '../orchestrator/discuss-bridge.js';
import { buildPlanFromClaudeOutput, PLAN_PROMPT_TEMPLATE } from '../orchestrator/planner.js';
import { translateToEnglish } from '../orchestrator/translator.js';
import { reportResults } from '../orchestrator/reporter.js';
import { spawnWorker, dispatchBatch } from '../orchestrator/dispatcher.js';
import { reviewCascade } from '../orchestrator/reviewer.js';
import { ModelRegistry } from '../orchestrator/model-registry.js';
import { checkProviderHealth, getAllProviders, resolveProviderForModel, quickPing } from '../orchestrator/provider-resolver.js';
import { isMmsAvailable, loadMmsRoutes } from '../orchestrator/mms-routes-loader.js';
import { getBudgetWarning, loadConfig, resolveTierModel, resolveFallback } from '../orchestrator/hive-config.js';
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
  'Break down a goal into executable tasks with model assignments.',
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
  'Execute a task plan and return results.',
  {
    plan_json: z.string().describe('TaskPlan JSON'),
    report_language: z.enum(['zh', 'en']).default('zh'),
  },
  async ({ plan_json, report_language }) => {
    const plan: TaskPlan = JSON.parse(plan_json);
    const registry = new ModelRegistry();
    const config = loadConfig(plan.cwd);

    const dispatchResult = await dispatchBatch(plan, registry);

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

    const orchestratorResult: OrchestratorResult = {
      plan,
      worker_results: dispatchResult.worker_results,
      review_results: reviewResults,
      score_updates: [],
      total_duration_ms: dispatchResult.worker_results.reduce((sum, worker) => sum + worker.duration_ms, 0),
      cost_estimate: {
        opus_tokens: 0,
        sonnet_tokens: 0,
        haiku_tokens: 0,
        domestic_tokens: dispatchResult.worker_results.reduce(
          (sum, worker) => sum + worker.token_usage.input + worker.token_usage.output,
          0,
        ),
        estimated_cost_usd: 0
      }
    };

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

    return { content: [{ type: 'text', text: report }] };
  }
);

// 工具 3: dispatch_single
server.tool(
  'dispatch_single',
  'Dispatch a single task to a specific model.',
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

// 工具 4: health_check
server.tool(
  'health_check',
  'Check health of all providers and MMS routes.',
  {},
  async () => {
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
);

// 工具 4b: debug_env — 诊断 MCP 进程环境
server.tool(
  'debug_env',
  'Show MCP server process environment for debugging.',
  {},
  async () => {
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
);

// 工具 5: model_scores
server.tool(
  'model_scores',
  'Display model capability scores.',
  {},
  async () => {
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
);

// 工具 6: translate
server.tool(
  'translate',
  'Translate Chinese natural language input to a clean English prompt for Claude.',
  {
    input: z.string().describe('Chinese natural language input from user'),
    model: z.string().describe('Translator model ID (e.g., kimi-for-coding)').optional(),
  },
  async ({ input, model }) => {
    const registry = new ModelRegistry();
    const translatorModel = model || registry.selectTranslator();
    const modelInfo = registry.get(translatorModel);
    if (!modelInfo) {
      return { content: [{ type: 'text', text: `Unknown model: ${translatorModel}` }] };
    }

    const result = await translateToEnglish(input, translatorModel, modelInfo.provider);
    return {
      content: [{
        type: 'text',
        text: `## Translation (${result.translator_model}, confidence: ${result.confidence.toFixed(2)})\n\n${result.english}\n\n_Duration: ${result.duration_ms}ms_`,
      }],
    };
  }
);

// 工具 7: report
server.tool(
  'report',
  'Generate a Chinese summary report from orchestration results.',
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

// ── Shared URL helpers ──
function stripTrailingV1(url: string): string {
  return url.replace(/\/v1\/?$/, '');
}

// 工具 8: ping_model — 最小化直接 API 调用诊断
import { buildSdkEnv } from '../orchestrator/project-paths.js';
import { resolveModelRoute } from '../orchestrator/mms-routes-loader.js';
import Anthropic from '@anthropic-ai/sdk';

server.tool(
  'ping_model',
  'Minimal SDK query() test — no worktree, no dispatch logic. Just call a model and return the response.',
  {
    model: z.string().describe('Model ID (e.g., kimi-for-coding, claude-haiku-4-5-20251001)'),
    prompt: z.string().describe('Simple prompt to test').default('Reply with exactly: PONG'),
  },
  async ({ model, prompt }) => {
    const startTime = Date.now();
    try {
      // Resolve endpoint: MMS route (per-model) → process env fallback
      const mmsRoute = resolveModelRoute(model);
      const baseUrl = mmsRoute?.anthropic_base_url
        || process.env.ANTHROPIC_BASE_URL || '';
      const apiKey = mmsRoute?.api_key
        || process.env.ANTHROPIC_AUTH_TOKEN || '';

      const client = new Anthropic({
        apiKey: apiKey || 'dummy',
        baseURL: stripTrailingV1(baseUrl) || undefined,
      });

      const response = await client.messages.create({
        model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
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
          text: `## ping_model OK\n\n**model**: ${model}\n**duration**: ${duration}ms\n**response**: ${output.slice(0, 500)}\n\n**routing debug**: ${JSON.stringify(debug, null, 2)}`,
        }],
      };
    } catch (err: any) {
      const duration = Date.now() - startTime;
      return {
        content: [{
          type: 'text',
          text: `## ping_model FAILED\n\n**model**: ${model}\n**duration**: ${duration}ms\n**error**: ${err.message}`,
        }],
        isError: true,
      };
    }
  }
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
