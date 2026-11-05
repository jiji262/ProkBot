import { t } from './i18n.js';
import { icon } from './icons.js';

export function setupPrivacy() {
  const button = document.querySelector('#privacy-toggle');
  let hidden = false;
  try { hidden = sessionStorage.getItem('grokbot-private-hidden') === '1'; } catch {}
  const apply = () => {
    document.documentElement.dataset.privateHidden = String(hidden);
    button.innerHTML = icon(hidden ? 'eyeOff' : 'eye');
    button.setAttribute('aria-pressed', String(hidden));
    button.title = button.ariaLabel = hidden ? t('显示敏感信息') : t('隐藏敏感信息');
  };
  button.addEventListener('click', () => {
    hidden = !hidden;
    try { sessionStorage.setItem('grokbot-private-hidden', hidden ? '1' : '0'); } catch {}
    apply();
  });
  apply();
}
