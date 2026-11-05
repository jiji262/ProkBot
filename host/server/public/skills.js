import { t, html } from './i18n.js';
import { $, item, toggle, menu, empty, button, confirmAction, dialog, filePicker } from './ui.js';
import { icon } from './icons.js';

export function createSkillsEditor({ api, toast, act }) {
  const panel = $('[data-panel=skills]');
  panel.innerHTML = html(`<header class="page-header"><h1>技能</h1><div class="page-actions"><button id="skill-new" class="btn btn-primary" type="button">添加技能</button></div></header>
    <section class="section"><div id="skills-list" class="card"></div></section>
    <dialog id="skill-editor" class="dialog wide"><form id="skill-form">
      <div class="dialog-head"><h2 id="skill-editor-title">技能</h2><button type="button" class="icon-btn" data-close aria-label="关闭">${icon('close')}</button></div>
      <div class="dialog-body">
        <div class="field-grid"><label class="field">ID<input name="id" pattern="[a-z][a-z0-9-]{0,63}" required spellcheck="false" /></label><label class="field">名称<input name="name" maxlength="100" required /></label></div>
        <label class="field">简介<input name="description" maxlength="2000" required /></label>
        <label class="field">工具依赖<input name="requiresTools" placeholder="Read, Shell" spellcheck="false" /></label>
        <label class="field">SKILL.md<textarea name="markdown" class="mono" rows="14" required spellcheck="false" data-raw></textarea></label>
        <label class="field">导入文件<input name="file" type="file" accept=".md,.json" /><span id="skill-resources" class="hint"></span></label>
        <details id="skill-history" class="disclosure boxed"><summary>版本记录</summary>
          <div class="history-body"><label class="field">比较版本<select name="version"></select></label>
            <div class="compare"><div><h3>选择的版本</h3><pre id="skill-before" class="code-block" data-raw></pre></div><div><h3>当前版本</h3><pre id="skill-after" class="code-block" data-raw></pre></div></div>
            <div class="actions"><button type="button" class="btn" data-restore="baseline">恢复初始版本</button><button type="button" class="btn" data-restore="previous">恢复上一版</button></div></div>
        </details>
      </div>
      <div class="dialog-foot"><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn btn-primary">发布版本</button></div>
    </form></dialog>`);
  const editor = dialog($('#skill-editor')), form = $('#skill-form');
  filePicker(form.elements.file);
  let selected, resources = [];
  const markdown = content => content.files.find(file => file.path === 'SKILL.md')?.content ?? '';
  function fill(entry) {
    selected = entry; const content = entry?.content;
    form.reset(); form.elements.id.readOnly = Boolean(entry);
    $('#skill-editor-title').textContent = entry ? entry.name : t('添加技能');
    for (const key of ['id', 'name', 'description']) form.elements[key].value = entry?.[key] ?? '';
    form.elements.markdown.value = content ? markdown(content) : '';
    form.elements.requiresTools.value = content?.requiresTools.join(', ') ?? '';
    resources = content?.files.filter(file => file.path !== 'SKILL.md') ?? [];
    $('#skill-resources').textContent = resources.length ? t('{0} 个附带文件', resources.length) : '';
    $('#skill-history').hidden = !entry; $('#skill-history').open = false;
    const selector = form.elements.version; selector.replaceChildren();
    for (const version of [...entry?.versions ?? []].reverse()) selector.add(new Option(`${new Date(version.at).toLocaleString()} · ${version.id.slice(0, 8)}`, version.id));
    panel.querySelector('[data-restore=previous]').disabled = !entry?.previous;
    $('#skill-after').textContent = content ? markdown(content) : '';
    $('#skill-before').textContent = $('#skill-after').textContent;
  }
  async function load() {
    const list = $('#skills-list'), entries = await api('/admin/api/skills');
    list.replaceChildren();
    if (!entries.length) list.append(empty(t('还没有技能'), t('添加 SKILL.md，Bot 会在需要时读取。')));
    for (const entry of entries) {
      const managed = entry.source === 'host';
      const enabled = toggle(entry.enabled, `${entry.name} · ${t('启用')}`); enabled.disabled = !managed;
      enabled.onchange = () => act(enabled, async () => {
        try { await api(`/admin/api/skills/${entry.id}`, { method: 'PATCH', body: { enabled: enabled.checked } }); } finally { await load(); }
      });
      const edit = button(t('编辑'), { size: 'sm' }); edit.disabled = !managed;
      edit.onclick = () => act(edit, async () => { fill(await api(`/admin/api/skills/${entry.id}`)); editor.showModal(); });
      const more = menu(t('更多操作'), [{ label: t('删除'), danger: true, disabled: !managed, run: trigger => act(trigger, async () => {
        if (!await confirmAction({ title: t('删除“{0}”？', entry.name), message: t('Bot 将无法再使用此技能。'), action: t('删除') })) return;
        await api(`/admin/api/skills/${entry.id}`, { method: 'DELETE' }); await load();
      }) }]);
      list.append(item({ tile: icon('book'), title: entry.name, description: entry.description,
        meta: [`${entry.source.startsWith('plugin:') ? t('应用附带') : entry.source === 'host' ? 'Host' : entry.source} · ${entry.current.slice(0, 8)}`], actions: [enabled, edit, more] }));
    }
  }
  $('#skill-new').onclick = () => { fill(null); editor.showModal(); };
  form.elements.file.onchange = async () => {
    try {
      const file = form.elements.file.files[0]; if (!file) return;
      if (file.size > 15 * 1024 * 1024) throw new Error(t('文件过大'));
      const source = await file.text();
      if (file.name.endsWith('.json')) {
        const value = JSON.parse(source);
        fill({ ...value, content: { ...value, requiresTools: value.requiresTools ?? [] }, versions: [], current: '', previous: null });
        selected = null; form.elements.id.readOnly = false; $('#skill-history').hidden = true;
      } else form.elements.markdown.value = source;
    } catch (error) { toast(error.message, true); }
  };
  form.elements.version.onchange = async () => {
    try { $('#skill-before').textContent = markdown((await api(`/admin/api/skills/${selected.id}?version=${form.elements.version.value}`)).content); }
    catch (error) { toast(error.message, true); }
  };
  for (const control of panel.querySelectorAll('[data-restore]')) control.onclick = () => act(control, async () => {
    fill(await api(`/admin/api/skills/${selected.id}`, { method: 'PATCH', body: { restore: control.dataset.restore } })); await load(); toast(t('配置已保存'));
  });
  form.onsubmit = event => { event.preventDefault(); act(form.querySelector('[type=submit]'), async () => {
    const body = Object.fromEntries(['id', 'name', 'description'].map(key => [key, form.elements[key].value]));
    body.requiresTools = form.elements.requiresTools.value.split(',').map(value => value.trim()).filter(Boolean);
    body.files = [{ path: 'SKILL.md', encoding: 'utf8', content: form.elements.markdown.value }, ...resources];
    await api('/admin/api/skills', { method: 'POST', body }); editor.close(); await load(); toast(t('配置已保存'));
  }); };
  return { load };
}
