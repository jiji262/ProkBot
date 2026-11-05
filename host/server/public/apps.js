import { t, html } from './i18n.js';
import { $, node, item, badge, menu, empty, button, toggle, confirmAction, dialog, errorText } from './ui.js';
import { icon } from './icons.js';
import { createConnectorForm } from './connector-form.js';
import { appCopy, createAppPackage } from './app-package.js';

const statusNames = { connected: '已授权', needs_auth: '需要授权', disconnected: '未连接', error: '连接错误' };

export function createApps(context) {
  const { api, toast, act } = context;
  $('[data-panel=apps]').innerHTML = html(`<header class="page-header"><h1>应用</h1><div class="page-actions"><button id="refresh-connectors" class="icon-btn" type="button" aria-label="刷新">${icon('refresh')}</button><button id="app-import" class="btn" type="button">导入</button><button id="add-connector" class="btn btn-primary" type="button">添加应用</button></div></header>
    <section class="section"><p id="connectors-error" class="error" role="alert" hidden></p><div id="connector-list" class="card"></div></section>
    <dialog id="connector-dialog" class="dialog wide"></dialog>
    <dialog id="connector-authorize-dialog" class="dialog"><form id="connector-authorize-form">
      <div class="dialog-head"><h2 id="connector-authorize-title">授权应用</h2><button class="icon-btn" type="button" data-close aria-label="关闭">${icon('close')}</button></div>
      <div class="dialog-body"><label class="field">访问凭证<input id="connector-secret" type="password" required autocomplete="new-password" data-private /></label><p id="connector-authorize-error" class="error" role="alert" hidden></p></div>
      <div class="dialog-foot"><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn btn-primary">保存授权</button></div>
    </form></dialog>`);
  let redirectUri = '', pending = false, authorizing = null;
  const authorizeDialog = dialog($('#connector-authorize-dialog'));
  const editor = createConnectorForm({ ...context, onSave: load, getRedirectUri: () => redirectUri });
  const packages = createAppPackage({ ...context, onSave: load });

  async function run(app, action) {
    const id = encodeURIComponent(app.id), name = appCopy(app.name), endpoint = `/admin/api/apps/${id}`;
    if (action === 'configure') return packages.configure(app);
    if (action === 'export') return packages.export(app);
    if (action === 'edit') return editor.open(await api(endpoint));
    if (action === 'restore') { await api(endpoint, { method: 'PATCH', body: { restore: 'previous' } }); return load(); }
    if (action === 'delete') {
      if (!await confirmAction({ title: t('删除“{0}”？', name), action: t('删除应用') })) return;
      await api(endpoint, { method: 'DELETE' }); toast(t('应用已删除')); return load();
    }
    if (action === 'authorize' && app.auth.type !== 'oauth2') {
      authorizing = app.id;
      $('#connector-secret').value = ''; $('#connector-authorize-error').hidden = true;
      $('#connector-authorize-title').textContent = t('授权 {0}', name);
      authorizeDialog.showModal(); $('#connector-secret').focus(); return;
    }
    if (action === 'authorize') {
      const url = new URL((await api(`${endpoint}/authorize`, { method: 'POST', body: { returnTo: 'admin' } })).authorizationUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error(t('授权地址无效'));
      return location.assign(url.href);
    }
    if (action === 'connect') { await api(`${endpoint}/authorize`, { method: 'POST', body: {} }); toast(t('应用已连接')); return load(); }
    if (action === 'disconnect') { await api(`${endpoint}/disconnect`, { method: 'POST' }); toast(t('应用授权已断开')); return load(); }
    const result = await api(`${endpoint}/test`, { method: 'POST' });
    await load();
    if (!result.ok) throw new Error(result.error || t('连接测试未通过'));
    toast(t('连接成功，发现 {0} 个工具', result.toolCount));
  }
  function capabilityList(title, entries) {
    if (!entries?.length) return null;
    const details = node('details', 'connector-tools'), list = node('ul');
    details.append(node('summary', '', t(title, entries.length)));
    for (const entry of entries) list.append(node('li', '', [appCopy(entry.name) || entry.id, appCopy(entry.description)].filter(Boolean).join(' — ')));
    details.append(list); return details;
  }
  function row(app) {
    const name = appCopy(app.name), builtin = app.kind === 'builtin' || app.builtin;
    const packaged = app.kind === 'package' || Boolean(app.pluginId), auth = app.auth?.type || 'none', disabled = app.enabled === false;
    const credential = app.hasCredential || app.auth?.hasCredential;
    const state = disabled ? '已停用' : builtin ? '已启用' : app.installed && auth === 'none' ? '已连接' : statusNames[app.authorizationStatus] || '尚未连接';
    const badges = [badge(t(state), ['已连接', '已授权', '已启用'].includes(state) ? 'success' : app.authorizationStatus === 'error' ? 'danger' : '')];
    if (builtin) badges.push(badge(t('内置')));
    if (app.connectionStatus === 'error') badges.push(badge(t('连接失败'), 'danger'));
    const actions = [];
    if (!builtin) {
      actions.push([packaged ? 'configure' : 'edit', packaged ? '配置' : '编辑'], ['export', '导出应用']);
      if (app.installed) actions.push(['test', '测试连接']);
      if (auth !== 'none') actions.push(['authorize', credential ? '重新授权' : '授权']);
      else if (!app.installed) actions.push(['connect', '连接']);
      if (app.installed || credential) actions.push(['disconnect', '断开授权']);
      if (app.previous) actions.push(['restore', '恢复上一版']);
      actions.push(['delete', '删除']);
    }
    const controls = [];
    const enabled = toggle(!disabled, `${name} · ${t('启用')}`);
    enabled.onchange = () => act(enabled, async () => {
      try { await api(`/admin/api/apps/${encodeURIComponent(app.id)}`, { method: 'PATCH', body: { enabled: enabled.checked } }); }
      finally { await load(); }
    });
    controls.push(enabled);
    const priorities = credential ? ['configure', 'edit', 'authorize'] : ['authorize', 'connect', 'configure', 'edit'];
    const primaryKey = priorities.find(key => actions.some(([action]) => action === key));
    if (primaryKey) {
      const [, label] = actions.find(([action]) => action === primaryKey), primary = button(t(label), { size: 'sm' });
      primary.setAttribute('aria-label', `${t(label)} ${name}`);
      primary.disabled = disabled && ['authorize', 'connect'].includes(primaryKey);
      primary.onclick = () => act(primary, () => run(app, primaryKey)); controls.push(primary);
    }
    if (actions.length) controls.push(menu(t('{0} 的更多操作', name), actions.filter(([action]) => action !== primaryKey).map(([action, label]) => ({
      label: t(label), danger: action === 'delete', disabled: disabled && ['test', 'connect', 'authorize'].includes(action),
      run: trigger => act(trigger, () => run(app, action)) }))));
    const valid = /^data:image\/(png|jpeg|webp);base64,/.test(app.iconDataUrl || '');
    const meta = [app.version, Number.isInteger(app.toolCount) && t('{0} 个工具', app.toolCount), app.skills?.length && t('{0} 个技能', app.skills.length)].filter(Boolean);
    const element = item({ image: valid ? app.iconDataUrl : '', tile: icon(builtin ? 'bolt' : 'plug'), title: name, badges,
      description: appCopy(app.description), meta: meta.length ? [meta.join(' · ')] : [], actions: controls });
    element.classList.add('connector-row'); element.dataset.appId = app.id;
    const content = element.querySelector('.item-copy');
    if (app.url && !packaged && !builtin) { const url = node('p', 'item-meta', app.url); url.dataset.private = ''; content.append(url); }
    if (app.lastError || app.error) content.append(node('p', 'error', app.lastError || app.error));
    for (const section of [capabilityList('工具（{0}）', app.tools), capabilityList('附带技能（{0}）', app.skills)]) if (section) content.append(section);
    return element;
  }
  async function load() {
    if (pending) return;
    pending = true;
    try {
      const result = await api('/admin/api/apps'); redirectUri = result.redirectUri || '';
      $('#connectors-error').hidden = true;
      $('#connector-list').replaceChildren(...(result.apps.length ? result.apps.map(row) : [empty(t('还没有添加应用'))]));
    } catch (error) { errorText('#connectors-error', error); }
    finally { pending = false; }
  }
  $('#app-import').onclick = () => packages.import();
  $('#add-connector').addEventListener('click', () => editor.open());
  $('#refresh-connectors').addEventListener('click', event => act(event.currentTarget, load));
  authorizeDialog.addEventListener('close', () => { $('#connector-secret').value = ''; authorizing = null; });
  $('#connector-authorize-form').addEventListener('submit', event => {
    event.preventDefault(); act(event.submitter, async () => {
      try {
        await api(`/admin/api/apps/${encodeURIComponent(authorizing)}/authorize`, { method: 'POST', body: { secret: $('#connector-secret').value } });
        authorizeDialog.close(); toast(t('应用授权已保存')); await load();
      } catch (error) { errorText('#connector-authorize-error', error); }
    });
  });
  return { load, reset() { redirectUri = ''; authorizing = null; editor.reset(); packages.reset(); authorizeDialog.close(); $('#connector-list').replaceChildren(); } };
}
