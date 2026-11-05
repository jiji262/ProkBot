import { t, html } from './i18n.js';
import { $, errorText, filePicker } from './ui.js';
import { icon } from './icons.js';

export function createConnectorForm({ act, toast, api, onSave, getRedirectUri }) {
  const dialog = $('#connector-dialog');
  dialog.innerHTML = html(`<form id="connector-form">
    <div class="dialog-head"><h2 id="connector-form-title">添加应用</h2><button class="icon-btn" type="button" data-close aria-label="关闭应用编辑">${icon('close')}</button></div>
    <div class="dialog-body">
      <div class="field-grid"><label class="field">应用名称<input name="name" required maxlength="100" placeholder="你的应用名称" /></label><label class="field">应用 ID<input name="id" required maxlength="64" pattern="[a-z][a-z0-9_-]{0,63}" placeholder="my-app" spellcheck="false" /><span class="hint">小写字母、数字、短横线或下划线</span></label></div>
      <label class="field">说明<textarea name="description" rows="2" maxlength="1000" placeholder="说明这个应用提供的能力"></textarea></label>
      <div class="field-grid"><label class="field">MCP 服务地址<input name="url" type="url" required spellcheck="false" placeholder="https://app.example.com/mcp" data-private /></label><label class="field">连接协议<select name="transport"><option value="streamable-http">Streamable HTTP</option><option value="sse">SSE</option></select></label></div>
      <div class="field-grid"><label class="field">应用图标<input name="iconFile" type="file" accept="image/png,image/jpeg,image/webp" /><span class="hint">可选，最大 256 KiB。</span></label><label class="check"><input name="clearIcon" type="checkbox" />移除已有图标</label></div>
      <label class="field">认证方式<select name="authType"><option value="none">无需认证</option><option value="bearer">Bearer Token</option><option value="api-key">API Key</option><option value="oauth2">OAuth 2.0</option></select></label>
      <label id="connector-header-field" class="field" hidden>API Key 请求头<input name="headerName" placeholder="X-API-Key" spellcheck="false" /></label>
      <div id="connector-oauth-fields" class="dialog-group" hidden>
        <div class="field-grid"><label class="field">授权地址<input name="authorizationUrl" type="url" spellcheck="false" placeholder="https://app.example.com/oauth/authorize" /></label><label class="field">Token 地址<input name="tokenUrl" type="url" spellcheck="false" placeholder="https://app.example.com/oauth/token" /></label></div>
        <div class="field-grid"><label class="field">Client ID<input name="clientId" spellcheck="false" autocomplete="off" /></label><label class="field">Client Secret<input name="clientSecret" type="password" autocomplete="new-password" placeholder="可选；留空保留已保存的值" /></label></div>
        <label class="check"><input name="clearClientSecret" type="checkbox" />清除已保存的 Client Secret</label>
        <div class="field-grid"><label class="field">授权范围<input name="scopes" spellcheck="false" placeholder="使用空格分隔，例如 read write" /></label><label class="field">资源地址<input name="resource" type="url" spellcheck="false" placeholder="可选" /></label></div>
        <label class="field">Host 回调地址<input name="redirectUri" readonly /><span class="hint">在应用中登记此回调地址</span></label>
      </div>
      <p id="connector-form-error" class="error" role="alert" hidden></p>
    </div>
    <div class="dialog-foot"><label class="check foot-check"><input name="enabled" type="checkbox" checked />启用应用</label><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn btn-primary">保存应用</button></div>
  </form>`);
  const form = $('#connector-form');
  const showIcon = filePicker(form.elements.iconFile);
  let editingId = null, originalIcon = null;
  function showAuth() {
    const type = form.elements.authType.value;
    $('#connector-header-field').hidden = type !== 'api-key';
    $('#connector-oauth-fields').hidden = type !== 'oauth2';
    for (const key of ['authorizationUrl', 'tokenUrl', 'clientId']) form.elements[key].required = type === 'oauth2';
  }
  form.elements.authType.addEventListener('change', showAuth);
  dialog.querySelectorAll('[data-close]').forEach(control => control.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => { form.elements.clientSecret.value = ''; form.elements.iconFile.value = ''; showIcon(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    act(form.querySelector('[type=submit]'), async () => {
      try {
        const value = name => form.elements[name].value.trim();
        const auth = { type: value('authType') };
        if (auth.type === 'api-key') auth.headerName = value('headerName') || 'X-API-Key';
        if (auth.type === 'oauth2') {
          for (const key of ['authorizationUrl', 'tokenUrl', 'clientId', 'resource']) if (value(key)) auth[key] = value(key);
          auth.scopes = value('scopes').split(/[\s,]+/).filter(Boolean);
          if (form.elements.clearClientSecret.checked) auth.clientSecret = '';
          else if (value('clientSecret')) auth.clientSecret = value('clientSecret');
        }
        const body = { id: value('id'), name: value('name'), description: value('description'), url: value('url'),
          transport: value('transport'), enabled: form.elements.enabled.checked, auth, iconDataUrl: originalIcon };
        if (form.elements.clearIcon.checked) body.iconDataUrl = null;
        const file = form.elements.iconFile.files[0];
        if (file) {
          if (file.size > 256 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
            throw new Error(t('图标需要 256 KiB 以内的 PNG、JPEG 或 WebP 图片'));
          body.iconDataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error(t('图标读取失败')));
            reader.readAsDataURL(file);
          });
        }
        await api(`/admin/api/apps${editingId ? `/${encodeURIComponent(editingId)}` : ''}`, { method: editingId ? 'PUT' : 'POST', body });
        dialog.close(); toast(t('应用已保存')); await onSave();
      } catch (error) { errorText('#connector-form-error', error); }
    });
  });
  return {
    open(connector) {
      form.reset();
      editingId = connector?.id || null; originalIcon = connector?.iconDataUrl || null;
      form.elements.id.readOnly = Boolean(connector);
      $('#connector-form-error').hidden = true;
      $('#connector-form-title').textContent = connector ? t('编辑应用') : t('添加应用');
      for (const key of ['id', 'name', 'description', 'url', 'transport']) form.elements[key].value = connector?.[key] || (key === 'transport' ? 'streamable-http' : '');
      form.elements.enabled.checked = connector?.enabled ?? true;
      const auth = connector?.auth || {};
      form.elements.authType.value = auth.type || 'none';
      for (const key of ['authorizationUrl', 'tokenUrl', 'clientId', 'headerName', 'resource']) form.elements[key].value = auth[key] || '';
      form.elements.scopes.value = (auth.scopes || []).join(' ');
      form.elements.redirectUri.value = getRedirectUri();
      form.elements.clientSecret.placeholder = auth.hasClientSecret || connector?.hasClientSecret ? t('已保存；留空保留') : t('可选，未保存');
      showAuth(); dialog.showModal(); form.elements.name.focus();
    },
    reset() { dialog.close(); form.reset(); editingId = null; },
  };
}
