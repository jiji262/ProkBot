import { t, html, locale } from './i18n.js';
import { $, item, badge, toggle, menu, empty, button, confirmAction, dialog, copyText } from './ui.js';
import { icon } from './icons.js';

const states = { queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', skipped: '已跳过' };
const tones = { completed: 'success', failed: 'danger', interrupted: 'warn', running: 'accent' };

export function createWebhookEditor({ api, toast, act }) {
  const panel = $('[data-panel=webhooks]');
  panel.innerHTML = html(`<header class="page-header"><h1>Webhook</h1><div class="page-actions"><button id="hook-add" class="btn btn-primary" type="button">添加 Webhook</button></div></header>
    <section class="section"><div id="hook-list" class="card"></div></section>
    <section class="section"><div class="section-head"><h2 class="section-title">运行记录</h2><div class="section-actions"><button id="hook-refresh" class="icon-btn" type="button" aria-label="刷新">${icon('refresh')}</button></div></div><div id="hook-events" class="card"></div></section>
    <dialog id="hook-editor" class="dialog"><form id="hook-form">
      <div class="dialog-head"><h2 id="hook-editor-title">Webhook</h2><button type="button" data-close class="icon-btn" aria-label="关闭">${icon('close')}</button></div>
      <div class="dialog-body">
        <label class="field">名称<input name="name" maxlength="60" required /></label>
        <label class="field">目标 Bot<select name="agentId" required></select></label>
        <label class="field">任务模板<textarea name="prompt" rows="5" maxlength="20000" required></textarea></label>
        <div class="field-grid"><label class="field">事件类型<input name="eventTypes" placeholder="全部，或以逗号分隔" /></label><label class="field">每分钟上限<input name="ratePerMinute" type="number" min="1" max="120" value="30" required /></label></div>
      </div>
      <div class="dialog-foot"><label class="check foot-check"><input name="enabled" type="checkbox" role="switch" checked />启用</label><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn btn-primary">保存</button></div>
    </form></dialog>
    <dialog id="hook-credential" class="dialog">
      <div class="dialog-head"><h2>Webhook 凭证</h2><button type="button" data-close class="icon-btn" aria-label="关闭">${icon('close')}</button></div>
      <div class="dialog-body"><p class="hint">签名密钥只显示这一次，请立即保存。</p><label class="field">请求地址<input id="hook-url" readonly data-private /></label>
        <label class="field">签名密钥<span class="inline-field"><input id="hook-key" type="password" readonly /><button id="hook-key-eye" type="button" class="icon-btn" aria-label="显示或隐藏">${icon('eye')}</button></span></label></div>
      <div class="dialog-foot"><button id="hook-key-copy" type="button" class="btn">复制密钥</button><button type="button" class="btn btn-primary" data-close>完成</button></div>
    </dialog>`);
  const editor = dialog($('#hook-editor')), form = $('#hook-form'), credential = dialog($('#hook-credential'));
  let current = null, hooks = [];
  function showKey(hook) {
    $('#hook-url').value = new URL(hook.path, location.origin).href;
    $('#hook-key').value = hook.key; $('#hook-key').type = 'password'; credential.showModal();
  }
  async function edit(hook) {
    const status = await api('/admin/api/status'); current = hook; form.reset();
    $('#hook-editor-title').textContent = hook ? hook.name : t('添加 Webhook');
    form.elements.agentId.replaceChildren(...status.host.agents.map(agent => new Option(agent.name, agent.id)));
    if (hook) {
      for (const key of ['name', 'agentId', 'prompt', 'ratePerMinute']) form.elements[key].value = hook[key];
      form.elements.eventTypes.value = hook.eventTypes.join(', '); form.elements.enabled.checked = hook.enabled;
    }
    form.elements.agentId.disabled = Boolean(hook); editor.showModal();
  }
  async function loadEvents() {
    const events = await api('/admin/api/webhooks/events'), list = $('#hook-events');
    list.replaceChildren(...(events.length ? events.slice(0, 50).map(event => item({ tile: icon('bolt'),
      title: hooks.find(hook => hook.id === event.hookId)?.name ?? event.hookId, description: event.detail,
      meta: [`${event.eventId} · ${new Date(event.receivedAt).toLocaleString(locale)}`],
      actions: [badge(t(states[event.state] ?? event.state), tones[event.state])] })) : [empty(t('暂无运行记录'))]));
  }
  async function load() {
    hooks = await api('/admin/api/webhooks');
    const list = $('#hook-list');
    list.replaceChildren(...(hooks.length ? hooks.map(hook => {
      const enabled = toggle(hook.enabled, `${hook.name} · ${t('启用')}`);
      enabled.onchange = () => act(enabled, async () => {
        try { await api(`/admin/api/webhooks/${hook.id}`, { method: 'PUT', body: { ...hook, enabled: enabled.checked } }); } finally { await load(); }
      });
      const editButton = button(t('编辑'), { size: 'sm' }); editButton.onclick = () => act(editButton, () => edit(hook));
      const more = menu(t('{0} 的更多操作', hook.name), [
        { label: t('复制地址'), run: trigger => act(trigger, async () => { await copyText(new URL(hook.path, location.origin).href); toast(t('已复制')); }) },
        { label: t('重置密钥'), run: trigger => act(trigger, async () => {
          if (!await confirmAction({ title: t('重置签名密钥？'), message: t('使用旧密钥的请求将被拒绝。'), action: t('重置密钥') })) return;
          showKey({ ...hook, ...await api(`/admin/api/webhooks/${hook.id}/rotate`, { method: 'POST' }) });
        }) },
        { label: t('删除'), danger: true, run: trigger => act(trigger, async () => {
          if (!await confirmAction({ title: t('删除“{0}”？', hook.name), message: t('请求地址将失效。'), action: t('删除') })) return;
          await api(`/admin/api/webhooks/${hook.id}`, { method: 'DELETE' }); await load();
        }) },
      ]);
      const row = item({ tile: icon('bolt'), title: hook.name, meta: [hook.path], actions: [enabled, editButton, more] });
      row.querySelector('.item-meta').dataset.private = '';
      return row;
    }) : [empty(t('还没有 Webhook'), t('外部系统发送签名事件后，由指定 Bot 执行任务。'))]));
    await loadEvents();
  }
  $('#hook-add').onclick = event => act(event.currentTarget, () => edit(null));
  $('#hook-refresh').onclick = event => act(event.currentTarget, loadEvents);
  form.onsubmit = event => { event.preventDefault(); act(event.submitter, async () => {
    const body = { name: form.elements.name.value, agentId: form.elements.agentId.value, prompt: form.elements.prompt.value,
      eventTypes: form.elements.eventTypes.value.split(',').map(value => value.trim()).filter(Boolean),
      ratePerMinute: Number(form.elements.ratePerMinute.value), enabled: form.elements.enabled.checked };
    const saved = await api(`/admin/api/webhooks${current ? `/${current.id}` : ''}`, { method: current ? 'PUT' : 'POST', body });
    editor.close(); await load();
    if (saved.key) showKey(saved); else toast(t('配置已保存'));
  }); };
  $('#hook-key-copy').onclick = event => act(event.currentTarget, async () => { await copyText($('#hook-key').value); toast(t('已复制')); });
  $('#hook-key-eye').onclick = () => { const input = $('#hook-key'); input.type = input.type === 'password' ? 'text' : 'password'; };
  const clearKey = () => { $('#hook-key').value = ''; };
  credential.addEventListener('close', clearKey);
  for (const control of credential.querySelectorAll('[data-close]')) control.addEventListener('click', clearKey);
  return { load };
}
