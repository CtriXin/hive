import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OrchestratorResult, TaskPlan } from '../orchestrator/types.js';
import {
  extractRunnableTaskPlan,
  LATEST_PLAN_ARTIFACT,
  loadLatestPlanPointer,
  relPath,
  resolvePreferredLatestPlanArtifact,
  resolveLatestPlanArtifact,
  saveLatestPlanPointer,
  summarizeDispatchCard,
  summarizeExecutionCard,
  summarizePlanCard,
  writeStableMcpJsonArtifact,
} from '../orchestrator/mcp-surface.js';
import type { RunCompactPacketResult } from '../orchestrator/compact-packet.js';

const tempDirs: string[] = [];
const LATEST_PLAN_POINTER_PATH = path.join(os.homedir(), '.hive', 'latest-plan-pointer.json');
let latestPlanPointerBackup: string | null = null;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mcp-surface-'));
  tempDirs.push(dir);
  return dir;
}

function buildPlan(cwd: string): TaskPlan {
  return {
    id: 'plan-123',
    goal: 'Tighten Hive MCP output',
    cwd,
    created_at: '2026-04-02T14:00:00.000Z',
    execution_order: [['task-a'], ['task-b']],
    context_flow: { 'task-b': ['task-a'] },
    tasks: [
      {
        id: 'task-a',
        description: 'Shrink the host-visible summary so Claude sees a short planning card instead of a long artifact dump.',
        complexity: 'medium',
        category: 'ux',
        assigned_model: 'claude-sonnet',
        assignment_reason: 'Best fit',
        estimated_files: ['mcp-server/index.ts'],
        acceptance_criteria: ['Summary is shorter'],
        discuss_threshold: 0.7,
        depends_on: [],
        review_scale: 'auto',
      },
      {
        id: 'task-b',
        description: 'Update docs.',
        complexity: 'low',
        category: 'docs',
        assigned_model: 'qwen3.5-plus',
        assignment_reason: 'Fast docs pass',
        estimated_files: ['docs/MCP_USAGE.md'],
        acceptance_criteria: ['Docs reflect flow'],
        discuss_threshold: 0.7,
        depends_on: ['task-a'],
        review_scale: 'auto',
      },
    ],
  };
}

function buildCompactPacket(cwd: string): RunCompactPacketResult {
  return {
    runId: 'run-123',
    jsonPath: path.join(cwd, '.ai', 'runs', 'run-123', 'compact-packet.json'),
    markdown: '# packet',
    markdownPath: path.join(cwd, '.ai', 'runs', 'run-123', 'compact-packet.md'),
    restorePromptPath: path.join(cwd, '.ai', 'runs', 'run-123', 'compact-restore-prompt.md'),
    latestJsonPath: path.join(cwd, '.ai', 'restore', 'latest-compact-packet.json'),
    latestMarkdownPath: path.join(cwd, '.ai', 'restore', 'latest-compact-packet.md'),
    latestRestorePromptPath: path.join(cwd, '.ai', 'restore', 'latest-compact-restore-prompt.md'),
    latestRunPath: path.join(cwd, '.ai', 'restore', 'latest-run.txt'),
    packet: {
      version: 1,
      run_id: 'run-123',
      cwd,
      goal: 'Ship cleaner MCP output',
      status: 'executing',
      round: 1,
      summary: 'task-a active',
      next_action: 'execute: keep going',
      room_refs: [
        {
          room_id: 'room-123',
          room_kind: 'plan',
          scope: 'run',
          status: 'collecting',
          replies: 1,
          join_hint: 'agentbus join room-123',
        },
      ],
      worker_focus: [{
        task_id: 'task-a',
        agent_id: 'task-a@run-123',
        status: 'running',
        task_summary: 'Shrinking host-visible tool output',
        transcript_path: '.ai/runs/run-123/workers/task-a.transcript.jsonl',
        collab: {
          room_id: 'room-task-a',
          room_kind: 'task_discuss',
          status: 'closed',
          replies: 1,
          join_hint: 'agentbus join room-task-a',
          focus_task_id: 'task-a',
          next: 'worker discuss complete',
        },
      }],
      suggested_commands: ['hive workers task-a', 'hive status'],
      detail_sources: ['.ai/runs/run-123/state.json'],
      restore_prompt: 'resume here',
    },
  };
}

function buildOrchestratorResult(plan: TaskPlan): OrchestratorResult {
  return {
    plan,
    worker_results: [
      {
        taskId: 'task-a',
        model: 'claude-sonnet',
        worktreePath: '/tmp/task-a',
        branch: 'task-a',
        sessionId: 'sess-a',
        output: [],
        changedFiles: ['mcp-server/index.ts'],
        success: true,
        duration_ms: 1000,
        token_usage: { input: 10, output: 20 },
        discuss_triggered: false,
        discuss_results: [],
      },
      {
        taskId: 'task-b',
        model: 'qwen3.5-plus',
        worktreePath: '/tmp/task-b',
        branch: 'task-b',
        sessionId: 'sess-b',
        output: [],
        changedFiles: ['docs/MCP_USAGE.md'],
        success: false,
        duration_ms: 800,
        token_usage: { input: 8, output: 12 },
        discuss_triggered: false,
        discuss_results: [],
      },
    ],
    review_results: [
      {
        taskId: 'task-a',
        final_stage: 'cross-review',
        passed: true,
        findings: [],
        iterations: 1,
        duration_ms: 120,
      },
      {
        taskId: 'task-b',
        final_stage: 'cross-review',
        passed: false,
        findings: [],
        iterations: 1,
        duration_ms: 140,
      },
    ],
    score_updates: [],
    total_duration_ms: 1800,
    cost_estimate: {
      opus_tokens: 0,
      sonnet_tokens: 30,
      haiku_tokens: 0,
      domestic_tokens: 20,
      estimated_cost_usd: 0.12,
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (latestPlanPointerBackup === null) {
    fs.rmSync(LATEST_PLAN_POINTER_PATH, { force: true });
  } else {
    fs.mkdirSync(path.dirname(LATEST_PLAN_POINTER_PATH), { recursive: true });
    fs.writeFileSync(LATEST_PLAN_POINTER_PATH, latestPlanPointerBackup, 'utf-8');
    latestPlanPointerBackup = null;
  }
});

describe('mcp-surface', () => {
  it('writes and resolves the stable latest plan artifact', () => {
    const cwd = makeTempDir();
    const payload = { plan: buildPlan(cwd) };

    const stablePath = writeStableMcpJsonArtifact(cwd, LATEST_PLAN_ARTIFACT, payload);

    expect(relPath(cwd, stablePath)).toBe('.ai/mcp/latest-plan.json');
    expect(resolveLatestPlanArtifact(cwd)).toBe(stablePath);
    expect(JSON.parse(fs.readFileSync(stablePath, 'utf-8'))).toEqual(payload);
  });

  it('builds a short planning card that points to execute_plan and the stable alias', () => {
    const cwd = makeTempDir();
    const plan = buildPlan(cwd);

    const summary = summarizePlanCard(plan, {
      artifactPath: path.join(cwd, '.ai', 'mcp', 'plan-tasks-1.json'),
      plannerModel: 'claude-opus',
      stablePlanPath: path.join(cwd, '.ai', 'mcp', LATEST_PLAN_ARTIFACT),
      translationModel: 'qwen-translate',
      discussQualityGate: 'pass',
      discussRoom: {
        room_id: 'room-123',
        transport: 'agentbus',
        reply_count: 1,
        timeout_ms: 30000,
        join_hint: 'agentbus join room-123',
        created_at: '2026-04-03T00:00:00.000Z',
      },
      collabCard: {
        room_id: 'room-123',
        room_kind: 'plan',
        status: 'closed',
        replies: 1,
        join_hint: 'agentbus join room-123',
        next: 'planner discuss complete',
      },
      budgetWarning: '$1.25 / $5.00 budget used',
    });

    expect(summary).toContain('Hive plan plan-123 ready.');
    expect(summary).toContain('- result: 2 task(s) via claude-opus');
    expect(summary).toContain('- translated: qwen-translate');
    expect(summary).toContain('- discuss: pass');
    expect(summary).toContain('- budget: $1.25 / $5.00 budget used');
    expect(summary).toContain('- room: room-123 (1 reply(s), join: agentbus join room-123)');
    expect(summary).toContain('- collab: room-123 [closed] replies=1, join: agentbus join room-123');
    expect(summary).toContain('- collab next: planner discuss complete');
    expect(summary).toContain('- focus: task-a | claude-sonnet |');
    expect(summary).toContain('+1 more');
    expect(summary).toContain('- next: execute_plan');
    expect(summary).toContain('- plan: .ai/mcp/latest-plan.json');
    expect(summary).toContain('- artifact: .ai/mcp/plan-tasks-1.json');
  });

  it('extracts only runnable plans from raw or wrapped payloads', () => {
    const cwd = makeTempDir();
    const plan = buildPlan(cwd);

    expect(extractRunnableTaskPlan(plan)).toEqual(plan);
    expect(extractRunnableTaskPlan({ plan, planner_error: null })).toEqual(plan);
    expect(extractRunnableTaskPlan({ plan: null, planner_error: 'bad output' })).toBeNull();
    expect(extractRunnableTaskPlan({ nope: true })).toBeNull();
  });

  it('prefers the saved latest-plan pointer when resolving the next execute_plan target', () => {
    const cwd = makeTempDir();
    const other = makeTempDir();
    latestPlanPointerBackup = fs.existsSync(LATEST_PLAN_POINTER_PATH)
      ? fs.readFileSync(LATEST_PLAN_POINTER_PATH, 'utf-8')
      : null;
    const localPlanPath = writeStableMcpJsonArtifact(cwd, LATEST_PLAN_ARTIFACT, { plan: buildPlan(cwd) });
    const pointedPlanPath = writeStableMcpJsonArtifact(other, LATEST_PLAN_ARTIFACT, { plan: buildPlan(other) });

    saveLatestPlanPointer(other, pointedPlanPath);

    expect(loadLatestPlanPointer()?.plan_path).toBe(pointedPlanPath);
    expect(resolveLatestPlanArtifact(cwd)).toBe(localPlanPath);
    expect(resolvePreferredLatestPlanArtifact(cwd)).toBe(pointedPlanPath);
  });

  it('builds a short execution card with one focus worker and next commands', () => {
    const cwd = makeTempDir();
    const plan = buildPlan(cwd);
    const summary = summarizeExecutionCard(plan, buildOrchestratorResult(plan), {
      reportPath: '.ai/mcp/execute-plan-report-1.md',
      compactPacket: buildCompactPacket(cwd),
      mergeResults: [
        { taskId: 'task-a', merged: true },
        { taskId: 'task-b', merged: false, error: 'review not passed' },
      ],
    });

    expect(summary).toContain('Hive run plan-123 ready.');
    expect(summary).toContain('- result: partial | workers 1/2 | reviews 1/2');
    expect(summary).toContain('- focus: task-a@run-123 | running | Shrinking host-visible tool output');
    expect(summary).toContain('- agent: task-a@run-123');
    expect(summary).toContain('- transcript: .ai/runs/run-123/workers/task-a.transcript.jsonl');
    expect(summary).toContain('- collab: task-a -> room-task-a [closed] replies=1, join: agentbus join room-task-a');
    expect(summary).toContain('- collab next: worker discuss complete');
    expect(summary).toContain('- note: 1 task(s) stayed in worktree for inspection');
    expect(summary).toContain('- next: hive workers task-a | hive status | hive compact');
    expect(summary).toContain('- restore: .ai/restore/latest-compact-restore-prompt.md');
    expect(summary).toContain('- artifact: .ai/mcp/execute-plan-report-1.md');
  });

  it('builds a short dispatch card with fallback and discuss hints inline', () => {
    const cwd = makeTempDir();
    const summary = summarizeDispatchCard({
      taskId: 'task-a',
      model: 'claude-sonnet',
      success: true,
      discuss_triggered: true,
      preflight_fallback: 'claude-opus -> claude-sonnet',
    }, {
      cwd,
      artifactPath: '.ai/mcp/dispatch-task-a-1.json',
      compactPacket: buildCompactPacket(cwd),
    });

    expect(summary).toContain('Hive worker task-a ready.');
    expect(summary).toContain('- result: ok | via claude-sonnet | fallback claude-opus -> claude-sonnet | discuss triggered');
    expect(summary).toContain('- focus: task-a@run-123 | running | Shrinking host-visible tool output');
    expect(summary).toContain('- agent: task-a@run-123');
    expect(summary).toContain('- transcript: .ai/runs/run-123/workers/task-a.transcript.jsonl');
    expect(summary).toContain('- collab: task-a -> room-task-a [closed] replies=1, join: agentbus join room-task-a');
    expect(summary).toContain('- next: hive workers task-a | hive compact');
    expect(summary).toContain('- restore: .ai/restore/latest-compact-restore-prompt.md');
    expect(summary).toContain('- artifact: .ai/mcp/dispatch-task-a-1.json');
  });
});
