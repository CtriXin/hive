// tests/operator-commands.test.ts — Phase 9B: Operator Workflow Polishing
// Tests for hint-to-command mapping and lifecycle-aware CLI guidance.

import { describe, expect, test } from 'vitest';
import {
  commandsForHintAction,
  commandsForRunState,
  suggestNextCommands,
} from '../orchestrator/operator-commands.js';

describe('commandsForHintAction', () => {
  test('resume_run suggests resume command with run-id', () => {
    const cmds = commandsForHintAction('resume_run', { runId: 'run-123' });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toContain('hive resume');
    expect(cmds[0].command).toContain('--run-id run-123');
    expect(cmds[0].command).toContain('--execute');
  });

  test('inspect_forensics suggests workers and watch commands', () => {
    const cmds = commandsForHintAction('inspect_forensics', {
      runId: 'run-123',
      taskId: 'task-a',
    });
    expect(cmds).toHaveLength(2);
    expect(cmds[0].command).toContain('hive workers');
    expect(cmds[0].command).toContain('--worker task-a');
    expect(cmds[1].command).toContain('hive watch');
    expect(cmds[1].command).toContain('--once');
  });

  test('replan suggests status and steer commands with task context', () => {
    const cmds = commandsForHintAction('replan', {
      runId: 'run-123',
      taskId: 'task-b',
    });
    expect(cmds).toHaveLength(2);
    expect(cmds[0].command).toContain('hive status');
    expect(cmds[1].command).toContain('hive steer');
    expect(cmds[1].command).toContain('--action request_replan');
    expect(cmds[1].command).toContain('task-b');
  });

  test('provider_wait_fallback suggests status and watch', () => {
    const cmds = commandsForHintAction('provider_wait_fallback', {
      runId: 'run-123',
      provider: 'provider-a',
    });
    expect(cmds).toHaveLength(2);
    expect(cmds[0].command).toContain('hive status');
    expect(cmds[1].command).toContain('hive watch');
  });

  test('merge_changes suggests compact and status', () => {
    const cmds = commandsForHintAction('merge_changes', { runId: 'run-123' });
    expect(cmds).toHaveLength(2);
    expect(cmds[0].command).toContain('hive compact');
    expect(cmds[1].command).toContain('hive status');
  });

  test('steering_recommended suggests steer list', () => {
    const cmds = commandsForHintAction('steering_recommended', { runId: 'run-123' });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toContain('hive steer');
    expect(cmds[0].command).not.toContain('--action'); // list mode
  });

  test('rerun_stronger_mode suggests escalate_mode', () => {
    const cmds = commandsForHintAction('rerun_stronger_mode', {
      runId: 'run-123',
      taskId: 'task-c',
    });
    expect(cmds).toHaveLength(2);
    expect(cmds[0].command).toContain('hive steer');
    expect(cmds[0].command).toContain('--action escalate_mode');
    expect(cmds[0].command).toContain('--task-id task-c');
  });

  test('review_findings suggests worker inspect', () => {
    const cmds = commandsForHintAction('review_findings', {
      runId: 'run-123',
      taskId: 'task-d',
    });
    expect(cmds).toHaveLength(2);
    expect(cmds[0].command).toContain('hive workers');
    expect(cmds[0].command).toContain('--worker task-d');
  });

  test('request_human_input suggests status and worker inspect', () => {
    const cmds = commandsForHintAction('request_human_input', {
      runId: 'run-123',
      taskId: 'task-e',
    });
    expect(cmds).toHaveLength(2);
    expect(cmds[0].command).toContain('hive status');
    expect(cmds[1].command).toContain('hive workers');
  });

  test('unknown action falls back to status', () => {
    const cmds = commandsForHintAction('unknown_action', { runId: 'run-123' });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toContain('hive status');
  });
});

describe('commandsForRunState', () => {
  test('running suggests watch and workers', () => {
    const cmds = commandsForRunState('running', { runId: 'run-123' });
    expect(cmds.length).toBeGreaterThanOrEqual(2);
    expect(cmds[0].command).toContain('hive watch');
    expect(cmds[1].command).toContain('hive workers');
  });

  test('running includes steer when hasSteering', () => {
    const cmds = commandsForRunState('running', { runId: 'run-123', hasSteering: true });
    expect(cmds.some((c) => c.command.includes('hive steer'))).toBe(true);
  });

  test('paused suggests resume, steer, and status', () => {
    const cmds = commandsForRunState('paused', { runId: 'run-123' });
    expect(cmds).toHaveLength(3);
    expect(cmds[0].command).toContain('hive resume');
    expect(cmds[0].command).toContain('--execute');
    expect(cmds[1].command).toContain('hive steer');
    expect(cmds[2].command).toContain('hive status');
  });

  test('partial suggests status, workers, and replan', () => {
    const cmds = commandsForRunState('partial', { runId: 'run-123' });
    expect(cmds).toHaveLength(3);
    expect(cmds[0].command).toContain('hive status');
    expect(cmds[1].command).toContain('hive workers');
    expect(cmds[2].command).toContain('hive steer');
    expect(cmds[2].command).toContain('--action request_replan');
  });

  test('blocked suggests status, steer, and escalate', () => {
    const cmds = commandsForRunState('blocked', { runId: 'run-123' });
    expect(cmds).toHaveLength(3);
    expect(cmds[0].command).toContain('hive status');
    expect(cmds[1].command).toContain('hive steer');
    expect(cmds[2].command).toContain('escalate_mode');
  });

  test('done suggests compact, status, and restore', () => {
    const cmds = commandsForRunState('done', { runId: 'run-123' });
    expect(cmds).toHaveLength(3);
    expect(cmds[0].command).toContain('hive compact');
    expect(cmds[1].command).toContain('hive status');
    expect(cmds[2].command).toContain('hive restore');
  });
});

describe('suggestNextCommands', () => {
  test('combines hint and lifecycle commands, deduplicates, limits to 4', () => {
    // inspect_forensics suggests workers + watch
    // running also suggests watch + workers
    // They overlap, so result should be deduplicated
    const cmds = suggestNextCommands('running', {
      runId: 'run-123',
      topHintAction: 'inspect_forensics',
      taskId: 'task-a',
      hasSteering: false,
    });
    expect(cmds.length).toBeGreaterThanOrEqual(2);
    expect(cmds.length).toBeLessThanOrEqual(4);
    // First should be hint-specific (workers with task)
    expect(cmds[0].command).toContain('hive workers');
    expect(cmds[0].command).toContain('--worker task-a');
  });

  test('paused run prioritizes resume hint', () => {
    const cmds = suggestNextCommands('paused', {
      runId: 'run-123',
      topHintAction: 'resume_run',
    });
    expect(cmds[0].command).toContain('hive resume');
    expect(cmds[0].command).toContain('--execute');
  });

  test('deduplicates commands from hint and lifecycle', () => {
    const cmds = suggestNextCommands('done', {
      runId: 'run-123',
      topHintAction: 'merge_changes',
    });
    // merge_changes suggests compact + status
    // done lifecycle suggests compact + status + restore
    // Should deduplicate
    const commandStrings = cmds.map((c) => c.command);
    const uniqueCommands = new Set(commandStrings);
    expect(uniqueCommands.size).toBe(commandStrings.length); // no duplicates
    expect(cmds.length).toBeGreaterThanOrEqual(3);
  });

  test('returns only lifecycle commands when no hint', () => {
    const cmds = suggestNextCommands('partial', {
      runId: 'run-456',
      hasFailures: true,
    });
    expect(cmds.length).toBeGreaterThanOrEqual(2);
    expect(cmds[0].command).toContain('hive status');
  });

  test('no runId produces commands without run-id flag', () => {
    const cmds = suggestNextCommands('paused', {
      topHintAction: 'resume_run',
    });
    expect(cmds[0].command).not.toContain('--run-id');
    expect(cmds[0].command).toBe('hive resume --execute');
  });
});
