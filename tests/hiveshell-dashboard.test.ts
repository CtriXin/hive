import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RunScoreHistory, RunSpec, RunState, TaskPlan, WorkerStatusSnapshot } from '../orchestrator/types.js';
import { loadHiveShellDashboard, renderHiveShellDashboard, resolveHiveShellRunId } from '../orchestrator/hiveshell-dashboard.js';

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

    writeJson(path.join(runDir, 'spec.json'), spec);
    writeJson(path.join(runDir, 'state.json'), state);
    writeJson(path.join(runDir, 'plan.json'), plan);
    writeJson(path.join(runDir, 'worker-status.json'), workerSnapshot);
    writeJson(path.join(runDir, 'score-history.json'), scoreHistory);
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
    expect(rendered).toContain('== Score Trend ==');
    expect(rendered).toContain('== Workers ==');
    expect(rendered).toContain('== Mindkeeper ==');
    expect(rendered).toContain('Ship hiveshell UI');
    expect(rendered).toContain('task-a [completed]');
    expect(rendered).toContain('r2');
    expect(rendered).toContain('dst-1');
  });
});
