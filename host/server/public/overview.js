import { t, html, locale } from './i18n.js';
import { $, node, status } from './ui.js';
import { icon } from './icons.js';
import { groups } from './navigation.js';
import { blink, createGaze } from './face.js';
import { createCrew } from './crew.js';

// Each summary reads its page's endpoint and returns [text, on] for the overview row.
const enabled = value => [value ? t('{0} 项已启用', value) : t('未配置'), value > 0];
const count = (value, template) => [value ? t(template, value) : t('无'), value > 0];
const summaries = {
  model: [null, (_, state) => [state.model.model || t('尚未配置'), state.model.configured]],
  speech: [['/admin/api/speech', '/admin/api/voice'], ([speech, voice]) =>
    [`${t('识别')} ${t(speech.enabled ? '已启用' : '已停用')}，${t('通话')} ${t(voice.enabled ? '已启用' : '已停用')}`, speech.enabled || voice.enabled]],
  media: [['/admin/api/media'], ([media]) => enabled(Object.values(media.defaults).filter(Boolean).length)],
  'web-services': [['/admin/api/web-services'], ([web]) => enabled(['search', 'fetch'].filter(kind => web.defaults[kind]).length)],
  harness: [['/admin/api/harness'], ([harness]) => {
    const on = Object.values(harness).filter(Boolean).length;
    return [t('{0}/{1} 已开启', on, Object.keys(harness).length), on > 0];
  }],
  skills: [['/admin/api/skills'], ([items]) => count(items.filter(item => item.enabled).length, '{0} 个')],
  apps: [['/admin/api/apps'], ([value]) => count(value.apps.length, '{0} 个')],
  devices: [null, (_, state) => count(state.devices.filter(device => !device.revokedAt).length, '{0} 台')],
  network: [['/admin/api/network'], ([network]) => [network.enabled
    ? t({ ready: '已就绪', connecting: '正在连接', reconnecting: '正在重新连接' }[network.state] ?? network.state) : t('未启用'), network.state === 'ready']],
  execution: [['/admin/api/execution'], ([computer]) => [computer.enabled ? computer.name : t('未启用'), computer.enabled]],
  federation: [['/admin/api/federation'], ([value]) => count(value.peers.filter(peer => peer.enabled).length, '{0} 个 Host')],
  webhooks: [['/admin/api/webhooks'], ([items]) => count(items.filter(item => item.enabled).length, '{0} 个')],
  sharing: [['/admin/api/sharing'], ([items]) => count(items.length, '{0} 个')],
};

// The headline is set as two lines of display type.
function headline(state, bots) {
  const running = bots.filter(bot => bot.isRunning).length;
  if (!state.model.configured) return [t('配置对话模型'), t('后启动 Host')];
  if (!state.host.connected) return [t('等待 Host'), t('启动')];
  if (running) return [t('{0} 个 Bot', running), t('正在工作')];
  return bots.length ? [t('Host 就绪'), t('{0} 个 Bot 待命', bots.length)] : [t('Host 就绪'), ''];
}

export function createOverview({ api, status: current }) {
  const panel = $('[data-panel=overview]');
  panel.innerHTML = html(`<section class="hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <h1 id="hero-title" class="hero-title"></h1>
        <p id="hero-usage" class="hero-usage"></p>
      </div>
      <div id="hero-host" class="hero-host"></div>
      <div id="bot-crew" class="crew"></div>
    </section>
    <section id="attention" class="section" hidden><div class="section-head"><h2 class="section-title">待处理</h2></div><div id="attention-list" class="card"></div></section>
    <div id="overview-groups" class="overview-grid"></div>`);
  const values = new Map(), crew = createCrew($('#bot-crew'), $('#hero-host'));
  for (const group of groups.filter(group => group.title)) {
    const section = node('section', 'section'), head = node('div', 'section-head'), card = node('div', 'card');
    head.append(node('h2', 'section-title', t(group.title)));
    for (const [view, label, glyph] of group.items.filter(([view]) => summaries[view])) {
      const row = node('button', 'row link'); row.type = 'button'; row.dataset.view = view;
      const title = node('span', 'row-title row-icon-title'); title.innerHTML = icon(glyph); title.append(t(label));
      const value = status('—'); values.set(view, value);
      const chevron = node('span', 'chevron'); chevron.innerHTML = icon('chevron');
      const control = node('span', 'row-control auto'), copyNode = node('span', 'row-copy');
      copyNode.append(title); control.append(value, chevron); row.append(copyNode, control); card.append(row);
    }
    section.append(head, card); $('#overview-groups').append(section);
  }
  blink(crew.faces);
  createGaze(crew.faces, { active: () => !panel.hidden });

  function show(view, [text, on]) {
    const value = values.get(view);
    value.textContent = text; value.dataset.tone = on ? 'success' : '';
  }
  function renderAttention(state) {
    const items = [];
    if (!state.model.configured) items.push(['还没有对话模型', '填写兼容 OpenAI 的接口后，Host 才会启动。', '配置模型', 'model']);
    if (!state.devices.some(device => !device.revokedAt)) items.push(['还没有配对设备', '用配对码连接电脑或手机客户端。', '配对设备', 'devices']);
    $('#attention').hidden = !items.length;
    $('#attention-list').replaceChildren(...items.map(([title, hint, action, view]) => {
      const row = node('div', 'row'), copyNode = node('span', 'row-copy'), button = node('button', 'btn btn-sm', t(action));
      copyNode.append(node('span', 'row-title', t(title)), node('span', 'row-hint', t(hint)));
      button.type = 'button'; button.dataset.view = view;
      row.append(copyNode, button);
      return row;
    }));
  }
  function render(state) {
    const bots = state.host.agents.filter(agent => !agent.isGroup);
    $('#hero-title').replaceChildren(...headline(state, bots).filter(Boolean).map(line => node('span', '', line)));
    crew.render(state, bots);
    renderAttention(state);
    for (const [view, [paths, summarize]] of Object.entries(summaries)) if (!paths) show(view, summarize(null, state));
  }
  async function loadUsage() {
    const usage = await api(`/admin/api/usage?timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
    const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
    $('#hero-usage').textContent = usage.requests
      ? t('今天 {0} Token，{1} 次请求', compact.format(usage.total), usage.requests)
      : t('今天还没有模型请求');
  }
  async function load() {
    const state = current(); if (state) render(state);
    await Promise.all([loadUsage().catch(() => { $('#hero-usage').textContent = ''; }),
      ...Object.entries(summaries).filter(([, [paths]]) => paths).map(async ([view, [paths, summarize]]) => {
        try { show(view, summarize(await Promise.all(paths.map(path => api(path))), state)); }
        catch { show(view, ['—', false]); }
      })]);
  }
  return { load, status: render };
}
