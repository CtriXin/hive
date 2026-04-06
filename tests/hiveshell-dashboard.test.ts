import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { OrchestratorResult, RunScoreHistory, RunSpec, RunState, TaskPlan, WorkerStatusSnapshot } from '../orchestrator/types.js';
import { loadHiveShellDashboard, renderHiveShellDashboard, resolveHiveShellRunId } from '../orchestrator/hiveshell-dashboard.js';
import type { LoopProgress } from '../orchestrator/loop-progress-store.js';

const TMP_DIR = '/tmp/hive-hiveshell-dashboard-test';
const RUN_ID = 'run-shell-123';

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

describe('hiveshell-dashboard', () => {
  beforeEach(() => {
    resetDir();
  });

  afterEach(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true });
    }
  });

  it('loads and renders a combined dashboard from run artifacts', () => {
    const runDir = path.join(TMP_DIR, '.ai', 'runs', RUN_ID);
    const spec: RunSpec = {
      id: RUN_ID,
      goal: 'Ship hiveshell UI',
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
      status: 'partial',
      round: 2,
      completed_task_ids: ['task-a'],
      failed_task_ids: ['task-b'],
      retry_counts: {},
      replan_count: 0,
      task_states: {
        'task-b': {
          task_id: 'task-b',
          status: 'merge_blocked',
          round: 2,
          changed_files: ['src/task-b.ts'],
          merged: false,
          worker_success: true,
          review_passed: true,
          last_error: 'Merge blocked (overlap_conflict): Overlapping changed file src/task-b.ts also touched by: task-c',
        },
      },
      verification_results: [],
      next_action: {
        kind: 'repair_task',
        reason: 'repair task-b',
        task_ids: ['task-b'],
      },
      final_summary: '1 task needs repair',
      updated_at: new Date().toISOString(),
    };
    const plan: TaskPlan = {
      id: 'plan-1',
      goal: 'Ship hiveshell UI',
      cwd: TMP_DIR,
      tasks: [],
      execution_order: [],
      context_flow: {},
      created_at: new Date().toISOString(),
    };
    const workerSnapshot: WorkerStatusSnapshot = {
      run_id: RUN_ID,
      plan_id: 'plan-1',
      goal: 'Ship hiveshell UI',
      round: 2,
      updated_at: new Date().toISOString(),
      workers: [
        {
          task_id: 'task-a',
          status: 'completed',
          assigned_model: 'qwen3-max',
          active_model: 'qwen3-max',
          provider: 'bailian',
          discuss_triggered: false,
          updated_at: new Date().toISOString(),
          changed_files_count: 2,
          success: true,
          last_message: 'completed successfully',
          collab: {
            card: {
              room_id: 'room-task-a',
              room_kind: 'task_discuss',
              status: 'closed',
              replies: 1,
              join_hint: 'agentbus join room-task-a',
              focus_task_id: 'task-a',
              next: 'worker discuss complete',
            },
            recent_events: [
              {
                type: 'room:closed',
                room_id: 'room-task-a',
                room_kind: 'task_discuss',
                at: '2026-04-03T00:00:04.000Z',
                reply_count: 1,
                focus_task_id: 'task-a',
              },
            ],
          },
        },
      ],
    };
    const scoreHistory: RunScoreHistory = {
      run_id: RUN_ID,
      goal: 'Ship hiveshell UI',
      updated_at: new Date().toISOString(),
      latest_score: 82,
      best_score: 82,
      rounds: [
        {
          run_id: RUN_ID,
          round: 1,
          action: 'execute',
          status: 'partial',
          created_at: new Date().toISOString(),
          score: 70,
          summary: 'score 70',
          signals: {
            worker_count: 1,
            worker_success_count: 1,
            review_count: 1,
            review_pass_count: 0,
            verification_count: 1,
            verification_pass_count: 1,
            verification_fail_count: 0,
            discuss_triggered_count: 0,
            changed_files_count: 1,
            total_duration_ms: 100,
            total_input_tokens: 10,
            total_output_tokens: 10,
          },
        },
        {
          run_id: RUN_ID,
          round: 2,
          action: 'repair_task',
          status: 'partial',
          created_at: new Date().toISOString(),
          score: 82,
          delta_from_previous: 12,
          summary: 'score 82',
          signals: {
            worker_count: 1,
            worker_success_count: 1,
            review_count: 1,
            review_pass_count: 1,
            verification_count: 1,
            verification_pass_count: 1,
            verification_fail_count: 0,
            discuss_triggered_count: 0,
            changed_files_count: 2,
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
          room_id: 'room-shell',
          room_kind: 'plan',
          status: 'collecting',
          replies: 1,
          last_reply_at: '2026-04-03T00:00:02.000Z',
          join_hint: 'agentbus join room-shell',
          next: 'wait for more replies or timeout',
        },
        recent_events: [
          {
            type: 'reply:arrived',
            room_id: 'room-shell',
            room_kind: 'plan',
            at: '2026-04-03T00:00:02.000Z',
            reply_count: 1,
            note: 'Reply from reviewer-a',
          },
        ],
      },
      updated_at: new Date().toISOString(),
    };
    const result: OrchestratorResult = {
      plan,
      worker_results: [],
      review_results: [
        {
          taskId: 'task-a',
          final_stage: 'cross-review',
          passed: false,
          findings: [],
          iterations: 2,
          duration_ms: 100,
          authority: {
            source: 'authority-layer',
            mode: 'pair',
            members: ['kimi-k2.5', 'MiniMax-M2.5'],
            disagreement_flags: ['conclusion_opposite'],
            synthesized_by: 'gpt-5.4',
            synthesis_strategy: 'model',
          },
        },
      ],
      score_updates: [],
      total_duration_ms: 1000,
      cost_estimate: {
        opus_tokens: 0,
        sonnet_tokens: 0,
        haiku_tokens: 0,
        domestic_tokens: 100,
        estimated_cost_usd: 0.01,
      },
    };

    writeJson(path.join(runDir, 'spec.json'), spec);
    writeJson(path.join(runDir, 'state.json'), state);
    writeJson(path.join(runDir, 'plan.json'), plan);
    writeJson(path.join(runDir, 'result.json'), result);
    writeJson(path.join(runDir, 'loop-progress.json'), loopProgress);
    writeJson(path.join(runDir, 'worker-status.json'), workerSnapshot);
    writeJson(path.join(runDir, 'score-history.json'), scoreHistory);
    writeJson(path.join(runDir, 'advisory-score-history.json'), {
      run_id: RUN_ID,
      updated_at: new Date().toISOString(),
      summary: {
        participant_count: 1,
        reply_count: 1,
        adopted_reply_count: 1,
        avg_score: 92,
      },
      participants: [
        {
          participant_id: 'reviewer-a',
          reply_count: 1,
          adopted_replies: 1,
          avg_score: 92,
          top_score: 92,
          latest_reply_at: '2026-04-03T00:00:02.000Z',
          room_kinds: ['plan'],
          task_ids: [],
        },
      ],
      replies: [
        {
          participant_id: 'reviewer-a',
          room_id: 'room-shell',
          room_kind: 'plan',
          run_id: RUN_ID,
          received_at: '2026-04-03T00:00:02.000Z',
          response_time_ms: 120,
          content_length: 88,
          quality_gate: 'pass',
          timeliness: 1,
          substance: 0.68,
          adoption: 1,
          score: 92,
        },
      ],
    });
    writeJson(path.join(runDir, 'mindkeeper-bootstrap.json'), {
      activeThread: {
        id: 'dst-1',
        task: 'previous task',
        status: 'active',
        nextSteps: ['step one'],
      },
    });
    writeJson(path.join(runDir, 'mindkeeper-checkpoint-input.json'), {
      next: ['repair_task: repair task-b'],
      room_refs: [
        {
          room_id: 'room-shell',
          room_kind: 'plan',
          scope: 'run',
          status: 'collecting',
          replies: 1,
          join_hint: 'agentbus join room-shell',
          last_reply_at: '2026-04-03T00:00:02.000Z',
        },
      ],
      bridge_refs: [
        {
          room_id: 'room-shell',
          room_kind: 'plan',
          scope: 'run',
          bridge_kind: 'agent-im',
          thread_kind: 'discord',
          thread_id: 'discord-shell',
          status: 'active',
          thread_title: 'Plan Shell',
        },
      ],
    });
    writeJson(path.join(runDir, 'human-bridge-state.json'), {
      bridge_refs: [
        {
          room_id: 'room-task-a',
          room_kind: 'task_discuss',
          scope: 'task',
          bridge_kind: 'agent-im',
          thread_kind: 'session',
          thread_id: 'session-task-a',
          status: 'linked',
          focus_task_id: 'task-a',
          thread_title: 'Task A Review',
        },
      ],
    });
    fs.writeFileSync(
      path.join(runDir, 'worker-events.jsonl'),
      `${JSON.stringify({ timestamp: '2026-04-01T00:00:00.000Z', task_id: 'task-a', status: 'completed', message: 'done' })}\n`,
      'utf-8',
    );

    const dashboard = loadHiveShellDashboard(TMP_DIR, RUN_ID);
    expect(dashboard).not.toBeNull();
    expect(resolveHiveShellRunId(TMP_DIR, RUN_ID)).toBe(RUN_ID);

    const rendered = renderHiveShellDashboard(dashboard!);
    expect(rendered).toContain('== HiveShell ==');
    expect(rendered).toContain('== Run Overview ==');
    expect(rendered).toContain('== Collab ==');
    expect(rendered).toContain('== Advisory ==');
    expect(rendered).toContain('== Authority ==');
    expect(rendered).toContain('== Score Trend ==');
    expect(rendered).toContain('== Workers ==');
    expect(rendered).toContain('== Merge Blockers ==');
    expect(rendered).toContain('== Human Bridge ==');
    expect(rendered).toContain('== Mindkeeper ==');
    expect(rendered).toContain('Ship hiveshell UI');
    expect(rendered).toContain('task-a [completed]');
    expect(rendered).toContain('room-shell [collecting]');
    expect(rendered).toContain('merge blockers: task-b');
    expect(rendered).toContain('task-b | Merge blocked (overlap_conflict): Overlapping changed file src/task-b.ts also touched by: task-c');
    expect(rendered).toContain('avg advisory score: 92');
    expect(rendered).toContain('reviewer-a avg=92 replies=1 adopted=1/1 kinds=plan');
    expect(rendered).toContain('authority=authority-layer');
    expect(rendered).toContain('mode=pair');
    expect(rendered).toContain('members=kimi-k2.5+MiniMax-M2.5');
    expect(rendered).toContain('synth=gpt-5.4');
    expect(rendered).toContain('task-a -> room-task-a [closed] replies=1');
    expect(rendered).toContain('agentbus join room-shell');
    expect(rendered).toContain('r2');
    expect(rendered).toContain('dst-1');
    expect(rendered).toContain('linked threads: 2');
    expect(rendered).toContain('thread link: room-shell -> discord:discord-shell [active] title=Plan Shell');
    expect(rendered).toContain('thread link: room-task-a -> session:session-task-a [linked] task=task-a title=Task A Review');
    expect(rendered).toContain('linked rooms: 2');
    expect(rendered).toContain('room link: room-shell [plan/collecting] replies=1');
    expect(rendered).toContain('room link: room-task-a [task_discuss/closed] replies=1 task=task-a');
  });

  it('renders blocked synthesis attempt in authority section', () => {
    const rendered = renderHiveShellDashboard({
      runId: RUN_ID,
      cwd: TMP_DIR,
      result: {
        plan: {
          id: 'plan-blocked',
          goal: 'blocked authority',
          tasks: [],
          execution_order: [],
        },
        worker_results: [],
        review_results: [
          {
            taskId: 'task-b',
            final_stage: 'cross-review',
            passed: false,
            verdict: 'BLOCKED',
            findings: [],
            iterations: 2,
            duration_ms: 100,
            authority: {
              source: 'authority-layer',
              mode: 'pair',
              members: ['kimi-k2.5', 'MiniMax-M2.5'],
              disagreement_flags: ['conclusion_opposite'],
              synthesis_attempted_by: 'gpt-5.4',
            },
          },
        ],
        score_updates: [],
        total_duration_ms: 1000,
        cost_estimate: {
          opus_tokens: 0,
          sonnet_tokens: 0,
          haiku_tokens: 0,
          domestic_tokens: 100,
          estimated_cost_usd: 0.01,
        },
      } as OrchestratorResult,
      updated_at: new Date().toISOString(),
    });

    expect(rendered).toContain('task-b [blocked]');
    expect(rendered).toContain('synth=blocked(gpt-5.4)');
  });

  it('renders pending repair context after max_rounds escalation', () => {
    const runDir = path.join(TMP_DIR, '.ai', 'runs', RUN_ID);
    const spec: RunSpec = {
      id: RUN_ID,
      goal: 'Preserve repair context',
      cwd: TMP_DIR,
      mode: 'safe',
      done_conditions: [],
      max_rounds: 1,
      max_worker_retries: 1,
      max_replans: 1,
      allow_auto_merge: true,
      stop_on_high_risk: false,
      created_at: new Date().toISOString(),
    };
    const state: RunState = {
      run_id: RUN_ID,
      status: 'partial',
      round: 1,
      completed_task_ids: [],
      failed_task_ids: ['task-a'],
      retry_counts: {},
      replan_count: 0,
      task_states: {
        'task-a': {
          task_id: 'task-a',
          status: 'merge_blocked',
          round: 1,
          changed_files: ['src/task-a.ts', 'src/unexpected.ts'],
          merged: false,
          worker_success: true,
          review_passed: true,
          last_error: 'Merge blocked (scope_violation): Changed files outside estimated_files: src/unexpected.ts',
        },
      },
      verification_results: [],
      next_action: {
        kind: 'request_human',
        reason: 'Max rounds reached (1) while pending repair_task: 1 task(s) changed files outside estimated_files and were blocked before merge.',
        task_ids: ['task-a'],
      },
      final_summary: '1 task blocked before merge',
      updated_at: new Date().toISOString(),
    };

    writeJson(path.join(runDir, 'spec.json'), spec);
    writeJson(path.join(runDir, 'state.json'), state);

    const rendered = renderHiveShellDashboard(loadHiveShellDashboard(TMP_DIR, RUN_ID)!);

    expect(rendered).toContain('== Run Overview ==');
    expect(rendered).toContain('- next: request_human - Max rounds reached (1) while pending repair_task: 1 task(s) changed files outside estim...');
    expect(rendered).toContain('== Merge Blockers ==');
    expect(rendered).toContain('task-a | Merge blocked (scope_violation): Changed files outside estimated_files: src/unexpected.ts');
  });
});
