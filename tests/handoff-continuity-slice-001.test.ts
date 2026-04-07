// tests/handoff-continuity-slice-001.test.ts — Round 001 validation
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type {
  RunSpec,
  RunState,
  TaskPlan,
  WorkerStatusSnapshot,
  OrchestratorResult,
  ReviewResult,
} from '../orchestrator/types.js';
import { updateWorkerStatus, loadWorkerStatusSnapshot } from '../orchestrator/worker-status-store.js';
import { writeLoopProgress, readLoopProgress } from '../orchestrator/loop-progress-store.js';
import { buildCompactPacket, renderCompactPacket } from '../orchestrator/compact-packet.js';
import { loadHiveShellDashboard, renderHiveShellDashboard } from '../orchestrator/hiveshell-dashboard.js';

const TMP_DIR = '/tmp/hive-handoff-continuity-test-001';
const RUN_ID = 'run-handoff-001';

function resetDir(): void {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true });
  }
  fs.mkdirSync(path.join(TMP_DIR, '.ai', 'runs', RUN_ID), { recursive: true });
}

function writeJson<T>(filePath: string, value: T): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

describe('handoff-continuity-slice-001', () => {
  beforeEach(() => {
    resetDir();
  });

  afterEach(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true });
    }
  });

  it('exposes worker discuss conclusion in worker status snapshot and dashboard', () => {
    // Arrange: Create a worker status entry with discuss_conclusion
    const snapshot = updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-a',
      status: 'completed',
      plan_id: RUN_ID,
      round: 1,
      assigned_model: 'qwen3-max',
      active_model: 'qwen3-max',
      provider: 'bailian',
      task_description: 'Test task with discuss resolution',
      discuss_triggered: true,
      discuss_conclusion: {
        quality_gate: 'pass',
        conclusion: 'Continue with the refactored approach; partner models agreed on the simpler abstraction.',
      },
      task_summary: 'Discuss resolved with pass',
      last_message: 'Discussion concluded: pass',
      success: true,
      changed_files_count: 3,
    });

    // Act: Load and verify the snapshot
    const loaded = loadWorkerStatusSnapshot(TMP_DIR, RUN_ID);
    expect(loaded).not.toBeNull();
    expect(loaded!.workers).toHaveLength(1);

    const worker = loaded!.workers[0];
    expect(worker.task_id).toBe('task-a');
    expect(worker.discuss_triggered).toBe(true);
    expect(worker.discuss_conclusion).toBeDefined();
    expect(worker.discuss_conclusion!.quality_gate).toBe('pass');
    expect(worker.discuss_conclusion!.conclusion).toContain('refactored approach');

    // Act: Verify dashboard renders the conclusion
    const data = loadHiveShellDashboard(TMP_DIR, RUN_ID);
    expect(data).not.toBeNull();
    const dashboard = renderHiveShellDashboard(data!);

    // Assert: Dashboard contains discuss conclusion
    expect(dashboard).toContain('[pass]');
    expect(dashboard).toContain('refactored approach');
  });

  it('exposes planner discuss conclusion in loop-progress and dashboard', () => {
    // Arrange: Write loop-progress with planner_discuss_conclusion
    writeLoopProgress(TMP_DIR, RUN_ID, {
      run_id: RUN_ID,
      round: 1,
      phase: 'executing',
      reason: 'Plan ready with discuss feedback incorporated',
      planner_model: 'gpt-5',
      planner_discuss_conclusion: {
        quality_gate: 'warn',
        overall_assessment: 'Plan is mostly solid but consider splitting task-b into smaller units for better reviewability.',
      },
    });

    // Arrange: Minimal state for dashboard
    const spec: RunSpec = {
      id: RUN_ID,
      goal: 'Test planner discuss continuity',
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
      round: 1,
      completed_task_ids: [],
      failed_task_ids: [],
      retry_counts: {},
      replan_count: 0,
      task_states: {},
      verification_results: [],
      next_action: {
        kind: 'execute',
        reason: 'Dispatching tasks',
        task_ids: [],
      },
      updated_at: new Date().toISOString(),
    };
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);

    // Act: Load dashboard
    const data = loadHiveShellDashboard(TMP_DIR, RUN_ID);
    expect(data).not.toBeNull();
    const dashboard = renderHiveShellDashboard(data!);

    // Assert: Dashboard contains planner discuss conclusion
    expect(dashboard).toContain('planner discuss: warn');
    expect(dashboard).toContain('splitting task-b');
  });

  it('preserves planner_discuss_conclusion through emitProgress overwrite scenario', () => {
    // Arrange: Write initial loop-progress with planner_discuss_conclusion
    writeLoopProgress(TMP_DIR, RUN_ID, {
      run_id: RUN_ID,
      round: 1,
      phase: 'planning',
      reason: 'Initial planning phase',
      planner_model: 'gpt-5',
      planner_discuss_conclusion: {
        quality_gate: 'pass',
        overall_assessment: 'Initial planner discuss conclusion that should persist.',
      },
    });

    // Act: Simulate emitProgress behavior - writeLoopProgress without planner_discuss_conclusion
    // This simulates what happens when emitProgress is called after persistPlannerDiscussConclusion
    writeLoopProgress(TMP_DIR, RUN_ID, {
      run_id: RUN_ID,
      round: 1,
      phase: 'executing',
      reason: 'Dispatching tasks',
      planner_model: 'gpt-5',
      // Note: no planner_discuss_conclusion here - should be preserved from previous
    });

    // Assert: planner_discuss_conclusion should still exist
    const loaded = readLoopProgress(TMP_DIR, RUN_ID);
    expect(loaded).not.toBeNull();
    expect(loaded!.planner_discuss_conclusion).toBeDefined();
    expect(loaded!.planner_discuss_conclusion!.quality_gate).toBe('pass');
    expect(loaded!.planner_discuss_conclusion!.overall_assessment).toContain('Initial planner');
  });

  it('exposes planner discuss conclusion in compact packet and restore prompt', () => {
    // Arrange: Write loop-progress with planner_discuss_conclusion
    writeLoopProgress(TMP_DIR, RUN_ID, {
      run_id: RUN_ID,
      round: 1,
      phase: 'executing',
      reason: 'Plan ready',
      planner_model: 'gpt-5',
      planner_discuss_conclusion: {
        quality_gate: 'pass',
        overall_assessment: 'Plan looks solid. Model assignments are appropriate.',
      },
    });

    // Arrange: Minimal state for compact packet
    const spec: RunSpec = {
      id: RUN_ID,
      goal: 'Test compact planner discuss',
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
      round: 1,
      completed_task_ids: [],
      failed_task_ids: [],
      retry_counts: {},
      replan_count: 0,
      task_states: {},
      verification_results: [],
      next_action: {
        kind: 'execute',
        reason: 'Dispatching tasks',
        task_ids: [],
      },
      updated_at: new Date().toISOString(),
    };
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);

    // Act: Build compact packet
    const data = loadHiveShellDashboard(TMP_DIR, RUN_ID);
    expect(data).not.toBeNull();
    const packet = buildCompactPacket(data!);
    const rendered = renderCompactPacket(packet);

    // Assert: Compact packet contains planner_discuss
    expect(packet.planner_discuss).toBeDefined();
    expect(packet.planner_discuss!.quality_gate).toBe('pass');
    expect(packet.planner_discuss!.overall_assessment).toContain('Plan looks solid');

    // Assert: Rendered output contains planner discuss section
    expect(rendered).toContain('- planner discuss:');
    expect(rendered).toContain('quality_gate: pass');
    expect(rendered).toContain('Plan looks solid');
  });

  it('exposes request_human handoff trace in compact restore prompt', () => {
    // Arrange: Create a state with request_human next_action
    const spec: RunSpec = {
      id: RUN_ID,
      goal: 'Test request_human handoff',
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
      status: 'blocked',
      round: 2,
      completed_task_ids: ['task-a'],
      failed_task_ids: ['task-b'],
      retry_counts: { 'task-b': 2 },
      replan_count: 0,
      task_states: {
        'task-b': {
          task_id: 'task-b',
          status: 'review_failed',
          round: 2,
          changed_files: ['src/task-b.ts'],
          merged: false,
          worker_success: true,
          review_passed: false,
          last_error: 'Critical issue in error handling',
        },
      },
      verification_results: [],
      next_action: {
        kind: 'request_human',
        reason: 'Retry budget exhausted for task-b after 2 attempts. Human intervention needed to decide: escalate to stronger model, simplify scope, or mark as known limitation.',
        task_ids: ['task-b'],
        instructions: 'Review task-b failure and decide whether to: (1) escalate to stronger model, (2) simplify the task scope, or (3) accept as known limitation.',
      },
      final_summary: 'Blocked: retry budget exhausted',
      updated_at: new Date().toISOString(),
    };
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);

    // Act: Build compact packet
    const data = loadHiveShellDashboard(TMP_DIR, RUN_ID);
    expect(data).not.toBeNull();
    const packet = buildCompactPacket(data!);

    // Assert: request_human_trace is populated
    expect(packet.request_human_trace).toBeDefined();
    expect(packet.request_human_trace!.why_blocked).toContain('Retry budget exhausted');
    expect(packet.request_human_trace!.what_needs_human).toContain('Review task-b failure');

    // Assert: Restore prompt contains handoff trace section
    const rendered = renderCompactPacket(packet);
    expect(rendered).toContain('Handoff trace (request_human)');
    expect(rendered).toContain('why_blocked:');
    expect(rendered).toContain('what_needs_human:');
  });

  it('does not include request_human_trace when next_action is not request_human', () => {
    // Arrange: State with execute action
    const spec: RunSpec = {
      id: RUN_ID,
      goal: 'Test normal execution',
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
      round: 1,
      completed_task_ids: [],
      failed_task_ids: [],
      retry_counts: {},
      replan_count: 0,
      task_states: {},
      verification_results: [],
      next_action: {
        kind: 'execute',
        reason: 'Dispatching tasks',
        task_ids: [],
      },
      updated_at: new Date().toISOString(),
    };
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);

    // Act: Build compact packet
    const data = loadHiveShellDashboard(TMP_DIR, RUN_ID);
    const packet = buildCompactPacket(data!);

    // Assert: No request_human_trace
    expect(packet.request_human_trace).toBeUndefined();
  });

  it('shows planner discuss and request_human trace in hive status CLI output', async () => {
    const { main } = await import('../orchestrator/index.js');
    const { writeLoopProgress } = await import('../orchestrator/loop-progress-store.js');
    const { updateWorkerStatus } = await import('../orchestrator/worker-status-store.js');

    // Arrange: Create run with planner discuss and request_human state
    const spec: RunSpec = {
      id: RUN_ID,
      goal: 'Test CLI handoff continuity',
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
      status: 'blocked',
      round: 2,
      completed_task_ids: ['task-a'],
      failed_task_ids: ['task-b'],
      retry_counts: { 'task-b': 2 },
      replan_count: 0,
      task_states: {
        'task-b': {
          task_id: 'task-b',
          status: 'review_failed',
          round: 2,
          changed_files: ['src/task-b.ts'],
          merged: false,
          worker_success: true,
          review_passed: false,
          last_error: 'Critical issue in error handling',
        },
      },
      verification_results: [],
      next_action: {
        kind: 'request_human',
        reason: 'Retry budget exhausted for task-b after 2 attempts. Human intervention needed.',
        task_ids: ['task-b'],
        instructions: 'Review task-b failure and decide: escalate to stronger model, simplify scope, or mark as known limitation.',
      },
      final_summary: 'Blocked: retry budget exhausted',
      updated_at: new Date().toISOString(),
    };
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'spec.json'), spec);
    writeJson(path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'state.json'), state);

    // Arrange: Loop progress with planner discuss conclusion
    writeLoopProgress(TMP_DIR, RUN_ID, {
      run_id: RUN_ID,
      round: 2,
      phase: 'blocked',
      reason: 'Waiting for human intervention',
      planner_model: 'gpt-5',
      planner_discuss_conclusion: {
        quality_gate: 'warn',
        overall_assessment: 'Plan was solid but task-b needs human review due to repeated failures.',
      },
    });

    // Arrange: Worker status snapshot (required for status command)
    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-a',
      status: 'completed',
      plan_id: RUN_ID,
      round: 1,
      assigned_model: 'qwen3-max',
      active_model: 'qwen3-max',
      provider: 'bailian',
      task_description: 'Completed task',
      task_summary: 'Task A completed successfully',
      last_message: 'Done',
      success: true,
      changed_files_count: 2,
    });

    // Act: Capture console output
    const originalLog = console.log;
    const outputLines: string[] = [];
    console.log = (...args) => {
      outputLines.push(args.join(' '));
    };

    // Simulate: hive status --run-id <RUN_ID>
    const originalArgv = process.argv;
    process.argv = ['node', 'hive', 'status', '--run-id', RUN_ID, '--cwd', TMP_DIR];

    try {
      await main();
    } finally {
      console.log = originalLog;
      process.argv = originalArgv;
    }

    // Assert: Output contains planner discuss
    const output = outputLines.join('\n');
    expect(output).toContain('planner discuss: warn');
    expect(output).toContain('Plan was solid but task-b needs human review');

    // Assert: Output contains request_human why_blocked
    expect(output).toContain('request_human:');
    expect(output).toContain('why_blocked:');
    expect(output).toContain('Retry budget exhausted');

    // Assert: Output contains request_human what_needs_human
    expect(output).toContain('what_needs_human:');
    expect(output).toContain('Review task-b failure');
    expect(output).toContain('escalate to stronger model');
  });

  it('flattens multiline planner discuss assessment to single line in status output', async () => {
    const { main } = await import('../orchestrator/index.js');
    const { saveRunSpec } = await import('../orchestrator/run-store.js');

    // Setup: Create run with multiline planner discuss assessment
    const runDir = path.join(TMP_DIR, '.ai', 'runs', RUN_ID);

    // Create spec (required for status command to find the run)
    const spec: RunSpec = {
      id: RUN_ID,
      goal: 'Test multiline planner discuss flattening',
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
    saveRunSpec(TMP_DIR, spec);

    const loopProgress: LoopProgress = {
      run_id: RUN_ID,
      plan_id: 'plan-test',
      round: 1,
      phase: 'executing',
      reason: 'Testing multiline flatten',
      planner_discuss_conclusion: {
        quality_gate: 'warn',
        overall_assessment: '[qwen3-max] No assessment\n[glm-5] No assessment\n[kimi-k2.5] No assessment',
      },
    };
    writeJson(path.join(runDir, 'loop-progress.json'), loopProgress);

    const state: RunState = {
      run_id: RUN_ID,
      status: 'executing',
      round: 1,
      completed_task_ids: [],
      failed_task_ids: [],
      review_failed_task_ids: [],
      merged_task_ids: [],
      retry_counts: {},
      replan_count: 0,
      task_states: {},
      task_verification_results: {},
      repair_history: [],
      policy_hook_results: [],
      verification_results: [],
      updated_at: new Date().toISOString(),
    };
    writeJson(path.join(runDir, 'state.json'), state);

    const outputLines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      outputLines.push(args.map(String).join(' '));
    };

    const originalArgv = process.argv;
    process.argv = ['node', 'hive', 'status', '--run-id', RUN_ID, '--cwd', TMP_DIR];

    try {
      await main();
    } finally {
      console.log = originalLog;
      process.argv = originalArgv;
    }

    // Assert: Multiline assessment is flattened to single line
    const output = outputLines.join('\n');
    expect(output).toContain('planner discuss: warn');
    // The key assertion: no raw newlines in the planner discuss line
    const plannerDiscussLine = outputLines.find(line => line.includes('planner discuss:'));
    expect(plannerDiscussLine).toBeDefined();
    // Line should not contain unflattened newlines (i.e., each model on separate line)
    expect(plannerDiscussLine).not.toMatch(/\[qwen3-max\].*\n.*\[glm-5\]/);
    expect(plannerDiscussLine).not.toMatch(/\[glm-5\].*\n.*\[kimi-k2\.5\]/);
    // All model mentions should be on the same line
    expect(plannerDiscussLine).toContain('[qwen3-max]');
    expect(plannerDiscussLine).toContain('[glm-5]');
    expect(plannerDiscussLine).toContain('[kimi-k2.5]');
  });
});
