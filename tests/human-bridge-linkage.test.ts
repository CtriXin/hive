import { describe, expect, it } from 'vitest';
import { collectHumanBridgeRefs } from '../orchestrator/human-bridge-linkage.js';

describe('human-bridge-linkage', () => {
  it('merges bridge refs from state and checkpoint artifacts', () => {
    const refs = collectHumanBridgeRefs({
      bridgeStateRefs: [
        {
          room_id: 'room-plan',
          room_kind: 'plan',
          scope: 'run',
          bridge_kind: 'agent-im',
          thread_kind: 'discord',
          thread_id: 'discord-123',
          status: 'active',
          thread_title: 'Plan Review',
          updated_at: '2026-04-05T10:00:00.000Z',
        },
      ],
      checkpointInputBridgeRefs: [
        {
          room_id: 'room-plan',
          room_kind: 'plan',
          scope: 'run',
          bridge_kind: 'agent-im',
          thread_kind: 'discord',
          thread_id: 'discord-123',
          status: 'linked',
          updated_at: '2026-04-05T09:00:00.000Z',
        },
      ],
      checkpointResultBridgeRefs: [
        {
          room_id: 'room-task-a',
          room_kind: 'task_discuss',
          scope: 'task',
          bridge_kind: 'agent-im',
          thread_kind: 'session',
          thread_id: 'session-456',
          status: 'closed',
          focus_task_id: 'task-a',
          thread_title: 'Task A',
          last_human_reply_at: '2026-04-05T10:05:00.000Z',
        },
      ],
    });

    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      room_id: 'room-plan',
      thread_id: 'discord-123',
      status: 'active',
      thread_title: 'Plan Review',
    });
    expect(refs[1]).toMatchObject({
      room_id: 'room-task-a',
      thread_kind: 'session',
      status: 'closed',
      focus_task_id: 'task-a',
      last_human_reply_at: '2026-04-05T10:05:00.000Z',
    });
  });
});
