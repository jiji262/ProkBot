import { t, html } from './i18n.js';
import { $, node, item, badge, menu, empty, button, confirmAction, dialog } from './ui.js';
import { icon } from './icons.js';

export function createSharingEditor({ api, toast, act }) {
  const panel = $('[data-panel=sharing]');
  panel.innerHTML = html(`<header class="page-header"><h1>分享</h1><div class="page-actions"><button class="btn" id="sharing-skill" type="button">发布技能</button>
    <label class="btn btn-primary sharing-file">导入 ZIP<input type="file" accept=".zip" id="sharing-file" hidden /></label></div></header>
    <section class="section"><div id="sharing-list" class="card"></div></section>
    <dialog id="sharing-review" class="dialog">
      <div class="dialog-head"><h2 id="sharing-title"></h2><button class="icon-btn" type="button" data-close aria-label="关闭">${icon('close')}</button></div>
      <div id="sharing-content" class="dialog-body"></div>
      <div class="dialog-foot"><button class="btn" type="button" data-close>取消</button><button id="sharing-confirm" class="btn btn-primary" type="button"></button></div>
    </dialog>
    <dialog id="sharing-select" class="dialog"><form id="sharing-select-form">
      <div class="dialog-head"><h2>发布技能</h2><button type="button" class="icon-btn" data-close aria-label="关闭">${icon('close')}</button></div>
      <div class="dialog-body"><label class="field">技能<select name="skill" required></select></label></div>
      <div class="dialog-foot"><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn btn-primary">预览</button></div>
    </form></dialog>`);
  const review = dialog($('#sharing-review')), picker = dialog($('#sharing-select'));
  const content = $('#sharing-content'), confirm = $('#sharing-confirm');
  let importZip, importId;
  function section(title, values) {
    if (!values.length) return;
    const group = node('section', 'preview'), list = node('ul', 'plain-list');
    group.append(node('h3', '', title));
    for (const value of values) list.append(node('li', '', value));
    group.append(list); content.append(group);
  }
  function show(value, importing = false) {
    content.replaceChildren(); $('#sharing-title').textContent = value.name;
    const pkg = value.package, data = pkg.content;
    if (!importing && value.versions?.length > 1) {
      const label = node('label', 'field', t('版本')), select = document.createElement('select');
      for (const version of [...value.versions].reverse()) select.add(new Option(`v${version.version} · ${new Date(version.at).toLocaleString()}`, version.version));
      select.value = value.version;
      select.onchange = () => act(select, async () => show(await api(`/admin/api/sharing/${value.id}?version=${select.value}`)));
      label.append(select); content.append(label);
    }
    content.append(node('p', 'item-desc', pkg.kind === 'bot' ? data.profile.description : data.description));
    section(t('技能'), pkg.kind === 'bot' ? data.skills.map(skill => skill.name) : [data.name]);
    section(t('自动任务 · 导入后暂停'), pkg.kind === 'bot' ? data.routines.map(routine => routine.name) : []);
    section(t('应用依赖'), value.dependencies.map(app => `${app.name}${app.version ? ` · ${app.version}` : ''}${app.installed === false ? ` · ${t('未安装')}` : ''}`));
    if (pkg.kind === 'bot' && data.memory.length) {
      const memories = node('fieldset', 'check-list'); memories.append(node('legend', 'field', t('包含记忆')));
      for (const [index, memory] of data.memory.entries()) {
        const label = node('label', 'check'), checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.value = index; checkbox.name = 'memory';
        if (!importing && value.immutable) { checkbox.checked = true; checkbox.disabled = true; }
        label.append(checkbox, node('span', '', memory.content)); memories.append(label);
      }
      content.append(memories);
    }
    confirm.textContent = importing ? t('导入') : t('发布版本');
    confirm.hidden = !importing && value.immutable;
    confirm.onclick = () => act(confirm, async () => {
      const memoryIndices = [...content.querySelectorAll('[name=memory]:checked')].map(input => Number(input.value));
      if (importing) {
        const result = await api('/admin/api/sharing/import', { method: 'POST', body: { zip: importZip, digest: value.digest, importId, memoryIndices } });
        toast(`${t('已导入')} · ${result.name}`);
      } else await api(`/admin/api/sharing/${value.id}/publish`, { method: 'POST', body: { version: value.version, memoryIndices } });
      review.close(); await load();
    });
    if (!review.open) review.showModal();
  }
  async function load() {
    const entries = await api('/admin/api/sharing'), list = $('#sharing-list');
    list.replaceChildren(...(entries.length ? entries.map(entry => {
      const open = button(t('预览'), { size: 'sm' });
      open.onclick = () => act(open, async () => show(await api(`/admin/api/sharing/${entry.id}`)));
      const more = menu(t('{0} 的更多操作', entry.name), [
        entry.published && { label: t('下载 ZIP'), run: () => { const link = document.createElement('a'); link.href = `/admin/api/sharing/${entry.id}/download`; link.download = ''; link.click(); } },
        { label: t('删除'), danger: true, run: trigger => act(trigger, async () => {
          if (!await confirmAction({ title: t('删除“{0}”？', entry.name), action: t('删除') })) return;
          await api(`/admin/api/sharing/${entry.id}`, { method: 'DELETE' }); await load();
        }) },
      ]);
      return item({ tile: icon(entry.kind === 'bot' ? 'share' : 'book'), title: entry.name, description: entry.description,
        badges: [badge(entry.active ? t('已发布') : t('草稿'), entry.active ? 'success' : '')],
        meta: [`${entry.kind === 'bot' ? 'Bot' : t('技能')} · v${entry.version}`], actions: [open, more] });
    }) : [empty(t('暂无分享'), t('发布技能，或导入别人分享的 Bot 与技能 ZIP。'))]));
  }
  $('#sharing-file').onchange = event => act(event.target, async () => {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > 15 * 1024 * 1024) throw new Error(t('文件过大'));
    const bytes = new Uint8Array(await file.arrayBuffer()); let raw = '';
    for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
    importZip = btoa(raw); importId = crypto.randomUUID(); event.target.value = '';
    show(await api('/admin/api/sharing/preview', { method: 'POST', body: { zip: importZip } }), true);
  });
  $('#sharing-skill').onclick = () => act($('#sharing-skill'), async () => {
    const skills = await api('/admin/api/skills'), select = $('#sharing-select-form').elements.skill;
    select.replaceChildren(...skills.map(skill => new Option(skill.name, skill.id)));
    $('#sharing-select-form [type=submit]').disabled = !skills.length; picker.showModal();
  });
  $('#sharing-select-form').onsubmit = event => { event.preventDefault(); act(event.submitter, async () => {
    const staged = await api('/admin/api/sharing/skills', { method: 'POST', body: { id: event.target.elements.skill.value } });
    picker.close(); show(await api(`/admin/api/sharing/${staged.id}`)); await load();
  }); };
  return { load };
}
