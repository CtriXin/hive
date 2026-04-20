import { describe, expect, it } from 'vitest';
import {
  refreshProfileFreshness,
  upsertUserProfile,
  type UserProfileStore,
  type UserProfileEvidence,
} from '../orchestrator/user-profile-store.js';

function makeEvidence(overrides: Partial<UserProfileEvidence> = {}): UserProfileEvidence {
  return {
    source_run_id: 'run-123',
    signal: 'test signal',
    weight: 0.8,
    observed_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeStore(overrides: Partial<UserProfileStore> = {}): UserProfileStore {
  return {
    user_id: 'test-user',
    entries: [],
    generated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('user-profile-store', () => {
  it('refreshProfileFreshness filters stale entries (30+ days old)', () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const store = makeStore({
      entries: [{
        dimension: 'communication_style',
        summary: 'old preference',
        confidence: 0.9,
        recency: 0,
        active: true,
        stale: false,
        evidence: [{ ...makeEvidence(), observed_at: oldDate }],
        created_at: oldDate,
        updated_at: oldDate,
      }],
    });

    const refreshed = refreshProfileFreshness(store);
    expect(refreshed.entries).toEqual([]);
  });

  it('refreshProfileFreshness keeps recent entries active', () => {
    const now = new Date().toISOString();
    const store = makeStore({
      entries: [{
        dimension: 'tech_stack',
        summary: 'uses TypeScript',
        confidence: 0.8,
        recency: 1,
        active: true,
        stale: false,
        evidence: [{ ...makeEvidence(), observed_at: now }],
        created_at: now,
        updated_at: now,
      }],
    });

    const refreshed = refreshProfileFreshness(store);
    expect(refreshed.entries).toHaveLength(1);
    expect(refreshed.entries[0].active).toBe(true);
    expect(refreshed.entries[0].stale).toBe(false);
  });

  it('upsert creates new entry when none exists', () => {
    const store = makeStore();
    const result = upsertUserProfile(store, {
      dimension: 'communication_style',
      summary: 'prefers terse responses',
      evidence: [makeEvidence({ weight: 0.9 })],
    });
    expect(result).not.toBeNull();
    expect(result!.dimension).toBe('communication_style');
    expect(store.entries).toHaveLength(1);
  });

  it('upsert merges evidence into similar existing entry', () => {
    const store = makeStore();
    const first = upsertUserProfile(store, {
      dimension: 'tech_stack',
      summary: 'uses TypeScript',
      evidence: [makeEvidence({ source_run_id: 'run-1', weight: 0.8 })],
    });
    const second = upsertUserProfile(store, {
      dimension: 'tech_stack',
      summary: 'uses TypeScript',
      evidence: [makeEvidence({ source_run_id: 'run-2', weight: 0.7 })],
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0].evidence).toHaveLength(2);
  });

  it('upsert ignores duplicate evidence (same run + signal)', () => {
    const store = makeStore();
    const ev = makeEvidence({ source_run_id: 'run-1', signal: 'same signal' });
    upsertUserProfile(store, {
      dimension: 'focus_project',
      summary: 'working on hive',
      evidence: [ev],
    });
    upsertUserProfile(store, {
      dimension: 'focus_project',
      summary: 'working on hive',
      evidence: [ev],
    });

    const entry = store.entries.find(e => e.dimension === 'focus_project');
    expect(entry).not.toBeUndefined();
    expect(entry!.evidence).toHaveLength(1);
  });

  it('upsert returns null for low-confidence evidence', () => {
    const store = makeStore();
    const result = upsertUserProfile(store, {
      dimension: 'special_habit',
      summary: 'minor habit',
      evidence: [makeEvidence({ weight: 0.1 })],
    });
    expect(result).toBeNull();
    expect(store.entries).toHaveLength(0);
  });
});
