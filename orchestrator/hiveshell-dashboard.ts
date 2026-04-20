import fs from 'fs';
import path from 'path';
import type {
  ExecutionMode,
  HumanBridgeRef,
  MindkeeperRoomRef,
  OrchestratorResult,
  ProviderHealthStoreData,
  RunScoreHistory,
  RunSpec,
  RunState,
  TaskPlan,
  WorkerStatusSnapshot,
} from './types.js';
import type { AdvisoryScoreHistory } from './advisory-score.js';
import type { LoopProgress } from './loop-progress-store.js';
import type { SteeringStore } from './steering-store.js';
import {
  formatAdvisoryParticipant,
  loadAdvisoryScoreHistory,
  topAdvisoryParticipants,
} from './advisory-score.js';
import { collectHumanBridgeRefs, formatHumanBridgeRef } from './human-bridge-linkage.js';
import { collectMindkeeperRoomRefs, formatMindkeeperRoomRef } from './memory-linkage.js';
import { loadRunPlan, loadRunResult, loadRunSpec, loadRunState, listRuns } from './run-store.js';
import { loadRunScoreHistory } from './score-history.js';
import { readLoopProgress } from './loop-progress-store.js';
import { listWorkerStatusSnapshots, loadWorkerStatusSnapshot, summarizeWorkerSnapshot } from './worker-status-store.js';
import { pickWorkerSurfaceSummary } from './worker-surface-summary.js';
import { loadSteeringStore } from './steering-store.js';
import { resolveEffectiveMode } from './mode-policy.js';
import { deriveTaskCues, groupCuesByCategory, cueIcon, cueLabel, type TaskCollabCue } from './collab-cues.js';
import {
  extractLatestProviderRoute,
  formatProviderDecision,
  formatProviderRoute,
  latestProviderDecision,
  summarizeProviderHealth,
} from './provider-surface.js';
import {
  loadRunModelOverrides,
  previewResolvedModelPolicy,
  resolveEffectiveRunModelPolicy,
  type EffectiveRunModelPolicy,
  type RunModelPolicyOverrides,
  type RunModelPolicyPatch,
} from './run-model-policy.js';

interface MindkeeperCheckpointPayload {
  repo: string;
  task: string;
  branch?: string;
  parent?: string;
  cli: string;
  model: string;
  decisions: string[];
  changes: string[];
  findings: string[];
  next: string[];
  status: string;
  room_refs?: MindkeeperRoomRef[];
  bridge_refs?: HumanBridgeRef[];
}

interface MindkeeperBootstrapArtifact {
  activeThread?: {
    id: string;
    task: string;
    status: string;
    nextSteps?: string[];
    decisions?: string[];
  };
  otherThreads?: Array<{
    id: string;
    task: string;
    status: string;
  }>;
}

interface MindkeeperCheckpointResult {
  success: boolean;
  threadId?: string;
  path?: string;
  parent?: string;
  room_refs?: MindkeeperRoomRef[];
  bridge_refs?: HumanBridgeRef[];
}

interface HumanBridgeStateArtifact {
  bridge_refs?: HumanBridgeRef[];
  updated_at?: string;
}

export interface HiveShellDashboardData {
  runId: string;
  cwd: string;
  spec: RunSpec | null;
  state: RunState | null;
  modelPolicy: EffectiveRunModelPolicy;
  modelOverrides: RunModelPolicyOverrides | null;
  previewModelPolicy: EffectiveRunModelPolicy;
  startRunDraft: RunModelPolicyPatch | null;
  loopProgress: LoopProgress | null;
  plan: TaskPlan | null;
  result: OrchestratorResult | null;
  workerSnapshot: WorkerStatusSnapshot | null;
  scoreHistory: RunScoreHistory | null;
  advisoryScoreHistory: AdvisoryScoreHistory | null;
  mindkeeperBootstrap: MindkeeperBootstrapArtifact | null;
  mindkeeperCheckpointInput: MindkeeperCheckpointPayload | null;
  mindkeeperCheckpointResult: MindkeeperCheckpointResult | null;
  humanBridgeState: HumanBridgeStateArtifact | null;
  // Phase 8C: Live watch surface
  providerHealth: ProviderHealthStoreData | null;
  steeringStore: SteeringStore | null;
}

interface MergeBlockerSummary {
  taskId: string;
  reason: string;
}

export interface LatestWorkerDiscussSurface {
  task_id: string;
  agent_id?: string;
  updated_at?: string;
  quality_gate: 'pass' | 'warn' | 'fail' | 'fallback';
  conclusion: string;
}

function runDir(cwd: string, runId: string): string {
  return path.join(cwd, '.ai', 'runs', runId);
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readLines(filePath: string, limit: number): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function truncate(text: string | undefined, limit: number): string {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '-';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

export function selectLatestWorkerDiscuss(
  snapshot: WorkerStatusSnapshot | null | undefined,
): LatestWorkerDiscussSurface | undefined {
  const workers = snapshot?.workers || [];
  const latest = [...workers]
    .filter((worker) => worker.discuss_conclusion)
    .sort((a, b) => {
      const updatedCompare = (b.updated_at || '').localeCompare(a.updated_at || '');
      if (updatedCompare !== 0) return updatedCompare;
      return a.task_id.localeCompare(b.task_id);
    })[0];

  if (!latest?.discuss_conclusion) {
    return undefined;
  }

  return {
    task_id: latest.task_id,
    agent_id: latest.agent_id,
    updated_at: latest.updated_at,
    quality_gate: latest.discuss_conclusion.quality_gate,
    conclusion: latest.discuss_conclusion.conclusion,
  };
}

function repeat(char: string, count: number): string {
  return Array.from({ length: Math.max(0, count) }, () => char).join('');
}

function section(title: string, lines: string[]): string {
  return [
    `== ${title} ==`,
    ...lines,
  ].join('\n');
}

function renderScoreTrend(history: RunScoreHistory | null): string[] {
  if (!history || history.rounds.length === 0) {
    return ['- no score history yet'];
  }

  return history.rounds.map((round) => {
    const filled = Math.max(1, Math.round(round.score / 5));
    const bar = `${repeat('#', filled)}${repeat('.', 20 - filled)}`;
    const delta = typeof round.delta_from_previous === 'number'
      ? `${round.delta_from_previous > 0 ? '+' : ''}${round.delta_from_previous}`
      : 'new';
    return `- r${round.round} ${bar} ${String(round.score).padStart(3, ' ')} (${delta}) ${round.status}`;
  });
}

function renderWorkers(snapshot: WorkerStatusSnapshot | null, limit = 8): string[] {
  if (!snapshot || snapshot.workers.length === 0) {
    return ['- no worker snapshot yet'];
  }

  return snapshot.workers.slice(0, limit).map((worker) => {
    const model = worker.assigned_model === worker.active_model
      ? worker.active_model
      : `${worker.assigned_model} -> ${worker.active_model}`;
    const changeText = typeof worker.changed_files_count === 'number'
      ? ` changed=${worker.changed_files_count}`
      : '';
    const discussText = worker.discuss_triggered ? ' discuss=yes' : '';
    const discussConclusionText = worker.discuss_conclusion
      ? ` [${worker.discuss_conclusion.quality_gate}] ${truncate(worker.discuss_conclusion.conclusion, 60)}`
      : '';
    const routeText = worker.provider_fallback_used
      ? ` fallback=${worker.assigned_model}->${worker.active_model}`
      : worker.provider_failure_subtype
        ? ` fail=${worker.provider_failure_subtype}`
        : '';
    const summary = pickWorkerSurfaceSummary(worker.task_summary, worker.last_message) || '-';
    return `- ${worker.task_id} [${worker.status}] ${model}${changeText}${discussText}${routeText}${discussConclusionText} | ${truncate(summary, 90)}`;
  });
}

function collectMergeBlockers(state: RunState | null): MergeBlockerSummary[] {
  if (!state?.task_states) {
    return [];
  }

  return Object.values(state.task_states)
    .filter((task) => task.status === 'merge_blocked')
    .map((task) => ({
      taskId: task.task_id,
      reason: task.last_error || 'Merge blocked',
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
}

function renderAuthority(data: HiveShellDashboardData): string[] {
  const reviews = data.result?.review_results || [];
  if (reviews.length === 0) {
    return ['- no review authority result yet'];
  }

  return reviews.map((review) => {
    const authority = review.authority;
    const parts = [
      `${review.taskId} ${review.verdict === 'BLOCKED' ? '[blocked]' : review.passed ? '[pass]' : '[fail]'}`,
      `stage=${review.final_stage}`,
    ];
    if (authority?.source) parts.push(`authority=${authority.source}`);
    if (authority?.mode) parts.push(`mode=${authority.mode}`);
    if (authority?.members?.length) parts.push(`members=${authority.members.join('+')}`);
    if (authority?.synthesized_by) parts.push(`synth=${authority.synthesized_by}`);
    else if (authority?.synthesis_strategy === 'heuristic') parts.push('synth=heuristic');
    else if (authority?.synthesis_attempted_by) parts.push(`synth=blocked(${authority.synthesis_attempted_by})`);
    if (authority?.disagreement_flags?.length) parts.push(`disagreement=${authority.disagreement_flags.join(',')}`);
    return `- ${parts.join(' | ')}`;
  });
}

function renderAdvisory(data: HiveShellDashboardData): string[] {
  const history = data.advisoryScoreHistory;
  if (!history || history.summary.reply_count === 0) {
    return ['- advisory scoring artifacts not found'];
  }

  const lines = [
    `- participants: ${history.summary.participant_count}`,
    `- replies: ${history.summary.reply_count}`,
    `- adopted replies: ${history.summary.adopted_reply_count}`,
    `- avg advisory score: ${history.summary.avg_score}`,
  ];
  for (const participant of topAdvisoryParticipants(history, 4)) {
    lines.push(`- advisor: ${truncate(formatAdvisoryParticipant(participant), 96)}`);
  }
  return lines;
}

function renderMindkeeper(data: HiveShellDashboardData): string[] {
  const lines: string[] = [];
  const roomRefs = collectMindkeeperRoomRefs({
    loopProgress: data.loopProgress,
    workerSnapshot: data.workerSnapshot,
    checkpointInputRoomRefs: data.mindkeeperCheckpointInput?.room_refs,
    checkpointResultRoomRefs: data.mindkeeperCheckpointResult?.room_refs,
  });
  const activeThread = data.mindkeeperBootstrap?.activeThread;
  if (activeThread) {
    lines.push(`- thread: ${activeThread.id}`);
    lines.push(`- previous: ${truncate(activeThread.task, 96)}`);
    lines.push(`- status: ${truncate(activeThread.status, 96)}`);
    for (const step of activeThread.nextSteps?.slice(0, 3) || []) {
      lines.push(`- next: ${truncate(step, 96)}`);
    }
  }

  if (data.mindkeeperCheckpointResult?.threadId) {
    lines.push(`- checkpoint: ${data.mindkeeperCheckpointResult.threadId}`);
  }

  if (data.mindkeeperCheckpointInput?.next?.length) {
    for (const next of data.mindkeeperCheckpointInput.next.slice(0, 2)) {
      lines.push(`- carry: ${truncate(next, 96)}`);
    }
  }

  if (roomRefs.length > 0) {
    lines.push(`- linked rooms: ${roomRefs.length}`);
    for (const ref of roomRefs.slice(0, 4)) {
      lines.push(`- room link: ${truncate(formatMindkeeperRoomRef(ref), 96)}`);
    }
  }

  return lines.length > 0 ? lines : ['- mindkeeper artifacts not found'];
}

function renderHumanBridge(data: HiveShellDashboardData): string[] {
  const bridgeRefs = collectHumanBridgeRefs({
    bridgeStateRefs: data.humanBridgeState?.bridge_refs,
    checkpointInputBridgeRefs: data.mindkeeperCheckpointInput?.bridge_refs,
    checkpointResultBridgeRefs: data.mindkeeperCheckpointResult?.bridge_refs,
  });

  if (bridgeRefs.length === 0) {
    return ['- human bridge artifacts not found'];
  }

  const lines = [`- linked threads: ${bridgeRefs.length}`];
  for (const ref of bridgeRefs.slice(0, 4)) {
    lines.push(`- thread link: ${truncate(formatHumanBridgeRef(ref), 96)}`);
  }
  return lines;
}

// Phase 8C: Steering visibility
function renderSteering(data: HiveShellDashboardData): string[] {
  const store = data.steeringStore;
  if (!store || store.actions.length === 0) {
    return ['- no steering actions'];
  }

  const state = data.state;
  const isPaused = state?.steering?.paused ?? false;
  const pending = store.actions.filter((a) => a.status === 'pending');
  const applied = store.actions.filter((a) => a.status === 'applied').reverse();
  const rejected = store.actions.filter((a) => a.status === 'rejected').reverse();

  const lines: string[] = [];
  if (isPaused) lines.push('\u23F8\uFE0F run PAUSED');
  if (pending.length > 0) lines.push(`pending: ${pending.length} action(s)`);

  if (applied[0]) {
    lines.push(`applied: ${applied[0].action_type} | ${truncate(applied[0].outcome, 80)}`);
  }
  if (rejected[0]) {
    lines.push(`rejected: ${rejected[0].action_type} | ${truncate(rejected[0].outcome, 80)}`);
  }

  const recent = store.actions.slice(-4);
  for (const a of recent) {
    const icon = a.status === 'applied' ? '\u2705' : a.status === 'rejected' ? '\u26D4' : a.status === 'suppressed' ? '\uD83D\uDD07' : '\u23F3';
    lines.push(`${icon} ${a.action_type}${a.task_id ? ` \u2192 ${a.task_id}` : ''} [${a.status}]`);
  }

  return lines;
}

// Phase 8C: Provider health visibility
function renderProviderHealth(data: HiveShellDashboardData): string[] {
  const healthData = data.providerHealth;
  if (!healthData || Object.keys(healthData.providers).length === 0) {
    return ['- no provider health data'];
  }

  const entries = Object.entries(healthData.providers);
  const lines: string[] = [];
  lines.push(summarizeProviderHealth(healthData) || `${entries.length} total`);

  const unhealthy = entries.filter(([, s]) => s.breaker !== 'healthy');
  if (unhealthy.length > 0) {
    for (const [provider, state] of unhealthy) {
      const icon = state.breaker === 'degraded' ? '\uD83D\uDFE1' : state.breaker === 'open' ? '\uD83D\uDD34' : '\uD83D\uDFE0';
      lines.push(`${icon} ${provider}: ${state.breaker}${state.last_failure_subtype ? ` (${state.last_failure_subtype})` : ''}`);
    }
  }
  const latestDecision = formatProviderDecision(latestProviderDecision(healthData));
  if (latestDecision) {
    lines.push(`latest resilience: ${latestDecision}`);
  }

  const latestRoute = formatProviderRoute(
    extractLatestProviderRoute({
      reviewResults: data.result?.review_results,
      providerHealth: healthData,
    }),
  );
  if (latestRoute) {
    lines.push(`latest route: ${latestRoute}`);
  }

  return lines;
}

// Phase 8C: Mode escalation visibility
function renderModeEscalation(data: HiveShellDashboardData): string[] {
  const history = data.state?.mode_escalation_history;
  if (!history || history.length === 0) {
    return ['- no mode escalation'];
  }

  return history.map(
    (e) => `round ${e.round}: ${e.from} \u2192 ${e.to} | ${truncate(e.reason, 90)}`,
  );
}

// Phase 8C / 8D: Current mode display with effective mode resolver
function renderCurrentMode(data: HiveShellDashboardData): string[] {
  const spec = data.spec;
  const state = data.state;
  const effective = spec && state ? resolveEffectiveMode(spec, state) : null;
  const normalizedMode = effective?.normalized ?? 'execute-standard';
  const rawMode = effective?.mode ?? (spec?.execution_mode ?? 'auto') as ExecutionMode;
  const escalated = (state?.mode_escalation_history?.length ?? 0) > 0;
  const overrideLabel = effective?.overridden ? ` (steered from ${rawMode})` : rawMode !== normalizedMode ? ` (normalized from ${rawMode})` : '';
  const lines = [`- mode: ${normalizedMode}${overrideLabel}${escalated ? ' [ESCALATED]' : ''}`];

  if (spec?.lane) {
    lines.push(`- lane: ${spec.lane}`);
  }

  return lines;
}

function policyStageModelLabel(value: unknown): string {
  const record = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  const model = record.model;
  if (Array.isArray(model)) return model.join(',');
  return String(model ?? '-');
}

function policyStageFallbackLabel(value: unknown): string {
  const record = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  return typeof record.fallback === 'string' && record.fallback ? ` fallback=${record.fallback}` : '';
}

function renderModelPolicy(data: HiveShellDashboardData): string[] {
  const modelPolicy = data.modelPolicy || previewResolvedModelPolicy(data.cwd);
  const lines: string[] = [];
  lines.push('Base Policy');
  for (const stage of modelPolicy.stages) {
    lines.push(`- ${stage.stage}: ${policyStageModelLabel(stage.config)}${policyStageFallbackLabel(stage.config)}`);
  }
  lines.push('Run Override');
  lines.push(`- start-run: ${data.modelOverrides?.start_time ? 'present' : 'none'}`);
  lines.push(`- runtime-next-stage: ${data.modelOverrides?.runtime_next_stage ? 'present' : 'none'}`);
  lines.push('Effective Policy');
  lines.push(`- override: ${modelPolicy.override_active ? 'active' : 'inactive'}`);
  if (modelPolicy.override_summary) {
    lines.push(`- summary: ${truncate(modelPolicy.override_summary, 120)}`);
  }
  for (const stage of modelPolicy.stages) {
    const model = policyStageModelLabel(stage.effective);
    const fallback = policyStageFallbackLabel(stage.effective);
    const source = stage.overridden ? ` source=${stage.source}` : ' source=default';
    lines.push(`- ${stage.stage}: ${model}${fallback}${source}`);
  }
  return lines;
}

function renderOverrideArtifacts(data: HiveShellDashboardData): string[] {
  const modelPolicy = data.modelPolicy || previewResolvedModelPolicy(data.cwd);
  const lines: string[] = [];
  const start = data.modelOverrides?.start_time;
  const runtime = data.modelOverrides?.runtime_next_stage;
  lines.push(`start-run override: ${start ? 'present' : 'none'}`);
  lines.push(`runtime next-stage override: ${runtime ? 'present' : 'none'}`);
  lines.push(`override active: ${modelPolicy.override_active ? 'yes' : 'no'}`);
  if (runtime) {
    lines.push('Apply to next round');
    lines.push('Apply on next review stage');
    lines.push('Apply on next replan');
    lines.push('This does not affect currently running workers');
  }
  return lines;
}

function renderStartRunControls(data: HiveShellDashboardData): string[] {
  const previewPolicy = data.previewModelPolicy || previewResolvedModelPolicy(data.cwd, data.startRunDraft || undefined);
  const lines: string[] = [];
  lines.push('Start Run');
  lines.push('fields: goal / mode / model policy override');
  lines.push('actions: Start run with override / Preview Effective Model Policy');
  for (const stage of previewPolicy.stages) {
    const model = policyStageModelLabel(stage.effective);
    lines.push(`- preview ${stage.stage}: ${model}${stage.overridden ? ' [override]' : ''}`);
  }
  return lines;
}

function renderTuneCurrentRun(data: HiveShellDashboardData): string[] {
  const lines: string[] = [];
  lines.push('Tune Current Run');
  lines.push('fields: next planner / next executor / next reviewer tiers / next discuss');
  lines.push('actions: Update run-scoped override / Update next-stage override / Reset override to default');
  lines.push('Apply to next round');
  lines.push('Apply on next review stage');
  lines.push('Apply on next replan');
  lines.push('This does not affect currently running workers');
  return lines;
}

function renderOverview(data: HiveShellDashboardData): string[] {
  const spec = data.spec;
  const state = data.state;
  const progress = data.loopProgress;
  const score = data.scoreHistory?.rounds.at(-1);
  const workers = data.workerSnapshot ? summarizeWorkerSnapshot(data.workerSnapshot) : null;
  const mergeBlockers = collectMergeBlockers(state);
  const goal = spec?.goal || data.workerSnapshot?.goal || '-';
  const round = state?.round ?? data.workerSnapshot?.round ?? 0;
  const summary = state?.final_summary || (data.workerSnapshot ? 'artifact-backed run' : undefined);

  const modelPolicy = data.modelPolicy || previewResolvedModelPolicy(data.cwd);
  const lines = [
    `- run: ${data.runId}`,
    `- goal: ${truncate(goal, 110)}`,
    `- status: ${state?.status || 'unknown'}`,
    `- round: ${round}${spec ? ` / ${spec.max_rounds}` : ''}`,
    `- phase: ${progress ? `${progress.phase} | ${truncate(progress.reason, 96)}` : 'n/a'}`,
    `- next: ${state?.next_action ? `${state.next_action.kind} - ${truncate(state.next_action.reason, 90)}` : '-'}`,
    `- summary: ${truncate(summary, 110)}`,
    `- score: ${score ? `${score.score} (best ${data.scoreHistory?.best_score ?? score.score})` : 'n/a'}`,
    `- workers: ${workers ? `${workers.total} total / ${workers.active} active / ${workers.completed} completed / ${workers.failed} failed` : 'n/a'}`,
    `- model override: ${modelPolicy.override_active ? 'active' : 'inactive'}`,
  ];

  if (modelPolicy.override_summary) {
    lines.push(`- override summary: ${truncate(modelPolicy.override_summary, 110)}`);
  }

  if (progress?.planner_discuss_conclusion) {
    lines.push(`- planner discuss: ${progress.planner_discuss_conclusion.quality_gate} | ${truncate(progress.planner_discuss_conclusion.overall_assessment, 90)}`);
  }

  const latestWorkerDiscuss = selectLatestWorkerDiscuss(data.workerSnapshot);
  if (latestWorkerDiscuss) {
    lines.push(`- worker discuss: ${latestWorkerDiscuss.task_id} | ${latestWorkerDiscuss.quality_gate} | ${truncate(latestWorkerDiscuss.conclusion, 90)}`);
  }

  if (state?.next_action?.kind === 'request_human') {
    const taskIds = state.next_action.task_ids?.join(', ') || 'unknown';
    const why = state.next_action.reason;
    const what = state.next_action.instructions
      ? `${state.next_action.instructions} (tasks: ${taskIds})`
      : `Resolve: ${why} (tasks: ${taskIds})`;
    lines.push(
      `- 🙋 request_human:`,
      `   why_blocked: ${truncate(why, 100)}`,
      `   what_needs_human: ${truncate(what, 100)}`,
    );
  }

  if (mergeBlockers.length > 0) {
    lines.push(`- merge blockers: ${mergeBlockers.map((item) => item.taskId).join(', ')}`);
  }

  return lines;
}

function renderMergeBlockers(data: HiveShellDashboardData): string[] {
  const blockers = collectMergeBlockers(data.state);
  if (blockers.length === 0) {
    return ['- no merge blockers'];
  }

  return blockers.map((blocker) => `- ${blocker.taskId} | ${truncate(blocker.reason, 120)}`);
}

function renderCollab(data: HiveShellDashboardData): string[] {
  const card = data.loopProgress?.collab?.card;
  const events = data.loopProgress?.collab?.recent_events || [];
  const workerCards = (data.workerSnapshot?.workers || [])
    .filter((worker) => worker.collab?.card)
    .filter((worker) => worker.collab!.card.room_id !== card?.room_id)
    .slice(0, 3);
  if (!card && workerCards.length === 0) {
    return ['- no collaboration snapshot yet'];
  }

  const lines: string[] = [];

  if (card) {
    lines.push(
      `- room: ${card.room_id} [${card.status}]`,
      `- replies: ${card.replies}`,
      `- next: ${truncate(card.next, 96)}`,
    );
  }

  if (card?.last_reply_at) {
    lines.push(`- last reply: ${card.last_reply_at}`);
  }
  if (card?.join_hint) {
    lines.push(`- join: ${truncate(card.join_hint, 96)}`);
  }
  for (const event of events.slice(-4)) {
    lines.push(`- event: ${event.at} ${event.type}${typeof event.reply_count === 'number' ? ` (#${event.reply_count})` : ''}${event.note ? ` | ${truncate(event.note, 72)}` : ''}`);
  }
  for (const worker of workerCards) {
    const workerCard = worker.collab!.card;
    lines.push(`- task collab: ${worker.task_id} -> ${workerCard.room_id} [${workerCard.status}] replies=${workerCard.replies}`);
    lines.push(`- task next: ${truncate(workerCard.next, 96)}`);
  }

  return lines;
}

// Phase 10A: Collaboration cues surface
function renderCollabCues(data: HiveShellDashboardData): string[] {
  const taskStates = data.state?.task_states;
  if (!taskStates || Object.keys(taskStates).length === 0) {
    return ['- no task states yet'];
  }

  const steeringActions = data.steeringStore?.actions || [];
  const cues = deriveTaskCues({
    taskStates,
    steeringActions,
    nextAction: data.state?.next_action,
    providerHealth: data.providerHealth,
  });

  const groups = groupCuesByCategory(cues);
  const activeCues = cues.filter((c) => c.cue !== 'ready' && c.cue !== 'passive');

  if (activeCues.length === 0 && groups.ready.length === 0) {
    return ['- no active collaboration signals'];
  }

  const lines: string[] = [];

  // Cue distribution
  const distParts: string[] = [];
  for (const cue of ['needs_human', 'blocked', 'needs_review', 'watch', 'ready'] as const) {
    if (groups[cue].length > 0) {
      distParts.push(`${cueIcon(cue)} ${cueLabel(cue)}:${groups[cue].length}`);
    }
  }
  if (distParts.length > 0) {
    lines.push(`- cues: ${distParts.join(' | ')}`);
  }

  // Top attention items
  for (const cue of activeCues.slice(0, 5)) {
    lines.push(`- ${cueIcon(cue.cue)} ${cue.task_id}: ${truncate(cue.reason, 96)}`);
  }

  return lines.length > 0 ? lines : ['- no active collaboration signals'];
}

function renderArtifacts(cwd: string, runId: string): string[] {
  const dir = runDir(cwd, runId);
  const files = [
    'worker-status.json',
    'worker-events.jsonl',
    'score-history.json',
    'advisory-score-history.json',
    'human-bridge-state.json',
    'mindkeeper-bootstrap.json',
    'mindkeeper-checkpoint-input.json',
    'mindkeeper-checkpoint-result.json',
  ];

  return files
    .filter((file) => fs.existsSync(path.join(dir, file)))
    .map((file) => `- ${path.join(dir, file)}`);
}

function renderRecentEvents(cwd: string, runId: string, limit = 5): string[] {
  const eventsFile = path.join(runDir(cwd, runId), 'worker-events.jsonl');
  const rawLines = readLines(eventsFile, 200);
  if (rawLines.length === 0) {
    return ['- no worker events yet'];
  }

  return rawLines
    .slice(-limit)
    .map((line) => {
      const parsed = JSON.parse(line) as {
        timestamp?: string;
        task_id?: string;
        status?: string;
        message?: string;
      };
      return `- ${parsed.timestamp || '-'} ${parsed.task_id || '-'} [${parsed.status || '-'}] ${truncate(parsed.message, 88)}`;
    });
}

export function resolveHiveShellRunId(cwd: string, runId?: string): string | null {
  if (runId) return runId;
  const workerRun = listWorkerStatusSnapshots(cwd)[0]?.run_id;
  if (workerRun) return workerRun;
  return listRuns(cwd)[0]?.id || null;
}

export function loadHiveShellDashboard(
  cwd: string,
  runId?: string,
): HiveShellDashboardData | null {
  const resolvedRunId = resolveHiveShellRunId(cwd, runId);
  if (!resolvedRunId) return null;

  const dir = runDir(cwd, resolvedRunId);
  return {
    runId: resolvedRunId,
    cwd,
    spec: loadRunSpec(cwd, resolvedRunId),
    state: loadRunState(cwd, resolvedRunId),
    modelPolicy: resolveEffectiveRunModelPolicy(cwd, resolvedRunId),
    modelOverrides: loadRunModelOverrides(cwd, resolvedRunId),
    previewModelPolicy: previewResolvedModelPolicy(cwd),
    startRunDraft: null,
    loopProgress: readLoopProgress(cwd, resolvedRunId),
    plan: loadRunPlan(cwd, resolvedRunId),
    result: loadRunResult(cwd, resolvedRunId),
    workerSnapshot: loadWorkerStatusSnapshot(cwd, resolvedRunId),
    scoreHistory: loadRunScoreHistory(cwd, resolvedRunId),
    advisoryScoreHistory: loadAdvisoryScoreHistory(cwd, resolvedRunId),
    mindkeeperBootstrap: readJson<MindkeeperBootstrapArtifact>(path.join(dir, 'mindkeeper-bootstrap.json')),
    mindkeeperCheckpointInput: readJson<MindkeeperCheckpointPayload>(path.join(dir, 'mindkeeper-checkpoint-input.json')),
    mindkeeperCheckpointResult: readJson<MindkeeperCheckpointResult>(path.join(dir, 'mindkeeper-checkpoint-result.json')),
    humanBridgeState: readJson<HumanBridgeStateArtifact>(path.join(dir, 'human-bridge-state.json')),
    // Phase 8C: Live watch surface
    providerHealth: readJson<ProviderHealthStoreData>(path.join(dir, 'provider-health.json')),
    steeringStore: loadSteeringStore(cwd, resolvedRunId),
  };
}

export function renderHiveShellDashboard(
  data: HiveShellDashboardData,
): string {
  const sections = [
    section('HiveShell', [
      `cwd: ${data.cwd}`,
      `updated: ${new Date().toISOString()}`,
    ]),
    section('Run Overview', renderOverview(data)),
    section('Model Policy', renderModelPolicy(data)),
    section('Override Artifacts', renderOverrideArtifacts(data)),
    section('Start Run', renderStartRunControls(data)),
    section('Tune Current Run', renderTuneCurrentRun(data)),
    section('Mode', renderCurrentMode(data)),
    section('Collab', renderCollab(data)),
    section('Collab Cues', renderCollabCues(data)),
    section('Advisory', renderAdvisory(data)),
    section('Authority', renderAuthority(data)),
    section('Score Trend', renderScoreTrend(data.scoreHistory)),
    section('Workers', renderWorkers(data.workerSnapshot)),
    section('Merge Blockers', renderMergeBlockers(data)),
    section('Steering', renderSteering(data)),
    section('Provider Health', renderProviderHealth(data)),
    section('Mode Escalation', renderModeEscalation(data)),
    section('Human Bridge', renderHumanBridge(data)),
    section('Mindkeeper', renderMindkeeper(data)),
    section('Recent Events', renderRecentEvents(data.cwd, data.runId)),
    section('Artifacts', renderArtifacts(data.cwd, data.runId)),
  ];

  return sections.join('\n\n');
}
