// The shared Host profile is the single local account; it is not a cloud identity.
export function createProfile({ request, window, auth, server, onChange }) {
  let avatar = null, last = '', pending, current = null;
  auth.email = '';
  const apply = value => {
    current = { displayName: value.displayName, avatarDataUrl: value.avatarDataUrl ?? null,
      hostName: value.hostName || 'Grok Bot Host' };
    const next = JSON.stringify([current, value.updatedAt]);
    if (next === last) return { ...auth };
    last = next; avatar = value.avatarDataUrl ?? null;
    Object.assign(auth, { displayName: value.displayName, profilePictureUrl: avatar,
      freshness: Date.now() });
    if (!window.isDestroyed()) window.webContents.send('dune-rpc:main:e:cursor-auth-changed', { ...auth });
    onChange?.();
    return { ...auth };
  };
  const refresh = () => pending ??= request('/local/profile', null, AbortSignal.timeout(10000), 'GET')
    .then(apply).finally(() => { pending = null; });
  // Profile availability does not change the saved device's pairing state.
  // The gateway handles 401 revocation; temporary network or Host failures must
  // not send the original first-run gate into its signed-out/onboarding branch.
  const refreshIdentity = async () => {
    try { await refresh(); } catch (error) { if (error.httpStatus === 401) throw error; }
  };
  let updates = Promise.resolve();
  const update = value => {
    updates = updates.catch(() => {}).then(async () => {
      const current = await request('/local/profile', null, AbortSignal.timeout(10000), 'GET');
      return apply(await request('/local/profile', {
        displayName: current.displayName, avatarDataUrl: current.avatarDataUrl ?? null, ...value,
      }, AbortSignal.timeout(15000), 'PUT'));
    });
    return updates;
  };
  return {
    refresh,
    current: () => current && { ...current },
    handlers: {
      getCursorAuthStatus: async () => { await refreshIdentity(); return { ...auth }; },
      getCursorAvatar: async () => { await refreshIdentity(); return avatar; },
      updateCursorAccountName: ({ name }) => update({ displayName: name }),
      updateCursorProfilePhoto: ({ photo }) => update({ avatarDataUrl: `data:${photo.contentType};base64,${Buffer.from(photo.bytes).toString('base64')}` }),
      getLocalAccountServer: () => server,
    },
  };
}
