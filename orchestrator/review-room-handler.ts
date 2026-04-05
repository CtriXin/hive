import path from 'path';
import type {
  AgentBusReply,
} from './agentbus-adapter.js';
import {
  closeDiscussRoom,
  collectDiscussReplies,
  openReviewRoom,
} from './agentbus-adapter.js';
import { loadConfig } from './hive-config.js';
import type {
  CollabLifecycleEvent,
  CollabStatusSnapshot,
  ReviewBrief,
  ReviewFinding,
  ReviewResult,
  SubTask,
  WorkerResult,
} from './types.js';

const MAX_REVIEW_COLLAB_EVENTS = 8;
const MAX_REVIEW_FINDINGS = 6;
const MAX_CHANGED_FILES = 12;

export interface ExternalReviewOptions {
  cwd: string;
  task: SubTask;
  workerResult: WorkerResult;
  reviewResult: ReviewResult;
  onSnapshot?: (snapshot: CollabStatusSnapshot) => void | Promise<void>;
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

function summarizeReviewCollab(snapshot: CollabStatusSnapshot): string {
  const replyLabel = snapshot.card.replies === 1 ? 'reply' : 'replies';
  return `${snapshot.card.room_kind} ${snapshot.card.status}: ${snapshot.card.replies} ${replyLabel}`;
}

function trimIssue(issue: string, limit: number): string {
  const normalized = issue.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

export function buildReviewBrief(
  task: SubTask,
  workerResult: WorkerResult,
  reviewResult: ReviewResult,
  cwd: string,
): ReviewBrief {
  return {
    type: 'review-brief',
    version: 1,
    created_at: new Date().toISOString(),
    task_id: task.id,
    worker_model: workerResult.model,
    cwd_hint: path.basename(cwd),
    final_stage: reviewResult.final_stage,
    passed: reviewResult.passed,
    task_description: trimIssue(task.description, 220),
    changed_files: workerResult.changedFiles.slice(0, MAX_CHANGED_FILES),
    finding_count: reviewResult.findings.length,
    findings: reviewResult.findings.slice(0, MAX_REVIEW_FINDINGS).map((finding) => ({
      severity: finding.severity,
      file: finding.file,
      issue: trimIssue(finding.issue, 240),
    })),
    ask: 'Sanity-check the failed internal review. Flag false positives, missed risks, or the best repair direction.',
  };
}

function buildExternalReviewFindings(
  replies: AgentBusReply[],
  startingId: number,
): ReviewFinding[] {
  return replies.map((reply, index) => ({
    id: startingId + index,
    severity: 'yellow' as const,
    lens: 'external-review',
    file: `review-room:${reply.participant_id}`,
    issue: trimIssue(reply.content, 300),
    decision: 'flag' as const,
    decision_reason: `External review advisory (${reply.response_time_ms}ms, ${reply.content_length} chars)`,
  }));
}

export async function maybeRunExternalReviewSlot(
  options: ExternalReviewOptions,
): Promise<ReviewResult> {
  const { cwd, task, workerResult, reviewResult, onSnapshot } = options;
  if (reviewResult.passed) {
    return reviewResult;
  }

  const collab = loadConfig(cwd).collab;
  if (collab?.review_transport !== 'agentbus') {
    return reviewResult;
  }

  const timeoutMs = collab.review_timeout_ms ?? 10000;
  const minReplies = collab.review_min_replies ?? 0;
  const brief = buildReviewBrief(task, workerResult, reviewResult, cwd);

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
    ].slice(-MAX_REVIEW_COLLAB_EVENTS);
    await publishSnapshot(snapshot, onSnapshot);
  };

  const safeCloseRoom = async (summary: Record<string, unknown>): Promise<void> => {
    if (!room) return;
    try {
      await closeDiscussRoom({
        room_id: room.room_id,
        orchestrator_id: room.orchestrator_id,
        room_kind: 'review',
        summary,
      });
    } catch (err: any) {
      console.log(`  ⚠️ AgentBus close failed for ${room.room_id}: ${err.message?.slice(0, 80)}`);
    }
  };

  const finalizeWithoutReplies = async (
    reason: string,
  ): Promise<ReviewResult> => {
    if (snapshot && room) {
      await updateCard({
        status: 'fallback',
        next: `${reason}; continuing with internal review result`,
      });
      await pushEvent({
        type: 'fallback:local',
        room_id: room.room_id,
        room_kind: 'review',
        at: new Date().toISOString(),
        reply_count: snapshot.card.replies,
        focus_task_id: task.id,
        note: `${reason}; continuing with internal review result.`,
      });
      await safeCloseRoom({
        quality_gate: 'fallback',
        reply_count: snapshot.card.replies,
        fallback: 'internal-review',
      });
      await pushEvent({
        type: 'room:closed',
        room_id: room.room_id,
        room_kind: 'review',
        at: new Date().toISOString(),
        reply_count: snapshot.card.replies,
        focus_task_id: task.id,
        note: 'External review room closed without advisory replies.',
      });
      return {
        ...reviewResult,
        external_review_collab: snapshot,
      };
    }

    return reviewResult;
  };

  try {
    room = await openReviewRoom({ cwd, brief });
    snapshot = {
      card: {
        room_id: room.room_id,
        room_kind: 'review',
        status: 'open',
        replies: 0,
        join_hint: room.join_hint,
        focus_task_id: task.id,
        next: 'external review room opened; collecting advisory replies',
      },
      recent_events: [],
    };
    await publishSnapshot(snapshot, onSnapshot);
    await pushEvent({
      type: 'room:opened',
      room_id: room.room_id,
      room_kind: 'review',
      at: new Date().toISOString(),
      reply_count: 0,
      focus_task_id: task.id,
      note: `External review room opened for ${task.id}.`,
    });

    await updateCard({
      status: 'collecting',
      next: minReplies > 0
        ? `collecting advisory replies until ${minReplies} arrive or timeout`
        : 'collecting quick advisory replies before continuing',
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
          room_kind: 'review',
          at: reply.received_at,
          reply_count: snapshot.card.replies,
          focus_task_id: task.id,
          note: `Reply from ${reply.participant_id}`,
        });
      },
    });

    if (replies.length === 0) {
      return await finalizeWithoutReplies('no external review replies');
    }

    await updateCard({
      status: 'synthesizing',
      next: 'synthesizing external review replies into repair guidance',
    });
    await pushEvent({
      type: 'synthesis:started',
      room_id: room.room_id,
      room_kind: 'review',
      at: new Date().toISOString(),
      reply_count: replies.length,
      focus_task_id: task.id,
      note: 'External review synthesis started.',
    });

    const externalFindings = buildExternalReviewFindings(replies, reviewResult.findings.length + 1);

    await updateCard({
      status: 'closed',
      next: 'external review complete; advisory findings attached to repair context',
    });
    await pushEvent({
      type: 'synthesis:done',
      room_id: room.room_id,
      room_kind: 'review',
      at: new Date().toISOString(),
      reply_count: replies.length,
      focus_task_id: task.id,
      note: `External review added ${externalFindings.length} advisory finding(s).`,
    });
    await safeCloseRoom({
      quality_gate: 'pass',
      reply_count: replies.length,
      findings_count: externalFindings.length,
      review_status: summarizeReviewCollab(snapshot),
    });
    await pushEvent({
      type: 'room:closed',
      room_id: room.room_id,
      room_kind: 'review',
      at: new Date().toISOString(),
      reply_count: replies.length,
      focus_task_id: task.id,
      note: 'External review room closed after advisory synthesis.',
    });

    return {
      ...reviewResult,
      findings: [...reviewResult.findings, ...externalFindings],
      external_review_collab: snapshot,
    };
  } catch (err: any) {
    return finalizeWithoutReplies(err.message?.slice(0, 120) || 'external review failed');
  }
}
