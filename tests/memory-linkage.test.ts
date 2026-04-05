import { describe, expect, it } from 'vitest';
import type { LoopProgress } from '../orchestrator/loop-progress-store.js';
import type { WorkerStatusSnapshot } from '../orchestrator/types.js';
import { collectMindkeeperRoomRefs } from '../orchestrator/memory-linkage.js';

describe('memory-linkage', () => {
  it('merges checkpoint refs with live collab refs and dedupes by room id', () => {
    const loopProgress: LoopProgress = {
      run_id: 'run-1',
      round: 2,
      phase: 'discussing',
      reason: 'Collecting plan replies',
      collab: {
        card: {
          room_id: 'room-plan',
          room_kind: 'plan',
          status: 'collecting',
          replies: 2,
          join_hint: 'agentbus join room-plan',
          next: 'wait for timeout',
        },
        recent_events: [],
      },
      updated_at: '2026-04-05T00:00:00.000Z',
    };

    const workerSnapshot: WorkerStatusSnapshot = {
      run_id: 'run-1',
      plan_id: 'plan-1',
      round: 2,
      updated_at: '2026-04-05T00:00:00.000Z',
      workers: [
        {
          task_id: 'task-a',
          status: 'running',
          assigned_model: 'qwen3-max',
          active_model: 'qwen3-max',
          provider: 'bailian',
          agent_id: 'task-a@run-1',
          discuss_triggered: true,
          updated_at: '2026-04-05T00:00:00.000Z',
          collab: {
            card: {
              room_id: 'room-task-a',
              room_kind: 'task_discuss',
              status: 'closed',
              replies: 1,
              focus_task_id: 'task-a',
              next: 'done',
            },
            recent_events: [],
          },
        },
      ],
    };

    const refs = collectMindkeeperRoomRefs({
      loopProgress,
      workerSnapshot,
      checkpointInputRoomRefs: [
        {
          room_id: 'room-plan',
          room_kind: 'plan',
          scope: 'run',
          status: 'open',
          replies: 0,
        },
      ],
      checkpointResultRoomRefs: [
        {
          room_id: 'room-task-a',
          room_kind: 'task_discuss',
          scope: 'task',
          status: 'closed',
          replies: 1,
          focus_task_id: 'task-a',
        },
      ],
    });

    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      room_id: 'room-plan',
      scope: 'run',
      status: 'collecting',
      replies: 2,
      join_hint: 'agentbus join room-plan',
    });
    expect(refs[1]).toMatchObject({
      room_id: 'room-task-a',
      scope: 'task',
      status: 'closed',
      replies: 1,
      focus_task_id: 'task-a',
    });
  });
});
