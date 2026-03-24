import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { query } from '@anthropic-ai/claude-code';
import * as z from 'zod';
import type { TaskPlan, TranslationResult, OrchestratorResult } from '../orchestrator/types.js';
import { buildPlanFromClaudeOutput, PLAN_PROMPT_TEMPLATE } from '../orchestrator/planner.js';
import { translateToEnglish } from '../orchestrator/translator.js';
import { reportResults } from '../orchestrator/reporter.js';
import { spawnWorker, dispatchBatch } from '../orchestrator/dispatcher.js';
import { reviewCascade } from '../orchestrator/reviewer.js';
import { ModelRegistry } from '../orchestrator/model-registry.js';
import { checkProviderHealth, getAllProviders } from '../orchestrator/provider-resolver.js';
import { getBudgetWarning, loadConfig } from '../orchestrator/hive-config.js';

const server = new McpServer({
  name: 'hive-mcp',
  version: '1.0.0',
});

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) => {
      if (typeof block === 'string') {
        return block;
      }
      if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block) {
        return typeof block.text === 'string' ? block.text : '';
      }
      return '';
    })
    .join('');
}

function parseJsonBlock<T>(raw: string): T {
  const fencedMatch = raw.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1] || raw.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) {
    throw new Error('Planner did not return JSON');
  }
  return JSON.parse(candidate) as T;
}

async function runClaudePlanner(prompt: string, cwd: string, modelId: string): Promise<string> {
  const stream = query({
    prompt,
    options: {
      cwd,
      maxTurns: 1,
      env: {
        ANTHROPIC_MODEL: modelId,
      },
    },
  });

  let output = '';
  for await (const msg of stream) {
    if (msg.type === 'assistant') {
      output += extractAssistantText(msg.message?.content);
    }
  }

  return output.trim();
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
    const plannerModel = process.env.HIVE_PLANNER_MODEL || config.orchestrator;

    // 检测语言（ASCII > 70% → 英文，否则中文）
    const asciiRatio = goal.split('').filter(c => c.charCodeAt(0) < 128).length / goal.length;
    let englishGoal = goal;
    let translationResult: TranslationResult | null = null;

    if (asciiRatio <= 0.7) {
      // 中文输入，需要翻译
      const translatorModel = registry.selectTranslator();
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

// 工具 2: execute_plan - 处理 DispatchResult 和 opus_tasks
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

    // dispatchBatch 返回 { worker_results, opus_tasks }
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

    // 构建 orchestrator result
    const orchestratorResult: OrchestratorResult = {
      plan,
      worker_results: dispatchResult.worker_results,
      review_results: reviewResults,
      score_updates: [], // 在实际实现中会更新模型评分
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

    // 生成报告
    const report = await reportResults(
      orchestratorResult,
      'kimi-k2.5',
      'kimi-codingplan',
      { language: report_language, format: 'summary', target: 'stdout' }
    );

    const opusAppendix = dispatchResult.opus_tasks.length > 0
      ? [
          '',
          '## Claude Direct Tasks',
          ...dispatchResult.opus_tasks.map((task) => `- ${task.id}: ${task.description}`),
          '',
          'These tasks were not dispatched and still need direct Claude handling.',
        ].join('\n')
      : '';

    return { content: [{ type: 'text', text: report + opusAppendix }] };
  }
);

// 工具 3: dispatch_single
server.tool(
  'dispatch_single',
  'Dispatch a single task to a specific model.',
  {
    task_json: z.string().describe('SubTask JSON'),
    model: z.string().describe('Model ID'),
    provider: z.string().describe('Provider ID'),
  },
  async ({ task_json, model, provider }) => {
    const task = JSON.parse(task_json);
    const result = await spawnWorker({
      taskId: task.id,
      model,
      provider,
      prompt: task.description,
      cwd: process.cwd(),
      worktree: true,
      contextInputs: [],
      discussThreshold: task.discuss_threshold,
      maxTurns: 25
    });

    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

// 工具 4: health_check
server.tool(
  'health_check',
  'Check health of all providers.',
  {},
  async () => {
    const providers = Object.keys(getAllProviders());

    let healthText = "## Provider Health Check\n";
    for (const provider of providers) {
      const healthy = await checkProviderHealth(provider);
      healthText += `- ${provider}: ${healthy ? 'OK' : 'UNAVAILABLE'}\n`;
    }

    return { content: [{ type: 'text', text: healthText }] };
  }
);

// 工具 5: model_scores
server.tool(
  'model_scores',
  'Display model capability scores.',
  {},
  async () => {
    const registry = new ModelRegistry();
    const models = registry.getAll() as any[];

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
    model: z.string().describe('Translator model ID (e.g., kimi-k2.5)').optional(),
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
    const report = await reportResults(result, 'kimi-k2.5', 'kimi-codingplan', {
      language: 'zh', format, target: 'stdout',
    });
    return { content: [{ type: 'text', text: report }] };
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
