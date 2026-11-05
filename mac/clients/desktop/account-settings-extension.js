// Preserve the original account card: name and Host are display text. Editing
// opens the original rich dialog instead of turning the whole card into a form.
function GrokAccountHost() {
  const [host, setHost] = Q.useState('Grok Bot Host');
  Q.useEffect(() => {
    const apply = status => setHost(status.profile?.hostName || 'Grok Bot Host');
    void window.localBot.connectionStatus().then(apply).catch(() => {});
    return window.localBot.onConnectionChanged(apply);
  }, []);
  return host;
}
function GrokAccountName({ className, name, onCommit }) {
  const [open, setOpen] = Q.useState(false), [value, setValue] = Q.useState(name);
  const [busy, setBusy] = Q.useState(false), [error, setError] = Q.useState('');
  const input = Q.useRef(null), composing = Q.useRef(false), submitting = Q.useRef(false);
  const edit = () => { setValue(name); setError(''); setOpen(true); };
  const save = async event => {
    event.preventDefault();
    if (composing.current || submitting.current || !value.trim()) return;
    submitting.current = true; setBusy(true); setError('');
    try { await onCommit(value.trim()); setOpen(false); }
    catch (failure) { setError(failure.message || grokText('保存失败，请重试。', 'Could not save. Try again.')); }
    finally { submitting.current = false; setBusy(false); }
  };
  return l.jsxs(l.Fragment, { children: [
    l.jsx('style', { children: `
      .grok-account-name{display:inline-flex;align-items:center;gap:8px;max-width:100%;width:fit-content;border:0;padding:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
      .grok-account-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .grok-account-name svg{width:14px;height:14px;flex:none;opacity:0;transition:opacity .12s}
      .grok-account-name:hover svg,.grok-account-name:focus-visible svg{opacity:.5}
      .grok-account-name:focus-visible{outline:2px solid currentColor;outline-offset:4px;border-radius:3px}
      @media(prefers-reduced-motion:reduce){.grok-account-name svg{transition:none}}
    ` }),
    l.jsxs('button', { type: 'button', className: `grok-account-name ${className}`, onClick: edit,
      'aria-label': grokText('修改账户名称', 'Edit account name'), children: [l.jsx('span', { children: name }),
        l.jsx('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true,
          children: l.jsx('path', { d: 'm16 3 5 5L8 21H3v-5L16 3Zm-2 2 5 5' }) })] }),
    open ? l.jsxs(GrokDialogParts.Root, { open: true, onOpenChange: setOpen, variant: 'rich',
      className: 'grok-host-dialog', 'aria-label': grokText('修改账户名称', 'Edit account name'), initialFocus: input, children: [
      l.jsx('style', { children: grokConnectionStyles }), l.jsx(GrokDialogParts.CloseButton, {}),
      l.jsxs('form', { className: 'grok-host-content', onSubmit: save, children: [
        l.jsxs('header', { children: [l.jsx(GrokDialogParts.Title, { children: grokText('修改账户名称', 'Edit account name') }),
          null] }),
        l.jsx('div', { className: 'grok-host-fields', children:
          l.jsxs('label', { children: [grokText('账户名称', 'Account name'), l.jsx('input', { ref: input, className: grokInputClass,
            value, maxLength: 80, required: true, disabled: busy, 'aria-label': grokText('账户名称', 'Account name'),
            onChange: event => setValue(event.currentTarget.value),
            onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; },
            onKeyDown: event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || composing.current || event.keyCode === 229)) event.preventDefault(); } })] }) }),
        error ? l.jsx('p', { className: 'grok-host-error', role: 'alert', children: error }) : null,
        l.jsxs('div', { className: 'grok-host-actions', children: [
          l.jsx(GrokDialogParts.Action, { type: 'button', variant: 'secondary', onClick: () => setOpen(false), disabled: busy, children: grokText('取消', 'Cancel') }),
          l.jsx(GrokDialogParts.Action, { type: 'submit', variant: 'primary', disabled: busy || !value.trim(), pending: busy, children: grokText('保存', 'Save') })] })] })] }) : null,
  ] });
}
