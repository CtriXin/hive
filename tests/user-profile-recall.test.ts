import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadUserProfileMock, refreshProfileFreshnessMock } = vi.hoisted(() => ({
  loadUserProfileMock: vi.fn(),
  refreshProfileFreshnessMock: vi.fn((store) => store),
}));

vi.mock('../orchestrator/user-profile-store.js', () => ({
  loadUserProfile: loadUserProfileMock,
  refreshProfileFreshness: refreshProfileFreshnessMock,
}));

import { recallUserProfile } from '../orchestrator/user-profile-recall.js';

describe('user-profile-recall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty result when no profile exists', () => {
    loadUserProfileMock.mockReturnValue(null);

    const result = recallUserProfile('improve TypeScript planner');

    expect(result.entries).toEqual([]);
    expect(result.selection_reason).toContain('No user profile');
  });

  it('returns only the top 2 relevant active entries', () => {
    loadUserProfileMock.mockReturnValue({
      user_id: 'tester',
      generated_at: new Date().toISOString(),
      entries: [
        {
          dimension: 'tech_stack',
          summary: 'prefers TypeScript services',
          detail: 'Often works on TypeScript planner flows',
          confidence: 0.9,
          recency: 0.9,
          active: true,
          stale: false,
          evidence: [],
          created_at: '2026-04-01T00:00:00.000Z',
          updated_at: '2026-04-12T00:00:00.000Z',
        },
        {
          dimension: 'focus_project',
          summary: 'focused on planner runner work',
          detail: 'Recently iterating planner prompts',
          confidence: 0.85,
          recency: 0.8,
          active: true,
          stale: false,
          evidence: [],
          created_at: '2026-04-01T00:00:00.000Z',
          updated_at: '2026-04-12T00:00:00.000Z',
        },
        {
          dimension: 'communication_style',
          summary: 'prefers terse responses',
          detail: 'Wants short status updates',
          confidence: 0.8,
          recency: 0.7,
          active: true,
          stale: false,
          evidence: [],
          created_at: '2026-04-01T00:00:00.000Z',
          updated_at: '2026-04-12T00:00:00.000Z',
        },
      ],
    });

    const result = recallUserProfile('fix TypeScript planner runner prompt', { topN: 2 });

    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.entry.summary)).toEqual([
      'prefers TypeScript services',
      'focused on planner runner work',
    ]);
  });

  it('does not recall stale entries', () => {
    loadUserProfileMock.mockReturnValue({
      user_id: 'tester',
      generated_at: new Date().toISOString(),
      entries: [
        {
          dimension: 'tech_stack',
          summary: 'prefers TypeScript services',
          confidence: 0.9,
          recency: 0.9,
          active: false,
          stale: true,
          evidence: [],
          created_at: '2026-04-01T00:00:00.000Z',
          updated_at: '2026-04-12T00:00:00.000Z',
        },
      ],
    });

    const result = recallUserProfile('fix TypeScript planner runner prompt');

    expect(result.entries).toHaveLength(0);
    expect(result.selection_reason).toContain('stale or inactive');
  });
});
