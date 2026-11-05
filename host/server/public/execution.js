import { t, html } from './i18n.js';
import { $ } from './ui.js';

const row = (title, control, hint = '') =>
  `<label class="row"><span class="row-copy"><span class="row-title">${title}</span>${hint ? `<span class="row-hint">${hint}</span>` : ''}</span>${control}</label>`;

export function createExecutionEditor({ api, toast, act }) {
  $('[data-panel=execution]').innerHTML = html(`<header class="page-header"><h1>执行环境</h1></header>
    <form id="execution-form" class="section"><div class="section-head"><h2 class="section-title">执行电脑</h2></div><div class="card">
      ${row('启用远程节点', '<input type="checkbox" name="enabled" role="switch" />', 'Bot 的命令、文件与桌面在此节点运行')}
      ${row('名称', '<input name="name" maxlength="100" required />')}
      ${row('节点地址', '<input name="url" type="text" placeholder="https://computer.example.com" data-private spellcheck="false" />')}
      ${row('节点密钥', '<input name="token" type="password" autocomplete="new-password" spellcheck="false" data-private />')}
      ${row('连接方式', '<select name="network"><option value="https">HTTPS</option><option value="private">私有网络 / Tailscale</option><option value="tailcat">Tailcat</option></select>')}
    </div><p class="section-note">文件保存在执行节点。切换节点后，已有文件不会自动迁移。</p>
    <div class="actions"><span id="execution-status" class="status-text" role="status"></span><button id="execution-test" class="btn" type="button">测试连接</button><button class="btn btn-primary" type="submit">保存</button></div></form>`);
  const form = $('#execution-form');
  function render(config) {
    for (const key of ['name', 'url']) form.elements[key].value = config[key];
    form.elements.enabled.checked = config.enabled;
    form.elements.network.value = config.url.startsWith('tailcat:') ? 'tailcat' : config.privateNetwork ? 'private' : 'https';
    form.elements.token.value = ''; form.elements.token.placeholder = t(config.hasToken ? '已保存，留空保留' : '输入节点密钥');
    $('#execution-status').textContent = t(config.applied ? '配置已应用' : config.revision ? '任务结束后应用' : '等待节点配置');
  }
  form.elements.network.onchange = () => { form.elements.url.placeholder = form.elements.network.value === 'tailcat' ? 'tailcat://connect/…' : 'https://computer.example.com'; };
  const body = () => ({ enabled: form.elements.enabled.checked, name: form.elements.name.value,
    url: form.elements.url.value, token: form.elements.token.value, privateNetwork: form.elements.network.value === 'private' });
  form.onsubmit = event => { event.preventDefault(); act(event.submitter, async () => { render(await api('/admin/api/execution', { method: 'PUT', body: body() })); toast(t('配置已保存')); }); };
  $('#execution-test').onclick = () => act($('#execution-test'), async () => {
    const result = await api('/admin/api/execution/test', { method: 'POST', body: body() });
    $('#execution-status').textContent = t(result.ok ? '节点就绪' : '节点未就绪');
    toast(t(result.ok ? '节点就绪' : '节点未就绪'), !result.ok);
  });

  return {
    async load() {
      for (const input of form.elements) input.disabled = true;
      try { render(await api('/admin/api/execution')); }
      finally { for (const input of form.elements) input.disabled = false; }
    },
  };
}
