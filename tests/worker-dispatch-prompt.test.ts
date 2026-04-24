import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLegacyWorkerPrompt,
  buildWorkerDispatchPrompt,
} from '../orchestrator/worker-dispatch-prompt.js';
import type { WorkerConfig } from '../orchestrator/types.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relPath: string, content: string): void {
  const filePath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function writeHandoffRefs(cwd: string, runId: string): void {
  writeFile(cwd, '.ai/plan/current.md', '# Current\n');
  writeFile(cwd, '.ai/plan/handoff.md', '# Handoff\n');
  writeFile(cwd, `.ai/runs/${runId}/human-progress.md`, '# Progress\n');
  writeFile(cwd, '.ai/plan/packet.json', JSON.stringify({
    version: 1,
    run_id: runId,
    task_id: 'task-a',
    status: 'running',
    goal: 'Ship packet-first dispatch',
    next_action: 'execute task-a',
    constraints: ['max_rounds=2'],
    refs: [
      '.ai/plan/packet.json',
      '.ai/plan/handoff.md',
      '.ai/plan/current.md',
      `.ai/runs/${runId}/human-progress.md`,
    ],
    expected_output: ['smaller worker prompt'],
  }, null, 2));
}

function makeConfig(cwd: string, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    taskId: 'task-a',
    model: 'glm-5-turbo',
    provider: 'glm-cn',
    prompt: '## Task: task-a\nImplement packet-first dispatch.',
    cwd,
    worktree: false,
    contextInputs: [],
    discussThreshold: 0.7,
    maxTurns: 4,
    runId: 'run-packet',
    planId: 'plan-packet',
    round: 1,
    taskDescription: 'Implement packet-first dispatch.',
    expectedFiles: ['orchestrator/dispatcher.ts'],
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('worker-dispatch-prompt', () => {
  it('uses packet refs and moves long task/context details into dispatch files', () => {
    const cwd = makeTempDir('hive-packet-prompt-');
    const worktree = makeTempDir('hive-packet-worktree-');
    const longTaskMarker = 'LONG_TASK_MARKER_'.repeat(250);
    const longContextMarker = 'LONG_CONTEXT_MARKER_'.repeat(250);
    writeHandoffRefs(cwd, 'run-packet');

    const config = makeConfig(cwd, {
      prompt: `## Task: task-a\n${longTaskMarker}`,
      contextInputs: [{
        from_task: 'task-upstream',
        summary: longContextMarker,
        key_outputs: [],
        decisions_made: [],
      }],
    });

    const legacyPrompt = buildLegacyWorkerPrompt(config, worktree);
    const result = buildWorkerDispatchPrompt(config, worktree);

    expect(result.mode).toBe('packet-first');
    expect(result.prompt).toContain('Read in order:');
    expect(result.prompt).toContain('./.ai/plan/packet.json');
    expect(result.prompt).toContain('./.ai/plan/handoff.md');
    expect(result.prompt).toContain('./.ai/plan/current.md');
    expect(result.prompt).not.toContain(longTaskMarker);
    expect(result.prompt).not.toContain(longContextMarker);
    expect(result.prompt.length).toBeLessThan(legacyPrompt.length * 0.45);
    expect(result.promptChars).toBe(result.prompt.length);
    expect(result.legacyPromptChars).toBe(legacyPrompt.length);

    const taskBrief = path.join(worktree, '.ai/runs/run-packet/dispatch/task-a-task-brief.md');
    const contextRef = path.join(worktree, '.ai/runs/run-packet/dispatch/task-a-upstream-context.json');
    expect(fs.readFileSync(taskBrief, 'utf-8')).toContain(longTaskMarker);
    expect(fs.readFileSync(contextRef, 'utf-8')).toContain(longContextMarker);
    expect(fs.existsSync(path.join(worktree, '.ai/plan/packet.json'))).toBe(true);
  });

  it('falls back to legacy prompt and records handoff note when packet is missing', () => {
    const cwd = makeTempDir('hive-packet-missing-');
    const longTaskMarker = 'MISSING_PACKET_LONG_PROMPT_'.repeat(120);
    const config = makeConfig(cwd, { prompt: longTaskMarker });

    const result = buildWorkerDispatchPrompt(config, cwd);

    expect(result.mode).toBe('legacy');
    expect(result.reason).toBe('packet missing');
    expect(result.prompt).toContain(longTaskMarker);
    expect(fs.readFileSync(path.join(cwd, '.ai/plan/handoff.md'), 'utf-8')).toContain('packet missing');
  });

  it('falls back to legacy prompt when packet belongs to another run', () => {
    const cwd = makeTempDir('hive-packet-stale-');
    writeHandoffRefs(cwd, 'run-old');
    const config = makeConfig(cwd, { runId: 'run-current' });

    const result = buildWorkerDispatchPrompt(config, cwd);

    expect(result.mode).toBe('legacy');
    expect(result.reason).toContain('packet stale');
  });

  it('keeps repair dispatch thin while preserving findings in task brief ref', () => {
    const cwd = makeTempDir('hive-packet-repair-');
    writeHandoffRefs(cwd, 'run-packet');
    const repairMarker = 'REPAIR_FINDING_DETAILS_'.repeat(180);
    const config = makeConfig(cwd, {
      prompt: `## Repair Task: task-a\n### Review Findings to Fix\n${repairMarker}`,
    });

    const result = buildWorkerDispatchPrompt(config, cwd);

    expect(result.mode).toBe('packet-first');
    expect(result.prompt).not.toContain(repairMarker);
    const taskBrief = path.join(cwd, '.ai/runs/run-packet/dispatch/task-a-task-brief.md');
    expect(fs.readFileSync(taskBrief, 'utf-8')).toContain(repairMarker);
  });
});
