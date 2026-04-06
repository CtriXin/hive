import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loadConfigMock,
  openRecoveryRoomMock,
  collectDiscussRepliesMock,
  closeDiscussRoomMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  openRecoveryRoomMock: vi.fn(),
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
    openRecoveryRoom: openRecoveryRoomMock,
    collectDiscussReplies: collectDiscussRepliesMock,
    closeDiscussRoom: closeDiscussRoomMock,
  };
});

import {
  buildRecoveryBrief,
  maybeRunRecoveryAdvisory,
} from '../orchestrator/recovery-room-handler.js';

function makeTask() {
  return {
    id: 'task-a',
    description: 'Repair the flaky repeated-fail branch without changing unrelated code.',
    complexity: 'medium',
    category: 'backend',
    assigned_model: 'glm-5-turbo',
    depends_on: [],
    estimated_files: ['orchestrator/driver.ts'],
    acceptance_criteria: ['The repair path no longer loops on the same finding'],
    assignment_reason: 'test',
    discuss_threshold: 0.7,
    review_scale: 'auto',
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
        file: 'orchestrator/driver.ts:512',
        issue: 'Repair loop keeps retrying the same failing branch.',
        decision: 'flag',
      },
    ],
    iterations: 1,
    duration_ms: 300,
  } as any;
}

function makeRepairHistory() {
  return [
    {
      task_id: 'task-a',
      round: 2,
      findings_count: 1,
      outcome: 'failed',
      note: 'repair review still failing',
    },
  ] as any;
}

describe('buildRecoveryBrief', () => {
  it('builds a repeated-fail brief without leaking full cwd', () => {
    const brief = buildRecoveryBrief(
      makeTask(),
      makeReviewResult(),
      1,
      2,
      makeRepairHistory(),
      '/Users/xin/auto-skills/CtriXin-repo/hive',
    );

    expect(brief.type).toBe('recovery-brief');
    expect(brief.cwd_hint).toBe('hive');
    expect(brief.cwd_hint).not.toContain('/Users/xin');
    expect(brief.retry_count).toBe(1);
    expect(brief.recent_attempts).toHaveLength(1);
    expect(brief.findings[0]?.severity).toBe('red');
  });
});

describe('maybeRunRecoveryAdvisory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({
      collab: {
        recovery_transport: 'agentbus',
        recovery_timeout_ms: 3000,
        recovery_min_replies: 0,
        recovery_after_failures: 1,
      },
    });
    openRecoveryRoomMock.mockResolvedValue({
      room_id: 'room-recovery-a',
      join_hint: 'agentbus join room-recovery-a',
      orchestrator_id: 'hive-recovery-task-a-1',
    });
  });

  it('skips recovery advisory before the failure threshold', async () => {
    const result = await maybeRunRecoveryAdvisory({
      cwd: '/Users/xin/auto-skills/CtriXin-repo/hive',
      task: makeTask(),
      reviewResult: makeReviewResult(),
      retryCount: 0,
      maxRetries: 2,
      repairHistory: [],
    });

    expect(openRecoveryRoomMock).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(1);
    expect(result.recovery_collab).toBeUndefined();
  });

  it('adds repeated-fail advisory findings when replies arrive', async () => {
    collectDiscussRepliesMock.mockImplementation(async (input: any) => {
      await input.on_reply?.({
        participant_id: 'advisor-a',
        content: 'Stop touching the downstream branch; guard the retry counter before rebuilding the prompt.',
        response_time_ms: 40,
        content_length: 92,
        received_at: '2026-04-05T00:00:02.000Z',
      });
      return [
        {
          participant_id: 'advisor-a',
          content: 'Stop touching the downstream branch; guard the retry counter before rebuilding the prompt.',
          response_time_ms: 40,
          content_length: 92,
          received_at: '2026-04-05T00:00:02.000Z',
        },
      ];
    });

    const snapshots: string[] = [];
    const result = await maybeRunRecoveryAdvisory({
      cwd: '/Users/xin/auto-skills/CtriXin-repo/hive',
      task: makeTask(),
      reviewResult: makeReviewResult(),
      retryCount: 1,
      maxRetries: 2,
      repairHistory: makeRepairHistory(),
      onSnapshot: async (snapshot) => {
        snapshots.push(`${snapshot.card.room_kind}:${snapshot.card.status}:${snapshot.card.replies}`);
      },
    });

    expect(openRecoveryRoomMock).toHaveBeenCalledTimes(1);
    expect(closeDiscussRoomMock).toHaveBeenCalledWith(expect.objectContaining({
      room_kind: 'recovery',
      summary: expect.objectContaining({
        quality_gate: 'pass',
        findings_count: 1,
      }),
    }));
    expect(result.findings).toHaveLength(2);
    expect(result.findings[1]?.lens).toBe('recovery-advisory');
    expect(result.findings[1]?.issue).toContain('retry counter');
    expect(result.recovery_collab?.card.room_kind).toBe('recovery');
    expect(result.recovery_collab?.card.status).toBe('closed');
    expect(snapshots.some((item) => item.startsWith('recovery:collecting'))).toBe(true);
    expect(snapshots.some((item) => item.startsWith('recovery:closed:1'))).toBe(true);
  });

  it('keeps the original findings when no replies arrive', async () => {
    collectDiscussRepliesMock.mockResolvedValue([]);

    const result = await maybeRunRecoveryAdvisory({
      cwd: '/Users/xin/auto-skills/CtriXin-repo/hive',
      task: makeTask(),
      reviewResult: makeReviewResult(),
      retryCount: 1,
      maxRetries: 2,
      repairHistory: makeRepairHistory(),
    });

    expect(result.findings).toHaveLength(1);
    expect(result.recovery_collab?.card.room_kind).toBe('recovery');
    expect(result.recovery_collab?.card.status).toBe('fallback');
    expect(closeDiscussRoomMock).toHaveBeenCalledWith(expect.objectContaining({
      room_kind: 'recovery',
      summary: expect.objectContaining({
        quality_gate: 'fallback',
        fallback: 'existing-repair-findings',
      }),
    }));
  });

  it('skips recovery advisory when transport is not agentbus', async () => {
    loadConfigMock.mockReturnValue({
      collab: {
        recovery_transport: 'webhook',
        recovery_timeout_ms: 3000,
        recovery_min_replies: 0,
        recovery_after_failures: 1,
      },
    });

    const result = await maybeRunRecoveryAdvisory({
      cwd: '/Users/xin/auto-skills/CtriXin-repo/hive',
      task: makeTask(),
      reviewResult: makeReviewResult(),
      retryCount: 1,
      maxRetries: 2,
      repairHistory: makeRepairHistory(),
    });

    expect(openRecoveryRoomMock).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(1);
    expect(result.recovery_collab).toBeUndefined();
  });

  it('falls back safely when openRecoveryRoom throws', async () => {
    openRecoveryRoomMock.mockRejectedValue(new Error('room quota exceeded'));

    const result = await maybeRunRecoveryAdvisory({
      cwd: '/Users/xin/auto-skills/CtriXin-repo/hive',
      task: makeTask(),
      reviewResult: makeReviewResult(),
      retryCount: 1,
      maxRetries: 2,
      repairHistory: makeRepairHistory(),
    });

    expect(result.findings).toHaveLength(1);
    expect(result.recovery_collab).toBeUndefined();
  });

  it('closes room with fallback summary when collectDiscussReplies throws', async () => {
    collectDiscussRepliesMock.mockRejectedValue(new Error('network timeout'));

    const snapshots: string[] = [];
    const result = await maybeRunRecoveryAdvisory({
      cwd: '/Users/xin/auto-skills/CtriXin-repo/hive',
      task: makeTask(),
      reviewResult: makeReviewResult(),
      retryCount: 1,
      maxRetries: 2,
      repairHistory: makeRepairHistory(),
      onSnapshot: async (snapshot) => {
        snapshots.push(`${snapshot.card.room_kind}:${snapshot.card.status}:${snapshot.card.replies}`);
      },
    });

    expect(result.findings).toHaveLength(1);
    expect(result.recovery_collab?.card.status).toBe('fallback');
    expect(snapshots.some((item) => item.startsWith('recovery:fallback'))).toBe(true);
  });
});
