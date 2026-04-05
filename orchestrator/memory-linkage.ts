import type { LoopProgress } from './loop-progress-store.js';
import type {
  CollabCard,
  CollabCardStatus,
  MindkeeperRoomRef,
  WorkerStatusSnapshot,
} from './types.js';

const STATUS_RANK: Record<CollabCardStatus, number> = {
  open: 0,
  collecting: 1,
  synthesizing: 2,
  closed: 3,
  fallback: 4,
};

function selectLatestIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.localeCompare(b) >= 0 ? a : b;
}

function toRoomRef(card: CollabCard, scope: 'run' | 'task'): MindkeeperRoomRef {
  return {
    room_id: card.room_id,
    room_kind: card.room_kind,
    scope,
    status: card.status,
    replies: card.replies,
    focus_task_id: card.focus_task_id,
    join_hint: card.join_hint,
    last_reply_at: card.last_reply_at,
  };
}

function mergeRoomRefs(existing: MindkeeperRoomRef, incoming: MindkeeperRoomRef): MindkeeperRoomRef {
  return {
    room_id: existing.room_id,
    room_kind: incoming.room_kind || existing.room_kind,
    scope: existing.scope === 'task' || incoming.scope === 'task' ? 'task' : 'run',
    status: STATUS_RANK[incoming.status] >= STATUS_RANK[existing.status]
      ? incoming.status
      : existing.status,
    replies: Math.max(existing.replies, incoming.replies),
    focus_task_id: existing.focus_task_id || incoming.focus_task_id,
    join_hint: existing.join_hint || incoming.join_hint,
    last_reply_at: selectLatestIso(existing.last_reply_at, incoming.last_reply_at),
  };
}

function upsertRoomRef(index: Map<string, MindkeeperRoomRef>, ref: MindkeeperRoomRef | null | undefined): void {
  if (!ref?.room_id) return;
  const existing = index.get(ref.room_id);
  if (!existing) {
    index.set(ref.room_id, ref);
    return;
  }
  index.set(ref.room_id, mergeRoomRefs(existing, ref));
}

function sortRoomRefs(roomRefs: MindkeeperRoomRef[]): MindkeeperRoomRef[] {
  return [...roomRefs].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'run' ? -1 : 1;
    if ((a.focus_task_id || '') !== (b.focus_task_id || '')) {
      return (a.focus_task_id || '').localeCompare(b.focus_task_id || '');
    }
    if (a.room_kind !== b.room_kind) return a.room_kind.localeCompare(b.room_kind);
    return a.room_id.localeCompare(b.room_id);
  });
}

export function collectMindkeeperRoomRefs(params: {
  loopProgress?: LoopProgress | null;
  workerSnapshot?: WorkerStatusSnapshot | null;
  checkpointInputRoomRefs?: MindkeeperRoomRef[] | null;
  checkpointResultRoomRefs?: MindkeeperRoomRef[] | null;
}): MindkeeperRoomRef[] {
  const roomIndex = new Map<string, MindkeeperRoomRef>();

  for (const ref of params.checkpointInputRoomRefs || []) {
    upsertRoomRef(roomIndex, ref);
  }

  for (const ref of params.checkpointResultRoomRefs || []) {
    upsertRoomRef(roomIndex, ref);
  }

  if (params.loopProgress?.collab?.card) {
    upsertRoomRef(roomIndex, toRoomRef(params.loopProgress.collab.card, 'run'));
  }

  for (const worker of params.workerSnapshot?.workers || []) {
    if (!worker.collab?.card) continue;
    upsertRoomRef(roomIndex, toRoomRef(worker.collab.card, 'task'));
  }

  return sortRoomRefs(Array.from(roomIndex.values()));
}

export function formatMindkeeperRoomRef(ref: MindkeeperRoomRef): string {
  const details = [
    `${ref.room_id}`,
    `[${ref.room_kind}/${ref.status}]`,
    `replies=${ref.replies}`,
  ];

  if (ref.scope === 'task' && ref.focus_task_id) {
    details.push(`task=${ref.focus_task_id}`);
  }

  return details.join(' ');
}
