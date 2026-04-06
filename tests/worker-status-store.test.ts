import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  appendWorkerTranscriptEntry,
  buildWorkerAgentId,
  findWorkerStatusEntry,
  loadWorkerEvents,
  loadWorkerStatusSnapshot,
  loadWorkerTranscript,
  listWorkerStatusSnapshots,
  summarizeWorkerSnapshot,
  updateWorkerStatus,
} from '../orchestrator/worker-status-store.js';

const TMP_DIR = '/tmp/hive-worker-status-test';
const RUN_ID = 'run-worker-123';
const OTHER_RUN_ID = 'run-worker-456';

function resetDir(): void {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true });
  }
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

describe('worker-status-store', () => {
  beforeEach(() => {
    resetDir();
  });

  afterEach(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true });
    }
  });

  it('creates and updates a worker snapshot entry', () => {
    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-a',
      status: 'queued',
      plan_id: 'plan-a',
      goal: 'Ship worker visibility',
      round: 2,
      assigned_model: 'qwen3-max',
      active_model: 'qwen3-max',
      provider: 'bailian',
      event_message: 'Queued',
    });

    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-a',
      status: 'running',
      plan_id: 'plan-a',
      round: 2,
      session_id: 'worker-task-a-1',
      worktree_path: '/tmp/wt-a',
      last_message: 'Applying changes now',
      event_message: 'Started',
    });

    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-a',
      status: 'completed',
      plan_id: 'plan-a',
      round: 2,
      changed_files_count: 3,
      success: true,
      event_message: 'Finished',
    });

    const snapshot = loadWorkerStatusSnapshot(TMP_DIR, RUN_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.goal).toBe('Ship worker visibility');
    expect(snapshot!.round).toBe(2);
    expect(snapshot!.workers).toHaveLength(1);
    expect(snapshot!.workers[0].status).toBe('completed');
    expect(snapshot!.workers[0].assigned_model).toBe('qwen3-max');
    expect(snapshot!.workers[0].session_id).toBe('worker-task-a-1');
    expect(snapshot!.workers[0].changed_files_count).toBe(3);
    expect(snapshot!.workers[0].success).toBe(true);
  });

  it('writes append-only event history', () => {
    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-a',
      status: 'queued',
      plan_id: 'plan-a',
      event_message: 'Queued',
    });
    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-a',
      status: 'running',
      plan_id: 'plan-a',
      event_message: 'Started',
    });
    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-a',
      status: 'failed',
      plan_id: 'plan-a',
      error: 'boom',
    });

    const events = loadWorkerEvents(TMP_DIR, RUN_ID);
    expect(events).toHaveLength(3);
    expect(events[0].status).toBe('queued');
    expect(events[1].status).toBe('running');
    expect(events[2].status).toBe('failed');
    expect(events[2].message).toBe('boom');

    const eventsFile = path.join(TMP_DIR, '.ai', 'runs', RUN_ID, 'worker-events.jsonl');
    expect(fs.existsSync(eventsFile)).toBe(true);
  });

  it('summarizes multiple runs by most recent update', () => {
    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-a',
      status: 'completed',
      plan_id: 'plan-a',
      assigned_model: 'glm-5-turbo',
      active_model: 'glm-5-turbo',
      provider: 'zhipu',
      success: true,
    });
    updateWorkerStatus(TMP_DIR, OTHER_RUN_ID, {
      task_id: 'task-b',
      status: 'running',
      plan_id: 'plan-b',
      assigned_model: 'kimi-k2.5',
      active_model: 'kimi-k2.5',
      provider: 'moonshot',
      event_message: 'Started',
    });

    const snapshots = listWorkerStatusSnapshots(TMP_DIR);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].run_id).toBe(OTHER_RUN_ID);

    const counts = summarizeWorkerSnapshot(snapshots[0]);
    expect(counts.total).toBe(1);
    expect(counts.active).toBe(1);
    expect(counts.completed).toBe(0);
  });

  it('stores claude-style worker metadata and transcript artifacts', () => {
    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-a',
      status: 'running',
      plan_id: 'plan-a',
      task_description: 'Draft the worker adapter',
      task_summary: 'Writing transcript adapter',
      session_id: 'worker-task-a-2',
      event_message: 'Started',
    });
    appendWorkerTranscriptEntry(TMP_DIR, RUN_ID, {
      task_id: 'task-a',
      plan_id: 'plan-a',
      session_id: 'worker-task-a-2',
      type: 'assistant',
      content: 'Implementing the transcript surface now.',
    });

    const snapshot = loadWorkerStatusSnapshot(TMP_DIR, RUN_ID);
    const worker = findWorkerStatusEntry(snapshot, 'task-a');
    expect(worker).not.toBeNull();
    expect(worker!.agent_id).toBe(buildWorkerAgentId(RUN_ID, 'task-a'));
    expect(worker!.task_summary).toBe('Writing transcript adapter');
    expect(worker!.transcript_path).toContain('.ai/runs/run-worker-123/workers/task-a.transcript.jsonl');

    const transcriptByTask = loadWorkerTranscript(TMP_DIR, RUN_ID, 'task-a');
    const transcriptByAgent = loadWorkerTranscript(TMP_DIR, RUN_ID, worker!.agent_id);
    expect(transcriptByTask).toHaveLength(1);
    expect(transcriptByAgent).toHaveLength(1);
    expect(transcriptByTask[0].agent_id).toBe(worker!.agent_id);
    expect(transcriptByTask[0].content).toContain('transcript surface');
  });

  it('persists worker collab snapshots across status updates', () => {
    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-c',
      status: 'discussing',
      plan_id: 'plan-c',
      task_description: 'Resolve cache structure choice',
      collab: {
        card: {
          room_id: 'room-task-c',
          room_kind: 'task_discuss',
          status: 'closed',
          replies: 1,
          join_hint: 'agentbus join room-task-c',
          focus_task_id: 'task-c',
          next: 'worker discuss complete',
        },
        recent_events: [
          {
            type: 'room:opened',
            room_id: 'room-task-c',
            room_kind: 'task_discuss',
            at: '2026-04-03T00:00:00.000Z',
            reply_count: 0,
            focus_task_id: 'task-c',
          },
        ],
      },
    });

    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-c',
      status: 'completed',
      plan_id: 'plan-c',
      success: true,
    });

    const snapshot = loadWorkerStatusSnapshot(TMP_DIR, RUN_ID);
    const worker = findWorkerStatusEntry(snapshot, 'task-c');
    expect(worker?.collab?.card.room_id).toBe('room-task-c');
    expect(worker?.collab?.card.room_kind).toBe('task_discuss');
    expect(worker?.collab?.card.next).toBe('worker discuss complete');
    expect(worker?.status).toBe('completed');
  });

  // Regression tests: task_summary should not be overwritten by event_message/last_message
  it('keeps existing task_summary when update only has event_message', () => {
    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-d',
      status: 'running',
      plan_id: 'plan-d',
      task_summary: 'Merged collab + authority summary',
    });

    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-d',
      status: 'running',
      plan_id: 'plan-d',
      event_message: 'Progress update',
    });

    const snapshot = loadWorkerStatusSnapshot(TMP_DIR, RUN_ID);
    const worker = findWorkerStatusEntry(snapshot, 'task-d');
    expect(worker?.task_summary).toBe('Merged collab + authority summary');
  });

  it('keeps existing task_summary when update only has last_message', () => {
    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-e',
      status: 'running',
      plan_id: 'plan-e',
      task_summary: 'Important merged summary',
    });

    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-e',
      status: 'running',
      plan_id: 'plan-e',
      last_message: 'Latest log line',
    });

    const snapshot = loadWorkerStatusSnapshot(TMP_DIR, RUN_ID);
    const worker = findWorkerStatusEntry(snapshot, 'task-e');
    expect(worker?.task_summary).toBe('Important merged summary');
    expect(worker?.last_message).toBe('Latest log line');
  });

  it('replaces task_summary when explicitly provided in update', () => {
    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-f',
      status: 'running',
      plan_id: 'plan-f',
      task_summary: 'Initial summary',
    });

    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-f',
      status: 'running',
      plan_id: 'plan-f',
      task_summary: 'New explicit summary',
    });

    const snapshot = loadWorkerStatusSnapshot(TMP_DIR, RUN_ID);
    const worker = findWorkerStatusEntry(snapshot, 'task-f');
    expect(worker?.task_summary).toBe('New explicit summary');
  });

  it('falls back to last_message/event_message/task_description when no previous summary exists', () => {
    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-g',
      status: 'running',
      plan_id: 'plan-g',
      task_description: 'Do something important',
      last_message: 'Working on it',
    });

    const snapshot = loadWorkerStatusSnapshot(TMP_DIR, RUN_ID);
    const worker = findWorkerStatusEntry(snapshot, 'task-g');
    expect(worker?.task_summary).toBe('Working on it');
  });

  it('falls back to event_message when no task_summary or last_message exists', () => {
    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-h',
      status: 'running',
      plan_id: 'plan-h',
      event_message: 'Started processing',
    });

    const snapshot = loadWorkerStatusSnapshot(TMP_DIR, RUN_ID);
    const worker = findWorkerStatusEntry(snapshot, 'task-h');
    expect(worker?.task_summary).toBe('Started processing');
  });

  it('falls back to task_description when no other summary sources exist', () => {
    updateWorkerStatus(TMP_DIR, RUN_ID, {
      task_id: 'task-i',
      status: 'running',
      plan_id: 'plan-i',
      task_description: 'This is the task description',
    });

    const snapshot = loadWorkerStatusSnapshot(TMP_DIR, RUN_ID);
    const worker = findWorkerStatusEntry(snapshot, 'task-i');
    expect(worker?.task_summary).toBe('This is the task description');
  });
});
