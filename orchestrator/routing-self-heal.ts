import fs from 'fs';
import os from 'os';
import path from 'path';

export type RoutingIncidentKind = 'missing_selector' | 'unavailable_for_model';

export interface RoutingIncident {
  kind: RoutingIncidentKind;
  model_id: string;
  pattern: string;
  selector: string;
  provider_id?: string;
  available_providers: string[];
  first_seen_at: string;
  last_seen_at: string;
  count: number;
  last_cwd?: string;
}

interface RoutingIncidentStore {
  schema_version: '1.0';
  incidents: RoutingIncident[];
}

const MAX_INCIDENTS = 500;
const WARNED_KEYS = new Set<string>();

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function userHomeCandidates(): string[] {
  const user = process.env.USER || process.env.LOGNAME || '';
  return uniq([
    process.env.HOME || '',
    user ? path.join('/Users', user) : '',
    os.homedir(),
  ]);
}

function resolveStorePath(): string {
  if (process.env.HIVE_SELF_HEAL_STORE_PATH) {
    return process.env.HIVE_SELF_HEAL_STORE_PATH;
  }

  const candidates = userHomeCandidates().map((home) => path.join(home, '.hive', 'user-memory', 'routing-incidents.json'));
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] || path.join(os.homedir(), '.hive', 'user-memory', 'routing-incidents.json');
}

function loadStore(): RoutingIncidentStore {
  const filePath = resolveStorePath();
  try {
    if (!fs.existsSync(filePath)) {
      return { schema_version: '1.0', incidents: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RoutingIncidentStore;
    if (!parsed || !Array.isArray(parsed.incidents)) {
      return { schema_version: '1.0', incidents: [] };
    }
    return {
      schema_version: '1.0',
      incidents: parsed.incidents.filter((item) => item && typeof item === 'object'),
    };
  } catch {
    return { schema_version: '1.0', incidents: [] };
  }
}

function saveStore(store: RoutingIncidentStore): void {
  const filePath = resolveStorePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const incidents = [...store.incidents]
      .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
      .slice(0, MAX_INCIDENTS);
    fs.writeFileSync(filePath, JSON.stringify({ schema_version: '1.0', incidents }, null, 2), 'utf-8');
  } catch {
    // fail open
  }
}

function incidentKey(input: Pick<RoutingIncident, 'kind' | 'model_id' | 'pattern' | 'selector' | 'provider_id'>): string {
  return [input.kind, input.model_id, input.pattern, input.selector, input.provider_id || ''].join('::');
}

export function recordRoutingIncident(input: {
  kind: RoutingIncidentKind;
  model_id: string;
  pattern: string;
  selector: string;
  provider_id?: string;
  available_providers?: string[];
  cwd?: string;
}): void {
  const now = new Date().toISOString();
  const store = loadStore();
  const key = incidentKey(input);
  const existing = store.incidents.find((item) => incidentKey(item) === key);

  if (existing) {
    existing.count += 1;
    existing.last_seen_at = now;
    existing.available_providers = uniq([...(existing.available_providers || []), ...(input.available_providers || [])]);
    existing.last_cwd = input.cwd || existing.last_cwd;
  } else {
    store.incidents.push({
      kind: input.kind,
      model_id: input.model_id,
      pattern: input.pattern,
      selector: input.selector,
      provider_id: input.provider_id,
      available_providers: uniq(input.available_providers || []),
      first_seen_at: now,
      last_seen_at: now,
      count: 1,
      last_cwd: input.cwd,
    });
  }

  saveStore(store);
}

export function warnRoutingSelfHeal(message: string, dedupeKey: string): void {
  if (WARNED_KEYS.has(dedupeKey)) return;
  WARNED_KEYS.add(dedupeKey);
  console.warn(message);
}

export function resetRoutingSelfHealWarnings(): void {
  WARNED_KEYS.clear();
}
