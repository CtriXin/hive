// orchestrator/index.ts — Re-exports + CLI entry

import path from 'path';
import { fileURLToPath } from 'url';
import { pickWorkerSurfaceSummary } from './worker-surface-summary.js';

// ── Re-exports (for MCP server and external consumers) ──
export { ModelRegistry } from './model-registry.js';
export { buildPlanFromClaudeOutput, PLAN_PROMPT_TEMPLATE } from './planner.js';
export { spawnWorker, dispatchBatch, type DispatchResult } from './dispatcher.js';
export { reviewCascade, runReview } from './reviewer.js';
export { resolveProvider, resolveProviderForModel, checkProviderHealth } from './provider-resolver.js';
export { loadMmsRoutes, resolveModelRoute, resolveModelRouteFull, resolveModelByPrefix, isMmsAvailable } from './mms-routes-loader.js';
export { translateToEnglish } from './translator.js';
export { reportResults } from './reporter.js';
export { runA2aReview } from './a2a-bridge.js';
export { triggerDiscussion } from './discuss-bridge.js';
export { buildPlanningBrief, executePlannerDiscuss, planGoal, synthesizeAgentBusReplies } from './planner-runner.js';
export { bootstrapRun, createRunSpec, createInitialRunState, resumeRun, inferDefaultDoneConditions, executeRun, runGoal } from './driver.js';
export { saveRunSpec, loadRunSpec, saveRunState, loadRunState, listRuns, loadRunPlan, loadRunResult } from './run-store.js';
export { writeLoopProgress, readLoopProgress, type LoopProgress, type LoopPhase } from './loop-progress-store.js';
export { runVerification, runVerificationSuite, allRequiredChecksPassed } from './verifier.js';
export {
  buildWorkerAgentId,
  findWorkerStatusEntry,
  loadWorkerStatusSnapshot,
  loadWorkerEvents,
  loadWorkerTranscript,
  listWorkerStatusSnapshots,
  summarizeWorkerSnapshot,
} from './worker-status-store.js';
export { buildRoundScoreEntry, buildRoundScoreSignals, computeRoundScore, loadRunScoreHistory, saveRoundScore } from './score-history.js';
export { loadHiveShellDashboard, renderHiveShellDashboard, resolveHiveShellRunId } from './hiveshell-dashboard.js';
export { collectMindkeeperRoomRefs, formatMindkeeperRoomRef } from './memory-linkage.js';
export { collectHumanBridgeRefs, formatHumanBridgeRef } from './human-bridge-linkage.js';
export {
  buildCompactPacket,
  buildWorkspaceCompactPacket,
  loadCompactPacket,
  loadLatestCompactRestore,
  loadWorkspaceCompactPacket,
  renderCompactPacket,
  renderWorkspaceCompactPacket,
  saveCompactPacket,
  saveWorkspaceCompactPacket,
} from './compact-packet.js';
export * from './types.js';

// ── CLI entry (only runs when executed directly) ──
export async function main() {
  const { maybePrintUpgradeNotice } = await import('./update-check.js');
  await maybePrintUpgradeNotice();

  const args = process.argv.slice(2);
  const command = args[0];
  const flagsWithValues = new Set([
    '--goal',
    '--cwd',
    '--mode',
    '--mindkeeper-thread',
    '--run-id',
    '--interval-ms',
    '--events',
    '--plan',
    '--worker',
  ]);
  const positionalArgsAfterCommand: string[] = [];
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (flagsWithValues.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    positionalArgsAfterCommand.push(arg);
  }
  const firstPositionalAfterCommand = positionalArgsAfterCommand[0];
  const secondPositionalAfterCommand = positionalArgsAfterCommand[1];

  const getFlag = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const isTerminal = (s: string) => s === 'done' || s === 'blocked';
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const formatScoreDelta = (delta?: number): string =>
    typeof delta === 'number' && delta !== 0
      ? `${delta > 0 ? '+' : ''}${delta}`
      : '0';

  const formatWorkerLine = (worker: any): string => {
    const modelText = worker.assigned_model === worker.active_model
      ? worker.active_model
      : `${worker.assigned_model} -> ${worker.active_model}`;
    const details = [
      worker.agent_id ? `agent=${worker.agent_id}` : '',
      worker.provider ? `provider=${worker.provider}` : '',
      worker.branch ? `branch=${worker.branch}` : '',
      worker.session_id ? `session=${worker.session_id}` : '',
      typeof worker.changed_files_count === 'number'
        ? `changed=${worker.changed_files_count}`
        : '',
    ].filter(Boolean);
    const summary = pickWorkerSurfaceSummary(worker.task_summary, worker.last_message);
    const collab = worker.collab?.card
      ? ` | collab ${worker.collab.card.room_id} [${worker.collab.card.status}] replies=${worker.collab.card.replies}`
      : '';
    return `- ${worker.task_id} [${worker.status}] ${modelText}${details.length ? ` (${details.join(', ')})` : ''}${summary ? ` | ${summary}` : ''}${collab}`;
  };

  const resolveWorkerRunId = async (cwd: string, runId?: string): Promise<string | null> => {
    const { listRuns } = await import('./run-store.js');
    const { listWorkerStatusSnapshots } = await import('./worker-status-store.js');
    return runId
      || listWorkerStatusSnapshots(cwd)[0]?.run_id
      || listRuns(cwd)[0]?.id
      || null;
  };

  const printWorkerDetails = async (
    cwd: string,
    runId: string,
    workerSelector: string,
  ): Promise<boolean> => {
    const {
      findWorkerStatusEntry,
      loadWorkerStatusSnapshot,
      loadWorkerTranscript,
    } = await import('./worker-status-store.js');
    const snapshot = loadWorkerStatusSnapshot(cwd, runId);
    const worker = findWorkerStatusEntry(snapshot, workerSelector);
    if (!worker) {
      console.error(`❌ worker not found: ${workerSelector}`);
      return false;
    }

    const transcript = loadWorkerTranscript(cwd, runId, worker.task_id).slice(-12);
    console.log(`🟡 Worker: ${worker.task_id}`);
    console.log(`🪪 agent: ${worker.agent_id}`);
    console.log(`📊 status: ${worker.status}`);
    console.log(`🤖 model: ${worker.assigned_model === worker.active_model ? worker.active_model : `${worker.assigned_model} -> ${worker.active_model}`}`);
    console.log(`📝 summary: ${pickWorkerSurfaceSummary(worker.task_summary, worker.last_message, worker.task_description) || '-'}`);
    if (worker.transcript_path) {
      console.log(`🧵 transcript: ${worker.transcript_path}`);
    }
    if (worker.collab?.card) {
      const card = worker.collab.card;
      console.log(`🤝 collab: ${card.room_id} [${card.status}] replies=${card.replies}`);
      console.log(`   next: ${card.next}`);
      if (card.last_reply_at) {
        console.log(`   last reply: ${card.last_reply_at}`);
      }
      if (card.join_hint) {
        console.log(`   join: ${card.join_hint}`);
      }
      for (const event of worker.collab.recent_events.slice(-4)) {
        console.log(`   event: ${event.at} ${event.type}${typeof event.reply_count === 'number' ? ` (#${event.reply_count})` : ''}${event.note ? ` | ${event.note}` : ''}`);
      }
    }
    if (worker.session_id) {
      console.log(`🆔 session: ${worker.session_id}`);
    }
    if (worker.branch) {
      console.log(`🌿 branch: ${worker.branch}`);
    }
    if (worker.worktree_path) {
      console.log(`📁 worktree: ${worker.worktree_path}`);
    }
    if (transcript.length === 0) {
      console.log('📝 transcript preview: none');
      return true;
    }

    console.log('📝 transcript preview:');
    for (const entry of transcript) {
      const content = entry.content.replace(/\s+/g, ' ').trim();
      console.log(`- ${entry.timestamp} [${entry.type}] ${content}`);
    }
    return true;
  };

  const printWorkerSnapshot = async (
    cwd: string,
    runId?: string,
    eventLimit = 5,
    workerSelector?: string,
  ): Promise<boolean> => {
    const {
      loadWorkerStatusSnapshot,
      summarizeWorkerSnapshot,
      loadWorkerEvents,
    } = await import('./worker-status-store.js');

    const resolvedRunId = await resolveWorkerRunId(cwd, runId);

    if (!resolvedRunId) {
      console.error('❌ no run with worker status found');
      return false;
    }

    if (workerSelector) {
      return printWorkerDetails(cwd, resolvedRunId, workerSelector);
    }

    const snapshot = loadWorkerStatusSnapshot(cwd, resolvedRunId);
    if (!snapshot) {
      console.error(`❌ worker status not found for run: ${resolvedRunId}`);
      return false;
    }

    const counts = summarizeWorkerSnapshot(snapshot);
    const events = loadWorkerEvents(cwd, resolvedRunId).slice(-eventLimit);

    console.log(`🟡 Worker snapshot: ${resolvedRunId}`);
    console.log(`📋 plan: ${snapshot.plan_id}`);
    console.log(`🔁 round: ${snapshot.round}`);
    console.log(`👷 workers: ${counts.total} total / ${counts.active} active / ${counts.completed} completed / ${counts.failed} failed / ${counts.queued} queued`);
    if (snapshot.goal) {
      console.log(`🎯 goal: ${snapshot.goal}`);
    }
    console.log(`🕒 updated: ${snapshot.updated_at}`);
    for (const worker of snapshot.workers) {
      console.log(formatWorkerLine(worker));
    }
    if (events.length > 0) {
      console.log('📝 recent events:');
      for (const event of events) {
        const label = event.agent_id ? `${event.task_id}/${event.agent_id}` : event.task_id;
        console.log(`- ${event.timestamp} ${label} [${event.status}] ${event.message || ''}`.trim());
      }
    }
    const firstWorker = snapshot.workers[0];
    if (firstWorker) {
      console.log(`💡 drill into one worker: hive workers ${firstWorker.task_id}`);
    }
    return true;
  };

  const printScoreHistory = async (cwd: string, runId?: string): Promise<boolean> => {
    const { resolveHiveShellRunId } = await import('./hiveshell-dashboard.js');
    const { loadRunScoreHistory, resolveLatestScoredRunId } = await import('./score-history.js');

    const preferredRunId = resolveHiveShellRunId(cwd, runId);
    const resolvedRunId = runId || resolveLatestScoredRunId(cwd, preferredRunId || undefined);
    if (!resolvedRunId) {
      console.error('❌ no run with score history found');
      return false;
    }

    const history = loadRunScoreHistory(cwd, resolvedRunId);
    if (!history) {
      console.error(`❌ score history not found for run: ${resolvedRunId}`);
      return false;
    }

    console.log(`🟡 Score history: ${resolvedRunId}`);
    if (!runId && preferredRunId && preferredRunId !== resolvedRunId) {
      console.log(`ℹ️ latest surface run ${preferredRunId} has no score history yet; showing latest scored run ${resolvedRunId}`);
    }
    if (history.goal) {
      console.log(`🎯 goal: ${history.goal}`);
    }
    console.log(`📈 latest: ${history.latest_score ?? 'n/a'}`);
    console.log(`🏆 best: ${history.best_score ?? 'n/a'}`);
    console.log(`🕒 updated: ${history.updated_at}`);

    for (const round of history.rounds) {
      console.log(
        `- round ${round.round} [${round.action}] ${round.status} `
          + `score=${round.score} delta=${formatScoreDelta(round.delta_from_previous)} `
          + `| ${round.summary}`,
      );
    }

    return true;
  };

  const printHiveShell = async (cwd: string, runId?: string): Promise<boolean> => {
    const { loadHiveShellDashboard, renderHiveShellDashboard } = await import('./hiveshell-dashboard.js');
    const dashboard = loadHiveShellDashboard(cwd, runId);
    if (!dashboard) {
      console.error('❌ no run available for hiveshell');
      return false;
    }

    console.log(renderHiveShellDashboard(dashboard));
    return true;
  };

  const printCompactPacket = async (cwd: string, runId?: string): Promise<boolean> => {
    const { loadCompactPacket, loadWorkspaceCompactPacket } = await import('./compact-packet.js');
    const result = loadCompactPacket(cwd, runId);
    const workspaceResult = result ? null : loadWorkspaceCompactPacket(cwd);
    const effectiveResult = result || workspaceResult;
    if (!effectiveResult) {
      console.error('❌ unable to build compact restore card');
      return false;
    }

    console.log(effectiveResult.markdown);
    console.log('');
    console.log(`🧾 packet json: ${effectiveResult.jsonPath}`);
    console.log(`🧾 packet md: ${effectiveResult.markdownPath}`);
    console.log(`🧾 restore prompt: ${effectiveResult.restorePromptPath}`);
    console.log(`🧾 latest restore prompt: ${effectiveResult.latestRestorePromptPath}`);
    if (result?.latestRunPath) {
      console.log(`🧾 latest run: ${result.runId}`);
    }
    return true;
  };

  const printLatestRestore = async (cwd: string): Promise<boolean> => {
    const { loadLatestCompactRestore } = await import('./compact-packet.js');
    const result = loadLatestCompactRestore(cwd);
    if (!result) {
      console.error('❌ no latest compact restore prompt found');
      return false;
    }

    console.log(result.restorePrompt);
    console.log('');
    console.log(`🧾 latest restore prompt: ${result.restorePromptPath}`);
    if (result.packetPath) {
      console.log(`🧾 latest packet: ${result.packetPath}`);
    }
    if (result.runId) {
      console.log(`🧾 latest run: ${result.runId}`);
    }
    return true;
  };

  if (command === 'run') {
    const { bootstrapRun, runGoal } = await import('./driver.js');
    const goal = getFlag('--goal') || firstPositionalAfterCommand || '';
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
    if (execution.plan_discuss_room) {
      const room = execution.plan_discuss_room;
      console.log(`🔗 discuss room: ${room.room_id} (${room.reply_count} reply${room.reply_count !== 1 ? 's' : ''}, transport=${room.transport})`);
      if (room.join_hint) {
        console.log(`   join: ${room.join_hint}`);
      }
    }
    if (execution.plan_discuss_collab?.card) {
      const card = execution.plan_discuss_collab.card;
      console.log(`🤝 collab: ${card.room_id} [${card.status}] replies=${card.replies}`);
      console.log(`   next: ${card.next}`);
      if (card.last_reply_at) {
        console.log(`   last reply: ${card.last_reply_at}`);
      }
    }
    console.log(`✅ done conditions: ${spec.done_conditions.length}`);
    for (const condition of spec.done_conditions) {
      console.log(`   - [${condition.type}] ${condition.label}`);
    }
    console.log(`➡️ next action: ${state.next_action?.kind} — ${state.next_action?.reason}`);
    if (state.final_summary) {
      console.log(`🧾 summary: ${state.final_summary}`);
    }
    const { loadRunScoreHistory } = await import('./score-history.js');
    const scoreHistory = loadRunScoreHistory(spec.cwd, spec.id);
    const latestScore = scoreHistory?.rounds.at(-1);
    if (latestScore) {
      console.log(`📈 score: ${latestScore.score} (delta ${formatScoreDelta(latestScore.delta_from_previous)})`);
    }
    return;
  }

  if (command === 'resume') {
    const { resumeRun } = await import('./driver.js');
    const cwd = getFlag('--cwd') || process.cwd();
    const { listRuns } = await import('./run-store.js');
    const runId = getFlag('--run-id') || firstPositionalAfterCommand || listRuns(cwd)[0]?.id || '';

    if (!runId.trim()) {
      console.error('❌ no run found to resume');
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
    if (shouldExecute && execution.plan_discuss_room) {
      const room = execution.plan_discuss_room;
      console.log(`🔗 discuss room: ${room.room_id} (${room.reply_count} reply${room.reply_count !== 1 ? 's' : ''})`);
    }
    if (shouldExecute && execution.plan_discuss_collab?.card) {
      const card = execution.plan_discuss_collab.card;
      console.log(`🤝 collab: ${card.room_id} [${card.status}] replies=${card.replies}`);
      console.log(`   next: ${card.next}`);
    }
    if (shouldExecute) {
      const { loadRunScoreHistory } = await import('./score-history.js');
      const latestScore = loadRunScoreHistory(cwd, runId)?.rounds.at(-1);
      if (latestScore) {
        console.log(`📈 score: ${latestScore.score} (delta ${formatScoreDelta(latestScore.delta_from_previous)})`);
      }
    }
    if (!shouldExecute && !isTerminal(rState.status)) {
      console.log(`💡 Use --execute to re-enter the loop`);
    }
    return;
  }

  if (command === 'status') {
    const { listRuns, loadRunPlan, loadRunResult } = await import('./run-store.js');
    const cwd = getFlag('--cwd') || process.cwd();
    const { resolveHiveShellRunId } = await import('./hiveshell-dashboard.js');
    const runId = getFlag('--run-id')
      || firstPositionalAfterCommand
      || resolveHiveShellRunId(cwd)
      || listRuns(cwd)[0]?.id;

    if (runId) {
      const { loadRunSpec, loadRunState } = await import('./run-store.js');
      const sSpec = loadRunSpec(cwd, runId);
      const sState = loadRunState(cwd, runId);
      const plan = loadRunPlan(cwd, runId);
      const result = loadRunResult(cwd, runId);
      const { readLoopProgress } = await import('./loop-progress-store.js');
      const progress = readLoopProgress(cwd, runId);
      const { loadWorkerStatusSnapshot, summarizeWorkerSnapshot } = await import('./worker-status-store.js');
      const workerSnapshot = loadWorkerStatusSnapshot(cwd, runId);
      const { loadRunScoreHistory } = await import('./score-history.js');
      const latestScore = loadRunScoreHistory(cwd, runId)?.rounds.at(-1);

      if (!sSpec || !sState) {
        if (!workerSnapshot && !latestScore) {
          console.error(`❌ run not found: ${runId}`);
          process.exit(1);
        }
        const counts = workerSnapshot ? summarizeWorkerSnapshot(workerSnapshot) : null;
        const inferredStatus = counts
          ? (counts.active > 0 ? 'executing' : counts.failed > 0 ? 'partial' : 'done')
          : 'unknown';
        console.log(`🟡 Run: ${runId}`);
        console.log(`📊 status: ${inferredStatus}`);
        console.log(`🔁 round: ${workerSnapshot?.round ?? latestScore?.round ?? 0}`);
        console.log(`📋 plan tasks: ${workerSnapshot?.workers.length || 0}`);
        console.log('🧪 verification checks: 0');
        console.log('🧾 summary: artifact-only run');
        console.log(`📦 result saved: ${result ? 'yes' : 'no'}`);
        if (counts) {
          console.log(`👷 workers: ${counts.total} total / ${counts.active} active / ${counts.completed} completed / ${counts.failed} failed / ${counts.queued} queued`);
          const firstWorker = workerSnapshot?.workers[0]?.task_id;
          console.log(`💡 inspect workers: ${firstWorker ? `hive workers ${firstWorker}` : 'hive workers'}`);
        }
        if (latestScore) {
          console.log(`📈 latest score: ${latestScore.score} (delta ${formatScoreDelta(latestScore.delta_from_previous)})`);
          console.log('💡 inspect score: hive score');
        }
        return;
      }
      console.log(`🟡 Run: ${runId}`);
      console.log(`📊 status: ${sState.status}`);
      console.log(`🔁 round: ${sState.round}`);
      if (progress) {
        console.log(`🧭 phase: ${progress.phase} — ${progress.reason}`);
      }
      console.log(`📋 plan tasks: ${plan?.tasks.length || 0}`);
      console.log(`🧪 verification checks: ${sState.verification_results.length}`);
      console.log(`🧾 summary: ${sState.final_summary || 'n/a'}`);
      console.log(`📦 result saved: ${result ? 'yes' : 'no'}`);
      if (workerSnapshot) {
        const counts = summarizeWorkerSnapshot(workerSnapshot);
        console.log(`👷 workers: ${counts.total} total / ${counts.active} active / ${counts.completed} completed / ${counts.failed} failed / ${counts.queued} queued`);
        const firstWorker = workerSnapshot.workers[0]?.task_id;
        console.log(`💡 inspect workers: ${firstWorker ? `hive workers ${firstWorker}` : 'hive workers'}`);
        const workerCollabs = workerSnapshot.workers
          .filter((worker) => worker.collab?.card)
          .filter((worker) => worker.collab!.card.room_id !== progress?.collab?.card.room_id)
          .slice(0, 2);
        for (const worker of workerCollabs) {
          const card = worker.collab!.card;
          console.log(`🤝 task collab: ${worker.task_id} -> ${card.room_id} [${card.status}] replies=${card.replies}`);
        }
      }
      if (progress?.collab?.card) {
        const card = progress.collab.card;
        console.log(`🤝 collab: ${card.room_id} [${card.status}] replies=${card.replies}`);
        console.log(`   next: ${card.next}`);
        if (card.last_reply_at) {
          console.log(`   last reply: ${card.last_reply_at}`);
        }
        if (card.join_hint) {
          console.log(`   join: ${card.join_hint}`);
        }
      }
      if (progress?.planner_discuss_conclusion) {
        const pd = progress.planner_discuss_conclusion;
        // Flatten multiline assessment to keep status output concise and single-line
        const flattenedAssessment = pd.overall_assessment
          .replace(/\r?\n/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        console.log(`🧠 planner discuss: ${pd.quality_gate} | ${flattenedAssessment.slice(0, 100)}${flattenedAssessment.length > 100 ? '...' : ''}`);
      }
      if (sState.next_action?.kind === 'request_human') {
        const taskIds = sState.next_action.task_ids?.join(', ') || 'unknown';
        const why = sState.next_action.reason;
        const what = sState.next_action.instructions
          ? `${sState.next_action.instructions} (tasks: ${taskIds})`
          : `Resolve: ${why} (tasks: ${taskIds})`;
        console.log(`🙋 request_human:`);
        console.log(`   why_blocked: ${why.slice(0, 120)}${why.length > 120 ? '...' : ''}`);
        console.log(`   what_needs_human: ${what.slice(0, 120)}${what.length > 120 ? '...' : ''}`);
      }
      if (latestScore) {
        console.log(`📈 latest score: ${latestScore.score} (delta ${formatScoreDelta(latestScore.delta_from_previous)})`);
        console.log('💡 inspect score: hive score');
      }
      return;
    }

    console.error('❌ no run found');
    process.exit(1);
  }

  if (command === 'runs') {
    const { listRuns } = await import('./run-store.js');
    const cwd = getFlag('--cwd') || process.cwd();
    const runs = listRuns(cwd);
    for (const run of runs) {
      console.log(`${run.id}  ${run.state?.status || 'unknown'}  ${run.spec?.goal || '(no goal)'}`);
    }
    return;
  }

  if (command === 'workers') {
    const cwd = getFlag('--cwd') || process.cwd();
    const requestedRunId = getFlag('--run-id');
    let runId = requestedRunId;
    let workerSelector = getFlag('--worker');
    const watch = args.includes('--watch');
    const intervalMs = Number(getFlag('--interval-ms') || 1500);
    const eventLimit = Number(getFlag('--events') || 5);

    if (!runId && firstPositionalAfterCommand && secondPositionalAfterCommand) {
      runId = firstPositionalAfterCommand;
      workerSelector = workerSelector || secondPositionalAfterCommand;
    } else if (!runId && !workerSelector && firstPositionalAfterCommand) {
      const resolvedRunId = await resolveWorkerRunId(cwd);
      if (resolvedRunId) {
        const { findWorkerStatusEntry, loadWorkerStatusSnapshot } = await import('./worker-status-store.js');
        const snapshot = loadWorkerStatusSnapshot(cwd, resolvedRunId);
        if (findWorkerStatusEntry(snapshot, firstPositionalAfterCommand)) {
          workerSelector = firstPositionalAfterCommand;
        } else {
          runId = firstPositionalAfterCommand;
        }
      } else {
        runId = firstPositionalAfterCommand;
      }
    }

    if (!watch) {
      const ok = await printWorkerSnapshot(cwd, runId, eventLimit, workerSelector);
      if (!ok) process.exit(1);
      return;
    }

    while (true) {
      process.stdout.write('\x1Bc');
      console.log(`=== ${new Date().toISOString()} ===`);
      const ok = await printWorkerSnapshot(cwd, runId, eventLimit, workerSelector);
      if (!ok) process.exit(1);
      await sleep(intervalMs);
    }
  }

  if (command === 'score') {
    const cwd = getFlag('--cwd') || process.cwd();
    const runId = getFlag('--run-id') || firstPositionalAfterCommand;
    const ok = await printScoreHistory(cwd, runId);
    if (!ok) process.exit(1);
    return;
  }

  if (command === 'shell' || command === 'dashboard') {
    const cwd = getFlag('--cwd') || process.cwd();
    const runId = getFlag('--run-id') || firstPositionalAfterCommand;
    const watch = args.includes('--watch');
    const intervalMs = Number(getFlag('--interval-ms') || 1500);

    if (!watch) {
      const ok = await printHiveShell(cwd, runId);
      if (!ok) process.exit(1);
      return;
    }

    while (true) {
      process.stdout.write('\x1Bc');
      const ok = await printHiveShell(cwd, runId);
      if (!ok) process.exit(1);
      await sleep(intervalMs);
    }
  }

  if (command === 'watch') {
    const cwd = getFlag('--cwd') || process.cwd();
    const runId = getFlag('--run-id') || firstPositionalAfterCommand;
    const intervalMs = Number(getFlag('--interval-ms') || 1500);

    while (true) {
      process.stdout.write('\x1Bc');
      const ok = await printHiveShell(cwd, runId);
      if (!ok) process.exit(1);
      await sleep(intervalMs);
    }
  }

  if (command === 'compact') {
    const cwd = getFlag('--cwd') || process.cwd();
    const runId = getFlag('--run-id') || firstPositionalAfterCommand;
    const ok = await printCompactPacket(cwd, runId);
    if (!ok) process.exit(1);
    return;
  }

  if (command === 'restore') {
    const cwd = getFlag('--cwd') || process.cwd();
    const ok = await printLatestRestore(cwd);
    if (!ok) process.exit(1);
    return;
  }

  const goalIdx = args.indexOf('--goal');
  const cwdIdx = args.indexOf('--cwd');
  const planIdx = args.indexOf('--plan');
  const translateFlag = args.includes('--translate');

  if (goalIdx < 0 && planIdx < 0) {
    console.log('Usage:');
    console.log('  hive run "Build auth system"');
    console.log('  hive --goal "构建认证系统" --cwd /path --translate');
    console.log('  hive --plan plan.json --cwd /path');
    console.log('  hive status');
    console.log('  hive workers');
    console.log('  hive score');
    console.log('  hive watch');
    console.log('  hive compact');
    console.log('  hive restore');
    console.log('  hive runs');
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
    const { bootstrapRun, executeRun } = await import('./driver.js');
    const { reportResults } = await import('./reporter.js');
    const { saveRunPlan, saveRunState } = await import('./run-store.js');
    const { ModelRegistry } = await import('./model-registry.js');

    const registry = new (ModelRegistry as any)();
    planJson.cwd = cwd;
    const plan = buildPlanFromClaudeOutput(planJson);
    const allowAutoMerge = args.includes('--auto-merge');
    const maxRounds = Number(getFlag('--max-rounds') || 6);
    const { spec, state } = bootstrapRun({
      goal: plan.goal,
      cwd,
      maxRounds,
      allowAutoMerge,
    });
    state.current_plan_id = plan.id;
    saveRunPlan(cwd, spec.id, plan);
    saveRunState(cwd, state);

    console.log(`\n📋 Plan: ${plan.tasks.length} tasks`);
    console.log(`📋 Groups: ${plan.execution_order.map((g: string[]) => `[${g.join(',')}]`).join(' → ')}\n`);

    const execution = await executeRun(spec, state);
    const result = execution.result;
    if (!result) {
      console.log('⚠️ Plan execution finished without result artifact.');
      return;
    }

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
      result,
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

const isMainModule = (() => {
  const invokedPath = process.argv[1];
  if (!invokedPath) return false;
  return path.resolve(invokedPath) === fileURLToPath(import.meta.url);
})();
if (isMainModule) {
  main().catch(err => {
    console.error('❌', err.message);
    process.exit(1);
  });
}
