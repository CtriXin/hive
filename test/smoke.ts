#!/usr/bin/env npx tsx
// ═══════════════════════════════════════════════════════════════════
// Hive Smoke Test — 端到端验证核心链路
// 用法: npx tsx test/smoke.ts
// ═══════════════════════════════════════════════════════════════════

import { ModelRegistry } from '../orchestrator/model-registry.js';
import { loadConfig, getBudgetWarning } from '../orchestrator/hive-config.js';
import { buildTaskFingerprint } from '../orchestrator/task-fingerprint.js';
import type { SubTask } from '../orchestrator/types.js';

// ── 配置 ──

const NEWAPI_BASE = process.env.NEWAPI_BASE_URL || 'https://chat.adsconflux.xyz/openapi/v1';
const NEWAPI_KEY = process.env.NEWAPI_KEY || 'sk-crL7G5zKZMGV8trp3Bz665UTso4FYeyJSpKbQbvdt5GZbn1M';

const TEST_MODELS = {
  translate: 'kimi-k2.5',
  worker: 'glm-5-turbo',
  reviewer: 'MiniMax-M2.7',
};

const passed: string[] = [];
const failed: string[] = [];

function report(name: string, ok: boolean, detail: string) {
  if (ok) {
    passed.push(name);
    console.log(`  ✅ ${name}: ${detail}`);
  } else {
    failed.push(name);
    console.log(`  ❌ ${name}: ${detail}`);
  }
}

// ── 直接调 Anthropic Messages API（不走 Claude Code SDK） ──

async function callModel(model: string, prompt: string): Promise<{ text: string; inputTokens: number; outputTokens: number; durationMs: number }> {
  const start = Date.now();
  const resp = await fetch(`${NEWAPI_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': NEWAPI_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`${resp.status} ${resp.statusText}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json() as any;
  const text = (data.content || [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');

  return {
    text,
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
    durationMs: Date.now() - start,
  };
}

// ── Test 1: Config 加载 ──

async function testConfig() {
  console.log('\n─── Test 1: Config 加载 ───');
  try {
    const config = loadConfig(process.cwd());
    report('loadConfig', true, `host=${config.host}, high_tier=${config.high_tier}, default_worker=${config.default_worker}`);

    const warning = getBudgetWarning(config);
    report('budgetWarning', true, warning || '(no warning, budget OK)');
  } catch (err: any) {
    report('loadConfig', false, err.message);
  }
}

// ── Test 2: Model Registry + 排序 ──

async function testRegistry() {
  console.log('\n─── Test 2: Model Registry ───');
  try {
    const registry = new ModelRegistry();
    const all = registry.getAll();
    report('registry.getAll', all.length > 0, `${all.length} models loaded: ${all.map(m => m.id).join(', ')}`);

    const fingerprint = buildTaskFingerprint({
      id: 'test-task',
      description: 'Create a REST API endpoint for user authentication',
      complexity: 'medium',
      category: 'api',
      assigned_model: '',
      assignment_reason: '',
      estimated_files: ['src/auth.ts'],
      acceptance_criteria: ['endpoint works'],
      discuss_threshold: 0.6,
      depends_on: [],
      review_scale: 'auto',
    });
    report('buildFingerprint', true, `role=${fingerprint.role}, domains=${fingerprint.domains.join(',')}`);

    const ranked = registry.rankModelsForTask(fingerprint);
    const topModels = ranked.filter(r => !r.blocked_by?.length).slice(0, 3);
    report('rankModels', topModels.length > 0,
      topModels.map(r => `${r.model}(${r.final_score.toFixed(3)})`).join(' > '));

    const mockTask: SubTask = {
      id: 'test-task', description: 'Create a REST API endpoint',
      complexity: 'medium', category: 'api', assigned_model: '', assignment_reason: '',
      estimated_files: ['src/auth.ts'], acceptance_criteria: ['works'],
      discuss_threshold: 0.6, depends_on: [], review_scale: 'auto',
    };
    const assigned = registry.assignModel(mockTask);
    report('assignModel(medium)', true, `→ ${assigned}`);

    const highTask: SubTask = { ...mockTask, id: 'high-task', complexity: 'high' };
    const highAssigned = registry.assignModel(highTask);
    report('assignModel(high)', true, `→ ${highAssigned} (should be config.high_tier)`);
  } catch (err: any) {
    report('registry', false, err.message);
  }
}

// ── Test 3: 翻译 (真实 API) ──

async function testTranslate() {
  console.log('\n─── Test 3: 翻译 (真实 API → newapi) ───');
  const model = TEST_MODELS.translate;
  const input = '帮我写一个用户认证模块，支持JWT和OAuth2';

  console.log(`  📡 Calling ${model} via newapi...`);
  try {
    const result = await callModel(model,
      `Translate the following Chinese to clean English for a coding assistant. Output ONLY the English, nothing else.\n\n${input}`);
    const ok = result.text.trim().length > 0;
    report(`translate(${model})`, ok,
      `${result.durationMs}ms, ${result.inputTokens}in/${result.outputTokens}out — "${result.text.trim().slice(0, 120)}"`);
  } catch (err: any) {
    report(`translate(${model})`, false, err.message?.slice(0, 200));
  }
}

// ── Test 4: Worker 代码生成 (真实 API) ──

async function testWorker() {
  console.log('\n─── Test 4: Worker 执行 (真实 API → newapi) ───');
  const model = TEST_MODELS.worker;

  console.log(`  📡 Calling ${model} via newapi...`);
  try {
    const result = await callModel(model,
      'Write a TypeScript function called `validateEmail` that checks if a string is a valid email address. Return ONLY the code, no explanation.');

    const hasCode = result.text.includes('function') || result.text.includes('=>');
    report(`worker(${model})`, hasCode,
      `${result.durationMs}ms, ${result.inputTokens}in/${result.outputTokens}out — ${hasCode ? 'code generated' : 'no code found'}`);
    if (hasCode) {
      console.log(`  📝 Preview: ${result.text.trim().slice(0, 150)}...`);
    }
  } catch (err: any) {
    report(`worker(${model})`, false, err.message?.slice(0, 200));
  }
}

// ── Test 5: Cross Review (真实 API) ──

async function testCrossReview() {
  console.log('\n─── Test 5: Cross Review (真实 API → newapi) ───');
  const model = TEST_MODELS.reviewer;

  console.log(`  📡 Calling ${model} via newapi...`);
  const codeToReview = `function validateEmail(email: string): boolean {
  const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$/;
  return regex.test(email);
}`;

  try {
    const result = await callModel(model,
      `Review this TypeScript code. Output JSON only: {"passed": true|false, "confidence": 0.0-1.0, "issues": ["issue 1"]}\n\nCode:\n${codeToReview}`);

    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      report(`review(${model})`, true,
        `${result.durationMs}ms — passed=${parsed.passed}, confidence=${parsed.confidence}, issues=${(parsed.issues || []).length}`);
    } else {
      report(`review(${model})`, result.text.trim().length > 0,
        `${result.durationMs}ms — response but not JSON: "${result.text.trim().slice(0, 100)}"`);
    }
  } catch (err: any) {
    report(`review(${model})`, false, err.message?.slice(0, 200));
  }
}

// ── Test 6: Provider Health ──

async function testProviderHealth() {
  console.log('\n─── Test 6: Provider Health ───');
  try {
    const resp = await fetch(`${NEWAPI_BASE}/models`, {
      headers: { Authorization: `Bearer ${NEWAPI_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json() as any;
    const modelCount = data.data?.length || 0;
    report('newapi health', resp.ok, `${resp.status} — ${modelCount} models available`);
  } catch (err: any) {
    report('newapi health', false, err.message);
  }
}

// ── Main ──

async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║     Hive Smoke Test (via newapi)       ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`Gateway: ${NEWAPI_BASE}`);
  console.log(`Models: translate=${TEST_MODELS.translate}, worker=${TEST_MODELS.worker}, reviewer=${TEST_MODELS.reviewer}`);

  await testConfig();
  await testRegistry();
  await testProviderHealth();
  await testTranslate();
  await testWorker();
  await testCrossReview();

  console.log('\n════════════════════════════════════════');
  console.log(`Results: ${passed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.log(`Failed: ${failed.join(', ')}`);
  }
  console.log('════════════════════════════════════════');

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
