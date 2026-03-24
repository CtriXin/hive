/**
 * Smoke test: verify speed-stats auto-matching for all Hive models.
 * Run: npx tsx scripts/smoke-speed-match.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load model-capabilities.json ──
const configPath = path.resolve(__dirname, '../config/model-capabilities.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const hiveModels: Record<string, { provider: string; speed_tier?: string }> = config.models;

// ── Load speed-stats.json ──
const statsPath = process.env.MMS_SPEED_STATS_PATH
  || path.join(os.homedir(), '.config', 'mms', 'speed-stats.json');
// Fallback: try real home if sandbox HOME is different
const realHome = '/Users/xin';
const statsPaths = [statsPath, path.join(realHome, '.config', 'mms', 'speed-stats.json')];
let resolvedStatsPath = '';
for (const p of statsPaths) {
  if (fs.existsSync(p)) { resolvedStatsPath = p; break; }
}
if (!resolvedStatsPath) { console.error('speed-stats.json not found'); process.exit(1); }
const rawData: Record<string, any> = JSON.parse(fs.readFileSync(resolvedStatsPath, 'utf-8'));

// ── Collect all entries (same logic as model-registry.ts loadSpeedStats) ──
interface Entry { ttfb_avg_ms?: number; ttfb_avg?: number; samples: number; model?: string }
const entries: Record<string, Entry> = {};

for (const [key, value] of Object.entries(rawData)) {
  if (key.startsWith('_')) continue;
  if (typeof value === 'object' && value !== null && 'samples' in value) {
    entries[key] = value as Entry;
  }
}
const scopedModels = rawData._scoped_models;
if (scopedModels && typeof scopedModels === 'object') {
  for (const scopedEntry of Object.values(scopedModels) as any[]) {
    const modelName = scopedEntry.model as string | undefined;
    const samples = scopedEntry.samples as number | undefined;
    if (modelName && typeof samples === 'number') {
      if (!entries[modelName] || samples > (entries[modelName].samples || 0)) {
        entries[modelName] = scopedEntry;
      }
    }
  }
}

// ── resolveSpeedEntry (same logic as model-registry.ts) ──
function resolve(hiveId: string, provider: string): { entry: Entry | undefined; strategy: string; mmsName: string } {
  // 1. Exact
  if (entries[hiveId]) return { entry: entries[hiveId], strategy: 'exact', mmsName: hiveId };

  // 2. Case-insensitive
  const lower = hiveId.toLowerCase();
  for (const [key, entry] of Object.entries(entries)) {
    if (key.toLowerCase() === lower) return { entry, strategy: 'case-insensitive', mmsName: key };
  }

  // 3. Fuzzy
  const providerBase = provider.replace(/-cn$/, '').toLowerCase();
  const hiveTokens = hiveId.toLowerCase()
    .split(/[-_.]/)
    .filter(t => /\d/.test(t) || /^(max|turbo|plus|pro|lite|v\d)$/i.test(t));

  let bestMatch: Entry | undefined;
  let bestScore = 0;
  let bestName = '';
  const providerCandidates: { name: string; entry: Entry }[] = [];

  for (const [mmsName, entry] of Object.entries(entries)) {
    const mmsLower = mmsName.toLowerCase();
    if (!mmsLower.includes(providerBase)) continue;
    providerCandidates.push({ name: mmsName, entry });
    let score = 1;
    for (const token of hiveTokens) {
      if (mmsLower.includes(token)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
      bestName = mmsName;
    }
  }

  if (!bestMatch && providerCandidates.length === 1) {
    return { entry: providerCandidates[0].entry, strategy: `single-provider(${providerBase})`, mmsName: providerCandidates[0].name };
  }

  if (bestMatch) {
    return { entry: bestMatch, strategy: `fuzzy(provider=${providerBase}, tokens=[${hiveTokens}], score=${bestScore})`, mmsName: bestName };
  }

  return { entry: undefined, strategy: 'no-match', mmsName: '' };
}

// ── Run ──
console.log('═══ Hive Speed-Stats Auto-Match Smoke Test ═══\n');
console.log(`mms entries: ${Object.keys(entries).join(', ')}\n`);

for (const [hiveId, model] of Object.entries(hiveModels)) {
  const { entry, strategy, mmsName } = resolve(hiveId, model.provider);

  const ttfb = entry ? (entry.ttfb_avg_ms ?? entry.ttfb_avg ?? null) : null;
  const samples = entry?.samples ?? 0;
  const liveTier = ttfb !== null && samples >= 3
    ? (ttfb < 500 ? 'fast' : ttfb < 2000 ? 'balanced' : 'strong')
    : null;
  const staticTier = model.speed_tier || 'unknown';
  const finalTier = liveTier || staticTier;
  const tierSource = liveTier ? 'LIVE' : 'STATIC';

  const status = entry ? '✅' : '⚠️';
  console.log(`${status} ${hiveId}`);
  console.log(`   provider: ${model.provider}`);
  console.log(`   strategy: ${strategy}`);
  if (entry) {
    console.log(`   mms name: ${mmsName}`);
    console.log(`   ttfb: ${ttfb}ms | samples: ${samples} | warming: ${samples < 5}`);
  }
  console.log(`   tier: ${finalTier} (${tierSource}, static=${staticTier})`);
  console.log();
}
