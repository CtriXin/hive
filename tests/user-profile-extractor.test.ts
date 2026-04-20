import { describe, expect, it } from 'vitest';
import { parseExtractorText } from '../orchestrator/user-profile-extractor.js';

describe('user-profile-extractor', () => {
  it('returns empty updates for non-JSON output', () => {
    expect(parseExtractorText('not json at all')).toEqual({ updates: [] });
  });

  it('drops entries with invalid dimensions', () => {
    const parsed = parseExtractorText(JSON.stringify({
      updates: [
        {
          dimension: 'unknown_dimension',
          summary: 'prefers terse responses',
          confidence: 0.8,
          signal: 'observed',
        },
      ],
    }));

    expect(parsed.updates).toEqual([]);
  });

  it('clamps out-of-range confidence values', () => {
    const parsed = parseExtractorText(JSON.stringify({
      updates: [
        {
          dimension: 'communication_style',
          summary: 'prefers terse responses',
          detail: 'Asked to keep it short',
          confidence: 3,
          signal: 'terse preference observed',
        },
        {
          dimension: 'special_habit',
          summary: 'prefers named exports',
          confidence: -2,
          signal: 'named export preference',
        },
      ],
    }));

    expect(parsed.updates).toHaveLength(2);
    expect(parsed.updates[0]?.confidence).toBe(1);
    expect(parsed.updates[1]?.confidence).toBe(0);
  });
});
