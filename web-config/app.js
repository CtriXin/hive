/**
 * Hive Config App — 模型配置中心前端逻辑
 */

// ═══════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════
const state = {
  step: 0,
  data: null,
  currentConfig: {},
  // Step 2: model selection
  enabledModels: new Set(),
  hiddenModels: new Set(),
  showHidden: true,
  // Step 3: channel config
  familyDefaultChannel: {},
  modelChannelOverride: {},
  // Step 4: stage assignment
  stageAssignment: {},
  // saved
  saved: false,
  theme: 'light',
};

const STEPS = [
  { id: 'welcome', label: '欢迎', desc: '开始配置 Hive' },
  { id: 'models', label: '选择模型', desc: '启用你的模型集群' },
  { id: 'channels', label: '配置通道', desc: '为模型分配 provider' },
  { id: 'stages', label: '环节分配', desc: '为每个环节指定模型' },
  { id: 'review', label: '确认保存', desc: '预览并写入配置' },
];

const STAGE_DEFS = [
  { key: 'translator', label: '翻译', desc: '将目标翻译为英文', icon: '🌐' },
  { key: 'planner', label: '规划', desc: '制定执行计划', icon: '📋' },
  { key: 'executor', label: '执行', desc: '按任务动态分配（此处配置 fallback）', icon: '⚡' },
  { key: 'discuss', label: '讨论', desc: '多模型讨论与共识', icon: '💬' },
  { key: 'cross_review', label: '交叉评审', desc: '互相审查代码与方案', icon: '🔍' },
  { key: 'arbitration', label: '仲裁评审', desc: '解决评审分歧', icon: '⚖️' },
  { key: 'final_review', label: '最终评审', desc: '最终质量把关', icon: '✅' },
];

// ═══════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

async function loadData() {
  const [data, configRes] = await Promise.all([
    api('/api/data'),
    api('/api/config').catch(() => ({ config: {} })),
  ]);
  state.data = data;
  state.currentConfig = configRes.config || {};
  initFromExistingConfig();
}

// ═══════════════════════════════════════════════
// Init from existing config
// ═══════════════════════════════════════════════
function initFromExistingConfig() {
  const cfg = state.currentConfig;
  const mmsModels = state.data?.mms?.models || [];
  const allModelIds = mmsModels.map((m) => m.id);
  const blacklist = new Set((cfg.model_blacklist || []).filter((pat) => !pat.includes('*') && allModelIds.includes(pat)));

  // Default: enable all models not in blacklist
  allModelIds.forEach((id) => {
    if (!blacklist.has(id)) state.enabledModels.add(id);
  });

  // Restore hidden models
  (cfg.model_hidden_list || []).forEach((id) => {
    if (allModelIds.includes(id)) state.hiddenModels.add(id);
  });

  // Channel overrides from model_channel_map
  const channelMap = cfg.model_channel_map || {};
  Object.entries(channelMap).forEach(([pattern, selector]) => {
    if (allModelIds.includes(pattern)) {
      state.modelChannelOverride[pattern] = selector;
    }
  });

  // Stage assignments from tiers
  const tiers = cfg.tiers || {};
  const mapStage = (key, val) => {
    if (val && val.model && val.model !== 'auto') state.stageAssignment[key] = val.model;
  };
  mapStage('translator', tiers.translator);
  mapStage('planner', tiers.planner);
  mapStage('executor', tiers.executor);
  mapStage('discuss', tiers.discuss);
  mapStage('cross_review', tiers.reviewer?.cross_review);
  mapStage('arbitration', tiers.reviewer?.arbitration);
  mapStage('final_review', tiers.reviewer?.final_review);
}

// ═══════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function showToast(msg, tone = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${tone}`;
  setTimeout(() => el.classList.remove('show'), 3000);
}

function getModelFamily(modelId) {
  const id = String(modelId).toLowerCase();
  if (id.includes('kimi') || /^k2\.|^k2-/.test(id)) return 'kimi';
  if (id.includes('qwen')) return 'qwen';
  if (id.includes('glm')) return 'glm';
  if (id.includes('minimax')) return 'minimax';
  if (id.includes('gpt-')) return 'openai';
  if (id.includes('gemini')) return 'gemini';
  if (id.includes('mimo')) return 'mimo';
  if (id.includes('claude')) return 'claude';
  return 'other';
}

function getFamilyDisplayName(family) {
  const map = {
    kimi: 'Kimi 家族', qwen: 'Qwen 家族', glm: 'GLM 家族',
    minimax: 'MiniMax 家族', openai: 'OpenAI 家族', gemini: 'Gemini 家族',
    mimo: 'Mimo 家族', claude: 'Claude 家族', other: '其他',
  };
  return map[family] || family;
}

function getProviders() {
  return state.data?.mms?.providers || [];
}

function getModels() {
  const mmsModels = state.data?.mms?.models || [];
  const capModels = state.data?.capabilities?.models || {};
  const profiles = state.data?.profiles?.profiles || {};

  return mmsModels.map((m) => {
    const cap = capModels[m.id];
    const prof = profiles[m.id];
    return {
      id: m.id,
      primary_provider: m.primary_provider,
      fallbacks: m.fallbacks || [],
      display_name: cap?.display_name || m.id,
      provider: cap?.provider || m.primary_provider,
      overall_rank: cap?.overall_rank,
      speed_tier: cap?.speed_tier,
      speed_rank: cap?.speed_rank,
      cost_per_1k: cap?.cost_per_1k,
      strengths: cap?.strengths || [],
      benchmark: cap?.benchmark || {},
      scores: cap?.scores || {},
      profile_scores: prof?.scores || {},
    };
  });
}

function getModelScores(modelId) {
  const models = getModels();
  const m = models.find((x) => x.id === modelId);
  return m?.profile_scores || {};
}

function groupByFamily(models) {
  const groups = {};
  for (const m of models) {
    const f = getModelFamily(m.id);
    if (!groups[f]) groups[f] = [];
    groups[f].push(m);
  }
  return groups;
}

function getFamilyDefaultChannel(family) {
  return state.familyDefaultChannel[family] || '';
}

function getModelChannel(modelId) {
  const models = getModels();
  const m = models.find((x) => x.id === modelId);
  const defaultCh = m?.primary_provider || '';
  return state.modelChannelOverride[modelId] || getFamilyDefaultChannel(getModelFamily(modelId)) || defaultCh;
}

function isModelReady(modelId) {
  if (!state.enabledModels.has(modelId)) return false;
  return !!getModelChannel(modelId);
}

// ═══════════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════════
function renderSteps() {
  const sidebar = document.getElementById('sidebarSteps');
  const mobile = document.getElementById('mobileSteps');
  sidebar.innerHTML = STEPS.map((s, i) => `
    <div class="step-item ${i === state.step ? 'active' : ''} ${i < state.step ? 'completed' : ''}" onclick="app.goTo(${i})">
      <div class="step-num">${i < state.step ? '✓' : i + 1}</div>
      <div>
        <div style="font-weight:700">${esc(s.label)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:1px">${esc(s.desc)}</div>
      </div>
    </div>
  `).join('');

  mobile.innerHTML = STEPS.map((s, i) => `
    <div class="mobile-step ${i === state.step ? 'active' : ''} ${i < state.step ? 'completed' : ''}" onclick="app.goTo(${i})">${esc(s.label)}</div>
  `).join('');
}

function updateNavButtons() {
  document.getElementById('prevBtn').style.display = state.step === 0 ? 'none' : 'inline-flex';
  const next = document.getElementById('nextBtn');
  if (state.step === STEPS.length - 1) {
    next.textContent = state.saved ? '完成' : '保存配置';
    next.onclick = state.saved ? () => {} : () => app.saveConfig();
  } else {
    next.textContent = '下一步';
    next.onclick = () => app.nextStep();
  }
}

function setPageTitle(title) {
  document.getElementById('pageTitle').textContent = title;
}

// ═══════════════════════════════════════════════
// Step Renderers
// ═══════════════════════════════════════════════
function renderContent() {
  renderSteps();
  updateNavButtons();
  const el = document.getElementById('content');
  const renderers = [renderWelcome, renderModelSelect, renderChannelConfig, renderStageAssign, renderReview];
  el.innerHTML = renderers[state.step]();
}

// ── Step 0: Welcome ──
function renderWelcome() {
  setPageTitle('欢迎');

  return `
    <div class="hero animate-in">
      <div class="hero-icon">🐝</div>
      <div class="hero-title">Hive 配置中心</div>
      <div class="hero-desc">
        在这里配置你的 Hive 模型集群。选择模型、分配通道、设定环节——<br>
        让 Hive 以最优的方式调度你的多模型军团。
      </div>
      <button class="btn btn-primary" style="height:44px;padding:0 28px;font-size:14px;" onclick="app.nextStep()">
        开始配置 →
      </button>
    </div>

    <div class="card animate-in animate-in-1 mt-4">
      <div class="card-title">配置流程</div>
      <div class="card-sub" style="margin-top:8px;">
        <div style="display:grid;gap:10px;margin-top:4px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="width:22px;height:22px;border-radius:50%;background:var(--accent-soft);color:var(--accent-hover);display:grid;place-items:center;font-size:11px;font-weight:700;flex-shrink:0;">1</span>
            <span><strong>选择模型</strong> — 从各大家族中挑选 Hive 要使用的模型</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="width:22px;height:22px;border-radius:50%;background:var(--accent-soft);color:var(--accent-hover);display:grid;place-items:center;font-size:11px;font-weight:700;flex-shrink:0;">2</span>
            <span><strong>配置通道</strong> — 为每个模型 family 设置默认 provider 通道，支持单模型覆盖</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="width:22px;height:22px;border-radius:50%;background:var(--accent-soft);color:var(--accent-hover);display:grid;place-items:center;font-size:11px;font-weight:700;flex-shrink:0;">3</span>
            <span><strong>环节分配</strong> — 根据 benchmark 数据为翻译、规划、执行等环节自动分配合适的模型</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="width:22px;height:22px;border-radius:50%;background:var(--accent-soft);color:var(--accent-hover);display:grid;place-items:center;font-size:11px;font-weight:700;flex-shrink:0;">4</span>
            <span><strong>确认保存</strong> — 预览完整配置并写入 ~/.hive/config.json</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── Step 1: Model Selection ──
function renderModelSelect() {
  setPageTitle('选择模型');
  const allModels = getModels();
  const groups = groupByFamily(allModels);
  const familyOrder = ['kimi', 'qwen', 'glm', 'minimax', 'openai', 'gemini', 'mimo', 'claude', 'other'];

  const visibleModels = state.showHidden ? allModels : allModels.filter((m) => !state.hiddenModels.has(m.id));
  const visibleGroups = groupByFamily(visibleModels);

  const enabledCount = state.enabledModels.size;
  const hiddenCount = state.hiddenModels.size;

  return `
    <div class="animate-in">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
        <div>
          <div style="font-size:18px;font-weight:800;">选择模型</div>
          <div class="text-secondary" style="font-size:13px;margin-top:2px;">
            已启用 <strong style="color:var(--text);">${enabledCount}</strong> 个模型
            ${hiddenCount > 0 ? `· 已隐藏 <strong style="color:var(--text-muted);">${hiddenCount}</strong> 个` : ''}
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <label class="switch">
            <input type="checkbox" ${state.showHidden ? 'checked' : ''} onchange="app.toggleShowHidden()">
            <span class="switch-track"></span>
            <span class="switch-label">显示已隐藏</span>
          </label>
          <button class="btn btn-sm" onclick="app.enableAllVisible()">全选可见</button>
          <button class="btn btn-sm btn-ghost" onclick="app.disableAllVisible()">取消全选</button>
        </div>
      </div>

      ${familyOrder.map((family) => {
        const models = visibleGroups[family];
        if (!models || models.length === 0) return '';
        const allFamModels = groups[family] || [];
        const famEnabled = allFamModels.filter((m) => state.enabledModels.has(m.id)).length;
        return `
          <div class="family-section">
            <div class="family-header">
              <div class="family-name">
                ${esc(getFamilyDisplayName(family))}
                <span class="family-badge">${famEnabled}/${allFamModels.length}</span>
              </div>
              <div style="display:flex;gap:6px;">
                <button class="btn btn-sm" onclick="app.setFamilyEnabled('${family}', true)">全选</button>
                <button class="btn btn-sm btn-ghost" onclick="app.setFamilyEnabled('${family}', false)">取消</button>
              </div>
            </div>
            <div class="model-grid">
              ${models.map((m) => renderModelCard(m)).join('')}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderModelCard(m) {
  const scores = getModelScores(m.id);
  const isActive = state.enabledModels.has(m.id);
  const isHidden = state.hiddenModels.has(m.id);
  const bench = m.benchmark || {};
  const combined = bench.combined;
  const rank = m.overall_rank;

  const chips = [];
  if (rank && rank <= 10) chips.push(`<span class="meta-chip accent">#${rank} 排名</span>`);
  if (combined) chips.push(`<span class="meta-chip">${combined} 分</span>`);
  if (m.speed_tier) chips.push(`<span class="meta-chip">${m.speed_tier}</span>`);
  if (m.cost_per_1k != null) chips.push(`<span class="meta-chip">$${m.cost_per_1k}/1K</span>`);
  const strengths = (m.strengths || []).slice(0, 2);
  if (strengths.length) chips.push(`<span class="meta-chip ok">${strengths.join(' · ')}</span>`);

  return `
    <div class="model-card ${isActive ? 'active' : ''} ${isHidden ? 'hidden-model' : ''}" onclick="app.toggleModel('${esc(m.id)}')">
      <div class="model-check"></div>
      <div class="model-card-head">
        <div style="min-width:0;">
          <div class="model-name">${esc(m.display_name || m.id)}</div>
          <div class="model-provider">${esc(m.provider || 'unknown')}</div>
        </div>
      </div>
      <div class="model-meta">${chips.join('')}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:8px;border-top:1px solid var(--border);">
        <label class="switch" style="flex:1;" onclick="event.stopPropagation()">
          <input type="checkbox" ${isActive ? 'checked' : ''} onchange="app.toggleModel('${esc(m.id)}')">
          <span class="switch-track"></span>
          <span class="switch-label">${isActive ? '已启用' : '已禁用'}</span>
        </label>
        ${isHidden ? `<button class="btn btn-sm btn-ok" style="height:28px;padding:0 8px;font-size:11px;" onclick="event.stopPropagation();app.unhideModel('${esc(m.id)}')">取消隐藏</button>` : `<button class="btn btn-sm btn-ghost" style="height:28px;padding:0 8px;font-size:11px;" onclick="event.stopPropagation();app.hideModel('${esc(m.id)}')">隐藏</button>`}
      </div>
    </div>
  `;
}

// ── Step 2: Channel Config ──
function renderChannelConfig() {
  setPageTitle('配置通道');
  const providers = getProviders();
  const enabled = getModels().filter((m) => state.enabledModels.has(m.id));
  const groups = groupByFamily(enabled);
  const familyOrder = ['kimi', 'qwen', 'glm', 'minimax', 'openai', 'gemini', 'mimo', 'claude', 'other'];

  const hiddenEnabled = getModels().filter((m) => state.hiddenModels.has(m.id) && state.enabledModels.has(m.id));

  return `
    <div class="animate-in">
      <div style="margin-bottom:16px;">
        <div style="font-size:18px;font-weight:800;">配置通道</div>
        <div class="text-secondary" style="font-size:13px;margin-top:2px;">
          每个模型已带有 MMS 默认通道。你可以为家族设置统一覆盖，或为特定模型单独指定不同通道。
        </div>
      </div>

      ${familyOrder.map((family) => {
        const models = groups[family];
        if (!models || models.length === 0) return '';
        const defaultCh = getFamilyDefaultChannel(family);
        return `
          <div class="family-section">
            <div class="family-header">
              <div class="family-name">${esc(getFamilyDisplayName(family))}</div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:12px;color:var(--text-muted);">家族默认:</span>
                <select class="select" style="width:180px;" onchange="app.setFamilyChannel('${family}', this.value)">
                  <option value="" ${!defaultCh ? 'selected' : ''}>未设置</option>
                  ${providers.map((p) => `<option value="${esc(p.id)}" ${p.id === defaultCh ? 'selected' : ''}>${esc(p.display_name || p.id)}</option>`).join('')}
                </select>
                ${defaultCh ? `<span class="meta-chip accent">${esc(providers.find(p=>p.id===defaultCh)?.display_name||defaultCh)}</span>` : ''}
              </div>
            </div>
            <div style="border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;">
              <table class="channel-table">
                <thead><tr><th>模型</th><th>MMS 默认</th><th>覆盖通道</th><th>状态</th></tr></thead>
                <tbody>
                  ${models.map((m) => {
                    const override = state.modelChannelOverride[m.id];
                    const familyOverride = getFamilyDefaultChannel(getModelFamily(m.id));
                    const effective = override || familyOverride || m.primary_provider;
                    const ready = !!effective;
                    return `
                      <tr>
                        <td>
                          <div style="font-weight:600;">${esc(m.display_name || m.id)}</div>
                          <div style="font-size:11px;color:var(--text-muted);">${esc(m.primary_provider)}</div>
                        </td>
                        <td>
                          <span class="meta-chip">${esc(m.primary_provider)}</span>
                        </td>
                        <td>
                          <select class="select" style="min-width:160px;" onchange="app.setModelChannel('${esc(m.id)}', this.value)">
                            <option value="" ${!override ? 'selected' : ''}>${familyOverride ? `使用家族默认 (${esc(familyOverride)})` : '使用 MMS 默认'}</option>
                            ${providers.map((p) => `<option value="${esc(p.id)}" ${p.id === override ? 'selected' : ''}>${esc(p.display_name || p.id)}</option>`).join('')}
                          </select>
                          ${override ? `<div style="font-size:11px;color:var(--accent-hover);margin-top:4px;">已覆盖: ${esc(override)}</div>` : ''}
                          ${familyOverride && !override ? `<div style="font-size:11px;color:var(--warn);margin-top:4px;">家族覆盖: ${esc(familyOverride)}</div>` : ''}
                        </td>
                        <td>
                          ${ready
                            ? `<span class="meta-chip ok">就绪</span>`
                            : `<span class="meta-chip" style="border-color:rgba(239,68,68,0.3);background:var(--danger-soft);color:var(--danger);">待配置</span>`
                          }
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>
        `;
      }).join('')}

      ${hiddenEnabled.length > 0 ? `
        <div class="unlock-section">
          <div class="unlock-section-title">🔒 已启用但隐藏的模型</div>
          <div class="text-secondary" style="font-size:12px;margin-bottom:10px;">这些模型已启用但被隐藏，需要配置通道才能进入正常轮替。</div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            ${hiddenEnabled.map((m) => {
              return `
                <div style="display:flex;align-items:center;gap:10px;justify-content:space-between;background:var(--surface);padding:10px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);">
                  <div>
                    <div style="font-weight:600;font-size:13px;">${esc(m.display_name || m.id)}</div>
                    <div style="font-size:11px;color:var(--text-muted);">默认: ${esc(m.primary_provider)}</div>
                  </div>
                  <div style="display:flex;align-items:center;gap:10px;">
                    <select class="select" style="width:160px;height:32px;" onchange="app.setModelChannel('${esc(m.id)}', this.value)">
                      <option value="" ${!state.modelChannelOverride[m.id] ? 'selected' : ''}>${getFamilyDefaultChannel(getModelFamily(m.id)) ? `使用家族默认 (${esc(getFamilyDefaultChannel(getModelFamily(m.id)))})` : '使用 MMS 默认'}</option>
                      ${providers.map((p) => `<option value="${esc(p.id)}" ${p.id === state.modelChannelOverride[m.id] ? 'selected' : ''}>${esc(p.display_name || p.id)}</option>`).join('')}
                    </select>
                    <button class="btn btn-sm btn-ok" style="height:32px;" onclick="app.unhideModel('${esc(m.id)}')">解锁显示</button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

// ── Step 3: Stage Assignment ──
function renderStageAssign() {
  setPageTitle('环节分配');
  const readyModels = getModels().filter((m) => isModelReady(m.id));
  const makeModelOptions = (stageKey) => readyModels.map((m) => {
    const selected = state.stageAssignment[stageKey] === m.id ? 'selected' : '';
    return `<option value="${esc(m.id)}" ${selected}>${esc(m.display_name || m.id)}</option>`;
  }).join('');

  return `
    <div class="animate-in">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
        <div>
          <div style="font-size:18px;font-weight:800;">环节分配</div>
          <div class="text-secondary" style="font-size:13px;margin-top:2px;">
            为 Hive 的每个工作环节指定模型。已就绪模型: <strong style="color:var(--text);">${readyModels.length}</strong> 个
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-primary btn-sm" onclick="app.autoAssignStages()">🎯 智能分配</button>
          <button class="btn btn-sm btn-ghost" onclick="app.clearStageAssignments()">清空</button>
        </div>
      </div>

      <div class="stage-grid">
        ${STAGE_DEFS.map((stage, i) => {
          const assigned = state.stageAssignment[stage.key];
          const model = assigned ? readyModels.find((m) => m.id === assigned) : null;
          return `
            <div class="card stage-card animate-in" style="animation-delay:${i * 0.04}s">
              <div class="stage-info">
                <div class="stage-label">${stage.icon} ${esc(stage.label)}</div>
                <div class="stage-desc">${esc(stage.desc)}</div>
                ${model ? renderModelMini(model) : '<div style="font-size:12px;color:var(--text-muted);margin-top:6px;">未分配（将使用 auto）</div>'}
              </div>
              <div>
                <select class="select" onchange="app.assignStage('${stage.key}', this.value)">
                  <option value="" ${!state.stageAssignment[stage.key] ? 'selected' : ''}>auto（自动选择）</option>
                  ${makeModelOptions(stage.key)}
                </select>
                ${model ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${renderStrengthChips(model)}</div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <div class="card mt-4">
        <div class="card-title">分配策略说明</div>
        <div class="card-sub" style="margin-top:8px;">
          <strong>🎯 智能分配</strong> 会根据 benchmark 数据为每个环节选择得分最高且互不重复的模型。<br>
          如果某个环节没有专门 benchmark，则优先选择综合能力强的模型，并确保各环节尽量不重复。<br>
          你也可以手动调整每个环节的下拉框。
        </div>
      </div>
    </div>
  `;
}

function renderModelMini(m) {
  const rank = m.overall_rank ? `#${m.overall_rank}` : '';
  return `
    <div class="stage-current mt-2">
      <span class="stage-model-tag">${esc(m.display_name || m.id)} ${rank}</span>
      <span style="font-size:11px;color:var(--text-muted);">${esc(m.provider || '')}</span>
    </div>
  `;
}

function renderStrengthChips(m) {
  const s = m.strengths || [];
  return s.slice(0, 3).map((tag) => `<span class="meta-chip accent">${esc(tag)}</span>`).join('');
}

// ── Step 4: Review & Save ──
function renderReview() {
  setPageTitle('确认保存');
  const readyModels = getModels().filter((m) => isModelReady(m.id));
  const config = buildConfigOutput();

  const stageSummary = STAGE_DEFS.map((s) => {
    const assigned = state.stageAssignment[s.key];
    const m = assigned ? readyModels.find((x) => x.id === assigned) : null;
    return `
      <div class="summary-item">
        <div class="summary-key">${esc(s.label)}</div>
        <div class="summary-value">${m ? esc(m.display_name || m.id) : '<span style="color:var(--text-muted);font-weight:500;">auto</span>'}</div>
      </div>
    `;
  }).join('');

  const channelSummary = Object.entries(groupByFamily(readyModels))
    .map(([family, models]) => {
      const defaultCh = getFamilyDefaultChannel(family);
      return `
        <div class="summary-item">
          <div class="summary-key">${esc(getFamilyDisplayName(family))}</div>
          <div class="summary-value" style="font-size:12px;">
            ${models.map((m) => {
              const ch = getModelChannel(m.id);
              const p = getProviders().find((pr) => pr.id === ch);
              return `<div style="margin:2px 0;">${esc(m.display_name || m.id)} → ${esc(p?.display_name || ch || '—')}</div>`;
            }).join('')}
          </div>
        </div>
      `;
    }).join('');

  return `
    <div class="animate-in">
      <div style="font-size:18px;font-weight:800;margin-bottom:16px;">确认配置</div>

      <div class="summary-grid mb-4">
        <div class="summary-item">
          <div class="summary-key">已启用模型</div>
          <div class="summary-value">${readyModels.length} 个</div>
        </div>
        <div class="summary-item">
          <div class="summary-key">已隐藏模型</div>
          <div class="summary-value">${state.hiddenModels.size} 个</div>
        </div>
        <div class="summary-item">
          <div class="summary-key">已分配环节</div>
          <div class="summary-value">${Object.keys(state.stageAssignment).length} / ${STAGE_DEFS.length}</div>
        </div>
      </div>

      <div class="card mb-4">
        <div class="card-title">环节分配摘要</div>
        <div class="summary-grid mt-3">${stageSummary}</div>
      </div>

      <div class="card mb-4">
        <div class="card-title">通道配置摘要</div>
        <div class="summary-grid mt-3">${channelSummary}</div>
      </div>

      <details class="collapsible mb-4">
        <summary>查看原始 JSON 配置</summary>
        <div class="collapsible-body">
          <pre style="font-size:11px;line-height:1.6;overflow:auto;max-height:400px;">${esc(JSON.stringify(config, null, 2))}</pre>
        </div>
      </details>

      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn btn-primary" style="height:44px;padding:0 28px;" onclick="app.saveConfig()" ${state.saved ? 'disabled' : ''}>
          ${state.saved ? '✓ 已保存' : '💾 保存到 ~/.hive/config.json'}
        </button>
        <button class="btn btn-ghost" onclick="app.downloadConfig()">下载 JSON</button>
      </div>

      ${state.saved ? `
        <div class="card mt-4" style="border-color:rgba(34,197,94,0.3);background:rgba(34,197,94,0.06);">
          <div class="card-title" style="color:var(--ok);">配置已保存</div>
          <div class="card-sub">文件已写入 ~/.hive/config.json。你可以关闭此页面，Hive 会在下次运行时读取新配置。</div>
        </div>
      ` : ''}
    </div>
  `;
}

// ═══════════════════════════════════════════════
// Config Builder
// ═══════════════════════════════════════════════
function buildConfigOutput() {
  const cfg = { ...state.currentConfig };
  const models = getModels();

  // tiers
  cfg.tiers = {
    translator: { model: state.stageAssignment.translator || 'auto', fallback: cfg.tiers?.translator?.fallback || '' },
    planner: { model: state.stageAssignment.planner || 'auto', fallback: cfg.tiers?.planner?.fallback || '' },
    executor: { model: state.stageAssignment.executor || 'auto', fallback: cfg.tiers?.executor?.fallback || '' },
    discuss: { model: state.stageAssignment.discuss || 'auto', fallback: cfg.tiers?.discuss?.fallback || '' },
    reviewer: {
      cross_review: { model: state.stageAssignment.cross_review || 'auto', fallback: cfg.tiers?.reviewer?.cross_review?.fallback || '' },
      arbitration: { model: state.stageAssignment.arbitration || 'auto', fallback: cfg.tiers?.reviewer?.arbitration?.fallback || '' },
      final_review: { model: state.stageAssignment.final_review || 'auto', fallback: cfg.tiers?.reviewer?.final_review?.fallback || '' },
    },
    reporter: { model: 'auto', fallback: '' },
  };

  // model_channel_map: explicit overrides + family defaults (when different from MMS primary)
  const channelMap = {};
  models.forEach((m) => {
    const family = getModelFamily(m.id);
    const override = state.modelChannelOverride[m.id];
    const familyDefault = state.familyDefaultChannel[family];
    if (override && override !== m.primary_provider) {
      channelMap[m.id] = override;
    } else if (familyDefault && familyDefault !== m.primary_provider) {
      channelMap[m.id] = familyDefault;
    }
  });
  cfg.model_channel_map = channelMap;

  // model_blacklist
  const blacklist = [];
  models.forEach((m) => {
    if (!state.enabledModels.has(m.id)) blacklist.push(m.id);
  });
  cfg.model_blacklist = [...new Set([...(cfg.model_blacklist || []).filter((p) => p.includes('*')), ...blacklist])];

  // model_hidden_list
  const allIds = models.map((m) => m.id);
  cfg.model_hidden_list = Array.from(state.hiddenModels).filter((id) => allIds.includes(id));

  return cfg;
}

// ═══════════════════════════════════════════════
// Benchmark Auto Assignment
// ═══════════════════════════════════════════════
function autoAssignStages() {
  const readyModels = getModels().filter((m) => isModelReady(m.id));
  if (readyModels.length === 0) {
    showToast('没有就绪的模型，请先配置通道', 'danger');
    return;
  }

  const stagePrefs = {
    translator: ['translation', 'general'],
    planner: ['planning', 'reasoning', 'architecture'],
    executor: ['coding', 'implementation', 'speed'],
    discuss: ['reasoning', 'analysis', 'general'],
    cross_review: ['review', 'coding', 'analysis'],
    arbitration: ['review', 'reasoning', 'complex reasoning'],
    final_review: ['review', 'code quality', 'planning'],
  };

  const used = new Set();
  const result = {};

  // Sort stages by importance and assign best fit first
  const stageKeys = Object.keys(stagePrefs);

  for (const key of stageKeys) {
    const prefs = stagePrefs[key];
    let best = null;
    let bestScore = -Infinity;

    for (const m of readyModels) {
      if (used.has(m.id)) continue;
      const scores = getModelScores(m.id);
      const strengths = m.strengths || [];
      let score = 0;

      // Benchmark profile scores
      if (scores.implementation?.value) score += scores.implementation.value * 10;
      if (scores.review?.value) score += scores.review.value * 10;
      if (scores.integration?.value) score += scores.integration.value * 8;
      if (scores.spec_adherence?.value) score += scores.spec_adherence.value * 8;
      if (scores.turnaround_speed?.value) score += scores.turnaround_speed.value * 5;

      // Capability scores
      const caps = m.scores || {};
      if (key === 'translator' && caps.translation) score += caps.translation * 15;
      if (key === 'planner' && caps.planning) score += caps.planning * 15;
      if (key === 'executor' && caps.coding) score += caps.coding * 15;
      if (key === 'discuss' && caps.reasoning) score += caps.reasoning * 10;
      if ((key === 'cross_review' || key === 'arbitration' || key === 'final_review') && caps.review) score += caps.review * 15;
      if (caps.general) score += caps.general * 5;

      // Strength match
      for (const pref of prefs) {
        if (strengths.some((s) => s.toLowerCase().includes(pref.toLowerCase()))) score += 8;
      }

      // Overall rank bonus (prefer higher ranked)
      if (m.overall_rank && m.overall_rank <= 5) score += (6 - m.overall_rank) * 2;

      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }

    if (best) {
      result[key] = best.id;
      used.add(best.id);
    }
  }

  // Fill remaining with any ready model
  for (const key of stageKeys) {
    if (!result[key]) {
      const remaining = readyModels.find((m) => !used.has(m.id));
      if (remaining) {
        result[key] = remaining.id;
        used.add(remaining.id);
      }
    }
  }

  state.stageAssignment = result;
  showToast('已根据 benchmark 数据智能分配模型');
  renderContent();
}

// ═══════════════════════════════════════════════
// Actions
// ═══════════════════════════════════════════════
const app = {
  goTo(step) {
    if (step < 0 || step >= STEPS.length) return;
    state.step = step;
    renderContent();
  },
  nextStep() {
    if (state.step < STEPS.length - 1) app.goTo(state.step + 1);
  },
  prevStep() {
    if (state.step > 0) app.goTo(state.step - 1);
  },
  toggleTheme() {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    applyTheme();
    try { localStorage.setItem('hive-config-theme', state.theme); } catch {}
  },
  toggleModel(id) {
    if (state.enabledModels.has(id)) {
      state.enabledModels.delete(id);
    } else {
      state.enabledModels.add(id);
    }
    renderContent();
  },
  hideModel(id) {
    state.hiddenModels.add(id);
    renderContent();
  },
  unhideModel(id) {
    state.hiddenModels.delete(id);
    state.enabledModels.add(id);
    renderContent();
  },
  toggleShowHidden() {
    state.showHidden = !state.showHidden;
    renderContent();
  },
  setFamilyEnabled(family, enabled) {
    const allModels = getModels();
    const visible = state.showHidden ? allModels : allModels.filter((m) => !state.hiddenModels.has(m.id));
    visible.filter((m) => getModelFamily(m.id) === family).forEach((m) => {
      if (enabled) state.enabledModels.add(m.id);
      else state.enabledModels.delete(m.id);
    });
    renderContent();
  },
  enableAllVisible() {
    const allModels = getModels();
    const visible = state.showHidden ? allModels : allModels.filter((m) => !state.hiddenModels.has(m.id));
    visible.forEach((m) => state.enabledModels.add(m.id));
    renderContent();
  },
  disableAllVisible() {
    const allModels = getModels();
    const visible = state.showHidden ? allModels : allModels.filter((m) => !state.hiddenModels.has(m.id));
    visible.forEach((m) => state.enabledModels.delete(m.id));
    renderContent();
  },
  setFamilyChannel(family, value) {
    state.familyDefaultChannel[family] = value;
    renderContent();
  },
  setModelChannel(id, value) {
    if (value) state.modelChannelOverride[id] = value;
    else delete state.modelChannelOverride[id];
    renderContent();
  },
  assignStage(key, value) {
    if (value) state.stageAssignment[key] = value;
    else delete state.stageAssignment[key];
    renderContent();
  },
  autoAssignStages() {
    autoAssignStages();
  },
  clearStageAssignments() {
    state.stageAssignment = {};
    renderContent();
  },
  async saveConfig() {
    const config = buildConfigOutput();
    try {
      await api('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      state.saved = true;
      showToast('配置已保存到 ~/.hive/config.json');
      renderContent();
    } catch (err) {
      showToast('保存失败: ' + (err.message || String(err)), 'danger');
    }
  },
  downloadConfig() {
    const config = buildConfigOutput();
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hive-config.json';
    a.click();
    URL.revokeObjectURL(url);
  },
};

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = state.theme === 'dark' ? '☀️' : '🌙';
}

function initTheme() {
  try {
    const saved = localStorage.getItem('hive-config-theme');
    if (saved === 'dark' || saved === 'light') {
      state.theme = saved;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      state.theme = 'dark';
    }
  } catch {}
  applyTheme();
}

// ═══════════════════════════════════════════════
// Boot
// ═══════════════════════════════════════════════
initTheme();
loadData().then(() => {
  renderContent();
}).catch((err) => {
  document.getElementById('content').innerHTML = `
    <div style="padding:60px 20px;text-align:center;">
      <div style="font-size:18px;font-weight:700;color:var(--danger);margin-bottom:8px;">加载失败</div>
      <div style="color:var(--text-secondary);">${esc(err.message || String(err))}</div>
      <button class="btn btn-primary mt-4" onclick="location.reload()">重试</button>
    </div>
  `;
});
