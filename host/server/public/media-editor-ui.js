import { t } from './i18n.js';
import { node, iconButton, item, toggle, menu, confirmAction } from './ui.js';

// Shared building blocks for the media and web tool pages: provider lists, editor dialogs and form fields.
export const labels = { image: '图片生成', video: '视频生成', watchVideo: '视频理解', videoReview: '视频审核' };

export function field(parent, name, label, type = 'text') {
  const row = node('label', 'field', t(label)), input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') input.type = type;
  input.name = name;
  if (['url', 'password'].includes(type)) { input.dataset.private = ''; input.spellcheck = false; }
  if (type === 'password') input.autocomplete = 'new-password';
  row.append(input); parent.append(row);
  return input;
}

export function select(parent, name, label, options) {
  const row = node('label', 'field', t(label)), input = document.createElement('select');
  input.name = name;
  for (const [value, title] of options) input.add(new Option(title, value));
  row.append(input); parent.append(row);
  return input;
}

/** Editor dialog with a form body and a save footer. */
export function modal(panel, title) {
  const dialog = node('dialog', 'dialog'), form = document.createElement('form');
  const head = node('div', 'dialog-head'), body = node('div', 'dialog-body'), foot = node('div', 'dialog-foot');
  head.append(node('h2', '', t(title)), iconButton('close', t('关闭'), () => dialog.close()));
  const cancel = node('button', 'btn', t('取消')); cancel.type = 'button'; cancel.onclick = () => dialog.close();
  const submit = node('button', 'btn btn-primary', t('保存')); submit.type = 'submit';
  foot.append(cancel, submit); form.append(head, body, foot); dialog.append(form); panel.append(dialog);
  return { dialog, form, body, submit };
}

/** A provider or model row with an enable switch and an overflow menu. */
export function serviceRow(entry, { meta, onToggle, onEdit, onRemove, act }) {
  const enabled = toggle(entry.enabled, `${entry.name} · ${t('启用')}`);
  enabled.onchange = () => act(enabled, () => onToggle(enabled.checked));
  const more = menu(t('更多操作'), [
    { label: t('编辑'), run: () => onEdit(entry) },
    { label: t('删除'), danger: true, run: trigger => act(trigger, async () => {
      if (await confirmAction({ title: t('删除“{0}”？', entry.name), action: t('删除') })) await onRemove();
    }) },
  ]);
  return item({ title: entry.name, meta: [meta], description: entry.description, actions: [enabled, more] });
}

export function sectionHead(title, addLabel, onAdd) {
  const head = node('div', 'section-head'), actions = node('div', 'section-actions');
  head.append(node('h2', 'section-title', t(title)));
  if (onAdd) { const add = iconButton('plus', t(addLabel), onAdd); actions.append(add); head.append(actions); return { head, add }; }
  return { head };
}

export const modelOptions = (config, kind) => [['', t('停用')], ...config.models.filter(entry => entry.kind === kind && entry.enabled
  && config.providers.find(provider => provider.id === entry.providerId)?.enabled).map(entry => [entry.id, entry.name])];
export const uid = () => `service-${crypto.randomUUID().slice(0, 8)}`;

export function providerDialog(panel, { adapters, save, act }) {
  const { dialog, form, body, submit } = modal(panel, '供应商');
  field(body, 'name', '名称').required = true;
  select(body, 'adapter', '接口类型', adapters);
  field(body, 'baseUrl', '接口地址', 'url').required = true;
  field(body, 'apiKey', 'API Key', 'password');
  const model = field(body, 'model', '模型 ID');
  let selected;
  form.onsubmit = event => { event.preventDefault(); act(submit, async () => {
    await save({ id: selected?.id ?? uid(), enabled: selected?.enabled ?? true, ...Object.fromEntries(new FormData(form)) });
    dialog.close();
  }); };
  form.elements.adapter.onchange = () => {
    const adapter = form.elements.adapter.value;
    model.parentElement.hidden = !['responses-search', 'anthropic-tools'].includes(adapter);
    const known = { wavespeed: 'https://api.wavespeed.ai', 'openai-images': 'https://api.openai.com/v1',
      'deepseek-tools': 'https://api.deepseek.com', 'responses-search': 'https://api.openai.com/v1',
      'anthropic-tools': 'https://api.anthropic.com/v1' };
    if (!selected || !form.elements.baseUrl.value) form.elements.baseUrl.value = known[adapter] || '';
  };
  return entry => {
    selected = entry; form.reset();
    for (const key of ['name', 'adapter', 'baseUrl', 'model']) if (entry?.[key]) form.elements[key].value = entry[key];
    form.elements.apiKey.placeholder = entry?.hasApiKey ? t('已保存，留空保留') : '';
    form.elements.adapter.onchange(); dialog.showModal();
  };
}
