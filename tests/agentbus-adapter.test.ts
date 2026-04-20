// tests/agentbus-adapter.test.ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  buildRoomRef,
  collectPlannerDiscussReplies,
  closePlannerDiscussRoom,
  closeDiscussRoom,
  openPlannerDiscussRoom,
  openRecoveryRoom,
  openReviewRoom,
  synthesizeWorkerDiscussReplies,
  synthesizeWorkerDiscussRepliesWithModel,
  type AgentBusReply,
  type PlannerDiscussRoom,
} from '../orchestrator/agentbus-adapter.js';
import { appendMessage, readManifest, readMessage } from '../src/agentbus/backend-fs.js';

afterEach(() => {
  vi.useRealTimers();
});

// ── buildRoomRef ──

describe('buildRoomRef', () => {
  it('constructs PlannerDiscussRoomRef from room and replies', () => {
    const room: PlannerDiscussRoom = {
      room_id: 'room-test123',
      join_hint: 'agentbus join room-test123',
      orchestrator_id: 'hive-planner-test123',
    };
    const replies: AgentBusReply[] = [
      { participant_id: 'agent-a', content: 'one', response_time_ms: 1200, content_length: 3, received_at: '2026-04-03T00:00:01.000Z' },
      { participant_id: 'agent-b', content: 'two', response_time_ms: 2500, content_length: 3, received_at: '2026-04-03T00:00:02.500Z' },
      { participant_id: 'agent-c', content: 'three', response_time_ms: 4000, content_length: 5, received_at: '2026-04-03T00:00:04.000Z' },
    ];
    const ref = buildRoomRef(room, replies, 30000);
    expect(ref.room_id).toBe('room-test123');
    expect(ref.transport).toBe('agentbus');
    expect(ref.reply_count).toBe(3);
    expect(ref.timeout_ms).toBe(30000);
    expect(ref.join_hint).toBe('agentbus join room-test123');
    expect(ref.created_at).toBeTruthy();
    expect(ref.reply_metadata).toEqual([
      { participant_id: 'agent-a', response_time_ms: 1200, content_length: 3 },
      { participant_id: 'agent-b', response_time_ms: 2500, content_length: 3 },
      { participant_id: 'agent-c', response_time_ms: 4000, content_length: 5 },
    ]);
  });

  it('omits join_hint when not present', () => {
    const room: PlannerDiscussRoom = { room_id: 'room-abc', orchestrator_id: 'hive-planner-abc' };
    const ref = buildRoomRef(room, [], 15000);
    expect(ref.join_hint).toBeUndefined();
    expect(ref.reply_count).toBe(0);
    expect(ref.timeout_ms).toBe(15000);
    expect(ref.reply_metadata).toBeUndefined();
  });

  it('uses ISO date string for created_at', () => {
    const room: PlannerDiscussRoom = { room_id: 'room-date', orchestrator_id: 'hive-planner-date' };
    const ref = buildRoomRef(room, [{ participant_id: 'agent-a', content: 'ok', response_time_ms: 100, content_length: 2, received_at: '2026-04-03T00:00:00.100Z' }], 5000);
    expect(new Date(ref.created_at).toISOString()).toBe(ref.created_at);
  });
});

describe('open/close room lifecycle', () => {
  it('uses one stable orchestrator identity across open broadcast and summary close', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-agentbus-stable-id-'));
    process.env.AGENTBUS_DATA_DIR = dataDir;

    try {
      const room = await openPlannerDiscussRoom({
        cwd: process.cwd(),
        brief: {
          type: 'planning-brief',
          version: 1,
          created_at: '2026-04-03T00:00:00.000Z',
          goal: 'Verify stable orchestrator identity',
          planner_model: 'glm-5-turbo',
          cwd_hint: 'hive',
          task_count: 1,
          tasks: [{
            id: 'task-a',
            complexity: 'medium',
            category: 'api',
            description: 'Keep one orchestrator id per room lifecycle',
            assigned_model: 'glm-5-turbo',
            depends_on: [],
            estimated_files: ['orchestrator/agentbus-adapter.ts'],
          }],
          execution_order: [['task-a']],
          context_flow: {},
          review_focus: 'Check room lifecycle identity.',
          questions: ['Does open/close keep the same from id?'],
        },
      });

      await closePlannerDiscussRoom({
        room_id: room.room_id,
        orchestrator_id: room.orchestrator_id,
        summary: {
          quality_gate: 'pass',
          reply_count: 1,
        },
      });

      const manifest = await readManifest(dataDir, room.room_id);
      const opening = await readMessage(dataDir, room.room_id, 1);
      const closing = await readMessage(dataDir, room.room_id, 2);

      expect(manifest.room.created_by).toBe(room.orchestrator_id);
      expect(manifest.room.status).toBe('CLOSED');
      expect(opening?.from).toBe(room.orchestrator_id);
      expect(closing?.from).toBe(room.orchestrator_id);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      delete process.env.AGENTBUS_DATA_DIR;
    }
  });

  it('writes external-review-summary when closing a review room', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-agentbus-review-summary-'));
    process.env.AGENTBUS_DATA_DIR = dataDir;

    try {
      const room = await openReviewRoom({
        cwd: process.cwd(),
        brief: {
          type: 'review-brief',
          version: 1,
          created_at: '2026-04-04T00:00:00.000Z',
          task_id: 'task-a',
          worker_model: 'glm-5-turbo',
          cwd_hint: 'hive',
          final_stage: 'a2a-lenses',
          passed: false,
          task_description: 'Review the failed internal review result.',
          changed_files: ['orchestrator/reviewer.ts'],
          finding_count: 1,
          findings: [
            {
              severity: 'red',
              file: 'orchestrator/reviewer.ts:420',
              issue: 'Potential false positive in internal review.',
            },
          ],
          ask: 'Check whether the failure is real and what to repair first.',
        },
      });

      await closeDiscussRoom({
        room_id: room.room_id,
        orchestrator_id: room.orchestrator_id,
        room_kind: 'review',
        summary: {
          quality_gate: 'pass',
          reply_count: 1,
        },
      });

      const closing = await readMessage(dataDir, room.room_id, 2);
      expect(closing?.payload).toMatchObject({
        type: 'external-review-summary',
        quality_gate: 'pass',
        reply_count: 1,
      });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      delete process.env.AGENTBUS_DATA_DIR;
    }
  });

  it('writes recovery-summary when closing a recovery room', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-agentbus-recovery-summary-'));
    process.env.AGENTBUS_DATA_DIR = dataDir;

    try {
      const room = await openRecoveryRoom({
        cwd: process.cwd(),
        brief: {
          type: 'recovery-brief',
          version: 1,
          created_at: '2026-04-05T00:00:00.000Z',
          task_id: 'task-a',
          worker_model: 'glm-5-turbo',
          cwd_hint: 'hive',
          retry_count: 1,
          max_retries: 2,
          task_description: 'Task kept failing repair and needs repeated-fail advice.',
          finding_count: 1,
          findings: [
            {
              severity: 'red',
              file: 'orchestrator/driver.ts:512',
              issue: 'Repair attempt repeated the same failing branch.',
            },
          ],
          recent_attempts: [
            {
              round: 2,
              outcome: 'failed',
              note: 'repair review still failing',
            },
          ],
          ask: 'Suggest the smallest next repair or whether Hive should stop retrying.',
        },
      });

      await closeDiscussRoom({
        room_id: room.room_id,
        orchestrator_id: room.orchestrator_id,
        room_kind: 'recovery',
        summary: {
          quality_gate: 'pass',
          reply_count: 1,
        },
      });

      const closing = await readMessage(dataDir, room.room_id, 2);
      expect(closing?.payload).toMatchObject({
        type: 'recovery-summary',
        quality_gate: 'pass',
        reply_count: 1,
      });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      delete process.env.AGENTBUS_DATA_DIR;
    }
  });
});

describe('collectPlannerDiscussReplies', () => {
  it('collects real answer messages and captures reply metadata', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-agentbus-'));
    process.env.AGENTBUS_DATA_DIR = dataDir;

    try {
      const room = await openPlannerDiscussRoom({
        cwd: process.cwd(),
        brief: {
          type: 'planning-brief',
          version: 1,
          created_at: '2026-04-03T00:00:00.000Z',
          goal: 'Test planner discuss',
          planner_model: 'glm-5-turbo',
          cwd_hint: 'hive',
          task_count: 1,
          tasks: [{
            id: 'task-a',
            complexity: 'medium',
            category: 'api',
            description: 'Test the adapter path',
            assigned_model: 'glm-5-turbo',
            depends_on: [],
            estimated_files: ['orchestrator/agentbus-adapter.ts'],
          }],
          execution_order: [['task-a']],
          context_flow: {},
          review_focus: 'Check the adapter flow.',
          questions: ['Is the room payload readable?'],
        },
      });

      await appendMessage(
        dataDir,
        room.room_id,
        'answer',
        'reviewer-a',
        '*',
        { text: 'Looks good, but add metadata.' },
      );

      const replies = await collectPlannerDiscussReplies({
        cwd: process.cwd(),
        room_id: room.room_id,
        timeout_ms: 50,
        min_replies: 1,
      });

      expect(replies).toHaveLength(1);
      expect(replies[0]?.participant_id).toBe('reviewer-a');
      expect(replies[0]?.content).toContain('add metadata');
      expect(replies[0]?.response_time_ms).toBeGreaterThanOrEqual(0);
      expect(replies[0]?.content_length).toBeGreaterThan(0);
      expect(replies[0]?.received_at).toMatch(/Z$/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      delete process.env.AGENTBUS_DATA_DIR;
    }
  });

  it('keeps a short grace window when min_replies=0 so quick replies are still collected', async () => {
    vi.useFakeTimers();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-agentbus-grace-'));
    process.env.AGENTBUS_DATA_DIR = dataDir;

    try {
      const room = await openPlannerDiscussRoom({
        cwd: process.cwd(),
        brief: {
          type: 'planning-brief',
          version: 1,
          created_at: '2026-04-03T00:00:00.000Z',
          goal: 'Collect fast replies with non-blocking mode',
          planner_model: 'glm-5-turbo',
          cwd_hint: 'hive',
          task_count: 1,
          tasks: [{
            id: 'task-a',
            complexity: 'medium',
            category: 'api',
            description: 'Verify grace-period polling',
            assigned_model: 'glm-5-turbo',
            depends_on: [],
            estimated_files: ['orchestrator/agentbus-adapter.ts'],
          }],
          execution_order: [['task-a']],
          context_flow: {},
          review_focus: 'Check quick reply collection.',
          questions: ['Will a fast reply be captured?'],
        },
      });

      const replyPromise = collectPlannerDiscussReplies({
        cwd: process.cwd(),
        room_id: room.room_id,
        timeout_ms: 5000,
        min_replies: 0,
      });

      await vi.advanceTimersByTimeAsync(200);
      await appendMessage(
        dataDir,
        room.room_id,
        'answer',
        'reviewer-fast',
        '*',
        { text: 'I arrived during the grace period.' },
      );

      await vi.advanceTimersByTimeAsync(2600);
      const replies = await replyPromise;

      expect(replies).toHaveLength(1);
      expect(replies[0]?.participant_id).toBe('reviewer-fast');
      expect(replies[0]?.content).toContain('grace period');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      delete process.env.AGENTBUS_DATA_DIR;
    }
  });
});

// ── synthesizeWorkerDiscussReplies ──

describe('synthesizeWorkerDiscussReplies', () => {
  const trigger = { leaning: 'option-A', task_id: 'task-x' };

  it('falls back to leaning when no replies', () => {
    const result = synthesizeWorkerDiscussReplies([], trigger);
    expect(result.decision).toBe('option-A');
    expect(result.quality_gate).toBe('warn');
    expect(result.escalated).toBe(false);
    expect(result.thread_id).toMatch(/^agentbus-task-x-/);
  });

  it('uses first reply content as decision with single reply', () => {
    const replies: AgentBusReply[] = [
      { participant_id: 'agent-a', content: 'Go with option B', response_time_ms: 500, content_length: 17, received_at: '2026-04-03T00:00:00.500Z' },
    ];
    const result = synthesizeWorkerDiscussReplies(replies, trigger);
    expect(result.decision).toBe('Go with option B');
    expect(result.quality_gate).toBe('warn');
    expect(result.reasoning).toContain('[agent-a]');
  });

  it('returns pass quality gate with 2+ replies', () => {
    const replies: AgentBusReply[] = [
      { participant_id: 'agent-a', content: 'Use approach X', response_time_ms: 500, content_length: 15, received_at: '2026-04-03T00:00:00.500Z' },
      { participant_id: 'agent-b', content: 'Agree with X', response_time_ms: 800, content_length: 13, received_at: '2026-04-03T00:00:00.800Z' },
    ];
    const result = synthesizeWorkerDiscussReplies(replies, trigger);
    expect(result.quality_gate).toBe('pass');
    expect(result.reasoning).toContain('[agent-a]');
    expect(result.reasoning).toContain('[agent-b]');
  });

  it('truncates long reply content to 200 chars in decision', () => {
    const longContent = 'x'.repeat(500);
    const replies: AgentBusReply[] = [
      { participant_id: 'agent-a', content: longContent, response_time_ms: 100, content_length: 500, received_at: '2026-04-03T00:00:00.100Z' },
    ];
    const result = synthesizeWorkerDiscussReplies(replies, trigger);
    expect(result.decision.length).toBe(200);
  });
});

// ── synthesizeWorkerDiscussRepliesWithModel ──

// These mocks intercept the dynamic imports inside synthesizeWorkerDiscussRepliesWithModel.
const {
  safeQueryMock,
  extractTextFromMessagesMock,
  buildSdkEnvMock,
  resolveProviderForModelMock,
} = vi.hoisted(() => ({
  safeQueryMock: vi.fn(),
  extractTextFromMessagesMock: vi.fn(),
  buildSdkEnvMock: vi.fn().mockReturnValue({}),
  resolveProviderForModelMock: vi.fn().mockReturnValue({ baseUrl: 'http://mock', apiKey: 'key' }),
}));

vi.mock('../orchestrator/sdk-query-safe.js', () => ({
  safeQuery: safeQueryMock,
  extractTextFromMessages: extractTextFromMessagesMock,
}));

vi.mock('../orchestrator/project-paths.js', () => ({
  buildSdkEnv: buildSdkEnvMock,
  resolveProjectPath: vi.fn((...segments: string[]) => path.join(process.cwd(), ...segments)),
}));

vi.mock('../orchestrator/provider-resolver.js', () => ({
  resolveProviderForModel: resolveProviderForModelMock,
}));

vi.mock('../orchestrator/model-registry.js', () => {
  class ModelRegistry {
    selectDiscussPartner() { return 'glm-5-turbo'; }
  }
  return { ModelRegistry };
});

vi.mock('../orchestrator/hive-config.js', () => ({
  resolveTierModel: (_selector: string, fallback: () => string) => fallback(),
}));

describe('synthesizeWorkerDiscussRepliesWithModel', () => {
  const trigger = { leaning: 'option-A', task_id: 'task-x' };
  const config = { tiers: { discuss: { model: 'glm-5-turbo' } } };

  beforeEach(() => {
    vi.restoreAllMocks();
    safeQueryMock.mockReset();
    extractTextFromMessagesMock.mockReset();
    buildSdkEnvMock.mockReset().mockReturnValue({});
    resolveProviderForModelMock.mockReset().mockReturnValue({ baseUrl: 'http://mock', apiKey: 'key' });
  });

  it('returns valid DiscussResult on successful model synthesis', async () => {
    const replies: AgentBusReply[] = [
      { participant_id: 'agent-a', content: 'Use approach X', response_time_ms: 500, content_length: 15, received_at: '2026-04-03T00:00:00.500Z' },
      { participant_id: 'agent-b', content: 'Agree with X', response_time_ms: 800, content_length: 13, received_at: '2026-04-03T00:00:00.800Z' },
    ];

    extractTextFromMessagesMock.mockReturnValue(
      JSON.stringify({ decision: 'Go with approach X', reasoning: '[agent-a] suggests X; [agent-b] agrees', escalated: false, quality_gate: 'pass' }),
    );
    safeQueryMock.mockResolvedValue({ messages: [] });

    const result = await synthesizeWorkerDiscussRepliesWithModel(replies, trigger, config, 'glm-5-turbo');

    expect(result.decision).toBe('Go with approach X');
    expect(result.reasoning).toContain('agent-a');
    expect(result.reasoning).toContain('agent-b');
    expect(result.quality_gate).toBe('pass');
    expect(result.escalated).toBe(false);
    expect(result.thread_id).toMatch(/^agentbus-model-task-x-/);
  });

  it('calls provider resolve and buildSdkEnv on happy path', async () => {
    const replies: AgentBusReply[] = [
      { participant_id: 'agent-a', content: 'Do this', response_time_ms: 500, content_length: 7, received_at: '2026-04-03T00:00:00.500Z' },
    ];

    extractTextFromMessagesMock.mockReturnValue(
      JSON.stringify({ decision: 'Do this', reasoning: '[agent-a] says do this', escalated: false, quality_gate: 'warn' }),
    );
    safeQueryMock.mockResolvedValue({ messages: [] });

    await synthesizeWorkerDiscussRepliesWithModel(replies, trigger, config, 'glm-5-turbo');

    expect(resolveProviderForModelMock).toHaveBeenCalledWith('glm-5-turbo');
    expect(buildSdkEnvMock).toHaveBeenCalledWith('glm-5-turbo', 'http://mock', 'key');
    expect(safeQueryMock).toHaveBeenCalled();
  });

  it('falls back to heuristic when a non-Claude synthesis model has no direct route', async () => {
    const replies: AgentBusReply[] = [
      { participant_id: 'agent-a', content: 'Do this', response_time_ms: 500, content_length: 7, received_at: '2026-04-03T00:00:00.500Z' },
    ];

    resolveProviderForModelMock.mockImplementation(() => { throw new Error('no route'); });
    extractTextFromMessagesMock.mockReturnValue(
      JSON.stringify({ decision: 'Do this', reasoning: '[agent-a] says do this', escalated: false, quality_gate: 'warn' }),
    );
    safeQueryMock.mockResolvedValue({ messages: [] });

    const result = await synthesizeWorkerDiscussRepliesWithModel(replies, trigger, config, 'glm-5-turbo');

    expect(buildSdkEnvMock).not.toHaveBeenCalled();
    expect(safeQueryMock).not.toHaveBeenCalled();
    expect(result.decision).toContain('Do this');
  });

  it('falls back to heuristic when safeQuery rejects', async () => {
    const replies: AgentBusReply[] = [
      { participant_id: 'agent-a', content: 'Use approach X', response_time_ms: 500, content_length: 15, received_at: '2026-04-03T00:00:00.500Z' },
      { participant_id: 'agent-b', content: 'Agree with X', response_time_ms: 800, content_length: 13, received_at: '2026-04-03T00:00:00.800Z' },
    ];

    safeQueryMock.mockRejectedValue(new Error('API down'));

    const result = await synthesizeWorkerDiscussRepliesWithModel(replies, trigger, config, 'glm-5-turbo');

    // Fallback: heuristic produces pass for 2+ replies
    expect(result.quality_gate).toBe('pass');
    expect(result.decision).toBe('Use approach X');
    expect(result.reasoning).toContain('agent-a');
    expect(result.reasoning).toContain('agent-b');
  });

  it('falls back to heuristic when model response is not valid JSON', async () => {
    const replies: AgentBusReply[] = [
      { participant_id: 'agent-a', content: 'Use approach X', response_time_ms: 500, content_length: 15, received_at: '2026-04-03T00:00:00.500Z' },
      { participant_id: 'agent-b', content: 'Agree with X', response_time_ms: 800, content_length: 13, received_at: '2026-04-03T00:00:00.800Z' },
    ];

    extractTextFromMessagesMock.mockReturnValue('Sorry, I cannot provide a valid response.');
    safeQueryMock.mockResolvedValue({ messages: [] });

    const result = await synthesizeWorkerDiscussRepliesWithModel(replies, trigger, config, 'glm-5-turbo');

    // No valid JSON in response → falls back to heuristic
    expect(result.quality_gate).toBe('pass');
    expect(result.decision).toBe('Use approach X');
  });

  it('falls back to heuristic when model returns JSON missing required fields', async () => {
    const replies: AgentBusReply[] = [
      { participant_id: 'agent-a', content: 'Use approach X', response_time_ms: 500, content_length: 15, received_at: '2026-04-03T00:00:00.500Z' },
    ];

    // JSON present but missing decision field
    extractTextFromMessagesMock.mockReturnValue(JSON.stringify({ quality_gate: 'pass', something: 'else' }));
    safeQueryMock.mockResolvedValue({ messages: [] });

    const result = await synthesizeWorkerDiscussRepliesWithModel(replies, trigger, config, 'glm-5-turbo');

    // Missing decision/reasoning → falls back to heuristic
    expect(result.decision).toBe('Use approach X');
    expect(result.quality_gate).toBe('warn'); // 1 reply heuristic
  });

  it('extracts JSON from wrapped text response', async () => {
    const replies: AgentBusReply[] = [
      { participant_id: 'agent-a', content: 'Do X', response_time_ms: 500, content_length: 5, received_at: '2026-04-03T00:00:00.500Z' },
    ];

    const innerJson = JSON.stringify({ decision: 'Do X', reasoning: 'agent-a says so', escalated: false, quality_gate: 'warn' });
    extractTextFromMessagesMock.mockReturnValue(
      `Here is my analysis:\n\n${innerJson}\n\nHope that helps.`,
    );
    safeQueryMock.mockResolvedValue({ messages: [] });

    const result = await synthesizeWorkerDiscussRepliesWithModel(replies, trigger, config, 'glm-5-turbo');

    expect(result.decision).toBe('Do X');
    expect(result.reasoning).toBe('agent-a says so');
    expect(result.quality_gate).toBe('warn');
  });

  it('falls back to heuristic with zero replies when model returns no valid JSON', async () => {
    const replies: AgentBusReply[] = [];

    extractTextFromMessagesMock.mockReturnValue('no valid json here');
    safeQueryMock.mockResolvedValue({ messages: [] });

    const result = await synthesizeWorkerDiscussRepliesWithModel(replies, trigger, config, 'glm-5-turbo');

    expect(result.decision).toBe('option-A');
    expect(result.quality_gate).toBe('warn');
  });
});
