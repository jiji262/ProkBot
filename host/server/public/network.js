import { t, html } from './i18n.js';
import { $, node, copyText, confirmAction, iconButton } from './ui.js';
import { icon } from './icons.js';

const states = { ready: ['已就绪', 'success'], connecting: ['正在连接', 'warn'], reconnecting: ['正在重新连接', 'warn'], disabled: ['未启用', ''] };

export function createNetworkEditor({ api, toast, act, copy }) {
  $('[data-panel=network]').innerHTML = html(`<header class="page-header"><h1>远程访问</h1></header>
    <section class="section"><div class="section-head"><h2 class="section-title">Host 地址</h2></div><div class="card">
      <div class="row"><span class="row-copy"><span class="row-title">连接地址</span><span class="row-hint">同一网络内的客户端使用此地址</span></span>
        <span class="row-control auto"><code id="network-public-url" class="row-value" data-private></code><button id="network-copy-address" class="icon-btn" type="button" aria-label="复制服务地址">${icon('copy')}</button></span></div>
    </div></section>
    <form id="network-form" class="section"><div class="section-head"><h2 class="section-title">Tailcat</h2></div><div class="card">
      <label class="row"><span class="row-copy"><span class="row-title">启用 Tailcat</span><span class="row-hint">跨网络时通过加密中继连接 Host</span></span><input name="enabled" type="checkbox" role="switch" aria-label="Tailcat" /></label>
      <div class="row"><span class="row-copy"><span class="row-title">状态</span></span><span id="network-status" class="status" role="status"></span></div>
      <div class="row"><span class="row-copy"><span class="row-title">连接链接</span><span class="row-hint">在客户端粘贴链接或扫描二维码</span></span>
        <span class="row-control auto"><button type="button" id="network-test" class="btn">测试连接</button><button type="button" id="network-qr" class="icon-btn" aria-label="二维码">${icon('qr')}</button><button type="button" id="network-copy" class="btn">复制连接链接</button></span></div>
      <details class="disclosure"><summary>高级设置</summary>
        <label class="row"><span class="row-copy"><span class="row-title">中继域名</span></span><input name="relay" placeholder="derp.example.com" spellcheck="false" /></label>
        <label class="row"><span class="row-copy"><span class="row-title">DERP 配置地址</span><span class="row-hint">留空使用公共中继</span></span><input name="derpMapURL" type="url" placeholder="https://example.com/derpmap.json" spellcheck="false" /></label>
        <div class="row"><span class="row-copy"><span class="row-title">更换连接链接</span><span class="row-hint">现有 Tailcat 连接将断开</span></span><button type="button" id="network-rotate" class="btn btn-danger">更换</button></div>
      </details>
    </div><div class="actions"><button type="submit" class="btn btn-primary">保存</button></div></form>`);
  const form = $('#network-form');
  let publicUrl = '';
  function render(value) {
    form.elements.enabled.checked = value.enabled;
    form.elements.relay.value = value.relay; form.elements.derpMapURL.value = value.derpMapURL;
    const [label, tone] = states[value.state] ?? [value.state, ''];
    $('#network-status').textContent = t(label); $('#network-status').dataset.tone = tone;
    for (const id of ['network-copy', 'network-qr', 'network-test']) $(`#${id}`).disabled = value.state !== 'ready';
    $('#network-rotate').disabled = !value.enabled;
  }
  async function save(rotate = false) {
    render(await api('/admin/api/network', { method: 'PUT', body: { enabled: form.elements.enabled.checked,
      relay: form.elements.relay.value, derpMapURL: form.elements.derpMapURL.value, rotate } }));
    toast(t('已保存'));
  }
  form.onsubmit = event => { event.preventDefault(); act(event.submitter, () => save()); };
  $('#network-copy-address').onclick = () => copy(publicUrl);
  $('#network-copy').onclick = () => act($('#network-copy'), async () => {
    const { link } = await api('/admin/api/network/link', { method: 'POST' }); await copyText(link); toast(t('已复制'));
  });
  $('#network-test').onclick = () => act($('#network-test'), async () => {
    const result = await api('/admin/api/network/test', { method: 'POST' });
    toast(result.path === 'direct' ? t('直接连接') : t('连接成功'));
  });
  $('#network-qr').onclick = () => act($('#network-qr'), async () => {
    const result = await api('/admin/api/network/qr', { method: 'POST' });
    const qr = node('dialog', 'dialog qr-dialog'), head = node('div', 'dialog-head'), body = node('div', 'dialog-body');
    head.append(node('h2', '', t('Tailcat 连接链接')), iconButton('close', t('关闭'), () => qr.close()));
    const image = document.createElement('img'); image.alt = 'Tailcat QR'; image.dataset.private = '';
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}`;
    body.append(image); qr.append(head, body); qr.onclose = () => qr.remove();
    document.body.append(qr); qr.showModal();
  });
  $('#network-rotate').onclick = () => act($('#network-rotate'), async () => {
    if (await confirmAction({ title: t('更换连接链接？'), message: t('现有 Tailcat 连接将断开，需要更新各设备的链接。'), action: t('更换') })) await save(true);
  });
  return {
    async load() { render(await api('/admin/api/network')); },
    status(state) { publicUrl = state.publicUrl; $('#network-public-url').textContent = publicUrl; },
  };
}
