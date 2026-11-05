import { t, html, locale } from './i18n.js';
import { $, node, copyText, item, badge, toggle, menu, empty, iconButton } from './ui.js';
import { icon } from './icons.js';

const time = value => value ? new Date(value).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : t('尚未同步');
const fingerprint = value => String(value ?? '').match(/.{1,8}/g)?.join(' ') ?? '';
const states = { queued: '排队中', accepted: '已送达', running: '执行中', completed: '已完成', failed: '失败', interrupted: '已中断', revoked: '已撤销', expired: '已过期' };

export function createFederationEditor({ api, toast, act }) {
  $('[data-panel=federation]').innerHTML = html(`<header class="page-header"><h1>Host 协作</h1><div id="federation-refresh" class="page-actions"></div></header>
    <section class="section"><div class="section-head"><h2 class="section-title">本机</h2></div><div class="card">
      <div class="row"><span class="row-copy"><span id="federation-name" class="row-title"></span></span>
        <span class="row-control auto"><span id="federation-role" class="badge"></span><button id="federation-primary" type="button" class="btn btn-sm" hidden>设为主 Host</button></span></div>
      <div id="federation-identity"></div>
    </div></section>
    <form id="federation-settings" class="section"><div class="section-head"><h2 class="section-title">对外地址</h2></div><div class="card">
      <label class="row"><span class="row-copy"><span class="row-title">Host 地址</span><span class="row-hint">仅主动连接其他 Host 时，地址可留空。</span></span><input name="url" type="text" placeholder="https://host.example.com" data-private /></label>
      <label class="row"><span class="row-copy"><span class="row-title">连接方式</span></span><select name="network"><option value="public">HTTPS</option><option value="tailcat">Tailcat</option><option value="private">私有网络 / Tailscale</option></select></label>
    </div><div class="actions"><button type="submit" class="btn btn-primary">保存</button></div></form>
    <section class="section"><div class="section-head"><h2 class="section-title">已配对的 Host</h2><div class="section-actions"><button id="federation-invite" type="button" class="btn btn-sm">创建邀请</button><button id="federation-accept" type="button" class="btn btn-sm btn-primary">接受邀请</button></div></div>
      <div id="federation-peers" class="card"></div></section>
    <section class="section"><div class="card"><details class="disclosure federation-activity"><summary>协作记录</summary><div id="federation-messages"></div></details></div></section>
    <dialog id="federation-editor" class="dialog"><form id="federation-form">
      <div class="dialog-head"><h2 id="federation-title"></h2><div id="federation-close"></div></div>
      <div id="federation-content" class="dialog-body"></div>
      <div class="dialog-foot"><button type="button" class="btn" id="federation-cancel">取消</button><button type="submit" class="btn btn-primary" id="federation-submit"></button></div>
    </form></dialog>`);
  let config, roster = [], submitWork, invitation = null;
  const editor = $('#federation-editor'), form = $('#federation-form'), content = $('#federation-content');
  const copy = value => copyText(value).then(() => toast(t('已复制')));
  const refresh = iconButton('refresh', t('刷新')); refresh.onclick = () => act(refresh, load); $('#federation-refresh').append(refresh);
  $('#federation-close').append(iconButton('close', t('关闭'), () => editor.close()));
  $('#federation-cancel').onclick = () => editor.close();
  editor.onclose = () => { invitation = null; submitWork = null; content.replaceChildren(); };
  form.onsubmit = event => { event.preventDefault(); if (submitWork) act(event.submitter, submitWork); };

  function identityRow(id) {
    const line = node('div', 'fingerprint'), copyNode = node('div', 'row-copy');
    copyNode.append(node('span', 'row-hint', t('公钥指纹 · SHA-256')), node('code', '', fingerprint(id)));
    const button = iconButton('copy', t('复制指纹')); button.onclick = () => act(button, () => copy(id));
    line.append(copyNode, button); return line;
  }
  function show(title, action, work) {
    content.replaceChildren(); $('#federation-title').textContent = title;
    $('#federation-submit').textContent = action; $('#federation-submit').hidden = false; $('#federation-submit').disabled = false;
    $('#federation-cancel').textContent = t('取消'); submitWork = work;
    if (!editor.open) editor.showModal();
  }
  function botSelection(selected = [], required = true) {
    const section = node('fieldset', 'check-list'); section.append(node('legend', 'field', t('允许协作的本地 Bot')));
    if (!roster.length) section.append(node('p', 'hint', t('暂无 Bot')));
    for (const bot of roster) {
      const label = node('label', 'check'), checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.name = 'allowedBots'; checkbox.value = bot.id; checkbox.checked = selected.includes(bot.id);
      label.append(checkbox, node('span', '', bot.name)); section.append(label);
    }
    const update = () => { if (required) $('#federation-submit').disabled = !section.querySelector('input:checked'); };
    section.onchange = update; content.append(section); update();
    return () => [...section.querySelectorAll('input:checked')].map(input => input.value);
  }
  function networkField(value = false) {
    const label = node('label', 'field', t('连接方式')), select = document.createElement('select');
    select.name = 'network';
    for (const [key, title] of [['public', 'HTTPS'], ['tailcat', 'Tailcat'], ['private', t('私有网络 / Tailscale')]]) select.add(new Option(title, key));
    select.value = value ? 'private' : 'public';
    label.append(select); content.append(label); return () => select.value === 'private';
  }
  function showInvitation(value) {
    invitation = value; show(t('邀请 Host'), '', null);
    const heading = node('div', 'preview'); heading.append(node('h3', '', value.name), identityRow(value.id)); content.append(heading);
    const label = node('label', 'field', t('邀请内容')), area = document.createElement('textarea');
    area.id = 'federation-invitation'; area.rows = 7; area.readOnly = true; area.spellcheck = false; area.className = 'mono'; area.dataset.private = '';
    let revealed = false;
    const render = () => { area.value = JSON.stringify({ ...invitation, token: revealed ? invitation.token : '••••••••', url: !revealed && invitation.url.startsWith('tailcat:') ? '••••••••' : invitation.url }, null, 2); };
    render(); label.append(area); content.append(label);
    const actions = node('div', 'actions');
    const eye = iconButton('eye', t('显示邀请密钥')); eye.setAttribute('aria-pressed', 'false');
    eye.onclick = () => { revealed = !revealed; eye.setAttribute('aria-pressed', String(revealed)); eye.setAttribute('aria-label', revealed ? t('隐藏邀请密钥') : t('显示邀请密钥')); render(); };
    const button = node('button', 'btn btn-primary', t('复制邀请')); button.type = 'button'; button.id = 'federation-copy-invitation';
    button.onclick = () => act(button, () => copy(JSON.stringify(invitation, null, 2)));
    actions.append(node('span', 'status-text', `${t('有效至')} ${time(value.expiresAt)}`), eye, button); content.append(actions);
    $('#federation-submit').hidden = true; $('#federation-cancel').textContent = t('完成');
  }
  function createInvitation() {
    let selected;
    show(t('创建邀请'), t('生成邀请'), async () => {
      showInvitation(await api('/admin/api/federation/invitation', { method: 'POST', body: { allowedBots: selected() } }));
    });
    selected = botSelection();
  }
  function acceptInvitation() {
    let selected, isPrivate;
    show(t('接受邀请'), t('连接'), async () => {
      let value; try { value = JSON.parse(area.value); } catch { throw new Error(t('邀请内容不是有效的 JSON')); }
      await api('/admin/api/federation/accept', { method: 'POST', body: { invitation: value, allowedBots: selected(), privateNetwork: isPrivate() } });
      editor.close(); await load(); toast(t('Host 已连接'));
    });
    const label = node('label', 'field', t('邀请内容')), area = document.createElement('textarea'), header = node('div', 'field-head');
    area.id = 'federation-paste'; area.rows = 3; area.required = true; area.spellcheck = false; area.autocomplete = 'off'; area.className = 'mono federation-secret';
    area.placeholder = t('粘贴邀请 JSON'); area.dataset.private = '';
    const eye = iconButton('eye', t('显示邀请内容')); eye.setAttribute('aria-pressed', 'false');
    eye.onclick = () => { const masked = area.classList.toggle('federation-secret'); eye.setAttribute('aria-pressed', String(!masked)); };
    label.htmlFor = area.id; header.append(label, eye); content.append(header, area);
    const preview = node('div', 'preview'); preview.hidden = true; content.append(preview);
    area.oninput = () => {
      preview.replaceChildren(); preview.hidden = true;
      try {
        const value = JSON.parse(area.value); if (!value.name || !/^[a-f0-9]{64}$/.test(value.id)) return;
        preview.append(node('h3', '', value.name), identityRow(value.id), node('p', 'hint', `${t('有效至')} ${time(value.expiresAt)}`));
        if (Array.isArray(value.bots)) preview.append(node('p', 'hint', value.bots.map(bot => bot.name).join(' · ')));
        preview.hidden = false;
      } catch { /* Keep incomplete pasted input editable. */ }
    };
    isPrivate = networkField(); selected = botSelection();
  }
  function editPeer(peer) {
    let selected, isPrivate, input;
    show(peer.name, t('保存'), async () => {
      await api(`/admin/api/federation/peers/${peer.id}`, { method: 'PUT', body: { allowedBots: selected(), enabled: peer.enabled, url: input.value, privateNetwork: isPrivate() } });
      editor.close(); await load(); toast(t('配置已保存'));
    });
    content.append(identityRow(peer.id));
    const label = node('label', 'field', t('Host 地址')); input = document.createElement('input');
    input.type = 'text'; input.name = 'url'; input.value = peer.url; input.placeholder = 'https://host.example.com'; input.dataset.private = '';
    label.append(input); content.append(label); isPrivate = networkField(peer.privateNetwork); selected = botSelection(peer.allowedBots, false);
  }
  function peerRow(peer) {
    const enabled = toggle(peer.enabled, `${peer.name} · ${t('启用')}`);
    enabled.onchange = () => act(enabled, async () => {
      try { await api(`/admin/api/federation/peers/${peer.id}`, { method: 'PUT', body: { ...peer, enabled: enabled.checked } }); } finally { await load(); }
    });
    const more = menu(t('{0} 的更多操作', peer.name), [
      { label: t('编辑授权'), run: () => editPeer(peer) },
      { label: t('同步'), disabled: !peer.enabled || !peer.url, run: trigger => act(trigger, async () => {
        await api(`/admin/api/federation/peers/${peer.id}/sync`, { method: 'POST' }); await load();
        const error = config.peers.find(value => value.id === peer.id)?.error; toast(error || t('已同步'), Boolean(error));
      }) },
    ]);
    const local = peer.allowedBots.map(id => roster.find(bot => bot.id === id)?.name ?? id);
    const row = item({ tile: icon('swap'), title: peer.name,
      badges: [peer.error ? badge(t('同步失败'), 'danger') : !peer.enabled ? badge(t('已停用')) : badge(t('已连接'), 'success')],
      meta: [`${t('本地 Bot')}：${local.join(' · ') || t('无')}`, `${t('对方 Bot')}：${peer.remoteBots.map(bot => bot.name).join(' · ') || t('无')}`,
        peer.error || `${t('最近同步')} · ${time(peer.lastSyncAt)}`],
      actions: [enabled, more] });
    row.dataset.peer = peer.id; row.classList.add('federation-peer');
    return row;
  }
  function renderMessages() {
    const list = $('#federation-messages'); list.replaceChildren();
    if (!config.messages.length) list.append(empty(t('暂无协作记录')));
    for (const entry of config.messages.slice(0, 50)) {
      const peer = config.peers.find(value => value.id === entry.peerId), outgoing = entry.direction === 'outbound';
      const local = roster.find(bot => bot.id === (outgoing ? entry.fromAgentId : entry.toAgentId))?.name ?? t('本地 Bot');
      const remote = peer?.remoteBots.find(bot => bot.id === (outgoing ? entry.toAgentId : entry.fromAgentId))?.name ?? t('远程 Bot');
      list.append(item({ tile: icon('swap'), title: outgoing ? `${local} → ${remote}` : `${remote} → ${local}`,
        meta: [`${peer?.name ?? ''} · ${time(entry.createdAt)}`], actions: [badge(t(states[entry.state] ?? entry.state))] }));
    }
  }
  async function load() {
    const [value, status] = await Promise.all([api('/admin/api/federation'), api('/admin/api/status')]);
    config = value; roster = (status.host.agents ?? []).filter(bot => !bot.isGroup);
    $('#federation-primary').hidden = config.role !== 'member' || config.peers.some(peer => peer.enabled);
    $('#federation-name').textContent = config.identity.name;
    $('#federation-identity').replaceChildren(identityRow(config.identity.id));
    const settings = $('#federation-settings');
    settings.elements.url.value = config.url;
    settings.elements.network.value = config.url.startsWith('tailcat:') ? 'tailcat' : config.privateNetwork ? 'private' : 'public';
    $('#federation-role').textContent = config.role === 'member' ? t('成员 Host') : t('主 Host');
    $('#federation-invite').hidden = config.role === 'member';
    $('#federation-accept').hidden = config.peers.some(peer => peer.enabled);
    $('#federation-invite').disabled = !config.url || !roster.length;
    $('#federation-invite').title = config.url ? '' : t('请先保存 Host 地址');
    $('#federation-peers').replaceChildren(...(config.peers.length ? config.peers.map(peerRow) : [empty(t('尚未连接其他 Host'), t('创建邀请发给对方，或粘贴对方的邀请。'))]));
    renderMessages();
  }
  $('#federation-settings').onsubmit = event => { event.preventDefault(); act(event.submitter, async () => {
    await api('/admin/api/federation', { method: 'PUT', body: { url: event.target.elements.url.value, privateNetwork: event.target.elements.network.value === 'private' } });
    await load(); toast(t('配置已保存'));
  }); };
  $('#federation-primary').onclick = event => act(event.currentTarget, async () => {
    await api('/admin/api/federation', { method: 'PUT', body: { role: 'primary', url: config.url, privateNetwork: config.privateNetwork } }); await load();
  });
  $('#federation-invite').onclick = createInvitation;
  $('#federation-accept').onclick = acceptInvitation;
  return { load };
}
