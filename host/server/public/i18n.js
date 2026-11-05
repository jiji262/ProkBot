import english from './locales-en.js';
export const locale = (navigator.languages?.[0] ?? navigator.language ?? 'en').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
document.documentElement.lang = locale;
export function t(source, ...values) {
  if (typeof source !== 'string') return source ?? '';
  const normalized = source.replace(/\s+/g, ' ').trim();
  const translated = locale === 'en' ? english[source] ?? english[normalized] ?? source : source;
  return translated.replace(/\{(\d+)\}/g, (match, index) => values[index] ?? match);
}
// Translate only static UI fragments at creation; never observe user-supplied content.
export function localize(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement?.closest('script,style,[data-raw]')) continue;
    const key = node.textContent.replace(/\s+/g, ' ').trim();
    if (english[key] && locale === 'en') node.textContent = node.textContent.replace(/\S[\s\S]*\S|\S/, english[key]);
  }
  for (const element of root.querySelectorAll('[placeholder],[aria-label],[title],[alt]'))
    for (const name of ['placeholder','aria-label','title','alt'])
      if (element.hasAttribute(name)) element.setAttribute(name, t(element.getAttribute(name)));
}
export function html(source) {
  const template = document.createElement('template'); template.innerHTML = source;
  localize(template.content); return template.innerHTML;
}
