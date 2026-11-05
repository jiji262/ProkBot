import { t, html } from './i18n.js';
import { $, node, empty } from './ui.js';
import { labels, field, select, modal, modelOptions, uid, providerDialog, serviceRow, sectionHead } from './media-editor-ui.js';

export function createMediaEditor({ api, act }) {
  const panel = $('[data-panel=media]');
  panel.innerHTML = html(`<header class="page-header"><h1>图片与视频</h1></header>
    <form id="media-defaults" class="section"><div class="section-head"><h2 class="section-title">默认模型</h2></div><div id="media-default-rows" class="card"></div>
      <div class="actions"><button type="submit" class="btn btn-primary">保存</button></div></form>
    <section id="media-providers" class="section"></section>
    <section id="media-models" class="section"></section>`);
  const defaults = $('#media-defaults'), providers = $('#media-providers'), models = $('#media-models');
  let config, catalog = [], currentModel;
  async function save(next) { config = await api('/admin/api/media', { method: 'PUT', body: next }); render(); }
  const editProvider = providerDialog(panel, {
    adapters: [['wavespeed', 'WaveSpeed'], ['openai-images', 'OpenAI Images'], ['http-json', 'HTTP JSON']], act,
    save: async entry => save({ ...config, providers: [...config.providers.filter(provider => provider.id !== entry.id), entry] }),
  });

  const editor = modal(panel, '生成模型'), form = editor.form;
  editor.dialog.id = 'media-model-editor';
  const provider = select(editor.body, 'providerId', '供应商', []);
  const catalogRow = node('div', 'inline-field'), catalogSelect = document.createElement('select');
  catalogSelect.setAttribute('aria-label', t('供应商模型'));
  const refresh = node('button', 'btn', t('读取模型')); refresh.type = 'button';
  refresh.onclick = () => act(refresh, async () => {
    catalog = await api(`/admin/api/media/catalog/${provider.value}`);
    catalogSelect.replaceChildren(new Option(t('选择模型'), ''));
    for (const entry of catalog) catalogSelect.add(new Option(`${entry.model}${entry.basePrice === undefined ? '' : ` · $${entry.basePrice}+`}`, entry.model));
  });
  catalogRow.append(catalogSelect, refresh); editor.body.append(catalogRow);
  field(editor.body, 'model', '模型 ID').required = true;
  field(editor.body, 'name', '名称').required = true;
  select(editor.body, 'kind', '功能', Object.entries(labels).map(([key, label]) => [key, t(label)]));
  const description = field(editor.body, 'description', '供 AI 选择的简介', 'textarea');
  description.rows = 3; description.maxLength = 2000;
  const parameters = field(editor.body, 'parameters', '默认参数', 'textarea');
  parameters.rows = 4; parameters.classList.add('mono');
  provider.onchange = () => {
    catalog = []; catalogSelect.replaceChildren();
    catalogRow.hidden = config.providers.find(entry => entry.id === provider.value)?.adapter !== 'wavespeed';
  };
  function fillModel(entry) {
    currentModel = entry; form.reset(); provider.replaceChildren();
    for (const candidate of config.providers) provider.add(new Option(candidate.name, candidate.id));
    for (const key of ['providerId', 'name', 'model', 'kind', 'description']) if (entry?.[key]) form.elements[key].value = entry[key];
    form.elements.parameters.value = JSON.stringify(entry?.parameters ?? {}, null, 2); provider.onchange();
    editor.dialog.showModal();
  }
  catalogSelect.onchange = () => {
    const entry = catalog.find(candidate => candidate.model === catalogSelect.value); if (!entry) return;
    currentModel = { ...currentModel, inputSchema: entry.inputSchema, basePrice: entry.basePrice };
    for (const key of ['model', 'name', 'description', 'kind']) form.elements[key].value = key === 'description' ? entry[key].slice(0, 2000) : entry[key];
    form.elements.parameters.value = '{}';
  };
  form.onsubmit = event => { event.preventDefault(); act(editor.submit, async () => {
    const entry = { ...currentModel, ...Object.fromEntries(new FormData(form)), id: currentModel?.id || uid(), enabled: currentModel?.enabled ?? true,
      parameters: JSON.parse(form.elements.parameters.value || '{}') };
    await save(resetDefaults({ ...config, defaults: { ...config.defaults }, models: [...config.models.filter(model => model.id !== entry.id), entry] }));
    editor.dialog.close();
  }); };

  function resetDefaults(next) {
    for (const key of Object.keys(next.defaults)) if (!modelOptions(next, key).some(([value]) => value === next.defaults[key])) next.defaults[key] = '';
    return next;
  }
  const withDefaults = change => resetDefaults({ ...config, defaults: { ...config.defaults }, ...change });
  function render() {
    const rows = $('#media-default-rows'); rows.replaceChildren();
    for (const key of Object.keys(config.defaults)) {
      const line = node('label', 'row'), copy = node('span', 'row-copy'), input = document.createElement('select');
      copy.append(node('span', 'row-title', t(labels[key])));
      input.name = key;
      for (const [value, title] of modelOptions(config, key)) input.add(new Option(title, value));
      input.value = config.defaults[key]; line.append(copy, input); rows.append(line);
    }
    const providerHead = sectionHead('供应商', '添加供应商', () => editProvider(null));
    const providerList = node('div', 'card');
    for (const entry of config.providers) providerList.append(serviceRow(entry, { act, meta: entry.adapter, onEdit: editProvider,
      onToggle: enabled => save(withDefaults({ providers: config.providers.map(p => p.id === entry.id ? { ...p, enabled } : p) })),
      onRemove: () => save(withDefaults({ providers: config.providers.filter(p => p.id !== entry.id), models: config.models.filter(model => model.providerId !== entry.id) })) }));
    if (!config.providers.length) providerList.append(empty(t('还没有供应商'), t('添加供应商后再添加模型。')));
    providers.replaceChildren(providerHead.head, providerList);

    const modelHead = sectionHead('模型', '添加模型', () => fillModel(null));
    modelHead.add.disabled = !config.providers.length;
    const modelList = node('div', 'card');
    for (const entry of config.models) modelList.append(serviceRow(entry, { act, meta: entry.model, onEdit: fillModel,
      onToggle: enabled => save(withDefaults({ models: config.models.map(model => model.id === entry.id ? { ...model, enabled } : model) })),
      onRemove: () => save(withDefaults({ models: config.models.filter(model => model.id !== entry.id) })) }));
    if (!config.models.length) modelList.append(empty(t('还没有模型'), t('添加模型后选择默认模型。')));
    models.replaceChildren(modelHead.head, modelList);
  }
  defaults.onsubmit = event => { event.preventDefault(); act(event.submitter, () => save({ ...config, defaults: Object.fromEntries(new FormData(defaults)) })); };
  return { async load() { config = await api('/admin/api/media'); render(); } };
}
