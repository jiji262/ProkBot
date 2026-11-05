import { t, localize } from './i18n.js';

const successful = new URLSearchParams(location.search).get('status') === 'success';
localize(document.body);
if (successful) {
  const mark = document.querySelector('#result-icon');
  mark.textContent = '✓'; mark.classList.add('success');
  document.querySelector('#result-title').textContent = t('应用已连接');
  document.querySelector('#result-description').textContent = t('返回 Grok Bot 即可使用。');
}
document.title = `${successful ? t('应用已连接') : t('授权未完成')} · Grok Bot`;
history.replaceState(null, '', location.pathname + (successful ? '?status=success' : '?status=error'));
