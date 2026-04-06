import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RunScoreHistory, RunSpec, RunState, TaskPlan, WorkerStatusSnapshot } from '../orchestrator/types.js';
import type { LoopProgress } from '../orchestrator/loop-progress-store.js';
import { loadCompactPacket, loadLatestCompactRestore, loadWorkspaceCompactPacket } from '../orchestrator/compact-packet.js';

const TMP_DIR = '/tmp/hive-compact-packet-test';
const RUN_ID = 'run-compact-123';

function resetDir(): void {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true });
  }
  fs.mkdirSync(path.join(TMP_DIR, '.ai', 'runs', RUN_ID), { recursive: true });
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

describe('compact-packet', () => {
  beforeEach(() => {
    resetDir();
  });

  afterEach(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true });
    }
  });

  it('builds and persists a compact packet from the latest run artifacts', () => {
    const runDir = path.join(TMP_DIR, '.ai', 'runs', RUN_ID);
    const spec: RunSpec = {
      id: RUN_ID,
      goal: 'Ship compact-aware distill',
      cwd: TMP_DIR,
      mode: 'safe',
      done_conditions: [],
      max_rounds: 4,
      max_worker_retries: 2,
      max_replans: 1,
      allow_auto_merge: false,
      stop_on_high_risk: true,
      created_at: new Date().toISOString(),
    };
    const state: RunState = {
      run_id: RUN_ID,
      status: 'executing',
      round: 2,
      completed_task_ids: ['task-a'],
      failed_task_ids: [],
      retry_counts: {},
      replan_count: 0,
      task_states: {
        'task-c': {
          task_id: 'task-c',
          status: 'merge_blocked',
          round: 2,
          changed_files: ['src/shared.ts'],
          merged: false,
          worker_success: true,
          review_passed: true,
          last_error: 'Merge blocked (overlap_conflict): Overlapping changed file src/shared.ts also touched by: task-d',
        },
      },
      verification_results: [],
      next_action: {
        kind: 'execute',
        reason: 'Continue worker execution',
        task_ids: ['task-b'],
      },
      final_summary: 'worker task-b still running',
      updated_at: new Date().toISOString(),
    };
    const plan: TaskPlan = {
      id: 'plan-compact-1',
      goal: 'Ship compact-aware distill',
      cwd: TMP_DIR,
      tasks: [],
      execution_order: [],
      context_flow: {},
      created_at: new Date().toISOString(),
    };
    const workerSnapshot: WorkerStatusSnapshot = {
      run_id: RUN_ID,
      plan_id: 'plan-compact-1',
      goal: 'Ship compact-aware distill',
      round: 2,
      updated_at: new Date().toISOString(),
      workers: [
        {
          task_id: 'task-b',
          status: 'running',
          assigned_model: 'qwen3-max',
          active_model: 'qwen3-max',
          provider: 'bailian',
          agent_id: 'task-b@run-compact-123',
          discuss_triggered: false,
          updated_at: new Date().toISOString(),
          task_summary: 'Building compact packet view',
          transcript_path: '.ai/runs/run-compact-123/workers/task-b.transcript.jsonl',
          collab: {
            card: {
              room_id: 'room-task-b',
              room_kind: 'task_discuss',
              status: 'closed',
              replies: 1,
              join_hint: 'agentbus join room-task-b',
              focus_task_id: 'task-b',
              next: 'worker discuss complete',
            },
            recent_events: [
              {
                type: 'room:closed',
                room_id: 'room-task-b',
                room_kind: 'task_discuss',
                at: '2026-04-03T00:00:04.000Z',
                reply_count: 1,
                focus_task_id: 'task-b',
              },
            ],
          },
        },
      ],
    };
    const scoreHistory: RunScoreHistory = {
      run_id: RUN_ID,
      goal: 'Ship compact-aware distill',
      updated_at: new Date().toISOString(),
      latest_score: 84,
      best_score: 84,
      rounds: [
        {
          run_id: RUN_ID,
          round: 1,
          action: 'execute',
          status: 'executing',
          created_at: new Date().toISOString(),
          score: 84,
          summary: 'score 84',
          signals: {
            worker_count: 1,
            worker_success_count: 0,
            review_count: 0,
            review_pass_count: 0,
            verification_count: 0,
            verification_pass_count: 0,
            verification_fail_count: 0,
            discuss_triggered_count: 0,
            changed_files_count: 0,
            total_duration_ms: 100,
            total_input_tokens: 10,
            total_output_tokens: 10,
          },
        },
      ],
    };
    const loopProgress: LoopProgress = {
      run_id: RUN_ID,
      round: 2,
      phase: 'discussing',
      reason: 'Planner discuss collecting replies',
      collab: {
        card: {
          room_id: 'room-compact',
          room_kind: 'plan',
          status: 'collecting',
          replies: 1,
          last_reply_at: '2026-04-03T00:00:03.000Z',
          join_hint: 'agentbus join room-compact',
          next: 'waiting for one more reply or timeout',
        },
        recent_events: [
          {
            type: 'room:opened',
            room_id: 'room-compact',
            room_kind: 'plan',
            at: '2026-04-03T00:00:00.000Z',
            reply_count: 0,
          },
        ],
      },
      updated_at: new Date().toISOString(),
    };

    writeJson(path.join(runDir, 'spec.json'), spec);
    writeJson(path.join(runDir, 'state.json'), state);
    writeJson(path.join(runDir, 'plan.json'), plan);
    writeJson(path.join(runDir, 'worker-status.json'), workerSnapshot);
    writeJson(path.join(runDir, 'score-history.json'), scoreHistory);
    writeJson(path.join(runDir, 'advisory-score-history.json'), {
      run_id: RUN_ID,
      updated_at: new Date().toISOString(),
      summary: {
        participant_count: 2,
        reply_count: 2,
        adopted_reply_count: 2,
        avg_score: 88,
      },
      participants: [
        {
          participant_id: 'reviewer-a',
          reply_count: 1,
          adopted_replies: 1,
          avg_score: 91,
          top_score: 91,
          latest_reply_at: '2026-04-03T00:00:03.000Z',
          room_kinds: ['plan'],
          task_ids: [],
        },
        {
          participant_id: 'reviewer-b',
          reply_count: 1,
          adopted_replies: 1,
          avg_score: 85,
          top_score: 85,
          latest_reply_at: '2026-04-03T00:00:04.000Z',
          room_kinds: ['task_discuss'],
          task_ids: ['task-b'],
        },
      ],
      replies: [],
    });
    writeJson(path.join(runDir, 'loop-progress.json'), loopProgress);
    writeJson(path.join(runDir, 'mindkeeper-checkpoint-input.json'), {
      next: ['execute: continue worker task-b'],
      room_refs: [
        {
          room_id: 'room-compact',
          room_kind: 'plan',
          scope: 'run',
          status: 'collecting',
          replies: 1,
          join_hint: 'agentbus join room-compact',
          last_reply_at: '2026-04-03T00:00:03.000Z',
        },
      ],
      bridge_refs: [
        {
          room_id: 'room-compact',
          room_kind: 'plan',
          scope: 'run',
          bridge_kind: 'agent-im',
          thread_kind: 'discord',
          thread_id: 'discord-compact-1',
          status: 'active',
          thread_title: 'Plan Thread',
        },
      ],
    });
    writeJson(path.join(runDir, 'human-bridge-state.json'), {
      bridge_refs: [
        {
          room_id: 'room-task-b',
          room_kind: 'task_discuss',
          scope: 'task',
          bridge_kind: 'agent-im',
          thread_kind: 'session',
          thread_id: 'session-task-b',
          status: 'linked',
          focus_task_id: 'task-b',
          thread_title: 'Task B Discuss',
        },
      ],
    });
    writeJson(path.join(runDir, 'mindkeeper-checkpoint-result.json'), {
      success: true,
      threadId: 'dst-compact-1',
    });

    const result = loadCompactPacket(TMP_DIR);
    expect(result).not.toBeNull();
    expect(result!.packet.run_id).toBe(RUN_ID);
    expect(result!.packet.collab?.room_id).toBe('room-compact');
    expect(result!.packet.collab?.status).toBe('collecting');
    expect(result!.packet.room_refs).toHaveLength(2);
    expect(result!.packet.bridge_refs).toHaveLength(2);
    expect(result!.packet.room_refs[0].room_id).toBe('room-compact');
    expect(result!.packet.room_refs[1].room_id).toBe('room-task-b');
    expect(result!.packet.bridge_refs[0].thread_id).toBe('discord-compact-1');
    expect(result!.packet.bridge_refs[1].thread_id).toBe('session-task-b');
    expect(result!.packet.worker_focus[0].agent_id).toBe('task-b@run-compact-123');
    expect(result!.packet.worker_focus[0].collab?.room_id).toBe('room-task-b');
    expect(result!.packet.advisory_focus).toHaveLength(2);
    expect(result!.packet.advisory_focus[0].participant_id).toBe('reviewer-a');
    expect(result!.packet.merge_blockers).toEqual([
      {
        task_id: 'task-c',
        reason: 'Merge blocked (overlap_conflict): Overlapping changed file src/shared.ts also touched by: task-d',
      },
    ]);
    expect(result!.packet.suggested_commands).toContain('hive workers task-b');
    expect(result!.packet.detail_sources).toContain('.ai/runs/run-compact-123/advisory-score-history.json');
    expect(result!.packet.detail_sources).toContain('.ai/runs/run-compact-123/human-bridge-state.json');
    expect(result!.packet.detail_sources).toContain('.ai/runs/run-compact-123/mindkeeper-checkpoint-input.json');
    expect(result!.packet.detail_sources).toContain('.ai/runs/run-compact-123/loop-progress.json');
    expect(result!.packet.detail_sources).toContain('.ai/plan/current.md');
    expect(result!.packet.restore_prompt).toContain('You are resuming a Hive run after compact/clear/new.');
    expect(result!.packet.restore_prompt).toContain('Collab room: room-compact | collecting | replies=1');
    expect(result!.packet.restore_prompt).toContain('Primary worker collab: room-task-b | closed | replies=1');
    expect(result!.packet.restore_prompt).toContain('Merge blockers:');
    expect(result!.packet.restore_prompt).toContain('- task-c: Merge blocked (overlap_conflict): Overlapping changed file src/shared.ts also touched by: task-d');
    expect(result!.packet.restore_prompt).toContain('Mindkeeper linked rooms:');
    expect(result!.packet.restore_prompt).toContain('room-task-b [task_discuss/closed] replies=1 task=task-b');
    expect(result!.packet.restore_prompt).toContain('Human bridge threads:');
    expect(result!.packet.restore_prompt).toContain('room-task-b -> session:session-task-b [linked] task=task-b title=Task B Discuss');
    expect(result!.packet.restore_prompt).toContain('Advisory scoring:');
    expect(result!.packet.restore_prompt).toContain('reviewer-a avg=91 replies=1 adopted=1/1 kinds=plan');
    expect(result!.packet.restore_prompt).toContain('Recovery order:');
    expect(result!.markdown).toContain('# Hive Compact Packet');
    expect(result!.markdown).toContain('- collab:');
    expect(result!.markdown).toContain('room-compact | collecting | replies=1');
    expect(result!.markdown).toContain('collab: room-task-b | closed | replies=1');
    expect(result!.markdown).toContain('- mindkeeper room refs:');
    expect(result!.markdown).toContain('room-task-b [task_discuss/closed] replies=1 task=task-b');
    expect(result!.markdown).toContain('- human bridge refs:');
    expect(result!.markdown).toContain('room-compact -> discord:discord-compact-1 [active] title=Plan Thread');
    expect(result!.markdown).toContain('- advisory focus:');
    expect(result!.markdown).toContain('reviewer-a avg=91 replies=1 adopted=1/1 kinds=plan');
    expect(result!.markdown).toContain('- merge blockers:');
    expect(result!.markdown).toContain('task-c | Merge blocked (overlap_conflict): Overlapping changed file src/shared.ts also touched by: task-d');
    expect(result!.markdown).toContain('## Restore Prompt');
    expect(result!.markdown).toContain('dst-compact-1');
    expect(fs.existsSync(path.join(runDir, 'compact-packet.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'compact-packet.md'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'compact-restore-prompt.md'))).toBe(true);
    expect(fs.existsSync(path.join(TMP_DIR, '.ai', 'restore', 'latest-compact-packet.json'))).toBe(true);
    expect(fs.existsSync(path.join(TMP_DIR, '.ai', 'restore', 'latest-compact-packet.md'))).toBe(true);
    expect(fs.existsSync(path.join(TMP_DIR, '.ai', 'restore', 'latest-compact-restore-prompt.md'))).toBe(true);
    expect(fs.readFileSync(path.join(TMP_DIR, '.ai', 'restore', 'latest-run.txt'), 'utf-8').trim()).toBe(RUN_ID);

    const latestRestore = loadLatestCompactRestore(TMP_DIR);
    expect(latestRestore).not.toBeNull();
    expect(latestRestore!.runId).toBe(RUN_ID);
    expect(latestRestore!.restorePrompt).toContain('You are resuming a Hive run after compact/clear/new.');
  });

  it('loads latest restore via origin pointer when task root differs', () => {
    const originDir = '/tmp/hive-origin-root-test';
    if (fs.existsSync(originDir)) {
      fs.rmSync(originDir, { recursive: true });
    }
    fs.mkdirSync(originDir, { recursive: true });

    const runDir = path.join(TMP_DIR, '.ai', 'runs', RUN_ID);
    const spec: RunSpec = {
      id: RUN_ID,
      goal: 'Cross-root restore',
      cwd: TMP_DIR,
      origin_cwd: originDir,
      task_cwd: TMP_DIR,
      mode: 'safe',
      done_conditions: [],
      max_rounds: 2,
      max_worker_retries: 1,
      max_replans: 1,
      allow_auto_merge: false,
      stop_on_high_risk: true,
      created_at: new Date().toISOString(),
    };
    const state: RunState = {
      run_id: RUN_ID,
      status: 'planning',
      round: 0,
      completed_task_ids: [],
      failed_task_ids: [],
      retry_counts: {},
      replan_count: 0,
      verification_results: [],
      next_action: { kind: 'execute', reason: 'start', task_ids: [] },
      updated_at: new Date().toISOString(),
    };
    writeJson(path.join(runDir, 'spec.json'), spec);
    writeJson(path.join(runDir, 'state.json'), state);

    loadCompactPacket(TMP_DIR, RUN_ID);
    const pointed = loadLatestCompactRestore(originDir);
    expect(pointed).not.toBeNull();
    expect(pointed!.runId).toBe(RUN_ID);
    expect(pointed!.restorePromptPath).toContain('.ai/restore/latest-compact-restore-prompt.md');

    fs.rmSync(originDir, { recursive: true, force: true });
  });

  it('builds a workspace restore card when no Hive run exists', () => {
    const planDir = path.join(TMP_DIR, '.ai', 'plan');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(
      path.join(planDir, 'current.md'),
      [
        '# Current Plan: Workspace Compact',
        '## Current Goal',
        '- Keep compact usable even without a Hive run',
        '',
        '## Current Stage',
        '- User is editing directly in the repo',
        '- No run artifacts are available yet',
        '',
        '## Highest Priority Next',
        '- Build a workspace restore card fallback',
      ].join('\n'),
      'utf-8',
    );

    const result = loadWorkspaceCompactPacket(TMP_DIR);
    expect(result.packet.goal).toContain('Keep compact usable even without a Hive run');
    expect(result.packet.summary).toContain('User is editing directly in the repo');
    expect(result.packet.restore_prompt).toContain('there is no active Hive run snapshot');
    expect(result.packet.detail_sources).toContain('.ai/plan/current.md');
    expect(result.packet.detail_sources).not.toContain('CLAUDE.md');
    expect(result.markdown).toContain('# Hive Workspace Restore Card');
    expect(fs.existsSync(path.join(TMP_DIR, '.ai', 'restore', 'workspace-compact-packet.json'))).toBe(true);
    expect(fs.existsSync(path.join(TMP_DIR, '.ai', 'restore', 'workspace-compact-restore-prompt.md'))).toBe(true);
    expect(fs.existsSync(path.join(TMP_DIR, '.ai', 'restore', 'latest-compact-restore-prompt.md'))).toBe(true);
    expect(fs.existsSync(path.join(TMP_DIR, '.ai', 'restore', 'latest-run.txt'))).toBe(false);

    const latestRestore = loadLatestCompactRestore(TMP_DIR);
    expect(latestRestore).not.toBeNull();
    expect(latestRestore!.runId).toBeUndefined();
    expect(latestRestore!.restorePrompt).toContain('workspace restore card');
  });
});
