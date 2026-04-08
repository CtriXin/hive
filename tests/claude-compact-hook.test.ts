import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RunScoreHistory, RunSpec, RunState, TaskPlan, WorkerStatusSnapshot } from '../orchestrator/types.js';
import { renderClaudeCompactHookOutput, syncClaudeCompactHookState } from '../orchestrator/claude-compact-hook.js';
import { loadLatestCompactRestore } from '../orchestrator/compact-packet.js';

const TMP_DIR = '/tmp/hive-claude-compact-hook-test';
const RUN_ID = 'run-hook-123';

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

function seedRun(): void {
  const runDir = path.join(TMP_DIR, '.ai', 'runs', RUN_ID);
  const spec: RunSpec = {
    id: RUN_ID,
    goal: 'Preserve Hive restore card',
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
    completed_task_ids: [],
    failed_task_ids: [],
    retry_counts: {},
    replan_count: 0,
    verification_results: [],
    next_action: {
      kind: 'execute',
      reason: 'Continue task-b',
      task_ids: ['task-b'],
    },
    final_summary: 'task-b still active',
    updated_at: new Date().toISOString(),
  };
  const plan: TaskPlan = {
    id: 'plan-hook-1',
    goal: 'Preserve Hive restore card',
    cwd: TMP_DIR,
    tasks: [],
    execution_order: [],
    context_flow: {},
    created_at: new Date().toISOString(),
  };
  const workerSnapshot: WorkerStatusSnapshot = {
    run_id: RUN_ID,
    plan_id: 'plan-hook-1',
    goal: 'Preserve Hive restore card',
    round: 2,
    updated_at: new Date().toISOString(),
    workers: [
      {
        task_id: 'task-b',
        status: 'running',
        assigned_model: 'qwen3-max',
        active_model: 'qwen3-max',
        provider: 'bailian',
        agent_id: 'task-b@run-hook-123',
        discuss_triggered: false,
        updated_at: new Date().toISOString(),
        task_summary: 'Preparing compact hook',
        transcript_path: '.ai/runs/run-hook-123/workers/task-b.transcript.jsonl',
      },
    ],
  };
  const scoreHistory: RunScoreHistory = {
    run_id: RUN_ID,
    goal: 'Preserve Hive restore card',
    updated_at: new Date().toISOString(),
    latest_score: 80,
    best_score: 80,
    rounds: [
      {
        run_id: RUN_ID,
        round: 1,
        action: 'execute',
        status: 'executing',
        created_at: new Date().toISOString(),
        score: 80,
        summary: 'score 80',
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
          prompt_fragment_usage: {},
          prompt_policy_version_usage: {},
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
}

describe('claude-compact-hook', () => {
  beforeEach(() => {
    resetDir();
    seedRun();
    process.env.CLAUDE_PROJECTS_ROOT = path.join(TMP_DIR, '.claude-projects');
  });

  afterEach(() => {
    delete process.env.CLAUDE_PROJECTS_ROOT;
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true });
    }
  });

  it('builds pre-compact instructions from the latest Hive run', () => {
    const output = renderClaudeCompactHookOutput(TMP_DIR, {
      hook_event_name: 'PreCompact',
      trigger: 'manual',
      custom_instructions: null,
    });

    expect(output).toBe('Keep Hive restore: .ai/restore/latest-compact-restore-prompt.md');
  });

  it('builds post-compact user message with restore prompt path', () => {
    const output = renderClaudeCompactHookOutput(TMP_DIR, {
      hook_event_name: 'PostCompact',
      trigger: 'auto',
      compact_summary: 'summary text',
    });

    expect(output).toBe('Hive restore: .ai/restore/latest-compact-restore-prompt.md');
  });

  it('uses the latest discuss source and normalizes hook output to one truncated line', () => {
    const runDir = path.join(TMP_DIR, '.ai', 'runs', RUN_ID);
    writeJson(path.join(runDir, 'worker-status.json'), {
      run_id: RUN_ID,
      plan_id: 'plan-hook-1',
      goal: 'Preserve Hive restore card',
      round: 2,
      updated_at: '2026-04-08T10:00:00.000Z',
      workers: [
        {
          task_id: 'task-b',
          status: 'running',
          assigned_model: 'qwen3-max',
          active_model: 'qwen3-max',
          provider: 'bailian',
          agent_id: 'task-b@run-hook-123',
          discuss_triggered: false,
          updated_at: '2026-04-08T10:00:00.000Z',
          task_summary: 'Primary worker still running',
        },
        {
          task_id: 'task-c',
          status: 'completed',
          assigned_model: 'kimi-k2.5',
          active_model: 'kimi-k2.5',
          provider: 'kimi',
          agent_id: 'task-c@run-hook-123',
          discuss_triggered: true,
          updated_at: '2026-04-08T10:05:00.000Z',
          task_summary: 'Discuss concluded',
          discuss_conclusion: {
            quality_gate: 'warn',
            conclusion: `First line with spacing\n\nSecond line should be normalized before the hook renders ${'x'.repeat(120)}`,
          },
        },
      ],
    });

    const output = renderClaudeCompactHookOutput(TMP_DIR, {
      hook_event_name: 'PostCompact',
      trigger: 'auto',
      compact_summary: 'summary text',
    });

    const lines = output.split('\n');
    expect(lines[0]).toBe('Hive restore: .ai/restore/latest-compact-restore-prompt.md');
    expect(lines[1]).toContain('Discuss: task-c | warn | First line with spacing Second line should be normalized');
    expect(lines[1]).not.toContain('\n');
    expect(lines[1].endsWith('...')).toBe(true);
    expect(lines[1].length).toBeLessThanOrEqual(160);
  });

  it('stores compact summary into the latest restore prompt for follow-up sessions', () => {
    syncClaudeCompactHookState(TMP_DIR, {
      hook_event_name: 'PostCompact',
      trigger: 'manual',
      compact_summary: [
        'Summary:',
        '1. Primary Request and Intent:',
        '- User asked me to remember the number 589.',
        '7. Pending Tasks:',
        '- None.',
      ].join('\n'),
    });

    const restored = loadLatestCompactRestore(TMP_DIR);
    expect(restored).not.toBeNull();
    expect(restored!.restorePrompt).toContain('Conversation carry-over:');
    expect(restored!.restorePrompt).toContain('remember the number 589');
    expect(fs.existsSync(path.join(TMP_DIR, '.ai', 'restore', 'latest-compact-conversation.json'))).toBe(true);
  });

  it('falls back to a workspace restore card when no Hive run exists', () => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(TMP_DIR, '.ai', 'plan'), { recursive: true });
    fs.writeFileSync(
      path.join(TMP_DIR, '.ai', 'plan', 'current.md'),
      [
        '# Current Plan: Workspace Hook',
        '## Current Goal',
        '- Preserve context without a Hive run',
        '',
        '## Highest Priority Next',
        '- Use workspace compact fallback',
      ].join('\n'),
      'utf-8',
    );

    const output = renderClaudeCompactHookOutput(TMP_DIR, {
      hook_event_name: 'PreCompact',
      trigger: 'manual',
      custom_instructions: null,
    });

    expect(output).toBe('Keep Hive restore: .ai/restore/latest-compact-restore-prompt.md');
  });

  it('captures recent Claude session user facts before compact when no compact summary exists yet', () => {
    const projectDir = path.join(
      process.env.CLAUDE_PROJECTS_ROOT!,
      '-tmp-hive-claude-compact-hook-test',
    );
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'session-1.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: { role: 'user', content: '帮我记住数字：589' },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: { role: 'user', content: '不要写进 memory，知道就行' },
        }),
      ].join('\n'),
      'utf-8',
    );

    syncClaudeCompactHookState(TMP_DIR, {
      hook_event_name: 'PreCompact',
      trigger: 'manual',
      custom_instructions: null,
    });

    const output = renderClaudeCompactHookOutput(TMP_DIR, {
      hook_event_name: 'PreCompact',
      trigger: 'manual',
      custom_instructions: null,
    });

    expect(output).toBe('Keep Hive restore: .ai/restore/latest-compact-restore-prompt.md');
    const restored = loadLatestCompactRestore(TMP_DIR);
    expect(restored!.restorePrompt).toContain('帮我记住数字：589');
  });
});
