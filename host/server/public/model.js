import { t, html } from './i18n.js';
import { $, node } from './ui.js';
import { icon } from './icons.js';
import { createRoutingLog } from './routing-log.js';

const tiers = [['routine', '一般任务'], ['reasoning', '中等任务'], ['expert', '困难任务']];
const levels = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const levelLabels = { default: '模型默认', auto: 'Jev 决定', none: '无', low: '轻度', medium: '中度', high: '高度', xhigh: '超高', max: '最高' };
const choices = (select, values, chosen) => {
  select.replaceChildren(...values.map(([value, label]) => new Option(t(label), value)));
  select.value = values.some(([value]) => value === chosen) ? chosen : values[0]?.[0] ?? '';
};
const row = (title, hint, control) => `<label class="row"><span class="row-copy"><span class="row-title">${title}</span>${hint ? `<span class="row-hint">${hint}</span>` : ''}</span>${control}</label>`;

function parseTokenCount(text) {
  if (!text.trim()) return 0;
  const match = text.trim().match(/^(\d+(?:\.\d*)?|\.\d+)\s*([km]?)$/i);
  if (!match) return NaN;
  const precision = { '': 0, k: 3, m: 6 }[match[2].toLowerCase()];
  const [whole, decimals = ''] = match[1].split('.');
  const fraction = decimals.replace(/0+$/, '');
  if (fraction.length > precision) return NaN;
  const value = Number((whole || '0') + fraction.padEnd(precision, '0'));
  return Number.isSafeInteger(value) && value <= 100_000_000 ? value : NaN;
}

function formatTokenCount(value) {
  if (!value) return '';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(6).replace(/\.?0+$/, '')}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(3).replace(/\.?0+$/, '')}K`;
  return String(value);
}

export function createModelPage({ api, toast, busy, refresh }) {
  const panel = $('[data-panel=model]');
  panel.innerHTML = html(`<header class="page-header"><h1>对话模型</h1></header>
    <form id="model-form" class="sections">
      <section class="section"><div class="section-head"><h2 class="section-title">服务</h2></div><div class="card">
        ${row('Base URL', '兼容 OpenAI 的接口地址', '<input name="baseUrl" type="url" required spellcheck="false" placeholder="https://api.example.com/v1" data-private />')}
        ${row('API Key', '', '<input name="apiKey" type="password" autocomplete="new-password" data-private />')}
        <div class="row"><span class="row-copy"><span class="row-title">模型列表</span><span class="row-hint">从服务读取可用模型</span></span><button type="button" id="refresh-models" class="btn">获取模型</button></div>
      </div></section>
      <section class="section"><div class="section-head"><h2 class="section-title">默认</h2></div><div class="card">
        ${row('默认模型', '', '<select name="model" required></select>')}
        <label id="manual-effort-row" class="row"><span class="row-copy"><span class="row-title">思考强度</span></span><select name="effort"></select></label>
      </div></section>
      <section class="section"><div class="section-head"><h2 class="section-title">智能路由</h2></div><div class="card">
        ${row('Jev 分类器', '按任务难度选择模型和思考强度', '<input id="adaptive-mode" type="checkbox" role="switch" />')}
        <div id="adaptive-settings" hidden>
          ${row('Jev API Key', '', '<input name="jevApiKey" type="password" autocomplete="new-password" data-private />')}
          ${row('分类器模型', '', '<input name="classifierModel" value="jev-latest" required />')}
          <div id="model-routes"></div>
          <details class="disclosure"><summary>测试路由</summary>
            <div class="row"><input id="routing-task" class="grow" aria-label="任务" placeholder="输入一条任务" /><button type="button" id="test-routing" class="btn">测试分类</button></div>
            <p id="routing-result" role="status" class="hint"></p>
          </details>
        </div>
      </div></section>
      <section class="section"><div class="section-head"><h2 class="section-title">模型能力</h2></div><div class="card">
        <details class="disclosure"><summary>思考强度与上下文</summary>
          <div id="model-capabilities"></div>
          <div class="row"><input id="custom-model" class="grow" aria-label="模型 ID" placeholder="模型 ID" /><button id="add-model" type="button" class="btn">添加模型</button></div>
          <p class="hint">支持 1M、400K。留空或 0：容量未知，摘要阈值沿用原策略。</p>
        </details>
      </div></section>
      <p id="model-error" class="error" role="alert" hidden></p>
      <div class="actions"><span id="model-apply-title" class="status-text" role="status"></span><button type="button" id="test-model" class="btn">测试连接</button><button type="submit" class="btn btn-primary">保存</button></div>
    </form>
    <section id="routing-section" class="section" hidden>
      <div class="section-head"><h2 class="section-title">分类记录</h2><div class="section-actions"><button id="refresh-routing" class="icon-btn" type="button" aria-label="刷新">${icon('refresh')}</button></div></div>
      <div id="routing-log" class="card"></div>
    </section>`);
  const form = $('#model-form'), routingLog = createRoutingLog({ api });
  let models = [], policy, loaded = false, active = false;

  function efforts(select, model, selected, auto = false) {
    choices(select, [[auto ? 'auto' : 'default', auto ? 'Jev 决定' : '模型默认'],
      ...(models.find(item => item.id === model)?.efforts ?? []).map(value => [value, levelLabels[value]])], selected);
  }
  function mode() {
    const adaptive = $('#adaptive-mode').checked;
    $('#manual-effort-row').hidden = adaptive;
    $('#adaptive-settings').hidden = !adaptive;
    $('#routing-section').hidden = !adaptive;
  }
  function renderRoutes() {
    const root = $('#model-routes'); root.replaceChildren();
    for (const [tier, label] of tiers) {
      const line = node('div', 'row'), copy = node('span', 'row-copy'), control = node('span', 'row-control wide');
      copy.append(node('span', 'row-title', t(label)));
      const model = document.createElement('select'), effort = document.createElement('select');
      model.dataset.routeModel = tier; effort.dataset.routeEffort = tier;
      model.setAttribute('aria-label', `${t(label)} · ${t('模型')}`);
      effort.setAttribute('aria-label', `${t(label)} · ${t('思考强度')}`);
      choices(model, models.map(item => [item.id, item.id]), policy.routes[tier]?.model);
      efforts(effort, model.value, policy.routes[tier]?.effort ?? 'auto', true);
      model.addEventListener('change', () => efforts(effort, model.value, 'auto', true));
      control.append(model, effort); line.append(copy, control); root.append(line);
    }
  }
  const captureRoutes = () => Object.fromEntries(tiers.map(([tier]) => [tier, {
    model: $(`[data-route-model="${tier}"]`).value, effort: $(`[data-route-effort="${tier}"]`).value }]));
  function renderCapabilities() {
    const root = $('#model-capabilities'); root.replaceChildren();
    for (const entry of models) {
      const line = node('div', 'row stack capability'), chips = node('div', 'chips');
      line.append(node('span', 'row-title mono', entry.id));
      for (const level of levels) {
        const chip = node('label', 'chip'), check = document.createElement('input');
        check.type = 'checkbox'; check.checked = entry.efforts.includes(level);
        check.setAttribute('aria-label', `${entry.id} · ${t(levelLabels[level])}`);
        check.addEventListener('change', () => {
          policy.routes = captureRoutes();
          entry.efforts = levels.filter(value => value === level ? check.checked : entry.efforts.includes(value));
          efforts(form.elements.effort, form.elements.model.value, form.elements.effort.value);
          renderRoutes();
        });
        chip.append(check, node('span', '', t(levelLabels[level]))); chips.append(chip);
      }
      const numbers = node('div', 'field-grid'), fields = {};
      const validate = () => {
        const values = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, parseTokenCount(input.value)]));
        for (const [key, input] of Object.entries(fields)) {
          input.setCustomValidity(Number.isNaN(values[key]) ? t('请输入 0–100M 的整数 Token 数，如 1M、400K。') : '');
          if (Number.isFinite(values[key])) entry[key] = values[key];
        }
        const { contextWindowTokens: capacity, summaryThresholdTokens: threshold } = values;
        if (Number.isFinite(capacity) && Number.isFinite(threshold) && threshold && threshold >= capacity)
          fields.summaryThresholdTokens.setCustomValidity(t('摘要阈值必须小于上下文容量。'));
      };
      for (const [key, title] of [['contextWindowTokens', '上下文容量'], ['summaryThresholdTokens', '摘要阈值']]) {
        const label = node('label', 'field', t(title)), input = document.createElement('input');
        input.type = 'text'; input.spellcheck = false; input.autocomplete = 'off';
        input.placeholder = t(key === 'contextWindowTokens' ? '未知' : '原策略');
        input.value = formatTokenCount(entry[key]); input.setAttribute('aria-label', `${entry.id} · ${t(title)}`);
        fields[key] = input;
        input.addEventListener('input', validate);
        input.addEventListener('blur', () => {
          const value = parseTokenCount(input.value);
          if (Number.isFinite(value)) input.value = formatTokenCount(value);
        });
        label.append(input); numbers.append(label);
      }
      validate();
      line.append(chips, numbers); root.append(line);
    }
  }
  function render(config) {
    policy = structuredClone(config.policy); models = policy.models;
    form.elements.baseUrl.value = config.baseUrl;
    const primary = models.find(entry => entry.id === config.model);
    if (primary && primary.contextWindowTokens === undefined) primary.contextWindowTokens = config.contextWindowTokens ?? 0;
    choices(form.elements.model, models.map(item => [item.id, item.id]), config.model);
    efforts(form.elements.effort, config.model, policy.effort);
    $('#adaptive-mode').checked = policy.mode === 'adaptive';
    form.elements.classifierModel.value = policy.classifierModel;
    form.elements.jevApiKey.placeholder = config.hasJevApiKey ? t('已保存，留空保留') : 'Jev API Key';
    renderRoutes(); renderCapabilities(); mode();
  }
  function input() {
    if (!form.reportValidity()) throw new Error(t('请检查上下文设置。'));
    const data = Object.fromEntries(new FormData(form));
    return { baseUrl: data.baseUrl, apiKey: data.apiKey, model: data.model,
      contextWindowTokens: models.find(entry => entry.id === data.model)?.contextWindowTokens ?? 0, jevApiKey: data.jevApiKey,
      policy: { mode: $('#adaptive-mode').checked ? 'adaptive' : 'manual', effort: data.effort,
        classifierModel: data.classifierModel, models, routes: captureRoutes() } };
  }
  function applyText(config) {
    if (!config.configured) return t('保存后启动 Host');
    return t({ applied: '配置已应用', waiting: '任务结束后应用', pending: '任务结束后应用', error: '配置应用失败，请检查 Host 日志' }[config.reload.status] ?? '配置已保存');
  }
  function status(state, isActive) {
    active = isActive;
    if (!loaded) { render(state.model); loaded = true; }
    form.elements.apiKey.placeholder = state.model.hasApiKey ? t('已保存，留空保留') : t('输入模型服务的 API Key');
    $('#model-apply-title').textContent = applyText(state.model);
    if (active && $('#adaptive-mode').checked) routingLog.load();
  }
  const showError = error => { $('#model-error').textContent = error.message; $('#model-error').hidden = false; };

  form.elements.model.addEventListener('change', () => efforts(form.elements.effort, form.elements.model.value, 'default'));
  $('#adaptive-mode').addEventListener('change', () => { mode(); if ($('#adaptive-mode').checked) routingLog.load(); });
  $('#refresh-models').addEventListener('click', () => busy($('#refresh-models'), async () => {
    try {
      const result = await api('/admin/api/model/catalog', { method: 'POST', body: input() });
      policy.routes = captureRoutes();
      models = result.models.map(item => models.find(old => old.id === item.id) ?? { id: item.id, efforts: item.efforts });
      const current = form.elements.model.value;
      choices(form.elements.model, models.map(item => [item.id, item.id]), current);
      efforts(form.elements.effort, form.elements.model.value, form.elements.effort.value);
      renderRoutes(); renderCapabilities(); toast(t('模型列表已更新'));
    } catch (error) { toast(error.message, true); }
  }));
  $('#add-model').addEventListener('click', () => {
    if (!form.reportValidity()) return;
    const field = $('#custom-model'), id = field.value.trim();
    if (!id || models.some(item => item.id === id)) return;
    policy.routes = captureRoutes(); models.push({ id, efforts: [] }); field.value = '';
    choices(form.elements.model, models.map(item => [item.id, item.id]), form.elements.model.value);
    renderRoutes(); renderCapabilities();
  });
  $('#test-routing').addEventListener('click', () => busy($('#test-routing'), async () => {
    const task = $('#routing-task').value.trim(); if (!task) return;
    try {
      const result = await api('/admin/api/model/classify', { method: 'POST', body: { ...input(), task } });
      $('#routing-result').textContent = `${result.model} · ${t(levelLabels[result.effort] ?? result.effort)}${result.fallback ? ` · ${t('分类器暂不可用，使用中等任务规则')}` : ''}`;
      routingLog.load();
    } catch (error) { toast(error.message, true); }
  }));
  $('#refresh-routing').addEventListener('click', () => routingLog.load());
  form.addEventListener('submit', event => {
    event.preventDefault();
    $('#model-error').hidden = true;
    busy(form.querySelector('[type=submit]'), async () => {
      try {
        await api('/admin/api/model', { method: 'PUT', body: input() });
        form.elements.apiKey.value = ''; form.elements.jevApiKey.value = '';
        toast(t('配置已保存'));
        await refresh();
      } catch (error) { showError(error); }
    });
  });
  $('#test-model').addEventListener('click', () => {
    if (!form.reportValidity()) return;
    busy($('#test-model'), async () => {
      $('#model-error').hidden = true;
      try { toast((await api('/admin/api/model/test', { method: 'POST', body: input() })).message); }
      catch (error) { showError(error); }
    });
  });
  return {
    status,
    async load() { if ($('#adaptive-mode').checked) await routingLog.load(); },
    reset() { loaded = false; form.reset(); },
  };
}
