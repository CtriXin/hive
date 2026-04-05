import type { OrchestratorResult, ReportOptions, TokenBreakdown } from './types.js';
import { ensureStageModelAllowed } from './hive-config.js';
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
      authority_mode: r.authority?.mode,
      authority_members: r.authority?.members || [],
      authority_source: r.authority?.source,
      disagreement_flags: r.authority?.disagreement_flags || [],
      synthesized_by: r.authority?.synthesized_by,
      synthesis_strategy: r.authority?.synthesis_strategy,
      synthesis_attempted_by: r.authority?.synthesis_attempted_by,
      verdict: r.verdict,
    })),
    cost: result.cost_estimate,
    score_updates: result.score_updates,
    total_duration_s: (result.total_duration_ms / 1000).toFixed(1),
    token_breakdown: result.token_breakdown,
    budget_status: result.budget_status,
    budget_warning: result.budget_warning,
    task_verification_results: result.task_verification_results,
  };

  if (options.format === 'summary') {
    // 简洁模式：直接格式化，不调 LLM
    return formatLocalReport(summary);
  }

  // detailed 模式：用国产模型生成自然语言报告
  ensureStageModelAllowed('reporter', reporterModel);
  const { baseUrl, apiKey } = resolveProvider(reporterProvider, reporterModel);

  const queryResult = await safeQuery({
    prompt: REPORT_PROMPT + JSON.stringify(summary, null, 2),
    options: {
      cwd: process.cwd(),
      env: buildSdkEnv(reporterModel, baseUrl, apiKey),
      model: reporterModel,
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
    const emoji = r.verdict === 'BLOCKED' ? '⛔' : r.passed ? '✅' : '❌';
    const authorityBits = [];
    if (r.authority_source) authorityBits.push(`authority=${r.authority_source}`);
    if (r.authority_mode) authorityBits.push(`mode=${r.authority_mode}`);
    if (Array.isArray(r.authority_members) && r.authority_members.length > 0) {
      authorityBits.push(`members=${r.authority_members.join('+')}`);
    }
    if (r.synthesized_by) authorityBits.push(`synth=${r.synthesized_by}`);
    else if (r.synthesis_strategy === 'heuristic') authorityBits.push('synth=heuristic');
    else if (r.synthesis_attempted_by) authorityBits.push(`synth=blocked(${r.synthesis_attempted_by})`);
    if (Array.isArray(r.disagreement_flags) && r.disagreement_flags.length > 0) {
      authorityBits.push(`disagreement=${r.disagreement_flags.join(',')}`);
    }
    const authorityText = authorityBits.length > 0 ? `, ${authorityBits.join(', ')}` : '';
    report += `- ${emoji} **${r.task}**: stage=${r.stage}, ${r.findings_red}🔴 ${r.findings_yellow}🟡${authorityText}\n`;
  }

  if (summary.cost) {
    report += `\n### 成本估算\n\n`;
    report += `- Claude tokens: ${fmtNum(summary.cost.opus_tokens + summary.cost.sonnet_tokens + summary.cost.haiku_tokens)}\n`;
    report += `- 国产 tokens: ${fmtNum(summary.cost.domestic_tokens)}\n`;
    report += `- 预估成本: $${summary.cost.estimated_cost_usd.toFixed(2)}\n`;
  }

  if (summary.token_breakdown) {
    report += formatTokenBreakdown(summary.token_breakdown);
  }

  if (summary.budget_status) {
    report += `\n### Budget\n\n`;
    report += `- 已花费: $${summary.budget_status.current_spent_usd.toFixed(4)} / $${summary.budget_status.monthly_limit_usd.toFixed(2)}\n`;
    report += `- 剩余: $${summary.budget_status.remaining_usd.toFixed(4)}\n`;
    if (summary.budget_warning) {
      report += `- 告警: ${summary.budget_warning}\n`;
    }
  }

  if (summary.task_verification_results && Object.keys(summary.task_verification_results).length > 0) {
    report += `\n### Task Verification\n\n`;
    for (const [taskId, results] of Object.entries(summary.task_verification_results)) {
      const failed = (results as any[]).filter((result) => result.target?.must_pass && !result.passed).length;
      report += `- ${taskId}: ${(results as any[]).length} checks`;
      if (failed > 0) report += `, ${failed} failed`;
      report += `\n`;
    }
  }

  return report;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatTokenBreakdown(tb: TokenBreakdown): string {
  let s = `\n### Token 明细\n\n`;
  s += `| 阶段 | 模型 | Input | Output |\n`;
  s += `|------|------|-------|--------|\n`;
  for (const st of tb.stages) {
    if (st.input_tokens === 0 && st.output_tokens === 0) continue;
    s += `| ${st.stage} | ${st.model} | ${fmtNum(st.input_tokens)} | ${fmtNum(st.output_tokens)} |\n`;
  }
  s += `\n`;
  s += `**总计**: ${fmtNum(tb.total_input)} input + ${fmtNum(tb.total_output)} output\n`;
  s += `**实际成本**: $${tb.actual_cost_usd.toFixed(4)}\n`;
  s += `**若全用 Claude Sonnet**: $${tb.claude_equivalent_usd.toFixed(4)}\n`;
  const pct = tb.claude_equivalent_usd > 0
    ? ((tb.savings_usd / tb.claude_equivalent_usd) * 100).toFixed(0)
    : '0';
  s += `**节省**: $${tb.savings_usd.toFixed(4)} (${pct}%)\n`;
  return s;
}
