import type { HumanBridgeRef, HumanBridgeStatus } from './types.js';

const STATUS_RANK: Record<HumanBridgeStatus, number> = {
  linked: 0,
  active: 1,
  closed: 2,
};

function selectLatestIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.localeCompare(b) >= 0 ? a : b;
}

function mergeBridgeRefs(existing: HumanBridgeRef, incoming: HumanBridgeRef): HumanBridgeRef {
  return {
    room_id: existing.room_id,
    room_kind: incoming.room_kind || existing.room_kind,
    scope: existing.scope === 'task' || incoming.scope === 'task' ? 'task' : 'run',
    bridge_kind: incoming.bridge_kind || existing.bridge_kind,
    thread_kind: incoming.thread_kind || existing.thread_kind,
    thread_id: incoming.thread_id || existing.thread_id,
    status: STATUS_RANK[incoming.status] >= STATUS_RANK[existing.status]
      ? incoming.status
      : existing.status,
    focus_task_id: existing.focus_task_id || incoming.focus_task_id,
    thread_title: incoming.thread_title || existing.thread_title,
    last_human_reply_at: selectLatestIso(existing.last_human_reply_at, incoming.last_human_reply_at),
    updated_at: selectLatestIso(existing.updated_at, incoming.updated_at),
  };
}

function bridgeRefKey(ref: HumanBridgeRef): string {
  return `${ref.room_id}::${ref.bridge_kind}::${ref.thread_kind}::${ref.thread_id}`;
}

function upsertBridgeRef(index: Map<string, HumanBridgeRef>, ref: HumanBridgeRef | null | undefined): void {
  if (!ref?.room_id || !ref.thread_id) return;
  const key = bridgeRefKey(ref);
  const existing = index.get(key);
  if (!existing) {
    index.set(key, ref);
    return;
  }
  index.set(key, mergeBridgeRefs(existing, ref));
}

function sortBridgeRefs(refs: HumanBridgeRef[]): HumanBridgeRef[] {
  return [...refs].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'run' ? -1 : 1;
    if ((a.focus_task_id || '') !== (b.focus_task_id || '')) {
      return (a.focus_task_id || '').localeCompare(b.focus_task_id || '');
    }
    if (a.room_kind !== b.room_kind) return a.room_kind.localeCompare(b.room_kind);
    if (a.thread_kind !== b.thread_kind) return a.thread_kind.localeCompare(b.thread_kind);
    return a.thread_id.localeCompare(b.thread_id);
  });
}

export function collectHumanBridgeRefs(params: {
  bridgeStateRefs?: HumanBridgeRef[] | null;
  checkpointInputBridgeRefs?: HumanBridgeRef[] | null;
  checkpointResultBridgeRefs?: HumanBridgeRef[] | null;
}): HumanBridgeRef[] {
  const refIndex = new Map<string, HumanBridgeRef>();

  for (const ref of params.bridgeStateRefs || []) {
    upsertBridgeRef(refIndex, ref);
  }

  for (const ref of params.checkpointInputBridgeRefs || []) {
    upsertBridgeRef(refIndex, ref);
  }

  for (const ref of params.checkpointResultBridgeRefs || []) {
    upsertBridgeRef(refIndex, ref);
  }

  return sortBridgeRefs(Array.from(refIndex.values()));
}

export function formatHumanBridgeRef(ref: HumanBridgeRef): string {
  const details = [
    `${ref.room_id}`,
    `-> ${ref.thread_kind}:${ref.thread_id}`,
    `[${ref.status}]`,
  ];

  if (ref.scope === 'task' && ref.focus_task_id) {
    details.push(`task=${ref.focus_task_id}`);
  }

  if (ref.thread_title) {
    details.push(`title=${ref.thread_title}`);
  }

  return details.join(' ');
}
