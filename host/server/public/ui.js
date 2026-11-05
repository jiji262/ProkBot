import { t, locale } from './i18n.js';
import { icon } from './icons.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const all = (selector, root = document) => [...root.querySelectorAll(selector)];

export function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; } catch {}
  }
  const active = document.activeElement, field = document.createElement('textarea');
  field.value = value; field.className = 'sr-only';
  (document.querySelector('dialog[open]') ?? document.body).append(field);
  try {
    field.select();
    if (!document.execCommand('copy')) throw new Error(t('浏览器未允许复制，请选择文字后复制'));
  } finally { field.remove(); active?.focus({ preventScroll: true }); }
}

export const date = (value) => value
  ? new Date(value).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  : t('暂无记录');

export function errorText(selector, error) {
  const element = $(selector);
  element.textContent = error.message;
  element.hidden = false;
}

export async function fileText(input, limit = 32 * 1024) {
  const file = input.files[0];
  if (!file) return undefined;
  if (file.size > limit) throw new Error(t('凭证文件过大，请选择正确的 PEM 或 p8 文件'));
  return file.text();
}

/** Disables a control while async work runs and restores its label afterwards. */
export async function busy(control, work) {
  if (control.disabled) return;
  const label = control.tagName === 'BUTTON' ? control.innerHTML : null;
  control.disabled = true;
  if (label !== null && !control.classList.contains('icon-btn')) control.textContent = t('处理中…');
  try { return await work(); }
  finally { control.disabled = false; if (label !== null) control.innerHTML = label; }
}

export function button(label, { variant = '', size = '', iconName, onClick, type = 'button' } = {}) {
  const element = node('button', ['btn', variant && `btn-${variant}`, size && `btn-${size}`].filter(Boolean).join(' '));
  element.type = type;
  element.innerHTML = iconName ? icon(iconName) : '';
  element.append(label);
  if (onClick) element.onclick = onClick;
  return element;
}

export function iconButton(name, label, onClick) {
  const element = node('button', 'icon-btn');
  element.type = 'button'; element.innerHTML = icon(name);
  element.setAttribute('aria-label', label); element.title = label;
  if (onClick) element.onclick = onClick;
  return element;
}

export function empty(title, message = '') {
  const element = node('div', 'empty');
  element.append(node('strong', '', title));
  if (message) element.append(node('span', '', message));
  return element;
}

export function status(text, tone = '') {
  const element = node('span', 'status', text);
  if (tone) element.dataset.tone = tone;
  return element;
}

export function badge(text, tone = '') {
  const element = node('span', 'badge', text);
  if (tone) element.dataset.tone = tone;
  return element;
}

export function toggle(checked, label) {
  const input = document.createElement('input');
  input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.checked = checked;
  input.setAttribute('aria-label', label);
  return input;
}

/** A list row: leading tile, title with badges, meta lines and trailing actions. */
export function item({ tile, image, title, badges = [], meta = [], description, actions = [] }) {
  const row = node('div', 'item'), lead = node('span', 'item-icon'), copy = node('div', 'item-copy');
  if (image) { const img = document.createElement('img'); img.src = image; img.alt = ''; lead.append(img); }
  else if (tile?.startsWith?.('<svg')) lead.innerHTML = tile;
  else lead.textContent = [...(tile || title || '·')][0].toUpperCase();
  const heading = node('div', 'item-title'); heading.append(node('span', '', title), ...badges);
  copy.append(heading);
  if (description) copy.append(node('p', 'item-desc', description));
  for (const line of meta.filter(Boolean)) copy.append(node('p', 'item-meta', line));
  const trailing = node('div', 'item-actions'); trailing.append(...actions);
  row.append(lead, copy, trailing);
  return row;
}

let confirmDialog;
/** Shared confirmation dialog for destructive or disruptive actions. Resolves true when accepted. */
export function confirmAction({ title, message = '', action, danger = true }) {
  if (!confirmDialog) {
    confirmDialog = node('dialog', 'dialog');
    confirmDialog.id = 'confirm-dialog';
    confirmDialog.innerHTML = `<form method="dialog"><div class="dialog-head"><h2></h2></div><div class="dialog-body"><p class="hint"></p></div>
      <div class="dialog-foot"><button class="btn" value="cancel"></button><button class="btn" id="confirm-accept" value="confirm"></button></div></form>`;
    document.body.append(confirmDialog);
  }
  $('h2', confirmDialog).textContent = title;
  $('.hint', confirmDialog).textContent = message;
  $('.dialog-body', confirmDialog).hidden = !message;
  $('[value=cancel]', confirmDialog).textContent = t('取消');
  const accept = $('#confirm-accept', confirmDialog);
  accept.textContent = action; accept.className = `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`;
  confirmDialog.returnValue = '';
  confirmDialog.showModal();
  return new Promise(resolve => confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'confirm'), { once: true }));
}

/** Wires a dialog's [data-close] buttons and returns it. */
export function dialog(element) {
  for (const control of all('[data-close]', element)) control.addEventListener('click', () => element.close());
  return element;
}

let openMenu;
/** Overflow menu for secondary row actions; entries are { label, run, danger, disabled }. */
export function menu(label, entries) {
  const trigger = iconButton('more', label);
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.addEventListener('click', () => {
    openMenu?.remove();
    const list = node('div', 'menu');
    list.setAttribute('role', 'menu'); list.popover = 'auto';
    for (const entry of entries.filter(Boolean)) {
      const option = node('button', `menu-item${entry.danger ? ' danger' : ''}`, entry.label);
      option.type = 'button'; option.setAttribute('role', 'menuitem'); option.disabled = Boolean(entry.disabled);
      option.addEventListener('click', () => { list.hidePopover(); entry.run(trigger); });
      list.append(option);
    }
    list.addEventListener('toggle', event => { if (event.newState === 'closed') list.remove(); });
    (trigger.closest('dialog[open]') ?? document.body).append(list);
    list.showPopover();
    const anchor = trigger.getBoundingClientRect(), width = list.offsetWidth, height = list.offsetHeight;
    list.style.left = `${Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))}px`;
    list.style.top = `${anchor.bottom + 4 + height > innerHeight - 8 ? Math.max(8, anchor.top - height - 4) : anchor.bottom + 4}px`;
    list.querySelector('button:not(:disabled)')?.focus();
    openMenu = list;
  });
  return trigger;
}

/** Replaces the browser's file control with a Sand button and the chosen file name. */
export function filePicker(input) {
  const wrap = node('span', 'file-picker'), choose = button(t('选择文件'), { size: 'sm' }), name = node('span', 'file-name');
  const update = () => { name.textContent = input.files?.[0]?.name ?? t('尚未选择文件'); };
  input.replaceWith(wrap); input.hidden = true; wrap.append(input, choose, name);
  choose.onclick = () => input.click();
  input.addEventListener('change', update);
  input.form?.addEventListener('reset', () => setTimeout(update));
  update();
  return update;
}
