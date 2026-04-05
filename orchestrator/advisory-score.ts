import fs from 'fs';
import path from 'path';
import type { CollabRoomKind } from './collab-types.js';

export type AdvisoryQualityGate = 'pass' | 'warn' | 'fail' | 'fallback';

export interface AdvisoryReplyInput {
  participant_id: string;
  response_time_ms: number;
  content_length: number;
  received_at: string;
  content?: string;
}

export interface AdvisoryReplyScore {
  participant_id: string;
  room_id: string;
  room_kind: CollabRoomKind;
  run_id: string;
  task_id?: string;
  received_at: string;
  response_time_ms: number;
  content_length: number;
  quality_gate: AdvisoryQualityGate;
  timeliness: number;
  substance: number;
  adoption: number;
  score: number;
}

export interface AdvisoryParticipantScore {
  participant_id: string;
  reply_count: number;
  adopted_replies: number;
  avg_score: number;
  top_score: number;
  latest_reply_at?: string;
  room_kinds: CollabRoomKind[];
  task_ids: string[];
}

export interface AdvisoryScoreSummary {
  participant_count: number;
  reply_count: number;
  adopted_reply_count: number;
  avg_score: number;
}

export interface AdvisoryScoreHistory {
  run_id: string;
  updated_at: string;
  summary: AdvisoryScoreSummary;
  participants: AdvisoryParticipantScore[];
  replies: AdvisoryReplyScore[];
}

export interface SaveAdvisoryScoreSignalsInput {
  cwd: string;
  runId: string;
  roomId: string;
  roomKind: CollabRoomKind;
  timeoutMs: number;
  qualityGate: AdvisoryQualityGate;
  replies: AdvisoryReplyInput[];
  adoptedParticipantIds?: string[];
  taskId?: string;
}

const FILE_MENTION_RE = /\b(?:[\w-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|json|md|py|sh|yaml|yml|sql)(?::\d+)?\b/i;
const TASK_MENTION_RE = /\btask-[a-z0-9-]+\b/i;
const ACTION_RE = /\b(add|remove|fix|guard|split|move|rename|retry|fallback|replan|test|verify|check|avoid|stop|simplify|narrow)\b/i;

function runDir(cwd: string, runId: string): string {
  return path.join(cwd, '.ai', 'runs', runId);
}

function advisoryScorePath(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'advisory-score-history.json');
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeAdvisoryTimeliness(
  responseTimeMs: number,
  timeoutMs: number,
): number {
  const response = Math.max(0, responseTimeMs);
  const timeout = Math.max(1, timeoutMs);
  const fullCreditWindow = Math.min(timeout, 10_000);

  if (response <= fullCreditWindow) {
    return 1;
  }
  if (timeout <= fullCreditWindow) {
    return 1;
  }
  if (response >= timeout) {
    return 0;
  }

  return round2(1 - ((response - fullCreditWindow) / (timeout - fullCreditWindow)));
}

export function computeAdvisorySubstance(
  content: string | undefined,
  contentLength: number,
): number {
  const normalized = (content || '').replace(/\s+/g, ' ').trim();
  const effectiveLength = Math.max(contentLength, normalized.length);
  const lengthScore = clamp01((Math.min(effectiveLength, 320) - 20) / 180);
  const taskMention = TASK_MENTION_RE.test(normalized) ? 1 : 0;
  const fileMention = FILE_MENTION_RE.test(normalized) ? 1 : 0;
  const actionMention = ACTION_RE.test(normalized) ? 1 : 0;

  return round2(Math.min(
    1,
    lengthScore * 0.5 + taskMention * 0.2 + fileMention * 0.2 + actionMention * 0.1,
  ));
}

function computeOverallAdvisoryScore(
  timeliness: number,
  substance: number,
  adoption: number,
): number {
  return Math.round((timeliness * 0.3 + substance * 0.3 + adoption * 0.4) * 100);
}

function aggregateParticipants(replies: AdvisoryReplyScore[]): AdvisoryParticipantScore[] {
  const byParticipant = new Map<string, {
    sumScore: number;
    replyCount: number;
    adoptedReplies: number;
    topScore: number;
    latestReplyAt?: string;
    roomKinds: Set<CollabRoomKind>;
    taskIds: Set<string>;
  }>();

  for (const reply of replies) {
    const current = byParticipant.get(reply.participant_id) || {
      sumScore: 0,
      replyCount: 0,
      adoptedReplies: 0,
      topScore: 0,
      latestReplyAt: undefined,
      roomKinds: new Set<CollabRoomKind>(),
      taskIds: new Set<string>(),
    };
    current.sumScore += reply.score;
    current.replyCount += 1;
    current.adoptedReplies += reply.adoption > 0 ? 1 : 0;
    current.topScore = Math.max(current.topScore, reply.score);
    if (!current.latestReplyAt || reply.received_at > current.latestReplyAt) {
      current.latestReplyAt = reply.received_at;
    }
    current.roomKinds.add(reply.room_kind);
    if (reply.task_id) {
      current.taskIds.add(reply.task_id);
    }
    byParticipant.set(reply.participant_id, current);
  }

  return [...byParticipant.entries()]
    .map(([participantId, value]) => ({
      participant_id: participantId,
      reply_count: value.replyCount,
      adopted_replies: value.adoptedReplies,
      avg_score: Math.round(value.sumScore / Math.max(1, value.replyCount)),
      top_score: value.topScore,
      latest_reply_at: value.latestReplyAt,
      room_kinds: [...value.roomKinds].sort(),
      task_ids: [...value.taskIds].sort(),
    }))
    .sort((a, b) => (
      b.avg_score - a.avg_score
      || b.adopted_replies - a.adopted_replies
      || b.reply_count - a.reply_count
      || a.participant_id.localeCompare(b.participant_id)
    ));
}

function buildSummary(replies: AdvisoryReplyScore[]): AdvisoryScoreSummary {
  const participantCount = new Set(replies.map((reply) => reply.participant_id)).size;
  const adoptedReplyCount = replies.filter((reply) => reply.adoption > 0).length;
  const avgScore = replies.length > 0
    ? Math.round(replies.reduce((sum, reply) => sum + reply.score, 0) / replies.length)
    : 0;

  return {
    participant_count: participantCount,
    reply_count: replies.length,
    adopted_reply_count: adoptedReplyCount,
    avg_score: avgScore,
  };
}

function dedupeReplies(replies: AdvisoryReplyScore[]): AdvisoryReplyScore[] {
  const byKey = new Map<string, AdvisoryReplyScore>();
  for (const reply of replies) {
    const key = [
      reply.room_id,
      reply.participant_id,
      reply.received_at,
      reply.room_kind,
      reply.task_id || '-',
    ].join('::');
    byKey.set(key, reply);
  }

  return [...byKey.values()].sort((a, b) => (
    a.received_at.localeCompare(b.received_at)
    || a.participant_id.localeCompare(b.participant_id)
  ));
}

export function buildAdvisoryReplyScores(
  input: Omit<SaveAdvisoryScoreSignalsInput, 'cwd' | 'runId'> & { runId: string },
): AdvisoryReplyScore[] {
  const adoptedParticipants = new Set(input.adoptedParticipantIds || []);

  return input.replies.map((reply) => {
    const timeliness = computeAdvisoryTimeliness(reply.response_time_ms, input.timeoutMs);
    const substance = computeAdvisorySubstance(reply.content, reply.content_length);
    const adoption = adoptedParticipants.has(reply.participant_id) ? 1 : 0;
    return {
      participant_id: reply.participant_id,
      room_id: input.roomId,
      room_kind: input.roomKind,
      run_id: input.runId,
      task_id: input.taskId,
      received_at: reply.received_at,
      response_time_ms: reply.response_time_ms,
      content_length: reply.content_length,
      quality_gate: input.qualityGate,
      timeliness,
      substance,
      adoption,
      score: computeOverallAdvisoryScore(timeliness, substance, adoption),
    };
  });
}

export function loadAdvisoryScoreHistory(
  cwd: string,
  runId: string,
): AdvisoryScoreHistory | null {
  return readJson<AdvisoryScoreHistory>(advisoryScorePath(cwd, runId));
}

export function saveAdvisoryScoreSignals(
  input: SaveAdvisoryScoreSignalsInput,
): AdvisoryScoreHistory | null {
  if (input.replies.length === 0) {
    return loadAdvisoryScoreHistory(input.cwd, input.runId);
  }

  const existing = loadAdvisoryScoreHistory(input.cwd, input.runId);
  const nextReplies = buildAdvisoryReplyScores({
    ...input,
    runId: input.runId,
  });
  const replies = dedupeReplies([...(existing?.replies || []), ...nextReplies]);
  const history: AdvisoryScoreHistory = {
    run_id: input.runId,
    updated_at: new Date().toISOString(),
    summary: buildSummary(replies),
    participants: aggregateParticipants(replies),
    replies,
  };

  writeJson(advisoryScorePath(input.cwd, input.runId), history);
  return history;
}

export function formatAdvisoryParticipant(score: AdvisoryParticipantScore): string {
  const roomKinds = score.room_kinds.join('+') || '-';
  const taskText = score.task_ids[0] ? ` task=${score.task_ids[0]}` : '';
  return `${score.participant_id} avg=${score.avg_score} replies=${score.reply_count} adopted=${score.adopted_replies}/${score.reply_count} kinds=${roomKinds}${taskText}`;
}

export function topAdvisoryParticipants(
  history: AdvisoryScoreHistory | null,
  limit = 3,
): AdvisoryParticipantScore[] {
  if (!history) return [];
  return history.participants.slice(0, limit);
}
