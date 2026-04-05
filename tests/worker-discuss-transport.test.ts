import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerDiscussBrief } from '../orchestrator/types.js';

// ── Mocks ──

const {
  triggerDiscussionMock,
  openWorkerDiscussRoomMock,
  collectDiscussRepliesMock,
  closeDiscussRoomMock,
  synthesizeWorkerDiscussRepliesMock,
  loadConfigMock,
  safeQueryMock,
  resolveProviderMock,
  buildSdkEnvMock,
  updateWorkerStatusMock,
  appendWorkerTranscriptEntryMock,
} = vi.hoisted(() => ({
  triggerDiscussionMock: vi.fn(),
  openWorkerDiscussRoomMock: vi.fn(),
  collectDiscussRepliesMock: vi.fn(),
  closeDiscussRoomMock: vi.fn(),
  synthesizeWorkerDiscussRepliesMock: vi.fn(),
  loadConfigMock: vi.fn(),
  safeQueryMock: vi.fn(),
  resolveProviderMock: vi.fn(),
  buildSdkEnvMock: vi.fn(),
  updateWorkerStatusMock: vi.fn(),
  appendWorkerTranscriptEntryMock: vi.fn(),
}));

vi.mock('../orchestrator/discuss-bridge.js', () => ({
  triggerDiscussion: triggerDiscussionMock,
}));

vi.mock('../orchestrator/agentbus-adapter.js', async () => {
  const actual = await vi.importActual<typeof import('../orchestrator/agentbus-adapter.js')>('../orchestrator/agentbus-adapter.js');
  return {
    ...actual,
    openWorkerDiscussRoom: openWorkerDiscussRoomMock,
    collectDiscussReplies: collectDiscussRepliesMock,
    closeDiscussRoom: closeDiscussRoomMock,
    synthesizeWorkerDiscussReplies: synthesizeWorkerDiscussRepliesMock,
  };
});

vi.mock('../orchestrator/hive-config.js', async () => {
  const actual = await vi.importActual<typeof import('../orchestrator/hive-config.js')>('../orchestrator/hive-config.js');
  return {
    ...actual,
    loadConfig: loadConfigMock,
  };
});

vi.mock('../orchestrator/sdk-query-safe.js', () => ({
  safeQuery: safeQueryMock,
}));

vi.mock('../orchestrator/provider-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../orchestrator/provider-resolver.js')>('../orchestrator/provider-resolver.js');
  return {
    ...actual,
    resolveProvider: resolveProviderMock,
  };
});

vi.mock('../orchestrator/project-paths.js', async () => {
  const actual = await vi.importActual<typeof import('../orchestrator/project-paths.js')>('../orchestrator/project-paths.js');
  return {
    ...actual,
    buildSdkEnv: buildSdkEnvMock,
  };
});

vi.mock('../orchestrator/worker-status-store.js', async () => {
  const actual = await vi.importActual<typeof import('../orchestrator/worker-status-store.js')>('../orchestrator/worker-status-store.js');
  return {
    ...actual,
    updateWorkerStatus: updateWorkerStatusMock,
    appendWorkerTranscriptEntry: appendWorkerTranscriptEntryMock,
  };
});

import { spawnWorker } from '../orchestrator/dispatcher.js';
import { buildWorkerDiscussBrief } from '../orchestrator/worker-discuss-handler.js';
import {
  type AgentBusReply,
} from '../orchestrator/agentbus-adapter.js';

// ── buildWorkerDiscussBrief ──

describe('buildWorkerDiscussBrief', () => {
  it('builds a structured brief with basename cwd and trigger fields', () => {
    const trigger = {
      uncertain_about: 'Should I use a Map or a plain object?',
      options: ['Map', 'plain object'],
      leaning: 'Map',
      why: 'Better key types',
      task_id: 'task-a',
      worker_model: 'glm-5-turbo',
    };
    const workerConfig = {
      taskId: 'task-a',
      model: 'glm-5-turbo',
      prompt: 'Implement the cache layer with proper data structures and tests.',
    } as any;

    const brief = buildWorkerDiscussBrief(
      trigger,
      workerConfig,
      '/tmp/workspaces/hive-worker',
    );

    expect(brief.type).toBe('worker-discuss-brief');
    expect(brief.version).toBe(1);
    expect(brief.task_id).toBe('task-a');
    expect(brief.worker_model).toBe('glm-5-turbo');
    expect(brief.cwd_hint).toBe('hive-worker');
    expect(brief.cwd_hint).not.toContain('/tmp/workspaces');
    expect(brief.uncertain_about).toBe('Should I use a Map or a plain object?');
    expect(brief.options).toEqual(['Map', 'plain object']);
    expect(brief.leaning).toBe('Map');
    expect(brief.why).toBe('Better key types');
    expect(brief.task_description.length).toBeLessThanOrEqual(200);
  });
});

describe('spawnWorker worker discuss transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveProviderMock.mockReturnValue({ baseUrl: 'http://mock-route', apiKey: 'mock-key' });
    buildSdkEnvMock.mockReturnValue({});
    loadConfigMock.mockReturnValue({
      collab: {
        worker_discuss_transport: 'agentbus',
        worker_discuss_timeout_ms: 3000,
        worker_discuss_min_replies: 0,
      },
    });
  });

  it('falls back to local discuss when AgentBus room open fails', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-worker-fallback-'));
    fs.mkdirSync(path.join(cwd, '.ai'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.ai', 'discuss-trigger.json'), JSON.stringify({
      uncertain_about: 'Map or object?',
      options: ['Map', 'object'],
      leaning: 'Map',
      why: 'Better key support',
      task_id: 'task-a',
      worker_model: 'glm-5-turbo',
    }));

    safeQueryMock
      .mockResolvedValueOnce({
        messages: [
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: '[DISCUSS_TRIGGER]\nNeed help.' }] },
          },
          { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      })
      .mockResolvedValueOnce({
        messages: [
          { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      });
    openWorkerDiscussRoomMock.mockRejectedValue(new Error('agentbus unavailable'));
    triggerDiscussionMock.mockResolvedValue({
      decision: 'Use Map',
      reasoning: 'Fallback local discuss result.',
      escalated: false,
      thread_id: 'local-task-a',
      quality_gate: 'warn',
    });

    try {
      const result = await spawnWorker({
        taskId: 'task-a',
        model: 'glm-5-turbo',
        provider: 'glm',
        prompt: 'Implement cache handling',
        cwd,
        worktree: false,
        contextInputs: [],
        discussThreshold: 0.7,
        maxTurns: 5,
        taskDescription: 'Implement cache handling',
      });

      expect(openWorkerDiscussRoomMock).toHaveBeenCalledTimes(1);
      expect(triggerDiscussionMock).toHaveBeenCalledTimes(1);
      expect(result.discuss_results).toHaveLength(1);
      expect(result.discuss_results[0]?.decision).toBe('Use Map');
      expect(result.worker_discuss_collab).toBeUndefined();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('publishes task_discuss snapshots and returns collab state on success', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-worker-collab-'));
    fs.mkdirSync(path.join(cwd, '.ai'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.ai', 'discuss-trigger.json'), JSON.stringify({
      uncertain_about: 'Map or object?',
      options: ['Map', 'object'],
      leaning: 'Map',
      why: 'Better key support',
      task_id: 'task-a',
      worker_model: 'glm-5-turbo',
    }));

    safeQueryMock
      .mockResolvedValueOnce({
        messages: [
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: '[DISCUSS_TRIGGER]\nNeed help.' }] },
          },
          { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      })
      .mockResolvedValueOnce({
        messages: [
          { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      });
    openWorkerDiscussRoomMock.mockResolvedValue({
      room_id: 'room-task-a',
      join_hint: 'agentbus join room-task-a',
      orchestrator_id: 'hive-worker-task-a-1',
    });
    collectDiscussRepliesMock.mockImplementation(async (input: any) => {
      await input.on_reply?.({
        participant_id: 'codex-planner',
        content: 'Use a Map.',
        response_time_ms: 12,
        content_length: 10,
        received_at: '2026-04-03T00:00:02.000Z',
      });
      return [{
        participant_id: 'codex-planner',
        content: 'Use a Map.',
        response_time_ms: 12,
        content_length: 10,
        received_at: '2026-04-03T00:00:02.000Z',
      }];
    });
    synthesizeWorkerDiscussRepliesMock.mockReturnValue({
      decision: 'Use Map',
      reasoning: 'AgentBus reply agrees with Map.',
      escalated: false,
      thread_id: 'agentbus-task-a-1',
      quality_gate: 'pass',
    });
    const snapshots: Array<{ status: string; replies: number; room_kind: string }> = [];

    try {
      const result = await spawnWorker({
        taskId: 'task-a',
        model: 'glm-5-turbo',
        provider: 'glm',
        prompt: 'Implement cache handling',
        cwd,
        worktree: false,
        contextInputs: [],
        discussThreshold: 0.7,
        maxTurns: 5,
        runId: 'run-task-a',
        planId: 'plan-task-a',
        round: 2,
        taskDescription: 'Implement cache handling',
        onWorkerDiscussSnapshot: async (snapshot) => {
          snapshots.push({
            status: snapshot.card.status,
            replies: snapshot.card.replies,
            room_kind: snapshot.card.room_kind,
          });
        },
      });

      expect(result.worker_discuss_collab?.card.room_id).toBe('room-task-a');
      expect(result.worker_discuss_collab?.card.room_kind).toBe('task_discuss');
      expect(result.worker_discuss_collab?.card.status).toBe('closed');
      expect(result.worker_discuss_collab?.recent_events.map((event) => event.type)).toEqual([
        'room:opened',
        'reply:arrived',
        'synthesis:started',
        'synthesis:done',
        'room:closed',
      ]);
      expect(snapshots.some((snapshot) => snapshot.room_kind === 'task_discuss')).toBe(true);
      expect(snapshots.at(-1)).toEqual({
        status: 'closed',
        replies: 1,
        room_kind: 'task_discuss',
      });
      expect(closeDiscussRoomMock).toHaveBeenCalledWith(expect.objectContaining({
        room_id: 'room-task-a',
        room_kind: 'task_discuss',
      }));
      expect(updateWorkerStatusMock).toHaveBeenCalledWith(
        cwd,
        'run-task-a',
        expect.objectContaining({
          task_id: 'task-a',
          status: 'discussing',
          collab: expect.objectContaining({
            card: expect.objectContaining({
              room_id: 'room-task-a',
              room_kind: 'task_discuss',
            }),
          }),
        }),
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ── openWorkerDiscussRoom (real filesystem) ──

describe('openWorkerDiscussRoom (real)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates room with worker orchestrator ID prefix', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-worker-discuss-'));
    process.env.AGENTBUS_DATA_DIR = dataDir;

    try {
      // Use the real implementation for this test
      const { openWorkerDiscussRoom: realOpen } = await vi.importActual<
        typeof import('../orchestrator/agentbus-adapter.js')
      >('../orchestrator/agentbus-adapter.js');

      const brief: WorkerDiscussBrief = {
        type: 'worker-discuss-brief',
        version: 1,
        created_at: new Date().toISOString(),
        task_id: 'task-a',
        worker_model: 'glm-5-turbo',
        cwd_hint: 'hive',
        uncertain_about: 'Map vs object?',
        options: ['Map', 'object'],
        leaning: 'Map',
        why: 'Better key types',
        task_description: 'Implement cache layer',
      };

      const room = await realOpen({ cwd: process.cwd(), brief });

      expect(room.room_id).toMatch(/^room-/);
      expect(room.orchestrator_id).toMatch(/^hive-worker-task-a-/);
      expect(room.join_hint).toContain(room.room_id);

      // Verify room was created on disk
      const { readManifest, readMessage } = await import('../src/agentbus/backend-fs.js');
      const manifest = await readManifest(dataDir, room.room_id);
      expect(manifest.room.created_by).toBe(room.orchestrator_id);

      const opening = await readMessage(dataDir, room.room_id, 1);
      expect(opening?.from).toBe(room.orchestrator_id);
      expect(opening?.payload?.type).toBe('worker-discuss-brief');
      expect(opening?.payload?.task_id).toBe('task-a');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      delete process.env.AGENTBUS_DATA_DIR;
    }
  });
});

describe('closeDiscussRoom (real)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a worker summary payload for task_discuss rooms', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-worker-close-'));
    process.env.AGENTBUS_DATA_DIR = dataDir;

    try {
      const { openWorkerDiscussRoom: realOpen, closeDiscussRoom: realClose } = await vi.importActual<
        typeof import('../orchestrator/agentbus-adapter.js')
      >('../orchestrator/agentbus-adapter.js');

      const room = await realOpen({
        cwd: process.cwd(),
        brief: {
          type: 'worker-discuss-brief',
          version: 1,
          created_at: new Date().toISOString(),
          task_id: 'task-a',
          worker_model: 'glm-5-turbo',
          cwd_hint: 'hive',
          uncertain_about: 'Map or object?',
          options: ['Map', 'object'],
          leaning: 'Map',
          why: 'Better key support',
          task_description: 'Implement cache layer',
        },
      });

      await realClose({
        room_id: room.room_id,
        orchestrator_id: room.orchestrator_id,
        room_kind: 'task_discuss',
        summary: { quality_gate: 'pass' },
      });

      const { readMessage } = await import('../src/agentbus/backend-fs.js');
      const summary = await readMessage(dataDir, room.room_id, 2);
      expect(summary?.payload?.type).toBe('worker-discuss-summary');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      delete process.env.AGENTBUS_DATA_DIR;
    }
  });
});

// ── synthesizeWorkerDiscussReplies ──

describe('synthesizeWorkerDiscussReplies', () => {
  it('produces a DiscussResult from AgentBus replies', async () => {
    const { synthesizeWorkerDiscussReplies: realSynth } = await vi.importActual<
      typeof import('../orchestrator/agentbus-adapter.js')
    >('../orchestrator/agentbus-adapter.js');

    const replies: AgentBusReply[] = [
      {
        participant_id: 'codex-planner',
        content: 'Use a Map — it handles non-string keys and has better iteration.',
        response_time_ms: 500,
        content_length: 60,
        received_at: new Date().toISOString(),
      },
      {
        participant_id: 'claude-planner',
        content: 'Agree with Map for this use case.',
        response_time_ms: 800,
        content_length: 33,
        received_at: new Date().toISOString(),
      },
    ];

    const result = realSynth(replies, { leaning: 'Map', task_id: 'task-a' });

    expect(result.decision).toBeTruthy();
    expect(result.reasoning).toContain('codex-planner');
    expect(result.reasoning).toContain('claude-planner');
    expect(result.quality_gate).toBe('pass'); // 2+ replies → pass
    expect(result.thread_id).toMatch(/^agentbus-task-a-/);
    expect(result.escalated).toBe(false);
  });

  it('returns warn quality_gate with zero replies', async () => {
    const { synthesizeWorkerDiscussReplies: realSynth } = await vi.importActual<
      typeof import('../orchestrator/agentbus-adapter.js')
    >('../orchestrator/agentbus-adapter.js');

    const result = realSynth([], { leaning: 'Map', task_id: 'task-a' });

    expect(result.decision).toBe('Map'); // uses leaning
    expect(result.quality_gate).toBe('warn');
  });
});
