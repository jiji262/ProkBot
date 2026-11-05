import { grokText as text } from './i18n.mjs';
const server = document.querySelector('#server');
const tailcat = document.querySelector('#tailcat');
tailcat.onchange = () => { server.placeholder = tailcat.checked ? 'tailcat://connect/…' : 'https://bot.example.com'; };
const key = document.querySelector('#key');
const status = document.querySelector('#status');
const connect = document.querySelector('#connect');
const disconnect = document.querySelector('#disconnect');
document.documentElement.lang = /^zh/i.test(window.connection.locale) ? 'zh-CN' : 'en';
document.title = text('连接 Grok Bot', 'Connect Grok Bot');
document.querySelector('h1').textContent = text('连接你的 Grok Bot', 'Connect your Grok Bot');
document.querySelector('[for=server]').textContent = text('Host 地址', 'Host address');
document.querySelector('[for=key]').textContent = text('配对码', 'Pairing code');
key.placeholder = text('配对码', 'Pairing code');
connect.textContent = text('连接', 'Connect');
key.addEventListener('input', () => { key.value = key.value.toUpperCase(); });
disconnect.textContent = text('退出连接', 'Disconnect');
window.connection.status().then(result => {
  server.value = result.server ?? ''; tailcat.checked = result.tailcat === true; tailcat.onchange();
  disconnect.hidden = !result.connected;
  if (result.error) status.textContent = result.error;
  if (result.connected) connect.textContent = text('重新配对', 'Pair again');
});
document.querySelector('#form').addEventListener('submit', async event => {
  event.preventDefault(); connect.disabled = true; disconnect.disabled = true;
  status.textContent = text('正在连接…', 'Connecting…'); status.style.color = '#aaa';
  try {
    const result = await window.connection.pair(server.value, key.value, tailcat.checked);
    if (!result.ok) throw new Error(result.error);
    key.value = ''; status.textContent = text('已连接', 'Connected');
  } catch (error) { status.textContent = error.message; status.style.color = '#f09b94'; }
  finally { connect.disabled = false; disconnect.disabled = false; }
});
disconnect.addEventListener('click', async () => {
  await window.connection.disconnect(); key.value = ''; disconnect.hidden = true;
  connect.textContent = text('连接', 'Connect'); status.textContent = text('已断开', 'Disconnected');
});
