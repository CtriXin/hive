import type { OrchestratorResult, ReportOptions } from './types.js';
import { resolveProvider } from './provider-resolver.js';
import { buildSdkEnv } from './project-paths.js';
import { safeQuery, extractTextFromMessages } from './sdk-query-safe.js';

const REPORT_PROMPT = `You are a technical project reporter. Generate a structured Chinese summary of the following orchestration results.

## Format requirements:
1. **任务概览** — 做了什么（1-2 句）
2. **执行情况** — 表格：任务ID | 模型 | 耗时 | 状态(✅/❌)
3. **Review 结果** — 红/黄/绿 findings 数量 + 关键问题摘要
4. **成本估算** — Claude token + 国产 token + 总成本
5. **下一步建议** — 需要人工关注的点

Output in Chinese. Keep it concise.

## Results data:
`;

export async function reportResults(
  result: OrchestratorResult,
  reporterModel: string,
  reporterProvider: string,
  options: ReportOptions = { language: 'zh', format: 'summary', target: 'stdout' },
): Promise<string> {
  // 构建简洁的数据摘要（不把整个 result 扔进去）
  const summary = {
    goal: result.plan.goal,
    task_count: result.plan.tasks.length,
    workers: result.worker_results.map(w => ({
      task: w.taskId,
      model: w.model,
      success: w.success,
      duration_s: (w.duration_ms / 1000).toFixed(1),
      files_changed: w.changedFiles.length,
      discuss_triggered: w.discuss_triggered,
    })),
    reviews: result.review_results.map(r => ({
      task: r.taskId,
      passed: r.passed,
      stage: r.final_stage,
      findings_red: r.findings.filter(f => f.severity === 'red').length,
      findings_yellow: r.findings.filter(f => f.severity === 'yellow').length,
    })),
    cost: result.cost_estimate,
    score_updates: result.score_updates,
    total_duration_s: (result.total_duration_ms / 1000).toFixed(1),
  };

  if (options.format === 'summary') {
    // 简洁模式：直接格式化，不调 LLM
    return formatLocalReport(summary);
  }

  // detailed 模式：用国产模型生成自然语言报告
  const { baseUrl, apiKey } = resolveProvider(reporterProvider, reporterModel);

  const queryResult = await safeQuery({
    prompt: REPORT_PROMPT + JSON.stringify(summary, null, 2),
    options: {
      cwd: process.cwd(),
      env: buildSdkEnv(reporterModel, baseUrl, apiKey),
      maxTurns: 1,
    }
  });

  const report = extractTextFromMessages(queryResult.messages);
  return report || formatLocalReport(summary);
}

// 本地格式化（不需要 LLM，用于 summary 模式）
function formatLocalReport(summary: any): string {
  let report = `## 📋 任务报告\n\n`;
  report += `**目标**: ${summary.goal}\n`;
  report += `**总耗时**: ${summary.total_duration_s}s\n\n`;

  report += `### 执行情况\n\n`;
  report += `| 任务 | 模型 | 耗时 | 状态 | 文件数 |\n`;
  report += `|------|------|------|------|--------|\n`;
  for (const w of summary.workers) {
    report += `| ${w.task} | ${w.model} | ${w.duration_s}s | ${w.success ? '✅' : '❌'} | ${w.files_changed} |\n`;
  }

  report += `\n### Review 结果\n\n`;
  for (const r of summary.reviews) {
    const emoji = r.passed ? '✅' : '❌';
    report += `- ${emoji} **${r.task}**: stage=${r.stage}, ${r.findings_red}🔴 ${r.findings_yellow}🟡\n`;
  }

  if (summary.cost) {
    report += `\n### 成本估算\n\n`;
    report += `- Claude tokens: ${summary.cost.opus_tokens + summary.cost.sonnet_tokens + summary.cost.haiku_tokens}\n`;
    report += `- 国产 tokens: ${summary.cost.domestic_tokens}\n`;
    report += `- 预估成本: $${summary.cost.estimated_cost_usd.toFixed(2)}\n`;
  }

  return report;
}
