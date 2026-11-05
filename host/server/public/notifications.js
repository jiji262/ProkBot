import { t } from './i18n.js';
import { $, node, empty, date } from './ui.js';

export function createNotifications({ api, toast, busy, refresh }) {
  const frequency = $('#notification-frequency');
  let saving = false, selected = 'every-reply';
  function status(state) {
    if (!saving) frequency.value = selected = state.notifications.frequency ?? 'every-reply';
    const enabled = state.devices.filter(device => !device.revokedAt && device.push?.provider === 'bark' && device.push.enabled).length;
    $('#bark-status').textContent = enabled ? t('{0} 台设备启用', enabled) : t('尚无设备启用');
  }
  frequency.addEventListener('change', async () => {
    const previous = selected; saving = true;
    try {
      await busy(frequency, async () => {
        const result = await api('/admin/api/notification-settings', { method: 'PUT', body: { frequency: frequency.value } });
        frequency.value = selected = result.frequency; toast(t('已保存'));
      });
    } catch (error) { frequency.value = selected = previous; toast(error.message, true); }
    finally { saving = false; }
  });
  async function loadEvents() {
    const { items } = await api('/admin/api/notifications');
    if (!items.length) return $('#notification-list').replaceChildren(empty(t('暂时没有通知'), t('选择一个会话，发送测试通知。')));
    $('#notification-list').replaceChildren(...items.map(entry => {
      const row = node('div', 'item notification-row'), copy = node('div', 'item-copy'), time = node('time', 'item-meta', date(entry.createdAt));
      copy.append(node('span', 'item-title', entry.title), node('p', 'item-desc', entry.body));
      time.dateTime = entry.createdAt;
      row.append(copy, time);
      return row;
    }));
  }
  $('#test-notification').addEventListener('click', () => busy($('#test-notification'), async () => {
    try {
      await api('/admin/api/notifications/test', { method: 'POST', body: { agentId: $('#device-test-agent').value } });
      toast(t('测试通知已保存并发送给在线客户端'));
      await refresh(); await loadEvents();
    } catch (error) { toast(error.message, true); }
  }));
  return { status, loadEvents, load: loadEvents };
}
