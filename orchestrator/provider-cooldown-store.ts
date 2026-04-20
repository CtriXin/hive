// orchestrator/provider-cooldown-store.ts — Durable provider cooldown persistence
//
// DEPRECATED: This class is no longer the authority source for provider health.
// All production code now uses ProviderHealthStore (provider-resilience.ts) which
// unifies cooldown, circuit breaker, failure taxonomy, and fallback decisions.
// This file is kept for backward compatibility only.
import fs from 'fs';
import path from 'path';

const COOLDOWN_MS = 60_000;
const MAX_FAILURES = 2;

export interface ProviderState {
  failures: number;
  last_failure: number;
}

export interface CooldownStoreData {
  providers: Record<string, ProviderState>;
  updated_at: string;
}

/**
 * Durable provider cooldown store.
 * Persists to .ai/runs/<runId>/provider-cooldown.json
 * Falls back to empty state if file missing or malformed.
 */
export class ProviderCooldownStore {
  private providers: Map<string, ProviderState> = new Map();
  private runDir: string | null = null;
  private dirty = false;

  constructor(runDir?: string) {
    if (runDir) {
      this.runDir = runDir;
      this.load();
    }
  }

  /** Load from disk if file exists */
  load(): void {
    if (!this.runDir) return;
    const filePath = this.filePath();
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw) as CooldownStoreData;
        this.providers = new Map(Object.entries(data.providers || {}));
      }
    } catch {
      this.providers = new Map();
    }
  }

  /** Persist to disk */
  save(): void {
    if (!this.runDir || !this.dirty) return;
    const filePath = this.filePath();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const data: CooldownStoreData = {
        providers: Object.fromEntries(this.providers),
        updated_at: new Date().toISOString(),
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      this.dirty = false;
    } catch {
      // Non-critical: cooldown persistence failure
    }
  }

  /** Record a provider failure */
  recordFailure(provider: string): void {
    const state = this.providers.get(provider) ?? { failures: 0, last_failure: 0 };
    state.failures++;
    state.last_failure = Date.now();
    this.providers.set(provider, state);
    this.dirty = true;
  }

  /** Check if provider is in cooldown */
  isCooledDown(provider: string, now = Date.now()): boolean {
    const state = this.providers.get(provider);
    if (!state) return false;
    if (state.failures < MAX_FAILURES) return false;
    if (now - state.last_failure > COOLDOWN_MS) {
      this.reset(provider);
      return false;
    }
    return true;
  }

  /** Reset provider cooldown */
  reset(provider: string): void {
    this.providers.delete(provider);
    this.dirty = true;
  }

  /** Get all provider states (for router consumption) */
  getAll(): Map<string, ProviderState> {
    return new Map(this.providers);
  }

  private filePath(): string {
    return path.join(this.runDir!, 'provider-cooldown.json');
  }
}

let _globalStore: ProviderCooldownStore | null = null;

export function getGlobalCooldownStore(runDir?: string): ProviderCooldownStore {
  if (!_globalStore && runDir) {
    _globalStore = new ProviderCooldownStore(runDir);
  }
  return _globalStore ?? new ProviderCooldownStore();
}

export function resetGlobalCooldownStore(): void {
  _globalStore = null;
}
