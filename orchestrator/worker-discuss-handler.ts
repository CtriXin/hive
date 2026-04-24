// orchestrator/worker-discuss-handler.ts — Worker discuss via AgentBus
import path from 'path';
import fs from 'fs';
import type {
  CollabStatusSnapshot,
  CollabLifecycleEvent,
  DiscussResult,
  DiscussTrigger,
  WorkerConfig,
  WorkerDiscussBrief,
} from './types.js';
import { saveAdvisoryScoreSignals } from './advisory-score.js';
import { loadConfig } from './hive-config.js';
import { triggerDiscussion } from './discuss-bridge.js';
import { updateWorkerStatus } from './worker-status-store.js';
import {
  openWorkerDiscussRoom,
  collectDiscussReplies,
  closeDiscussRoom,
  synthesizeWorkerDiscussReplies,
  synthesizeWorkerDiscussRepliesWithModel,
} from './agentbus-adapter.js';

export interface WorkerDiscussHandlerResult {
  result: DiscussResult;
  collab?: CollabStatusSnapshot;
}

const MAX_WORKER_COLLAB_EVENTS = 8;

function cloneCollabSnapshot(
  snapshot: CollabStatusSnapshot,
): CollabStatusSnapshot {
  return {
    card: { ...snapshot.card },
    recent_events: snapshot.recent_events.map((event) => ({ ...event })),
  };
}

function summarizeWorkerCollab(snapshot: CollabStatusSnapshot): string {
  const replyLabel = snapshot.card.replies === 1 ? 'reply' : 'replies';
  return `${snapshot.card.room_kind} ${snapshot.card.status}: ${snapshot.card.replies} ${replyLabel}`;
}

async function publishSnapshot(
  snapshot: CollabStatusSnapshot,
  workerConfig: WorkerConfig,
): Promise<void> {
  const cloned = cloneCollabSnapshot(snapshot);
  if (workerConfig.runId) {
    updateWorkerStatus(workerConfig.cwd, workerConfig.runId, {
      task_id: workerConfig.taskId,
      status: 'discussing',
      plan_id: workerConfig.planId || workerConfig.runId,
      round: workerConfig.round,
      task_description: workerConfig.taskDescription,
      discuss_triggered: true,
      task_summary: summarizeWorkerCollab(cloned),
      last_message: cloned.card.next,
      collab: cloned,
    });
  }
  await workerConfig.onWorkerDiscussSnapshot?.(cloned);
}

export function buildWorkerDiscussBrief(
  trigger: DiscussTrigger,
  workerConfig: WorkerConfig,
  workDir: string,
): WorkerDiscussBrief {
  return {
    type: 'worker-discuss-brief',
    version: 1,
    created_at: new Date().toISOString(),
    task_id: trigger.task_id,
    worker_model: trigger.worker_model || workerConfig.model,
    cwd_hint: path.basename(workDir),
    uncertain_about: trigger.uncertain_about,
    options: [...trigger.options],
    leaning: trigger.leaning,
    why: trigger.why,
    task_description: (workerConfig.taskDescription || workerConfig.prompt).slice(0, 200),
  };
}

// ── AgentBus path ──

async function handleViaAgentBus(
  trigger: DiscussTrigger,
  workerConfig: WorkerConfig,
  workDir: string,
): Promise<WorkerDiscussHandlerResult> {
  const config = loadConfig(workDir);
  const collab = config.collab;
  const timeoutMs = collab?.worker_discuss_timeout_ms ?? 10000;
  const minReplies = collab?.worker_discuss_min_replies ?? 0;

  let room: { room_id: string; join_hint?: string; orchestrator_id: string } | undefined;
  let snapshot: CollabStatusSnapshot | undefined;

  const pushEvent = async (event: CollabLifecycleEvent): Promise<void> => {
    if (!snapshot) return;
    snapshot.recent_events = [
      ...snapshot.recent_events,
      event,
    ].slice(-MAX_WORKER_COLLAB_EVENTS);
    await publishSnapshot(snapshot, workerConfig);
  };

  const updateCard = async (
    updates: Partial<CollabStatusSnapshot['card']>,
  ): Promise<void> => {
    if (!snapshot) return;
    snapshot.card = { ...snapshot.card, ...updates };
    await publishSnapshot(snapshot, workerConfig);
  };

  const safeCloseRoom = async (summary: Record<string, unknown>): Promise<void> => {
    if (!room) return;
    try {
      await closeDiscussRoom({
        room_id: room.room_id,
        orchestrator_id: room.orchestrator_id,
        room_kind: 'task_discuss',
        summary,
      });
    } catch (err: any) {
      console.log(`  ⚠️ AgentBus close failed for ${room.room_id}: ${err.message?.slice(0, 80)}`);
    }
  };

  const fallbackToLocal = async (reason: string): Promise<WorkerDiscussHandlerResult> => {
    if (snapshot && room) {
      console.log(`  ⚠️ Worker AgentBus discuss: ${reason} for ${trigger.task_id}, falling back to local`);
      await updateCard({ status: 'fallback', next: `${reason}; falling back to local discuss` });
      await pushEvent({ type: 'fallback:local', room_id: room.room_id, room_kind: 'task_discuss', at: new Date().toISOString(), reply_count: snapshot.card.replies, focus_task_id: trigger.task_id, note: `${reason}; falling back to local discuss.` });
      await safeCloseRoom({ quality_gate: 'fallback', reply_count: snapshot.card.replies, fallback: 'local-discuss' });
      await pushEvent({ type: 'room:closed', room_id: room.room_id, room_kind: 'task_discuss', at: new Date().toISOString(), reply_count: snapshot.card.replies, focus_task_id: trigger.task_id, note: 'Worker discuss room closed after local fallback.' });
    } else {
      console.log(`  ⚠️ Worker AgentBus discuss: ${reason} for ${trigger.task_id}, falling back to local`);
    }
    const localResult = await triggerDiscussion(trigger, workerConfig, workDir);
    return { result: localResult, collab: snapshot };
  };

  try {
    const brief = buildWorkerDiscussBrief(trigger, workerConfig, workDir);
    room = await openWorkerDiscussRoom({ cwd: workDir, brief });
    snapshot = {
      card: { room_id: room.room_id, room_kind: 'task_discuss', status: 'open', replies: 0, join_hint: room.join_hint, focus_task_id: trigger.task_id, next: 'worker discuss room opened; collecting replies' },
      recent_events: [],
    };
    await publishSnapshot(snapshot, workerConfig);
    await pushEvent({ type: 'room:opened', room_id: room.room_id, room_kind: 'task_discuss', at: new Date().toISOString(), reply_count: 0, focus_task_id: trigger.task_id, note: `Worker discuss room opened for ${trigger.task_id}.` });

    await updateCard({
      status: 'collecting',
      next: minReplies > 0
        ? `collecting replies until ${minReplies} arrive or timeout`
        : 'collecting quick replies before fallback',
    });

    const replies = await collectDiscussReplies({
      cwd: workDir,
      room_id: room.room_id,
      timeout_ms: timeoutMs,
      min_replies: minReplies,
      on_reply: async (reply) => {
        if (!snapshot || !room) return;
        await updateCard({ replies: snapshot.card.replies + 1, last_reply_at: reply.received_at, next: 'reply received; waiting for more or timeout' });
        await pushEvent({ type: 'reply:arrived', room_id: room.room_id, room_kind: 'task_discuss', at: reply.received_at, reply_count: snapshot.card.replies, focus_task_id: trigger.task_id, note: `Reply from ${reply.participant_id}` });
      },
    });

    if (replies.length === 0) {
      return fallbackToLocal('no AgentBus replies');
    }

    await updateCard({ status: 'synthesizing', next: 'synthesizing worker discuss replies' });
    await pushEvent({ type: 'synthesis:started', room_id: room.room_id, room_kind: 'task_discuss', at: new Date().toISOString(), reply_count: replies.length, focus_task_id: trigger.task_id, note: 'Worker discuss synthesis started.' });

    const synthesized = await synthesizeWorkerDiscussRepliesWithModel(
      replies, { leaning: trigger.leaning, task_id: trigger.task_id }, config, workerConfig.model,
    );
    if (workerConfig.runId) {
      saveAdvisoryScoreSignals({
        cwd: workDir,
        runId: workerConfig.runId,
        roomId: room.room_id,
        roomKind: 'task_discuss',
        taskId: trigger.task_id,
        timeoutMs,
        qualityGate: synthesized.quality_gate,
        replies,
        adoptedParticipantIds: replies.map((reply) => reply.participant_id),
      });
    }

    await updateCard({ status: 'closed', next: 'worker discuss complete' });
    await pushEvent({ type: 'synthesis:done', room_id: room.room_id, room_kind: 'task_discuss', at: new Date().toISOString(), reply_count: replies.length, focus_task_id: trigger.task_id, note: `Worker discuss synthesis: ${synthesized.quality_gate}.` });

    await safeCloseRoom({ quality_gate: synthesized.quality_gate, reply_count: replies.length, decision: synthesized.decision.slice(0, 200) });
    await pushEvent({ type: 'room:closed', room_id: room.room_id, room_kind: 'task_discuss', at: new Date().toISOString(), reply_count: replies.length, focus_task_id: trigger.task_id, note: 'Worker discuss room closed after synthesis.' });

    return { result: synthesized, collab: snapshot };
  } catch (err: any) {
    return fallbackToLocal(err.message?.slice(0, 120) || 'AgentBus worker discuss failed');
  }
}

// ── Main entry point ──

export async function handleDiscussTrigger(
  workerConfig: WorkerConfig,
  workDir: string,
): Promise<WorkerDiscussHandlerResult> {
  try {
    const triggerFile = path.join(workDir, '.ai', 'discuss-trigger.json');

    if (!fs.existsSync(triggerFile)) {
      return {
        result: {
          decision: 'continue',
          reasoning: 'No discuss-trigger.json found, skipping discussion',
          escalated: false,
          thread_id: `auto-${workerConfig.taskId}`,
          quality_gate: 'warn',
        },
      };
    }

    const trigger: DiscussTrigger = JSON.parse(fs.readFileSync(triggerFile, 'utf-8'));
    const config = loadConfig(workDir);
    const transport = config.collab?.worker_discuss_transport || 'local';

    if (transport === 'agentbus') {
      return await handleViaAgentBus(trigger, workerConfig, workDir);
    }

    const result = await triggerDiscussion(trigger, workerConfig, workDir);
    return { result };
  } catch (err: any) {
    return {
      result: {
        decision: 'continue',
        reasoning: `Discuss trigger failed: ${err.message}`,
        escalated: false,
        thread_id: `error-${workerConfig.taskId}`,
        quality_gate: 'warn',
      },
    };
  }
}
