import { t, html } from './i18n.js';
import { $ } from './ui.js';

export function createGeneral({ api, toast, busy }) {
  const panel = $('[data-panel=general]');
  panel.innerHTML = html(`<header class="page-header"><h1>通用</h1></header>
    <form id="profile-form" class="section">
      <div class="section-head"><h2 class="section-title">账户</h2></div>
      <div class="card">
        <div class="row profile-row">
          <span id="profile-picture" class="avatar profile-avatar" data-private><img id="profile-avatar" alt="" hidden /><span id="profile-initial" aria-hidden="true"></span></span>
          <span class="row-copy"><span class="row-title">头像</span><span class="row-hint">PNG、JPEG 或 WebP，最大 2 MiB</span></span>
          <span class="row-control auto"><button type="button" id="remove-avatar" class="btn btn-ghost" disabled>移除</button><button type="button" id="choose-avatar" class="btn">上传</button></span>
          <input id="avatar-file" type="file" accept="image/png,image/jpeg,image/webp" hidden />
        </div>
        <label class="row"><span class="row-copy"><span class="row-title">用户名</span></span><input name="displayName" autocomplete="nickname" maxlength="160" required placeholder="本地工作区" data-private /></label>
        <label class="row"><span class="row-copy"><span class="row-title">Host 昵称</span><span class="row-hint">显示在客户端和协作 Host 中</span></span><input name="hostName" maxlength="160" required placeholder="Grok Bot Host" /></label>
      </div>
      <p id="profile-error" class="error" role="alert" hidden></p>
      <div class="actions"><span id="profile-saved" class="status-text" role="status"></span><button type="submit" class="btn btn-primary" disabled>保存</button></div>
    </form>
    <section class="section">
      <div class="section-head"><h2 class="section-title">外观</h2></div>
      <div class="card"><label class="row"><span class="row-copy"><span class="row-title">主题</span></span>
        <select data-theme-picker class="compact-select"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label></div>
    </section>
    <section class="section">
      <div class="section-head"><h2 class="section-title">管理员</h2></div>
      <div class="card"><div class="row"><span class="row-copy"><span class="row-title">退出登录</span><span class="row-hint">再次进入需要管理员密码</span></span><button id="logout" type="button" class="btn">退出登录</button></div></div>
    </section>`);
  const form = $('#profile-form'), name = form.elements.displayName, hostName = form.elements.hostName;
  const picker = $('#avatar-file'), image = $('#profile-avatar'), initial = $('#profile-initial');
  const error = $('#profile-error'), note = $('#profile-saved'), save = form.querySelector('[type=submit]');
  let avatarDataUrl = null, dirty = false, pending = false, loaded = false;

  function account() {
    const avatar = $('#account-avatar'), label = name.value.trim() || t('本地工作区');
    avatar.replaceChildren();
    if (avatarDataUrl) { const img = document.createElement('img'); img.src = avatarDataUrl; img.alt = ''; avatar.append(img); }
    else avatar.textContent = [...label][0];
    $('#account-name').textContent = label;
  }
  function preview() {
    image.hidden = !avatarDataUrl;
    if (avatarDataUrl) image.src = avatarDataUrl; else image.removeAttribute('src');
    initial.hidden = Boolean(avatarDataUrl);
    initial.textContent = [...name.value.trim()][0] || t('本');
    $('#remove-avatar').disabled = !avatarDataUrl;
  }
  function changed() {
    dirty = true; save.disabled = false;
    note.textContent = t('有未保存的修改'); error.hidden = true; preview();
  }
  function render(value) {
    error.hidden = true; name.value = value.displayName; hostName.value = value.hostName;
    avatarDataUrl = value.avatarDataUrl; dirty = false; loaded = true; save.disabled = true;
    note.textContent = ''; preview(); account();
  }
  async function load() {
    if (pending || dirty) return;
    pending = true;
    try { render(await api('/admin/api/profile')); }
    catch (failure) { error.textContent = failure.message; error.hidden = false; }
    finally { pending = false; }
  }
  name.addEventListener('input', changed);
  hostName.addEventListener('input', changed);
  $('#choose-avatar').addEventListener('click', () => picker.click());
  $('#remove-avatar').addEventListener('click', () => { avatarDataUrl = null; picker.value = ''; changed(); });
  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error(t('头像最大为 2 MiB'));
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(t('请选择 PNG、JPEG 或 WebP 图片'));
      const value = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error(t('图片读取失败，请重新选择')));
        reader.readAsDataURL(file);
      });
      const test = new Image(); test.src = value;
      await test.decode().catch(() => { throw new Error(t('图片无法打开，请选择有效的图片')); });
      avatarDataUrl = value; changed();
    } catch (failure) { error.textContent = failure.message; error.hidden = false; }
    finally { picker.value = ''; }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    error.hidden = true;
    busy(save, async () => {
      try {
        if ([...name.value.trim()].length > 80) throw new Error(t('用户名最多为 80 个字符'));
        render(await api('/admin/api/profile', { method: 'PUT', body: { displayName: name.value, avatarDataUrl, hostName: hostName.value } }));
        toast(t('用户资料已保存'));
      } catch (failure) { error.textContent = failure.message; error.hidden = false; }
    }).then(() => { save.disabled = !dirty; });
  });
  $('#logout').addEventListener('click', () => busy($('#logout'), async () => {
    try { await api('/admin/api/logout', { method: 'POST' }); document.dispatchEvent(new Event('grokbot:logout')); }
    catch (failure) { toast(failure.message, true); }
  }));
  return {
    load,
    status() { if (!loaded) load(); },
    reset() { dirty = false; loaded = false; avatarDataUrl = null; name.value = ''; hostName.value = ''; preview(); },
  };
}
