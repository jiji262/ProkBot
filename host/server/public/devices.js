import { t, html } from './i18n.js';
import { $, node, item, badge, menu, empty, button, confirmAction, date, dialog } from './ui.js';
import { icon } from './icons.js';
import { createPushEditor } from './push.js';
import { createNotifications } from './notifications.js';

const kinds = { iphone: 'iPhone', ipad: 'iPad', mac: 'Mac', desktop: '电脑', ios: 'iPhone / iPad' };
const permissions = { authorized: '已允许', granted: '已允许', provisional: '临时允许', ephemeral: '临时允许', denied: '已拒绝',
  notDetermined: '尚未询问', not_determined: '尚未询问', unknown: '尚未报告' };

export function createDevices(context) {
  const { api, toast, busy, refresh, copy } = context;
  $('[data-panel=devices]').innerHTML = html(`<header class="page-header"><h1>设备与通知</h1><div class="page-actions"><button id="create-key" class="btn btn-primary" type="button">创建配对码</button></div></header>
    <section class="section"><div class="section-head"><h2 class="section-title">通知偏好</h2></div><div class="card">
      <label class="row"><span class="row-copy"><span class="row-title">通知频率</span><span class="row-hint">适用于手机和 Mac；授权与提问仍会提醒。</span></span>
        <select id="notification-frequency" aria-label="通知频率"><option value="every-reply">每条回复</option><option value="task-complete">仅任务完成</option></select>
      </label>
    </div></section>
    <section id="pairing-panel" class="section" hidden><div class="section-head"><h2 class="section-title">配对码</h2></div><div class="card">
      <div class="row"><span class="row-copy"><span id="pairing-value" class="pairing-value" data-private></span><span id="pairing-expiry" class="row-hint"></span></span><button id="copy-key" class="btn" type="button">复制</button></div>
    </div></section>
    <section class="section"><div class="section-head"><h2 class="section-title">已配对设备</h2><span id="device-badge" class="badge">0 台</span></div><div id="device-list" class="card"></div></section>
    <section class="section"><div class="section-head"><h2 class="section-title">测试通知</h2></div><div class="card">
      <label class="row"><span class="row-copy"><span class="row-title">目标会话</span><span class="row-hint">打开通知后进入此会话</span></span><select id="device-test-agent"></select></label>
      <div class="row"><span class="row-copy"><span class="row-title">在线通知</span><span class="row-hint">发送给已连接的客户端</span></span><button id="test-notification" class="btn" type="button" disabled>发送测试</button></div>
      <div class="row"><span class="row-copy"><span class="row-title">Bark</span></span><span id="bark-status" class="row-value">正在读取</span></div>
    </div></section>
    <form id="push-form" class="section"></form>
    <section class="section"><div class="section-head"><h2 class="section-title">最近通知</h2></div><div id="notification-list" class="card"></div></section>`);
  const push = createPushEditor(context), notifications = createNotifications(context);
  let devices = [], agents = [], pairingKey = '', pairingId = '', pairingExpires = 0;
  const operations = new Set();
  const renameDialog = node('dialog', 'dialog');
  renameDialog.id = 'device-name-dialog';
  renameDialog.setAttribute('aria-labelledby', 'device-name-title');
  renameDialog.innerHTML = html(`<form><div class="dialog-head"><h2 id="device-name-title">重命名设备</h2></div>
    <div class="dialog-body"><label class="field">设备名称<input name="name" required maxlength="80" autocomplete="off" data-private /></label></div>
    <div class="dialog-foot"><button class="btn" type="button" data-close>取消</button><button class="btn btn-primary" type="submit">保存</button></div></form>`);
  dialog(renameDialog); document.body.append(renameDialog);
  let editingDevice;
  $('form', renameDialog).onsubmit = event => {
    event.preventDefault();
    const name = $('[name=name]', renameDialog).value.trim();
    if (!name) return;
    return busy($('[type=submit]', renameDialog), async () => {
      try {
        await api(`/admin/api/devices/${editingDevice.id}`, { method: 'PATCH', body: { name } });
        renameDialog.close(); await refresh();
      } catch (error) { toast(error.message, true); }
    });
  };

  function agentOptions() {
    const select = $('#device-test-agent'), selection = select.value;
    const options = agents.map(agent => new Option(agent.name || agent.id, agent.id));
    select.replaceChildren(...(options.length ? options : [new Option(t('创建会话后可测试推送'), '')]));
    if (agents.some(agent => agent.id === selection)) select.value = selection;
    $('#test-notification').disabled = !select.value;
  }
  function deviceRow(device) {
    const notice = device.push || {}, label = t(kinds[device.kind] || kinds[device.platform] || '设备');
    const badges = [badge(notice.provider === 'apns' ? 'Apple APNs' : notice.provider === 'bark' ? 'Bark' : t('在线通知'))];
    if (notice.provider === 'apns') badges.push(badge(t('权限：{0}', t(permissions[notice.authorization] || notice.authorization || '尚未报告')), notice.authorization === 'denied' ? 'warn' : ''));
    if (device.platform === 'ios' && notice.provider !== 'bark' && notice.capable === false) badges.push(badge(t('未提供 APNs 权限'), 'warn'));
    if (notice.provider === 'apns' && notice.environment) badges.push(badge(['sandbox', 'development'].includes(notice.environment) ? t('开发环境') : t('生产环境')));
    if (notice.configured) badges.push(badge(notice.enabled ? t('推送已启用') : t('推送已关闭'), notice.enabled ? 'success' : ''));
    const meta = [t('{0}{1} · 最近连接 {2}', label, device.appVersion ? ` · ${device.appVersion}` : '', date(device.lastSeenAt)), device.bundleId,
      notice.barkHost && t('Bark 服务：{0}', notice.barkHost),
      notice.lastAttemptAt && t('最近尝试 {0}{1}', date(notice.lastAttemptAt), notice.lastDeliveredAt ? t(' · 服务接收 {0}', date(notice.lastDeliveredAt)) : '')];
    const actions = [];
    if (device.revokedAt) actions.push(badge(t('已撤销 · {0}', date(device.revokedAt))));
    else {
      const test = button(t('测试推送'), { size: 'sm' });
      test.setAttribute('aria-label', `${t('测试推送')} ${device.name}`);
      test.disabled = operations.has(device.id) || !$('#device-test-agent').value;
      test.onclick = () => operate(test, device, async () => {
        const result = await api(`/admin/api/devices/${device.id}/push/test`, { method: 'POST', body: { agentId: $('#device-test-agent').value } });
        toast(result.status === 'sent' ? t('推送服务已接收测试通知') : result.status === 'queued' ? t('测试通知已排队') : result.reason || t('当前设备未发送推送'),
          !['sent', 'queued'].includes(result.status));
      });
      actions.push(test, menu(t('{0} 的更多操作', device.name), [
        { label: t('重命名设备'), run: () => {
          editingDevice = device; $('[name=name]', renameDialog).value = device.name;
          renameDialog.showModal(); $('[name=name]', renameDialog).select();
        } },
        notice.configured && { label: notice.enabled ? t('关闭推送') : t('启用推送'), run: trigger => operate(trigger, device, async () => {
          await api(`/admin/api/devices/${device.id}/push`, { method: 'PUT', body: { enabled: !notice.enabled } });
          toast(notice.enabled ? t('设备推送已关闭') : t('设备推送已启用'));
        }) },
        { label: t('撤销设备'), danger: true, run: trigger => operate(trigger, device, async () => {
          if (!await confirmAction({ title: t('撤销设备连接？'), message: t('“{0}”的现有连接和推送会停用。再次使用时，需要新的配对码。', device.name), action: t('撤销连接') })) return;
          await api(`/admin/api/devices/${device.id}/revoke`, { method: 'POST' });
          toast(t('设备连接与推送已撤销'));
        }) },
      ]));
    }
    const row = item({ tile: icon('devices'), title: device.name, badges, meta, actions });
    row.classList.add('device-row'); if (device.revokedAt) row.classList.add('revoked');
    row.querySelector('.item-title span').dataset.private = '';
    for (const error of [notice.lastError, notice.registrationError].filter(Boolean)) row.querySelector('.item-copy').append(node('p', 'error', error));
    return row;
  }
  function operate(control, device, work) {
    return busy(control, async () => {
      operations.add(device.id);
      try { await work(); } catch (error) { toast(error.message, true); }
      finally { operations.delete(device.id); await refresh(); }
    });
  }
  function render() {
    agentOptions();
    const active = devices.filter(device => !device.revokedAt).reverse(), revoked = devices.filter(device => device.revokedAt).reverse();
    $('#device-badge').textContent = t('{0} 台', active.length);
    const rows = active.map(deviceRow);
    if (!active.length) rows.push(empty(t('还没有连接的设备'), t('创建配对码，在客户端输入服务地址和配对码。')));
    if (revoked.length) {
      const history = node('details', 'disclosure revoked-devices');
      history.open = $('.revoked-devices')?.open || false;
      history.append(node('summary', '', t('已撤销设备（{0}）', revoked.length)), ...revoked.map(deviceRow));
      rows.push(history);
    }
    $('#device-list').replaceChildren(...rows);
  }
  $('#device-test-agent').addEventListener('change', render);
  $('#copy-key').addEventListener('click', () => copy(pairingKey));
  $('#create-key').addEventListener('click', () => busy($('#create-key'), async () => {
    try {
      const result = await api('/admin/api/pairing-keys', { method: 'POST' });
      pairingKey = result.pairingKey; pairingId = result.id; pairingExpires = Date.parse(result.expiresAt);
      $('#pairing-value').textContent = pairingKey;
      $('#pairing-expiry').textContent = t('有效至 {0} · 仅限一台设备使用', date(result.expiresAt));
      $('#pairing-panel').hidden = false; $('#copy-key').disabled = false;
    } catch (error) { toast(error.message, true); }
  }));
  setInterval(() => {
    if (pairingKey && Date.now() >= pairingExpires) { $('#pairing-expiry').textContent = t('配对码已过期'); $('#copy-key').disabled = true; }
  }, 1000);
  return {
    async load() { await Promise.all([notifications.load(), push.load()]); },
    status(state, active) {
      devices = state.devices; agents = state.host.agents;
      render();
      if (pairingId && Date.now() < pairingExpires && !state.pairingKeys?.some(key => key.id === pairingId)) {
        $('#pairing-expiry').textContent = t('配对码已使用'); $('#copy-key').disabled = true;
      }
      notifications.status(state);
      if (active) notifications.loadEvents().catch(() => {});
    },
    reset() {
      devices = []; agents = []; pairingKey = ''; pairingId = ''; pairingExpires = 0;
      $('#pairing-panel').hidden = true; push.reset();
    },
  };
}
