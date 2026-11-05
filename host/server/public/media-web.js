import { t, html } from './i18n.js';
import { $, node, empty, iconButton } from './ui.js';
import { providerDialog, serviceRow, sectionHead } from './media-editor-ui.js';

export function createWebServicesEditor({ api, act }) {
  const panel = $('[data-panel=web-services]');
  panel.innerHTML = html(`<header class="page-header"><h1>联网工具</h1></header>
    <form id="web-routing" class="section"><div class="section-head"><h2 class="section-title">使用方式</h2><div class="section-actions"><button id="web-add-rule" type="button" class="btn btn-ghost btn-sm">添加模型规则</button></div></div>
      <div class="card route-table"><div class="route-line route-labels"><span>模型</span><span>搜索</span><span>抓取</span></div><div id="web-routes"></div></div>
      <div class="actions"><button type="submit" class="btn btn-primary">保存</button></div></form>
    <section id="web-providers" class="section"></section>
    <form id="web-test" class="section"><div class="section-head"><h2 class="section-title">测试</h2></div><div class="card">
      <label class="row"><span class="row-copy"><span class="row-title">工具</span></span><select name="kind"><option value="search">搜索</option><option value="fetch">抓取</option></select></label>
      <label class="row"><span class="row-copy"><span class="row-title">关键词或网址</span></span><input name="value" required /></label>
      <label class="row"><span class="row-copy"><span class="row-title">模型规则</span></span><select name="model"></select></label>
    </div><div class="actions"><span id="web-test-status" class="status-text" role="status"></span><button type="submit" class="btn btn-primary">测试</button></div></form>`);
  const routing = $('#web-routing'), testing = $('#web-test'), routes = $('#web-routes');
  let config;
  async function save(next) { config = await api('/admin/api/web-services', { method: 'PUT', body: next }); render(); }
  const editProvider = providerDialog(panel, { act, adapters: [
    ['deepseek-tools', 'DeepSeek Search / Fetch'], ['responses-search', t('模型原生 · Responses')],
    ['anthropic-tools', t('模型原生 · Anthropic')], ['http-json', 'HTTP JSON']],
    save: entry => save({ ...config, providers: [...config.providers.filter(provider => provider.id !== entry.id), entry] }),
  });
  const options = kind => [['', t('停用')], ...config.providers.filter(provider => provider.enabled
    && !(kind === 'fetch' && provider.adapter === 'responses-search')).map(provider => [provider.id, provider.name])];
  function clearRoutes(next) {
    for (const route of [next.defaults, ...next.models]) for (const kind of ['search', 'fetch'])
      if (!next.providers.some(entry => entry.id === route[kind] && entry.enabled)) route[kind] = '';
    return next;
  }
  function routeRow(route, isDefault) {
    const line = node('div', 'route-line');
    if (isDefault) line.append(node('strong', 'route-default', t('默认')));
    else {
      const model = document.createElement('input'); model.name = 'model'; model.value = route.model; model.required = true;
      model.placeholder = t('模型 ID'); model.setAttribute('aria-label', t('模型 ID')); line.append(model);
    }
    for (const kind of ['search', 'fetch']) {
      const input = document.createElement('select'); input.name = kind; input.setAttribute('aria-label', t(kind === 'search' ? '搜索' : '抓取'));
      for (const [value, title] of options(kind)) input.add(new Option(title, value));
      input.value = route[kind]; line.append(input);
    }
    line.append(isDefault ? node('span') : iconButton('close', t('移除规则'), () => line.remove()));
    return line;
  }
  function render() {
    routes.replaceChildren(routeRow(config.defaults, true), ...config.models.map(entry => routeRow(entry, false)));
    const head = sectionHead('供应商', '添加联网供应商', () => editProvider(null)), list = node('div', 'card');
    for (const entry of config.providers) list.append(serviceRow(entry, { act, meta: `${entry.adapter}${entry.model ? ` · ${entry.model}` : ''}`, onEdit: editProvider,
      onToggle: enabled => save(clearRoutes({ ...structuredClone(config), providers: config.providers.map(p => p.id === entry.id ? { ...p, enabled } : p) })),
      onRemove: () => save(clearRoutes({ ...structuredClone(config), providers: config.providers.filter(p => p.id !== entry.id) })) }));
    if (!config.providers.length) list.append(empty(t('还没有供应商'), t('添加搜索或抓取服务。')));
    $('#web-providers').replaceChildren(head.head, list);
    const model = testing.elements.model; model.replaceChildren(new Option(t('默认'), ''));
    for (const entry of config.models) model.add(new Option(entry.model, entry.model));
  }
  $('#web-add-rule').onclick = () => routes.append(routeRow({ model: '', search: '', fetch: '' }, false));
  routing.onsubmit = event => { event.preventDefault(); act(event.submitter, async () => {
    const values = [...routes.children].map(line => Object.fromEntries([...line.querySelectorAll('[name]')].map(input => [input.name, input.value])));
    await save({ ...config, defaults: values[0], models: values.slice(1) });
  }); };
  testing.onsubmit = event => { event.preventDefault(); act(event.submitter, async () => {
    const result = await api('/admin/api/web-services/test', { method: 'POST', body: Object.fromEntries(new FormData(testing)) });
    $('#web-test-status').textContent = result.sources === undefined ? t('已读取 {0} 个字符', result.characters) : t('找到 {0} 个来源', result.sources);
  }); };
  return { async load() { config = await api('/admin/api/web-services'); render(); } };
}
