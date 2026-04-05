// tests/agentbus-adapter-extended.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  mergeAgentBusReplies,
  buildRoomRef,
  type AgentBusReply,
  type PlannerDiscussRoom,
} from '../orchestrator/agentbus-adapter.js';

// ── mergeAgentBusReplies ──

describe('mergeAgentBusReplies', () => {
  it('maps participant_id to partner_models', () => {
    const replies: AgentBusReply[] = [
      { participant_id: 'agent-alpha', content: 'looks good', response_time_ms: 0, content_length: 10, received_at: '2026-04-03T00:00:00.000Z' },
      { participant_id: 'agent-beta', content: 'consider caching', response_time_ms: 0, content_length: 16, received_at: '2026-04-03T00:00:01.000Z' },
    ];
    const result = mergeAgentBusReplies(replies);
    expect(result.partner_models).toEqual(['agent-alpha', 'agent-beta']);
  });

  it('concatenates truncated content in overall_assessment', () => {
    const longContent = 'x'.repeat(300);
    const replies: AgentBusReply[] = [
      { participant_id: 'agent-a', content: longContent, response_time_ms: 0, content_length: 300, received_at: '2026-04-03T00:00:00.000Z' },
    ];
    const result = mergeAgentBusReplies(replies);
    // content sliced to 200 chars per reply
    expect(result.overall_assessment).toContain('[agent-a]');
    expect(result.overall_assessment.length).toBeLessThan(longContent.length + 20);
  });

  it('defaults quality_gate to warn', () => {
    const result = mergeAgentBusReplies([
      { participant_id: 'p', content: 'ok', response_time_ms: 0, content_length: 2, received_at: '2026-04-03T00:00:00.000Z' },
    ]);
    expect(result.quality_gate).toBe('warn');
  });

  it('returns empty arrays for gaps/redundancies/suggestions/order issues', () => {
    const result = mergeAgentBusReplies([]);
    expect(result.task_gaps).toEqual([]);
    expect(result.task_redundancies).toEqual([]);
    expect(result.model_suggestions).toEqual([]);
    expect(result.execution_order_issues).toEqual([]);
  });

  it('handles empty replies array', () => {
    const result = mergeAgentBusReplies([]);
    expect(result.partner_models).toEqual([]);
    expect(result.overall_assessment).toBe('');
  });
});

// ── buildRoomRef edge cases ──

describe('buildRoomRef edge cases', () => {
  it('handles zero replies and zero timeout', () => {
    const room: PlannerDiscussRoom = { room_id: 'r1', orchestrator_id: 'hive-planner-r1' };
    const ref = buildRoomRef(room, [], 0);
    expect(ref.reply_count).toBe(0);
    expect(ref.timeout_ms).toBe(0);
  });

  it('always sets transport to agentbus', () => {
    const room: PlannerDiscussRoom = { room_id: 'r2', join_hint: 'hint', orchestrator_id: 'hive-planner-r2' };
    const ref = buildRoomRef(room, [
      { participant_id: 'p1', content: 'a', response_time_ms: 10, content_length: 1, received_at: '2026-04-03T00:00:01.000Z' },
      { participant_id: 'p2', content: 'b', response_time_ms: 20, content_length: 1, received_at: '2026-04-03T00:00:02.000Z' },
      { participant_id: 'p3', content: 'c', response_time_ms: 30, content_length: 1, received_at: '2026-04-03T00:00:03.000Z' },
      { participant_id: 'p4', content: 'd', response_time_ms: 40, content_length: 1, received_at: '2026-04-03T00:00:04.000Z' },
      { participant_id: 'p5', content: 'e', response_time_ms: 50, content_length: 1, received_at: '2026-04-03T00:00:05.000Z' },
    ], 10000);
    expect(ref.transport).toBe('agentbus');
  });
});
