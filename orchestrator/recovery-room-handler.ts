import path from 'path';
import type { AgentBusReply } from './agentbus-adapter.js';
import {
  closeDiscussRoom,
  collectDiscussReplies,
  openRecoveryRoom,
} from './agentbus-adapter.js';
import { loadConfig } from './hive-config.js';
import type {
  CollabLifecycleEvent,
  CollabStatusSnapshot,
  RecoveryBrief,
  RepairHistoryEntry,
  ReviewFinding,
  ReviewResult,
  SubTask,
} from './types.js';

const MAX_RECOVERY_COLLAB_EVENTS = 8;
const MAX_RECOVERY_FINDINGS = 6;
const MAX_RECENT_ATTEMPTS = 4;

export interface RecoveryAdvisoryOptions {
  cwd: string;
  task: SubTask;
  reviewResult: ReviewResult;
  retryCount: number;
  maxRetries: number;
  repairHistory: RepairHistoryEntry[];
  onSnapshot?: (snapshot: CollabStatusSnapshot) => void | Promise<void>;
}

export interface RecoveryAdvisoryResult {
  findings: ReviewFinding[];
  recovery_collab?: CollabStatusSnapshot;
}

function cloneCollabSnapshot(
  snapshot: CollabStatusSnapshot,
): CollabStatusSnapshot {
  return {
    card: { ...snapshot.card },
    recent_events: snapshot.recent_events.map((event) => ({ ...event })),
  };
}

async function publishSnapshot(
  snapshot: CollabStatusSnapshot,
  onSnapshot?: (snapshot: CollabStatusSnapshot) => void | Promise<void>,
): Promise<void> {
  await onSnapshot?.(cloneCollabSnapshot(snapshot));
}

function summarizeRecoveryCollab(snapshot: CollabStatusSnapshot): string {
  const replyLabel = snapshot.card.replies === 1 ? 'reply' : 'replies';
  return `${snapshot.card.room_kind} ${snapshot.card.status}: ${snapshot.card.replies} ${replyLabel}`;
}

function trimText(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function buildRecoveryAdvisoryFindings(
  replies: AgentBusReply[],
  startingId: number,
): ReviewFinding[] {
  return replies.map((reply, index) => ({
    id: startingId + index,
    severity: 'yellow' as const,
    lens: 'recovery-advisory',
    file: `recovery-room:${reply.participant_id}`,
    issue: trimText(reply.content, 300),
    decision: 'flag' as const,
    decision_reason: `Repeated-fail advisory (${reply.response_time_ms}ms, ${reply.content_length} chars)`,
  }));
}

export function buildRecoveryBrief(
  task: SubTask,
  reviewResult: ReviewResult,
  retryCount: number,
  maxRetries: number,
  repairHistory: RepairHistoryEntry[],
  cwd: string,
): RecoveryBrief {
  return {
    type: 'recovery-brief',
    version: 1,
    created_at: new Date().toISOString(),
    task_id: task.id,
    worker_model: task.assigned_model,
    cwd_hint: path.basename(cwd),
    retry_count: retryCount,
    max_retries: maxRetries,
    task_description: trimText(task.description, 220),
    finding_count: reviewResult.findings.length,
    findings: reviewResult.findings.slice(0, MAX_RECOVERY_FINDINGS).map((finding) => ({
      severity: finding.severity,
      file: finding.file,
      issue: trimText(finding.issue, 240),
    })),
    recent_attempts: repairHistory.slice(-MAX_RECENT_ATTEMPTS).map((entry) => ({
      round: entry.round,
      outcome: entry.outcome,
      note: entry.note ? trimText(entry.note, 120) : undefined,
    })),
    ask: 'This task has failed repair repeatedly. Suggest the smallest next repair, likely root cause, or whether Hive should stop retrying.',
  };
}

export async function maybeRunRecoveryAdvisory(
  options: RecoveryAdvisoryOptions,
): Promise<RecoveryAdvisoryResult> {
  const {
    cwd,
    task,
    reviewResult,
    retryCount,
    maxRetries,
    repairHistory,
    onSnapshot,
  } = options;
  const collab = loadConfig(cwd).collab;
  const threshold = Math.max(1, collab?.recovery_after_failures ?? 1);
  if (retryCount < threshold || collab?.recovery_transport !== 'agentbus') {
    return { findings: reviewResult.findings };
  }

  const timeoutMs = collab.recovery_timeout_ms ?? 10000;
  const minReplies = collab.recovery_min_replies ?? 0;
  const brief = buildRecoveryBrief(
    task,
    reviewResult,
    retryCount,
    maxRetries,
    repairHistory,
    cwd,
  );

  let room: { room_id: string; join_hint?: string; orchestrator_id: string } | undefined;
  let snapshot: CollabStatusSnapshot | undefined;

  const updateCard = async (
    updates: Partial<CollabStatusSnapshot['card']>,
  ): Promise<void> => {
    if (!snapshot) return;
    snapshot.card = { ...snapshot.card, ...updates };
    await publishSnapshot(snapshot, onSnapshot);
  };

  const pushEvent = async (event: CollabLifecycleEvent): Promise<void> => {
    if (!snapshot) return;
    snapshot.recent_events = [
      ...snapshot.recent_events,
      event,
    ].slice(-MAX_RECOVERY_COLLAB_EVENTS);
    await publishSnapshot(snapshot, onSnapshot);
  };

  const safeCloseRoom = async (summary: Record<string, unknown>): Promise<void> => {
    if (!room) return;
    try {
      await closeDiscussRoom({
        room_id: room.room_id,
        orchestrator_id: room.orchestrator_id,
        room_kind: 'recovery',
        summary,
      });
    } catch (err: any) {
      console.log(`  ⚠️ AgentBus close failed for ${room.room_id}: ${err.message?.slice(0, 80)}`);
    }
  };

  const finalizeWithoutReplies = async (
    reason: string,
  ): Promise<RecoveryAdvisoryResult> => {
    if (snapshot && room) {
      await updateCard({
        status: 'fallback',
        next: `${reason}; continuing with the existing repair findings`,
      });
      await pushEvent({
        type: 'fallback:local',
        room_id: room.room_id,
        room_kind: 'recovery',
        at: new Date().toISOString(),
        reply_count: snapshot.card.replies,
        focus_task_id: task.id,
        note: `${reason}; continuing with the existing repair findings.`,
      });
      await safeCloseRoom({
        quality_gate: 'fallback',
        reply_count: snapshot.card.replies,
        fallback: 'existing-repair-findings',
      });
      await pushEvent({
        type: 'room:closed',
        room_id: room.room_id,
        room_kind: 'recovery',
        at: new Date().toISOString(),
        reply_count: snapshot.card.replies,
        focus_task_id: task.id,
        note: 'Recovery advisory room closed without advisory replies.',
      });
      return {
        findings: reviewResult.findings,
        recovery_collab: snapshot,
      };
    }

    return { findings: reviewResult.findings };
  };

  try {
    room = await openRecoveryRoom({ cwd, brief });
    snapshot = {
      card: {
        room_id: room.room_id,
        room_kind: 'recovery',
        status: 'open',
        replies: 0,
        join_hint: room.join_hint,
        focus_task_id: task.id,
        next: 'recovery advisory room opened; collecting repeated-fail guidance',
      },
      recent_events: [],
    };
    await publishSnapshot(snapshot, onSnapshot);
    await pushEvent({
      type: 'room:opened',
      room_id: room.room_id,
      room_kind: 'recovery',
      at: new Date().toISOString(),
      reply_count: 0,
      focus_task_id: task.id,
      note: `Recovery advisory room opened for ${task.id}.`,
    });

    await updateCard({
      status: 'collecting',
      next: minReplies > 0
        ? `collecting repeated-fail advisory replies until ${minReplies} arrive or timeout`
        : 'collecting quick repeated-fail advisory replies before retrying repair',
    });

    const replies = await collectDiscussReplies({
      cwd,
      room_id: room.room_id,
      timeout_ms: timeoutMs,
      min_replies: minReplies,
      on_reply: async (reply) => {
        if (!snapshot || !room) return;
        await updateCard({
          replies: snapshot.card.replies + 1,
          last_reply_at: reply.received_at,
          next: 'advisory reply received; waiting for more or timeout',
        });
        await pushEvent({
          type: 'reply:arrived',
          room_id: room.room_id,
          room_kind: 'recovery',
          at: reply.received_at,
          reply_count: snapshot.card.replies,
          focus_task_id: task.id,
          note: `Reply from ${reply.participant_id}`,
        });
      },
    });

    if (replies.length === 0) {
      return await finalizeWithoutReplies('no repeated-fail advisory replies');
    }

    await updateCard({
      status: 'synthesizing',
      next: 'synthesizing repeated-fail advisory replies into the next repair prompt',
    });
    await pushEvent({
      type: 'synthesis:started',
      room_id: room.room_id,
      room_kind: 'recovery',
      at: new Date().toISOString(),
      reply_count: replies.length,
      focus_task_id: task.id,
      note: 'Recovery advisory synthesis started.',
    });

    const advisoryFindings = buildRecoveryAdvisoryFindings(
      replies,
      reviewResult.findings.length + 1,
    );

    await updateCard({
      status: 'closed',
      next: 'recovery advisory complete; appended guidance to the next repair prompt',
    });
    await pushEvent({
      type: 'synthesis:done',
      room_id: room.room_id,
      room_kind: 'recovery',
      at: new Date().toISOString(),
      reply_count: replies.length,
      focus_task_id: task.id,
      note: `Recovery advisory added ${advisoryFindings.length} finding(s).`,
    });
    await safeCloseRoom({
      quality_gate: 'pass',
      reply_count: replies.length,
      findings_count: advisoryFindings.length,
      review_status: summarizeRecoveryCollab(snapshot),
    });
    await pushEvent({
      type: 'room:closed',
      room_id: room.room_id,
      room_kind: 'recovery',
      at: new Date().toISOString(),
      reply_count: replies.length,
      focus_task_id: task.id,
      note: 'Recovery advisory room closed after synthesis.',
    });

    return {
      findings: [...reviewResult.findings, ...advisoryFindings],
      recovery_collab: snapshot,
    };
  } catch (err: any) {
    return finalizeWithoutReplies(err.message?.slice(0, 120) || 'recovery advisory failed');
  }
}
