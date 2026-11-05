import { t, html } from './i18n.js';
import { $, fileText, errorText, date, filePicker } from './ui.js';

const row = (title, control, { hint = '', id = '', hidden = false } = {}) =>
  `<label class="row"${id ? ` id="${id}"` : ''}${hidden ? ' hidden' : ''}><span class="row-copy"><span class="row-title">${title}</span>${hint}</span>${control}</label>`;

export function createPushEditor({ api, toast, busy }) {
  const form = $('#push-form');
  form.innerHTML = html(`<div class="section-head"><h2 class="section-title">Apple 推送</h2><span id="apns-status" class="badge">正在读取</span></div>
    <div class="card">
      ${row('启用 Apple APNs', '<input name="enabled" type="checkbox" role="switch" />')}
      ${row('认证方式', '<select name="mode"><option value="token">签名密钥（p8）</option><option value="certificate">证书与私钥（PEM）</option></select>')}
      ${row('应用 Bundle ID', '<input name="topic" placeholder="com.example.GrokBot" maxlength="255" spellcheck="false" />', { hint: '<span class="row-hint">与客户端 Bundle ID 一致</span>' })}
      <div id="apns-token-fields">
        ${row('Team ID', '<input name="teamId" maxlength="10" spellcheck="false" placeholder="Apple 开发者 Team ID" />')}
        ${row('Key ID', '<input name="keyId" maxlength="10" spellcheck="false" placeholder="APNs 签名密钥 ID" />')}
      </div>
      <label class="row"><span class="row-copy"><span id="apns-key-label" class="row-title">签名私钥（p8）</span><span id="apns-key-status" class="row-hint">选择 p8 或 PEM 文件</span></span><input id="apns-key-file" type="file" accept=".p8,.pem,.key" /></label>
      <label id="apns-certificate-field" class="row" hidden><span class="row-copy"><span class="row-title">APNs 证书（PEM）</span><span id="apns-certificate-status" class="row-hint">PEM 格式</span></span><input id="apns-certificate-file" type="file" accept=".pem,.crt,.cer" /></label>
      <p id="apns-mode-note" class="hint" hidden></p>
      ${row('清除已保存的推送凭证', '<input name="clearCredentials" type="checkbox" />')}
      ${row('Bark 图标地址', '<input name="barkIconUrl" type="url" maxlength="2048" placeholder="https://example.com/grok-bot-icon.png" spellcheck="false" />', { hint: '<span class="row-hint">留空使用官方图标；Bark 必须能访问此地址。</span>' })}
    </div>
    <p id="push-error" class="error" role="alert" hidden></p>
    <div class="actions"><span id="push-save-status" class="status-text">正在读取设置…</span><button type="submit" class="btn btn-primary" disabled>保存</button></div>`);
  const save = form.querySelector('[type="submit"]');
  const showKeyFile = filePicker($('#apns-key-file')), showCertificateFile = filePicker($('#apns-certificate-file'));
  let saved = null, dirty = false, pending = false;
  function mode() {
    const certificate = form.elements.mode.value === 'certificate';
    $('#apns-token-fields').hidden = certificate;
    $('#apns-certificate-field').hidden = !certificate;
    $('#apns-key-label').textContent = certificate ? t('证书私钥（PEM）') : t('签名私钥（p8）');
    $('#apns-mode-note').textContent = saved && saved.mode !== form.elements.mode.value ? t('请选择对应凭证') : '';
    $('#apns-mode-note').hidden = !$('#apns-mode-note').textContent;
  }
  function render(value) {
    saved = value; dirty = false;
    for (const name of ['mode', 'teamId', 'keyId', 'topic', 'barkIconUrl']) form.elements[name].value = value[name] || (name === 'mode' ? 'token' : '');
    form.elements.enabled.checked = value.enabled;
    form.elements.clearCredentials.checked = false;
    $('#apns-key-file').value = ''; $('#apns-certificate-file').value = ''; showKeyFile(); showCertificateFile();
    $('#apns-key-status').textContent = value.hasPrivateKey ? t('私钥已保存') : t('请选择 p8 或 PEM 文件');
    $('#apns-certificate-status').textContent = value.hasCertificate
      ? t('证书已保存{0}。留空保留。', value.certificateExpiresAt ? t(' · 有效至 {0}', date(value.certificateExpiresAt)) : '')
      : t('尚未保存 APNs 证书。');
    const configured = value.hasPrivateKey && value.topic && (value.mode === 'certificate' ? value.hasCertificate : value.teamId && value.keyId);
    const status = $('#apns-status');
    status.textContent = value.ready ? t('已启用') : configured && !value.enabled ? t('已配置，未启用') : t('尚未配置完成');
    status.dataset.tone = value.ready ? 'success' : '';
    $('#push-save-status').textContent = ''; $('#push-error').hidden = true;
    save.disabled = true; mode();
  }
  form.addEventListener('input', () => {
    dirty = true; save.disabled = false;
    $('#push-save-status').textContent = t('有未保存的修改'); $('#push-error').hidden = true;
  });
  form.elements.mode.addEventListener('change', mode);
  form.elements.clearCredentials.addEventListener('change', () => { if (form.elements.clearCredentials.checked) form.elements.enabled.checked = false; });
  form.addEventListener('submit', event => {
    event.preventDefault();
    busy(save, async () => {
      try {
        const body = { enabled: form.elements.enabled.checked, mode: form.elements.mode.value, topic: form.elements.topic.value.trim(),
          teamId: form.elements.teamId.value.trim(), keyId: form.elements.keyId.value.trim(),
          clearCredentials: form.elements.clearCredentials.checked, barkIconUrl: form.elements.barkIconUrl.value.trim() };
        const privateKey = await fileText($('#apns-key-file')), certificate = await fileText($('#apns-certificate-file'));
        if (privateKey !== undefined) body.privateKey = privateKey;
        if (certificate !== undefined && body.mode === 'certificate') body.certificate = certificate;
        render(await api('/admin/api/push', { method: 'PUT', body }));
        toast(t('推送设置已保存'));
      } catch (error) { errorText('#push-error', error); }
    }).then(() => { save.disabled = !dirty; });
  });
  return {
    async load() {
      if (pending || dirty) return;
      pending = true;
      try { render(await api('/admin/api/push')); }
      catch (error) { errorText('#push-error', error); }
      finally { pending = false; }
    },
    reset() { saved = null; dirty = false; form.reset(); save.disabled = true; },
  };
}
