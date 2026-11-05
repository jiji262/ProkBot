function ie() {
  return o.jsx(Se, { children: o.jsxs('div', { style: {
    display: 'flex', alignItems: 'center', gap: 16, padding: '22px 20px', minWidth: 0,
  }, children: [
    o.jsx('img', { src: new URL('../../../local-client/icon.png', import.meta.url).href, alt: '', style: { width: 48, height: 48, flexShrink: 0 } }),
    o.jsxs('div', { style: { display: 'grid', gap: 5, flex: 1, minWidth: 0 }, children: [
      o.jsx('strong', { style: { fontWeight: 550, fontSize: 16 }, children: 'Grok Bot' }),
      o.jsx('span', { style: { opacity: .55, fontSize: 13 }, children: '0.71.2' }),
    ] }),
    o.jsx('span', { style: { fontSize: 12, opacity: .55, whiteSpace: 'nowrap' }, children: grokText('本地版', 'Local') }),
  ] }) });
}
