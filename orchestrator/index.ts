// orchestrator/index.ts — Re-exports + CLI entry

// ── Re-exports (for MCP server and external consumers) ──
export { ModelRegistry } from './model-registry.js';
export { buildPlanFromClaudeOutput, PLAN_PROMPT_TEMPLATE } from './planner.js';
export { spawnWorker, dispatchBatch, type DispatchResult } from './dispatcher.js';
export { reviewCascade } from './reviewer.js';
export { resolveProvider, resolveProviderForModel, checkProviderHealth } from './provider-resolver.js';
export { loadMmsRoutes, resolveModelRoute, resolveModelRouteFull, resolveModelByPrefix, isMmsAvailable } from './mms-routes-loader.js';
export { translateToEnglish } from './translator.js';
export { reportResults } from './reporter.js';
export { runA2aReview } from './a2a-bridge.js';
export { triggerDiscussion } from './discuss-bridge.js';
export { bootstrapRun, createRunSpec, createInitialRunState, resumeRun, inferDefaultDoneConditions, executeRun, runGoal } from './driver.js';
export { saveRunSpec, loadRunSpec, saveRunState, loadRunState, listRuns, loadRunPlan, loadRunResult } from './run-store.js';
export { runVerification, runVerificationSuite, allRequiredChecksPassed } from './verifier.js';
export * from './types.js';

// ── CLI entry (only runs when executed directly) ──
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const getFlag = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const isTerminal = (s: string) => s === 'done' || s === 'blocked';

  if (command === 'run') {
    const { bootstrapRun, runGoal } = await import('./driver.js');
    const goal = getFlag('--goal') || '';
    const cwd = getFlag('--cwd') || process.cwd();
    const mode = (getFlag('--mode') || 'safe') as 'safe' | 'balanced' | 'aggressive';
    const initOnly = args.includes('--init-only');
    const autoMerge = args.includes('--auto-merge');

    if (!goal.trim()) {
      console.error('❌ run requires --goal "<task goal>"');
      process.exit(1);
    }

    if (initOnly) {
      const { spec, state } = bootstrapRun({ goal, cwd, mode });
      console.log(`🟡 Run initialized: ${spec.id}`);
      console.log(`📁 cwd: ${spec.cwd}`);
      console.log(`🧭 mode: ${spec.mode}`);
      console.log(`✅ done conditions: ${spec.done_conditions.length}`);
      for (const condition of spec.done_conditions) {
        console.log(`   - [${condition.type}] ${condition.label}`);
      }
      console.log(`➡️ next action: ${state.next_action?.kind} — ${state.next_action?.reason}`);
      return;
    }

    const execution = await runGoal({ goal, cwd, mode, allowAutoMerge: autoMerge });
    const { spec, state } = execution;
    console.log(`🟡 Run finished: ${spec.id}`);
    console.log(`📁 cwd: ${spec.cwd}`);
    console.log(`🧭 mode: ${spec.mode}`);
    console.log(`📊 status: ${state.status}`);
    if (execution.plan) {
      console.log(`📋 plan: ${execution.plan.tasks.length} tasks`);
    }
    console.log(`✅ done conditions: ${spec.done_conditions.length}`);
    for (const condition of spec.done_conditions) {
      console.log(`   - [${condition.type}] ${condition.label}`);
    }
    console.log(`➡️ next action: ${state.next_action?.kind} — ${state.next_action?.reason}`);
    if (state.final_summary) {
      console.log(`🧾 summary: ${state.final_summary}`);
    }
    return;
  }

  if (command === 'resume') {
    const { resumeRun } = await import('./driver.js');
    const runId = getFlag('--run-id') || '';
    const cwd = getFlag('--cwd') || process.cwd();

    if (!runId.trim()) {
      console.error('❌ resume requires --run-id <run-id>');
      process.exit(1);
    }

    const shouldExecute = args.includes('--execute');
    const execution = await resumeRun(cwd, runId, { execute: shouldExecute });
    if (!execution) {
      console.error(`❌ run not found: ${runId}`);
      process.exit(1);
    }

    const { spec: rSpec, state: rState } = execution;
    console.log(`🟡 ${shouldExecute ? 'Resumed & re-executed' : 'Restored'} run: ${rSpec.id}`);
    console.log(`📊 status: ${rState.status}`);
    console.log(`🔁 round: ${rState.round}`);
    console.log(`➡️ next action: ${rState.next_action?.kind} — ${rState.next_action?.reason || 'n/a'}`);
    if (rState.final_summary) {
      console.log(`🧾 summary: ${rState.final_summary}`);
    }
    if (!shouldExecute && !isTerminal(rState.status)) {
      console.log(`💡 Use --execute to re-enter the loop`);
    }
    return;
  }

  if (command === 'status') {
    const { listRuns, loadRunPlan, loadRunResult } = await import('./run-store.js');
    const cwd = getFlag('--cwd') || process.cwd();
    const runId = getFlag('--run-id');

    if (runId) {
      const { loadRunSpec, loadRunState } = await import('./run-store.js');
      const sSpec = loadRunSpec(cwd, runId);
      const sState = loadRunState(cwd, runId);
      if (!sSpec || !sState) {
        console.error(`❌ run not found: ${runId}`);
        process.exit(1);
      }
      const plan = loadRunPlan(cwd, runId);
      const result = loadRunResult(cwd, runId);
      console.log(`🟡 Run: ${runId}`);
      console.log(`📊 status: ${sState.status}`);
      console.log(`🔁 round: ${sState.round}`);
      console.log(`📋 plan tasks: ${plan?.tasks.length || 0}`);
      console.log(`🧪 verification checks: ${sState.verification_results.length}`);
      console.log(`🧾 summary: ${sState.final_summary || 'n/a'}`);
      console.log(`📦 result saved: ${result ? 'yes' : 'no'}`);
      return;
    }

    const runs = listRuns(cwd);
    for (const run of runs) {
      console.log(`${run.id}  ${run.state?.status || 'unknown'}  ${run.spec?.goal || '(no goal)'}`);
    }
    return;
  }

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
    const { loadConfig: loadHiveConfig, resolveTierModel } = await import('./hive-config.js');
    const registry = new (ModelRegistry as any)();
    const config = loadHiveConfig(cwd);
    const translatorModel = resolveTierModel(
      config.tiers.translator.model,
      () => registry.selectTranslator(),
      registry,
      'translation',
    );
    const translatorInfo = registry.get(translatorModel);
    console.log(`\n🌐 Translating with ${translatorModel}...`);
    const result = await translateToEnglish(goal, translatorModel, translatorInfo?.provider || translatorModel);
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

    const { worker_results: workerResults } = await dispatchBatch(plan, registry);

    // Review
    const reviewResults = await Promise.all(
      workerResults.map(r => {
        const task = plan.tasks.find((t: any) => t.id === r.taskId);
        return reviewCascade(r, task!, plan, registry);
      }),
    );

    // Report — use tiers config
    const { loadConfig: loadHiveConfig, resolveTierModel } = await import('./hive-config.js');
    const config = loadHiveConfig(cwd);
    const reporterModel = resolveTierModel(
      config.tiers.reporter.model,
      () => registry.selectForReporter(),
      registry,
      'general',
    );
    const reporterInfo = registry.get(reporterModel);
    const reporterProvider = reporterInfo?.provider || reporterModel;

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
      reporterModel,
      reporterProvider,
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
