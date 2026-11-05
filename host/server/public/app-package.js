import { t, html, locale } from './i18n.js';
import { $, node, dialog } from './ui.js';
import { icon } from './icons.js';

export const appCopy = value => typeof value === 'string' ? value : value?.[locale] ?? value?.en ?? '';

export function createAppPackage({ api, act, toast, onSave }) {
  const root = document.createElement('div');
  root.innerHTML = html(`<input id="app-file" type="file" accept=".json,application/json" hidden />
    <dialog id="app-preview" class="dialog"><div class="dialog-head"><h2>导入应用</h2><button class="icon-btn" type="button" data-close aria-label="关闭">${icon('close')}</button></div>
      <div class="dialog-body"><div id="app-preview-content" class="preview"></div><details class="disclosure boxed"><summary>包内容</summary><pre id="app-source" class="code-block" data-raw></pre></details></div>
      <div class="dialog-foot"><button class="btn" type="button" data-close>取消</button><button id="app-publish" class="btn btn-primary" type="button">导入</button></div></dialog>
    <dialog id="app-settings" class="dialog"><form id="app-config">
      <div class="dialog-head"><h2 id="app-settings-name"></h2><button class="icon-btn" type="button" data-close aria-label="关闭">${icon('close')}</button></div>
      <div id="app-fields" class="dialog-body"></div>
      <div class="dialog-foot"><button type="button" class="btn" data-close>取消</button><button class="btn btn-primary" type="submit">保存</button></div>
    </form></dialog>`);
  $('[data-panel=apps]').append(root);
  const preview = dialog($('#app-preview')), settings = dialog($('#app-settings'));
  let candidate, selected;
  settings.addEventListener('close', () => { for (const input of settings.querySelectorAll('input[type=password]')) input.value = ''; });
  $('#app-file').onchange = async event => {
    try {
      const file = event.target.files[0]; if (!file) return;
      if (file.size > 20 * 1024 * 1024) throw new Error(t('文件过大'));
      const result = await api('/admin/api/apps/preview', { method: 'POST', body: JSON.parse(await file.text()) });
      candidate = result.package;
      const content = $('#app-preview-content');
      content.replaceChildren(node('h3', '', appCopy(candidate.name)), node('p', 'item-desc', appCopy(candidate.description)));
      const metadata = [candidate.publisher, candidate.version, candidate.license].filter(Boolean).join(' · ');
      if (metadata) content.append(node('p', 'hint', metadata));
      if (candidate.permissions?.network?.length) content.append(node('p', 'hint', `${t('网络权限')}: ${candidate.permissions.network.join(', ')}`));
      content.append(node('p', 'hint', t('{0} 个文件 · {1} 个技能', result.files?.length ?? candidate.files?.length ?? 0, candidate.skills?.length ?? 0)));
      $('#app-source').textContent = JSON.stringify(candidate, null, 2); preview.showModal();
    } catch (error) { toast(error.message, true); } finally { event.target.value = ''; }
  };
  $('#app-publish').onclick = event => act(event.currentTarget, async () => {
    await api('/admin/api/apps/import', { method: 'POST', body: candidate }); preview.close(); await onSave(); toast(t('已导入'));
  });
  $('#app-config').onsubmit = event => { event.preventDefault(); act(event.submitter, async () => {
    const values = Object.fromEntries((selected.configuration ?? []).map(setting => [setting.key, event.target.elements[setting.key].value])
      .filter(([key, value]) => value || !selected.configuration.find(setting => setting.key === key).secret));
    await api(`/admin/api/apps/${encodeURIComponent(selected.id)}/configuration`, { method: 'PUT', body: values });
    settings.close(); await onSave(); toast(t('配置已保存'));
  }); };
  return {
    import() { $('#app-file').click(); },
    async configure(entry) {
      selected = await api(`/admin/api/apps/${encodeURIComponent(entry.id)}`);
      $('#app-settings-name').textContent = appCopy(selected.name);
      const fields = $('#app-fields'); fields.replaceChildren();
      for (const setting of selected.configuration ?? []) {
        const label = node('label', 'field', appCopy(setting.name)), input = document.createElement('input');
        input.name = setting.key; input.type = setting.secret ? 'password' : 'text'; input.autocomplete = 'off';
        input.value = selected.values?.[setting.key] ?? '';
        input.placeholder = selected.configured?.includes(setting.key) && setting.secret ? t('已保存') : '';
        if (setting.secret) input.dataset.private = '';
        label.append(input); fields.append(label);
      }
      if (!selected.configuration?.length) fields.append(node('p', 'hint', t('无需额外配置')));
      settings.showModal();
    },
    async export(entry) {
      const data = await api(`/admin/api/apps/${encodeURIComponent(entry.id)}/export`);
      const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = `${entry.id}.json`; document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    reset() { preview.close(); settings.close(); candidate = null; selected = null; $('#app-fields').replaceChildren(); },
  };
}
