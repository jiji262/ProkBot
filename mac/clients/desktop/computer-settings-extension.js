// Reuse the original section cards and Mac permission control.
function Tt() {
  return n.jsx(Tn, { children: n.jsxs('div', { className: 'sand-9f619 sand-78zum5 sand-dt5ytf sand-3qzy4x', children: [
    n.jsx(os, { title: grokText('远程桌面', 'Remote desktop'), children: n.jsxs('div', { style: {
      padding: '18px 16px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, minWidth: 0,
    }, children: [
      n.jsx('span', { style: { flex: '1 1 180px', color: 'var(--color-text-secondary, #aaa)', lineHeight: 1.5 }, children: grokText('Bot 的运行环境', 'Where your Bot runs') }),
      n.jsx(ve, { onClick: () => window.localBot.openManagement(), size: 'md', type: 'button', variant: 'secondary', children: grokText('管理', 'Manage') }),
    ] }) }),
    n.jsx(os, { title: grokText('这台 Mac', 'This Mac'), children: n.jsx(Ue, {}) }),
  ] }) });
}
