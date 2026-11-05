import { externalHttpUrl } from './external-url.mjs';

export function installExternalLinks(window, { openExternal, clipboard, Menu, text }) {
  const open = value => {
    const target = externalHttpUrl(value);
    if (target) void Promise.resolve(openExternal(target)).catch(() => {});
  };
  window.webContents.setWindowOpenHandler(({ url }) => { open(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return;
    event.preventDefault(); open(url);
  });
  window.webContents.on('context-menu', (_event, params) => {
    const template = [], link = externalHttpUrl(params.linkURL);
    if (link) template.push(
      { label: text('打开链接', 'Open Link'), click: () => open(link) },
      { label: text('复制链接地址', 'Copy Link Address'), click: () => clipboard.writeText(link) },
    );
    if (params.isEditable) {
      if (template.length) template.push({ type: 'separator' });
      for (const [action, label, english, flag, shortcut] of [
        ['undo', '撤销', 'Undo', 'canUndo', 'CmdOrCtrl+Z'],
        ['redo', '重做', 'Redo', 'canRedo', 'Shift+CmdOrCtrl+Z'],
        ['cut', '剪切', 'Cut', 'canCut', 'CmdOrCtrl+X'],
        ['copy', '复制', 'Copy', 'canCopy', 'CmdOrCtrl+C'],
        ['paste', '粘贴', 'Paste', 'canPaste', 'CmdOrCtrl+V'],
        ['selectAll', '全选', 'Select All', 'canSelectAll', 'CmdOrCtrl+A'],
      ]) template.push({ label: text(label, english), enabled: params.editFlags[flag],
        accelerator: shortcut, click: () => window.webContents[action]() });
    } else if (params.selectionText?.trim()) {
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: text('复制', 'Copy'), click: () => window.webContents.copy() });
    }
    if (template.length) Menu.buildFromTemplate(template).popup({ window, frame: params.frame ?? undefined });
  });
}
