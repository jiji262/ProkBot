import { t, html } from './i18n.js';
import { $ } from './ui.js';

const capabilities = [
  ['dreaming', '后台记忆整理', '自动整理已有记忆，会使用模型 Token'],
  ['browserUse', '浏览器子 Agent', '在执行电脑的浏览器中完成网页任务'],
  ['userForm', '交互表单', '需要用户填写信息时显示表单'],
  ['browserLoginImport', '导入浏览器登录状态', '从 Mac 客户端导入网站登录'],
  ['passkeys', '通行密钥', '经客户端完成 WebAuthn 登录'],
  ['macComputer', 'Mac 图形操作', '在已连接的 Mac 上点击和输入'],
  ['teachTask', '演示任务', '录制操作并整理成技能'],
];

export function createHarnessEditor({ api, toast }) {
  $('[data-panel=harness]').innerHTML = html(`<header class="page-header"><h1>内置能力</h1></header>
    <form id="harness-form" class="section"><div class="card">${capabilities.map(([name, title, hint]) =>
      `<label class="row"><span class="row-copy"><span class="row-title">${title}</span><span class="row-hint">${hint}</span></span><input name="${name}" type="checkbox" role="switch" /></label>`).join('')}
    </div></form>`);
  const form = $('#harness-form'), switches = [...form.querySelectorAll('input[name]')];
  async function save(changed) {
    for (const input of switches) input.disabled = true;
    try {
      await api('/admin/api/harness', { method: 'PUT', body: Object.fromEntries(switches.map(input => [input.name, input.checked])) });
      toast(t('配置已保存'));
    } catch (error) { changed.checked = !changed.checked; toast(error.message, true); }
    finally { for (const input of switches) input.disabled = false; }
  }
  for (const input of switches) input.addEventListener('change', () => save(input));
  return {
    async load() {
      for (const input of switches) input.disabled = true;
      try {
        const config = await api('/admin/api/harness');
        for (const input of switches) input.checked = Boolean(config[input.name]);
      } finally { for (const input of switches) input.disabled = false; }
    },
  };
}
