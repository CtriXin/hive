import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeAdvisorySubstance,
  computeAdvisoryTimeliness,
  loadAdvisoryScoreHistory,
  saveAdvisoryScoreSignals,
} from '../orchestrator/advisory-score.js';

const TMP_DIR = '/tmp/hive-advisory-score-test';
const RUN_ID = 'run-advisory-1';

function resetDir(): void {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(TMP_DIR, '.ai', 'runs', RUN_ID), { recursive: true });
}

afterEach(() => {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe('advisory-score', () => {
  it('scores timeliness and substance with the expected heuristics', () => {
    expect(computeAdvisoryTimeliness(500, 3000)).toBe(1);
    expect(computeAdvisoryTimeliness(20000, 30000)).toBeLessThan(1);
    expect(computeAdvisorySubstance('Fix task-a in orchestrator/driver.ts before retry.', 52)).toBeGreaterThan(0.5);
    expect(computeAdvisorySubstance('ok', 2)).toBeLessThan(0.2);
  });

  it('persists aggregated advisory score history without duplicating identical replies', () => {
    resetDir();

    const input = {
      cwd: TMP_DIR,
      runId: RUN_ID,
      roomId: 'room-review-a',
      roomKind: 'review' as const,
      taskId: 'task-a',
      timeoutMs: 30000,
      qualityGate: 'pass' as const,
      adoptedParticipantIds: ['reviewer-a'],
      replies: [
        {
          participant_id: 'reviewer-a',
          content: 'Fix task-a in orchestrator/driver.ts before retrying the same branch.',
          response_time_ms: 12000,
          content_length: 68,
          received_at: '2026-04-05T10:00:00.000Z',
        },
      ],
    };

    const first = saveAdvisoryScoreSignals(input);
    const second = saveAdvisoryScoreSignals(input);
    const loaded = loadAdvisoryScoreHistory(TMP_DIR, RUN_ID);

    expect(first?.summary.reply_count).toBe(1);
    expect(second?.summary.reply_count).toBe(1);
    expect(loaded?.summary.participant_count).toBe(1);
    expect(loaded?.participants[0]?.participant_id).toBe('reviewer-a');
    expect(loaded?.participants[0]?.adopted_replies).toBe(1);
    expect(loaded?.participants[0]?.room_kinds).toEqual(['review']);
    expect(loaded?.participants[0]?.task_ids).toEqual(['task-a']);
    expect(loaded?.participants[0]?.avg_score).toBeGreaterThan(70);
  });
});
