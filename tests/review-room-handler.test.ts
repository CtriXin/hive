import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loadConfigMock,
  openReviewRoomMock,
  collectDiscussRepliesMock,
  closeDiscussRoomMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  openReviewRoomMock: vi.fn(),
  collectDiscussRepliesMock: vi.fn(),
  closeDiscussRoomMock: vi.fn(),
}));

vi.mock('../orchestrator/hive-config.js', async () => {
  const actual = await vi.importActual<typeof import('../orchestrator/hive-config.js')>('../orchestrator/hive-config.js');
  return {
    ...actual,
    loadConfig: loadConfigMock,
  };
});

vi.mock('../orchestrator/agentbus-adapter.js', async () => {
  const actual = await vi.importActual<typeof import('../orchestrator/agentbus-adapter.js')>('../orchestrator/agentbus-adapter.js');
  return {
    ...actual,
    openReviewRoom: openReviewRoomMock,
    collectDiscussReplies: collectDiscussRepliesMock,
    closeDiscussRoom: closeDiscussRoomMock,
  };
});

import {
  buildReviewBrief,
  maybeRunExternalReviewSlot,
} from '../orchestrator/review-room-handler.js';

function makeTask() {
  return {
    id: 'task-a',
    description: 'Fix the review pipeline edge case and preserve the current boundaries.',
    complexity: 'medium',
    category: 'backend',
    assigned_model: 'glm-5-turbo',
    depends_on: [],
    estimated_files: ['orchestrator/reviewer.ts'],
    acceptance_criteria: ['All review findings are addressed'],
    assignment_reason: 'test',
    discuss_threshold: 0.7,
    review_scale: 'auto',
  } as any;
}

function makeWorkerResult() {
  return {
    taskId: 'task-a',
    model: 'glm-5-turbo',
    worktreePath: '/tmp/hive-worker-task-a',
    branch: 'worker-task-a',
    sessionId: 'worker-task-a',
    output: [],
    changedFiles: ['orchestrator/reviewer.ts'],
    success: true,
    duration_ms: 1200,
    token_usage: { input: 10, output: 20 },
    discuss_triggered: false,
    discuss_results: [],
  } as any;
}

function makeReviewResult() {
  return {
    taskId: 'task-a',
    final_stage: 'a2a-lenses',
    passed: false,
    findings: [
      {
        id: 1,
        severity: 'red',
        lens: 'cross-review',
        file: 'orchestrator/reviewer.ts:420',
        issue: 'Internal review flagged a possible regression in reply handling.',
        decision: 'flag',
      },
    ],
    iterations: 1,
    duration_ms: 300,
  } as any;
}

describe('buildReviewBrief', () => {
  it('builds a structured brief without leaking full cwd', () => {
    const brief = buildReviewBrief(
      makeTask(),
      makeWorkerResult(),
      makeReviewResult(),
      '/Users/xin/auto-skills/CtriXin-repo/hive',
    );

    expect(brief.type).toBe('review-brief');
    expect(brief.cwd_hint).toBe('hive');
    expect(brief.cwd_hint).not.toContain('/Users/xin');
    expect(brief.task_id).toBe('task-a');
    expect(brief.findings).toHaveLength(1);
    expect(brief.findings[0]?.severity).toBe('red');
  });
});

describe('maybeRunExternalReviewSlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({
      collab: {
        review_transport: 'agentbus',
        review_timeout_ms: 3000,
        review_min_replies: 0,
      },
    });
    openReviewRoomMock.mockResolvedValue({
      room_id: 'room-review-a',
      join_hint: 'agentbus join room-review-a',
      orchestrator_id: 'hive-review-task-a-1',
    });
  });

  it('adds external advisory findings when replies arrive', async () => {
    collectDiscussRepliesMock.mockImplementation(async (input: any) => {
      await input.on_reply?.({
        participant_id: 'reviewer-a',
        content: 'The failure looks real; guard the zero-reply branch before synthesis.',
        response_time_ms: 22,
        content_length: 71,
        received_at: '2026-04-04T00:00:02.000Z',
      });
      return [
        {
          participant_id: 'reviewer-a',
          content: 'The failure looks real; guard the zero-reply branch before synthesis.',
          response_time_ms: 22,
          content_length: 71,
          received_at: '2026-04-04T00:00:02.000Z',
        },
      ];
    });

    const snapshots: string[] = [];
    const result = await maybeRunExternalReviewSlot({
      cwd: '/Users/xin/auto-skills/CtriXin-repo/hive',
      task: makeTask(),
      workerResult: makeWorkerResult(),
      reviewResult: makeReviewResult(),
      onSnapshot: async (snapshot) => {
        snapshots.push(`${snapshot.card.room_kind}:${snapshot.card.status}:${snapshot.card.replies}`);
      },
    });

    expect(openReviewRoomMock).toHaveBeenCalledTimes(1);
    expect(closeDiscussRoomMock).toHaveBeenCalledWith(expect.objectContaining({
      room_kind: 'review',
      summary: expect.objectContaining({
        quality_gate: 'pass',
        findings_count: 1,
      }),
    }));
    expect(result.findings).toHaveLength(2);
    expect(result.findings[1]?.lens).toBe('external-review');
    expect(result.findings[1]?.issue).toContain('zero-reply branch');
    expect(result.external_review_collab?.card.room_kind).toBe('review');
    expect(result.external_review_collab?.card.status).toBe('closed');
    expect(snapshots.some((item) => item.startsWith('review:collecting'))).toBe(true);
    expect(snapshots.some((item) => item.startsWith('review:closed:1'))).toBe(true);
  });

  it('skips external review when reviewResult.passed is true', async () => {
    const passedResult = { ...makeReviewResult(), passed: true };

    const result = await maybeRunExternalReviewSlot({
      cwd: '/Users/xin/auto-skills/CtriXin-repo/hive',
      task: makeTask(),
      workerResult: makeWorkerResult(),
      reviewResult: passedResult,
    });

    expect(openReviewRoomMock).not.toHaveBeenCalled();
    expect(result).toBe(passedResult);
  });

  it('skips external review when collab.review_transport is not agentbus', async () => {
    loadConfigMock.mockReturnValue({
      collab: { review_transport: 'none' },
    });

    const result = await maybeRunExternalReviewSlot({
      cwd: '/Users/xin/auto-skills/CtriXin-repo/hive',
      task: makeTask(),
      workerResult: makeWorkerResult(),
      reviewResult: makeReviewResult(),
    });

    expect(openReviewRoomMock).not.toHaveBeenCalled();
    expect(result).toStrictEqual(makeReviewResult());
  });

  it('falls back safely when openReviewRoom throws', async () => {
    openReviewRoomMock.mockRejectedValue(new Error('AgentBus unavailable'));

    const result = await maybeRunExternalReviewSlot({
      cwd: '/Users/xin/auto-skills/CtriXin-repo/hive',
      task: makeTask(),
      workerResult: makeWorkerResult(),
      reviewResult: makeReviewResult(),
    });

    expect(result.findings).toHaveLength(1);
    expect(result.external_review_collab).toBeUndefined();
    expect(closeDiscussRoomMock).not.toHaveBeenCalled();
  });

  it('keeps the original review result when no replies arrive', async () => {
    collectDiscussRepliesMock.mockResolvedValue([]);

    const result = await maybeRunExternalReviewSlot({
      cwd: '/Users/xin/auto-skills/CtriXin-repo/hive',
      task: makeTask(),
      workerResult: makeWorkerResult(),
      reviewResult: makeReviewResult(),
    });

    expect(result.findings).toHaveLength(1);
    expect(result.external_review_collab?.card.room_kind).toBe('review');
    expect(result.external_review_collab?.card.status).toBe('fallback');
    expect(closeDiscussRoomMock).toHaveBeenCalledWith(expect.objectContaining({
      room_kind: 'review',
      summary: expect.objectContaining({
        quality_gate: 'fallback',
        fallback: 'internal-review',
      }),
    }));
  });
});
