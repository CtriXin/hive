// orchestrator/index.ts — Re-exports + CLI entry

// ── Re-exports (for MCP server and external consumers) ──
export { ModelRegistry } from './model-registry.js';
export { buildPlanFromClaudeOutput, PLAN_PROMPT_TEMPLATE } from './planner.js';
export { spawnWorker, dispatchBatch, type DispatchResult } from './dispatcher.js';
export { reviewCascade } from './reviewer.js';
export { resolveProvider, checkProviderHealth } from './provider-resolver.js';
export { translateToEnglish } from './translator.js';
export { reportResults } from './reporter.js';
export { runA2aReview } from './a2a-bridge.js';
export { triggerDiscussion } from './discuss-bridge.js';
export * from './types.js';

// ── CLI entry (only runs when executed directly) ──
async function main() {
  const args = process.argv.slice(2);

  const goalIdx = args.indexOf('--goal');
  const cwdIdx = args.indexOf('--cwd');
  const planIdx = args.indexOf('--plan');
  const translateFlag = args.includes('--translate');

  if (goalIdx < 0 && planIdx < 0) {
    console.log('Usage:');
    console.log('  hive --goal "Build auth system" --cwd /path/to/project');
    console.log('  hive --goal "构建认证系统" --cwd /path --translate');
    console.log('  hive --plan plan.json --cwd /path');
    process.exit(1);
  }

  const cwd = cwdIdx >= 0 ? args[cwdIdx + 1] : process.cwd();
  let goal = goalIdx >= 0 ? args[goalIdx + 1] : '';

  // Tier 0: translate if needed
  if (translateFlag && goal) {
    const { translateToEnglish } = await import('./translator.js');
    const { ModelRegistry } = await import('./model-registry.js');
    const registry = new (ModelRegistry as any)();
    const all = registry.getAll();
    const translator = all.sort((a: any, b: any) => b.chinese - a.chinese)[0];
    console.log(`\n🌐 Translating with ${translator.id}...`);
    const result = await translateToEnglish(goal, translator.id, translator.provider);
    console.log(`📝 English: ${result.english}\n`);
    goal = result.english;
  }

  // Execute from plan file
  if (planIdx >= 0) {
    const fs = await import('fs');
    const planJson = JSON.parse(fs.readFileSync(args[planIdx + 1], 'utf-8'));
    const { buildPlanFromClaudeOutput } = await import('./planner.js');
    const { dispatchBatch } = await import('./dispatcher.js');
    const { reviewCascade } = await import('./reviewer.js');
    const { reportResults } = await import('./reporter.js');
    const { ModelRegistry } = await import('./model-registry.js');

    const registry = new (ModelRegistry as any)();
    planJson.cwd = cwd;
    const plan = buildPlanFromClaudeOutput(planJson);

    console.log(`\n📋 Plan: ${plan.tasks.length} tasks`);
    console.log(`📋 Groups: ${plan.execution_order.map((g: string[]) => `[${g.join(',')}]`).join(' → ')}\n`);

    const { worker_results: workerResults, opus_tasks } = await dispatchBatch(plan, registry);

    // Handle opus tasks
    if (opus_tasks.length > 0) {
      console.log(`\n⚠️  ${opus_tasks.length} task(s) require Claude to handle directly:`);
      for (const t of opus_tasks) {
        console.log(`   - [${t.id}] ${t.description} (complexity: ${t.complexity})`);
      }
      console.log('   These tasks were skipped by the dispatcher.\n');
    }

    // Review
    const reviewResults = await Promise.all(
      workerResults.map(r => {
        const task = plan.tasks.find((t: any) => t.id === r.taskId);
        return reviewCascade(r, task!, plan, registry);
      }),
    );

    // Report
    const all = registry.getAll();
    const reporter = all.sort((a: any, b: any) => b.chinese - a.chinese)[0];
    const report = await reportResults(
      {
        plan,
        worker_results: workerResults,
        review_results: reviewResults,
        score_updates: [],
        total_duration_ms: 0,
        cost_estimate: {
          opus_tokens: 0, sonnet_tokens: 0, haiku_tokens: 0,
          domestic_tokens: 0, estimated_cost_usd: 0,
        },
      },
      reporter?.id || 'kimi-k2.5',
      'kimi-codingplan',
      { language: 'zh', format: 'summary', target: 'stdout' },
    );
    console.log(report);
  } else {
    console.log('💡 Use MCP server for interactive planning:');
    console.log('   npm run start:mcp');
    console.log('   Or provide --plan <file.json> for CLI execution');
  }
}

const isMainModule = process.argv[1]?.includes('index');
if (isMainModule) {
  main().catch(err => {
    console.error('❌', err.message);
    process.exit(1);
  });
}
