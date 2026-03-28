import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import type { TaskPlan, TranslationResult, OrchestratorResult } from '../orchestrator/types.js';
import { buildPlanFromClaudeOutput, PLAN_PROMPT_TEMPLATE } from '../orchestrator/planner.js';
import { translateToEnglish } from '../orchestrator/translator.js';
import { reportResults } from '../orchestrator/reporter.js';
import { spawnWorker, dispatchBatch } from '../orchestrator/dispatcher.js';
import { reviewCascade } from '../orchestrator/reviewer.js';
import { ModelRegistry } from '../orchestrator/model-registry.js';
import { checkProviderHealth, getAllProviders, resolveProviderForModel } from '../orchestrator/provider-resolver.js';
import { isMmsAvailable, loadMmsRoutes } from '../orchestrator/mms-routes-loader.js';
import { getBudgetWarning, loadConfig, resolveTierModel } from '../orchestrator/hive-config.js';

const server = new McpServer({
  name: 'hive-mcp',
  version: '1.0.0',
});

function parseJsonBlock<T>(raw: string): T {
  const fencedMatch = raw.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1] || raw.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) {
    throw new Error('Planner did not return JSON');
  }
  return JSON.parse(candidate) as T;
}

async function runClaudePlanner(prompt: string, cwd: string, modelId: string): Promise<string> {
  const { safeQuery, extractTextFromMessages } = await import('../orchestrator/sdk-query-safe.js');
  const { buildSdkEnv } = await import('../orchestrator/project-paths.js');

  // Agent alias: domestic models get claude- prefix for full agent loop
  const agentModel = modelId.startsWith('claude-') ? modelId : `claude-${modelId}`;

  let env: Record<string, string>;
  try {
    const resolved = resolveProviderForModel(modelId);
    env = buildSdkEnv(agentModel, resolved.baseUrl, resolved.apiKey);
  } catch {
    env = buildSdkEnv(agentModel);
  }

  const result = await safeQuery({
    prompt,
    options: { cwd, maxTurns: 1, env },
  });

  return extractTextFromMessages(result.messages);
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

    // 构建 Claude prompt
    const claudePrompt = `${PLAN_PROMPT_TEMPLATE}\n\nUser goal: ${englishGoal}`;
    let plannerOutput = '';
    let plan: TaskPlan | null = null;
    let plannerFallbackPrompt: string | null = null;

    try {
      plannerOutput = await runClaudePlanner(claudePrompt, effectiveCwd, plannerModel);
      const parsedPlannerOutput = parseJsonBlock<{ goal: string; tasks: unknown[] }>(plannerOutput);
      plan = buildPlanFromClaudeOutput(parsedPlannerOutput);
      plan.cwd = effectiveCwd;
    } catch {
      plannerFallbackPrompt = claudePrompt;
    }

    if (plan) {
      for (const task of plan.tasks) {
        task.assigned_model = registry.assignModel(task);
        task.assignment_reason = `Assigned by registry for ${task.complexity} ${task.category} task`;
      }
    }
    const budgetWarning = getBudgetWarning(config);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          plan,
          translation: translationResult,
          planner_model: plannerModel,
          planner_prompt: plannerFallbackPrompt,
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
      const result = await spawnWorker({
        taskId: task_id,
        model,
        provider: provider || '',
        prompt,
        cwd: cwd || process.cwd(),
        worktree: worktree ?? false,
        contextInputs: [],
        discussThreshold: discuss_threshold,
        maxTurns: 25,
      });

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
        baseURL: baseUrl || undefined,
      });

      const response = await client.messages.create({
        model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      });

      const output = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');

      const duration = Date.now() - startTime;

      const debug = {
        baseUrl: baseUrl?.slice(0, 50),
        tokenPrefix: apiKey?.slice(0, 8),
        source: mmsRoute ? 'mms-route' : 'process-env',
        responseModel: response.model,
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
