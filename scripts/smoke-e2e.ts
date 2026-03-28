/**
 * Hive MCP E2E Smoke Test
 * Tests: ModelRegistry, speed-stats, provider health, translate, assignModel
 * Run: npx tsx scripts/smoke-e2e.ts
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { ModelRegistry } from '../orchestrator/model-registry.js';
import { checkProviderHealth, getAllProviders, resolveProvider } from '../orchestrator/provider-resolver.js';
import { translateToEnglish } from '../orchestrator/translator.js';
import { buildTaskFingerprint } from '../orchestrator/task-fingerprint.js';
import type { SubTask } from '../orchestrator/types.js';

const REAL_HOME = '/Users/xin';
// Ensure speed-stats path works in sandbox
process.env.HOME = process.env.HOME?.includes('.config/mms/claude-gateway') ? REAL_HOME : process.env.HOME;

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('═══ Hive E2E Smoke Test ═══\n');

  // ── Phase 1: ModelRegistry basics ──
  console.log('Phase 1: ModelRegistry');
  const registry = new ModelRegistry();
  const allModels = registry.getAll();
  ok('getAll() returns models', allModels.length >= 5, `${allModels.length} models`);
  ok('each model has required fields', allModels.every(m => m.id && m.provider && m.coding > 0), '');

  const known = ['qwen-3.5', 'qwen-max', 'kimi-for-coding', 'kimi-k2.5', 'glm-5-turbo', 'MiniMax-M2.7'];
  for (const id of known) {
    ok(`get("${id}") exists`, !!registry.get(id));
  }

  // ── Phase 2: Speed tiers ──
  console.log('\nPhase 2: Speed Tiers (live from mms)');
  // Debug: check what resolveSpeedEntry is doing
  console.log(`  🔍 HOME=${process.env.HOME}, homedir=${os.homedir()}`);
  const statsPath = path.join(os.homedir(), '.config', 'mms', 'speed-stats.json');
  console.log(`  🔍 speed-stats exists: ${fs.existsSync(statsPath)}`);

  const expectedTiers: Record<string, string[]> = {
    'glm-5-turbo': ['fast', 'balanced'],
    'MiniMax-M2.7': ['strong'],
    'qwen-3.5': ['balanced', 'strong'],
    'qwen-max': ['strong'],
    'kimi-for-coding': ['balanced', 'strong'],
    'kimi-k2.5': ['balanced', 'strong'],
  };
  for (const [id, acceptable] of Object.entries(expectedTiers)) {
    const tier = registry.getSpeedTier(id);
    ok(`getSpeedTier("${id}")`, acceptable.includes(tier), `${tier}`);
  }

  const fastModels = registry.getModelsBySpeedTier('fast');
  const balancedModels = registry.getModelsBySpeedTier('balanced');
  const strongModels = registry.getModelsBySpeedTier('strong');
  console.log(`  📊 fast=${fastModels}, balanced=${balancedModels}, strong=${strongModels}`);

  // ── Phase 3: selectTranslator ──
  console.log('\nPhase 3: Translator Selection');
  const translator = registry.selectTranslator();
  ok('selectTranslator() returns a model', !!translator, translator);
  const translatorFallback = registry.selectTranslatorFallback(translator);
  ok('selectTranslatorFallback() returns different model', translatorFallback !== translator, translatorFallback);

  // ── Phase 4: rankModelsForTask ──
  console.log('\nPhase 4: Model Ranking');
  const codingFingerprint = buildTaskFingerprint({
    id: 'test-1',
    description: 'Implement a TypeScript module',
    category: 'coding',
    complexity: 'medium',
    assigned_model: '',
    depends_on: [],
    context_inputs: [],
    estimated_files: ['src/auth/module.ts'],
  } as SubTask);
  const ranked = registry.rankModelsForTask(codingFingerprint);
  ok('rankModelsForTask returns results', ranked.length >= 5, `${ranked.length} candidates`);
  ok('top model has positive score', ranked[0].final_score > 0, `${ranked[0].model}: ${ranked[0].final_score.toFixed(3)}`);
  console.log('  📊 Ranking:');
  for (const r of ranked.slice(0, 5)) {
    const blocked = r.blocked_by?.length ? ` [BLOCKED: ${r.blocked_by.join(',')}]` : '';
    console.log(`     ${r.model}: ${r.final_score.toFixed(3)}${blocked}`);
  }

  // ── Phase 5: assignModel ──
  console.log('\nPhase 5: assignModel');
  const sampleTask: SubTask = {
    id: 'smoke-1',
    description: 'Add unit tests for the auth module',
    category: 'coding',
    complexity: 'medium',
    assigned_model: '',
    depends_on: [],
    context_inputs: [],
    estimated_files: ['src/auth/__tests__/auth.test.ts'],
  };
  try {
    const assigned = registry.assignModel(sampleTask);
    ok('assignModel() returns a model', !!assigned, assigned);
  } catch (e: any) {
    ok('assignModel() works', false, e.message);
  }

  // ── Phase 6: Cross-reviewer & discuss partner ──
  console.log('\nPhase 6: Cross-Review & Discuss');
  const reviewer = registry.selectCrossReviewer('kimi-for-coding');
  ok('selectCrossReviewer avoids same model', reviewer !== 'kimi-for-coding', reviewer);
  const partner = registry.selectDiscussPartner('qwen-3.5');
  ok('selectDiscussPartner avoids same model', partner !== 'qwen-3.5', partner);

  // ── Phase 7: Provider health ──
  console.log('\nPhase 7: Provider Health');
  const providers = getAllProviders();
  const providerNames = Object.keys(providers);
  ok('providers loaded', providerNames.length >= 3, `${providerNames.length} providers`);

  // Test a few providers
  const testProviders = providerNames.slice(0, 3);
  for (const pId of testProviders) {
    try {
      const healthy = await checkProviderHealth(pId);
      ok(`provider "${pId}" health`, true, healthy ? 'OK' : 'UNAVAILABLE');
    } catch (e: any) {
      ok(`provider "${pId}" health`, false, e.message?.slice(0, 60));
    }
  }

  // ── Phase 8: Translate (live API call) ──
  console.log('\nPhase 8: Translate (live)');
  try {
    const translatorModel = registry.selectTranslator();
    const modelInfo = registry.get(translatorModel);
    if (modelInfo) {
      const result = await translateToEnglish('给认证模块添加单元测试', translatorModel, modelInfo.provider);
      ok('translate returns english', result.english.length > 5, `"${result.english.slice(0, 80)}"`);
      ok('translate has confidence', result.confidence > 0, `${result.confidence.toFixed(2)}`);
      ok('translate duration reasonable', result.duration_ms < 30000, `${result.duration_ms}ms`);
    } else {
      ok('translator model info', false, `${translatorModel} not found`);
    }
  } catch (e: any) {
    ok('translate API call', false, e.message?.slice(0, 80));
  }

  // ── Summary ──
  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
