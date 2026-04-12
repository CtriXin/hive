import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderCooldownStore, getGlobalCooldownStore, resetGlobalCooldownStore } from '../orchestrator/provider-cooldown-store.js';

describe('provider cooldown store: basic operations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-cooldown-'));
    resetGlobalCooldownStore();
  });

  it('starts empty', () => {
    const store = new ProviderCooldownStore(tmpDir);
    expect(store.isCooledDown('kimi')).toBe(false);
    expect(store.isCooledDown('qwen')).toBe(false);
  });

  it('records failure and marks cooldown after threshold', () => {
    const store = new ProviderCooldownStore(tmpDir);
    store.recordFailure('kimi');
    expect(store.isCooledDown('kimi')).toBe(false); // only 1 failure

    store.recordFailure('kimi');
    expect(store.isCooledDown('kimi')).toBe(true); // 2 failures
  });

  it('reset clears cooldown', () => {
    const store = new ProviderCooldownStore(tmpDir);
    store.recordFailure('kimi');
    store.recordFailure('kimi');
    expect(store.isCooledDown('kimi')).toBe(true);

    store.reset('kimi');
    expect(store.isCooledDown('kimi')).toBe(false);
  });

  it('auto-clears after cooldown window', () => {
    const store = new ProviderCooldownStore(tmpDir);
    store.recordFailure('kimi');
    store.recordFailure('kimi');
    expect(store.isCooledDown('kimi')).toBe(true);

    // Simulate time passing
    const future = Date.now() + 61_000;
    expect(store.isCooledDown('kimi', future)).toBe(false);
  });

  it('getAll returns all provider states', () => {
    const store = new ProviderCooldownStore(tmpDir);
    store.recordFailure('kimi');
    store.recordFailure('kimi');
    store.recordFailure('qwen');

    const all = store.getAll();
    expect(all.size).toBe(2);
    expect(all.get('kimi')?.failures).toBe(2);
    expect(all.get('qwen')?.failures).toBe(1);
  });
});

describe('provider cooldown store: persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-cooldown-persist-'));
    resetGlobalCooldownStore();
  });

  it('saves state to disk', () => {
    const store = new ProviderCooldownStore(tmpDir);
    store.recordFailure('kimi');
    store.recordFailure('kimi');
    store.save();

    const filePath = path.join(tmpDir, 'provider-cooldown.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.providers.kimi.failures).toBe(2);
    expect(data.providers.kimi.last_failure).toBeGreaterThan(0);
    expect(data.updated_at).toBeTruthy();
  });

  it('loads state from disk', () => {
    // Write file manually
    const filePath = path.join(tmpDir, 'provider-cooldown.json');
    const data = {
      providers: { kimi: { failures: 2, last_failure: Date.now() } },
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

    const store = new ProviderCooldownStore(tmpDir);
    expect(store.isCooledDown('kimi')).toBe(true);
  });

  it('returns empty state if file missing', () => {
    const store = new ProviderCooldownStore(tmpDir);
    expect(store.getAll().size).toBe(0);
  });

  it('returns empty state if file malformed', () => {
    const filePath = path.join(tmpDir, 'provider-cooldown.json');
    fs.writeFileSync(filePath, 'not json');

    const store = new ProviderCooldownStore(tmpDir);
    expect(store.getAll().size).toBe(0);
  });
});

describe('provider cooldown store: global singleton', () => {
  beforeEach(() => {
    resetGlobalCooldownStore();
  });

  it('returns same instance on repeated calls', () => {
    const store1 = getGlobalCooldownStore('/tmp/test1');
    const store2 = getGlobalCooldownStore('/tmp/test1');
    expect(store1).toBe(store2);
  });

  it('reset allows re-creation', () => {
    const store1 = getGlobalCooldownStore('/tmp/test2');
    resetGlobalCooldownStore();
    const store2 = getGlobalCooldownStore('/tmp/test2');
    expect(store1).not.toBe(store2);
  });

  it('returns empty store without runDir', () => {
    resetGlobalCooldownStore();
    const store = getGlobalCooldownStore();
    expect(store.isCooledDown('any')).toBe(false);
  });
});
