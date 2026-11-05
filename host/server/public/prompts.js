import { t, html, locale } from './i18n.js';
import { $, node, badge } from './ui.js';
import { icon } from './icons.js';
import { promptDiff } from './prompt-diff.js';

const roles = { parent: '主 Agent', automation: '自动任务', generalPurpose: '通用子 Agent', computerUse: '电脑子 Agent',
  browserUse: '浏览器子 Agent', videoReview: '视频分析', watchVideo: '观看视频' };
const sectionNames = { Spotlight: '重点标记', 'Agent profile': 'Bot 资料', 'User identity': '用户身份', Multitask: '多任务', 'Writing style': '表达风格',
  'MCP accounts': 'MCP 账户', 'User form': '用户表单', 'External message draft': '外部消息草稿', 'Time zone': '时区', Memory: '记忆', Routines: '自动任务',
  Skills: '技能', Purchasing: '支付', Channels: '连接应用', 'Bot directory': 'Bot 目录', 'Group chats': '群组', 'MCP instructions': 'MCP 指令',
  'MCP discovery': 'MCP 发现', 'Execution computer': '执行电脑', 'User computer': '用户电脑' };

export function createPromptEditor({ api, toast, busy }) {
  $('[data-panel=prompts]').innerHTML = html(`<header class="page-header"><h1>提示词</h1><div class="page-actions"><button id="prompt-refresh" class="icon-btn" type="button" aria-label="刷新">${icon('refresh')}</button></div></header>
    <div id="prompt-empty" class="card" hidden><div class="empty"><strong>暂无提示词</strong><span>Host 启动后会提供原版提示词。</span></div></div>
    <section id="prompt-workspace" class="section" hidden>
      <div class="card"><label class="row"><span class="row-copy"><span class="row-title">角色与变体</span><span class="row-hint">基础提示词，保存后用于下一回合。</span></span><span class="row-control wide"><select id="prompt-select"></select><span id="prompt-status" class="badge"></span></span></label></div>
      <div class="prompt-columns">
        <div class="prompt-pane"><label class="field">对照版本<select id="prompt-compare"><option value="original">原版</option><option value="current">当前版本</option><option value="previous">上一个版本</option></select></label><pre id="prompt-source" class="code-block" tabindex="0"></pre></div>
        <label class="field prompt-pane">编辑<textarea id="prompt-draft" class="mono" spellcheck="false" maxlength="200000"></textarea></label>
      </div>
      <div class="card">
        <details id="prompt-diff" class="disclosure"><summary>查看差异 <span id="prompt-diff-count" class="hint"></span></summary><div id="prompt-diff-lines" class="diff"></div></details>
        <details id="prompt-observation" class="disclosure"><summary>最近运行</summary><div class="disclosure-body"><p id="prompt-observed-at" class="hint"></p><pre id="prompt-assembled" class="code-block" tabindex="0"></pre>
          <h3>实际工具</h3><div id="prompt-tools"></div></div></details>
      </div>
      <div class="actions"><small id="prompt-provenance" class="status-text"></small><button id="prompt-restore-original" type="button" class="btn">恢复原版</button><button id="prompt-restore-previous" type="button" class="btn">恢复上一版</button><button id="prompt-save" type="button" class="btn btn-primary">保存</button></div>
    </section>`);
  let selected, entries = [], scheduled = false;
  const perform = async (control, work) => {
    await busy(control, async () => { try { await work(); } catch (error) { toast(error.message, true); } });
    if (selected) { renderDiff(); $('#prompt-restore-original').disabled = selected.content === selected.original; $('#prompt-restore-previous').disabled = !selected.previous; }
  };
  const comparison = () => ({ original: selected.original, previous: selected.previous?.content ?? selected.original })[$('#prompt-compare').value] ?? selected.content;
  function renderDiff() {
    if (!selected) return;
    const lines = promptDiff(comparison(), $('#prompt-draft').value), list = $('#prompt-diff-lines'); list.replaceChildren();
    const added = lines.filter(line => line.kind === 'add').length, removed = lines.filter(line => line.kind === 'remove').length;
    $('#prompt-diff-count').textContent = `+${added} −${removed}`;
    if (!added && !removed) list.append(node('p', 'hint', t('没有差异')));
    else {
      const visible = new Set();
      for (let i = 0; i < lines.length; i++) if (lines[i].kind !== 'same') for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) visible.add(j);
      let last = -1;
      for (const index of [...visible].slice(0, 3000)) {
        if (index > last + 1) list.append(node('div', 'prompt-diff-gap', '⋯'));
        const line = lines[index], element = node('div', `prompt-diff-${line.kind}`);
        element.append(node('span', 'prompt-diff-mark', { same: ' ', add: '+', remove: '−' }[line.kind]), node('code', '', line.line || ' '));
        list.append(element); last = index;
      }
    }
    $('#prompt-save').disabled = $('#prompt-draft').value === selected.content || !$('#prompt-draft').value.trim();
  }
  function show(value) {
    selected = value; $('#prompt-draft').value = value.content;
    $('#prompt-compare [value=previous]').disabled = !value.previous;
    if ($('#prompt-compare').value === 'previous' && !value.previous) $('#prompt-compare').value = 'original';
    $('#prompt-source').textContent = comparison();
    const modified = value.content !== value.original;
    $('#prompt-status').textContent = modified ? `v${value.revision}` : t('原版');
    $('#prompt-status').dataset.tone = modified ? 'accent' : '';
    $('#prompt-restore-original').disabled = !modified;
    $('#prompt-restore-previous').disabled = !value.previous;
    $('#prompt-provenance').textContent = `${value.source} · ${value.digest.slice(0, 12)} · ${t(value.observed ? '已运行' : '默认变体')}`;
    const preview = value.preview, assembled = $('#prompt-assembled'), tools = $('#prompt-tools'); tools.replaceChildren(); assembled.hidden = !preview;
    $('#prompt-observed-at').textContent = preview ? `${new Date(preview.at).toLocaleString(locale)} · v${preview.revision}` : t('尚无运行记录');
    if (preview) {
      assembled.textContent = [preview.base, ...preview.sections.map(section => `## ${locale === 'zh-CN' ? sectionNames[section] ?? section : section}\n[${t('动态内容已隐藏')}]`)].join('\n\n');
      for (const tool of preview.tools ?? []) {
        const line = node('div', 'item'), copy = node('div', 'item-copy');
        copy.append(node('code', 'item-title', tool.name), node('span', 'item-meta', `${tool.source}${tool.identifier ? ` · ${tool.identifier}` : ''}`));
        line.append(copy, badge(t(tool.placement === 'dynamic' ? '动态工具 · 已启用' : '已启用'))); tools.append(line);
      }
    }
    if (!preview?.tools?.length) tools.append(node('p', 'hint', t(preview?.tools ? '无工具' : '尚未记录工具')));
    renderDiff();
  }
  async function load(preferred = selected?.id) {
    entries = await api('/admin/api/prompts');
    entries.sort((a, b) => Number(b.observed) - Number(a.observed) || (b.previewAt ?? b.observedAt) - (a.previewAt ?? a.observedAt));
    $('#prompt-empty').hidden = entries.length > 0; $('#prompt-workspace').hidden = !entries.length;
    const select = $('#prompt-select'); select.replaceChildren();
    for (const entry of entries) select.add(new Option(`${t(roles[entry.role] ?? entry.role)} · ${entry.digest.slice(0, 8)}${entry.modified ? ` · ${t('已修改')}` : ''}`, entry.id));
    if (!entries.length) { selected = null; return; }
    if (entries.some(entry => entry.id === preferred)) select.value = preferred;
    show(await api(`/admin/api/prompts/${select.value}`));
  }
  async function save(restore) {
    const value = await api(`/admin/api/prompts/${selected.id}`, { method: 'PUT', body: { digest: selected.digest, expectedRevision: selected.revision,
      ...(restore ? { restore } : { content: $('#prompt-draft').value }) } });
    await load(value.id); toast(t('配置已保存'));
  }
  $('#prompt-select').onchange = async event => {
    const select = event.target; select.disabled = true;
    try { show(await api(`/admin/api/prompts/${select.value}`)); } catch (error) { toast(error.message, true); } finally { select.disabled = false; }
  };
  $('#prompt-compare').onchange = () => { $('#prompt-source').textContent = comparison(); renderDiff(); };
  $('#prompt-draft').oninput = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; renderDiff(); }); } };
  $('#prompt-refresh').onclick = event => perform(event.currentTarget, () => load());
  $('#prompt-save').onclick = event => perform(event.currentTarget, () => save());
  $('#prompt-restore-original').onclick = event => perform(event.currentTarget, () => save('original'));
  $('#prompt-restore-previous').onclick = event => perform(event.currentTarget, () => save('previous'));
  return { load: () => load() };
}
