import { describe, expect, it } from 'vitest';
import { mergeWorkerTaskSummary } from '../orchestrator/driver.js';

describe('driver authority summary merge', () => {
  it('preserves collab summary while appending authority summary', () => {
    const merged = mergeWorkerTaskSummary(
      'External review collecting: 2 replies',
      'review passed | authority-layer | mode=pair',
    );

    expect(merged).toContain('External review collecting: 2 replies');
    expect(merged).toContain('review passed | authority-layer | mode=pair');
  });

  it('avoids duplicating the authority summary', () => {
    const summary = 'External review closed || review failed | authority-layer | mode=pair';
    expect(mergeWorkerTaskSummary(summary, 'review failed | authority-layer | mode=pair')).toBe(summary);
  });
});
