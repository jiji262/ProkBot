import { grokText } from './i18n.mjs';

/** The original call entry follows this Host's configured service availability. */
export function createVoiceAvailability({ request, window, experiments, getPreference = () => false }) {
  let pending, closed = false;
  const lifetime = new AbortController();
  experiments.featureGates.sand_voice_call = false;
  const refresh = () => {
    if (closed) return Promise.resolve(experiments);
    if (pending) return pending;
    pending = (async () => {
      let enabled = false;
      try {
        const value = await request('/local/voice/status', null,
          AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]), 'GET');
        enabled = value?.enabled === true && getPreference() === true;
      } catch {}
      if (!closed && enabled !== experiments.featureGates.sand_voice_call) {
        experiments.featureGates.sand_voice_call = enabled;
        if (!window.isDestroyed()) window.webContents.send('dune-rpc:main:e:experiments-changed', experiments);
      }
      return experiments;
    })().finally(() => { pending = null; });
    return pending;
  };
  const focus = () => { void refresh(); };
  window.on('focus', focus);
  return { refresh, close() { closed = true; lifetime.abort(); window.off('focus', focus); } };
}

/** Only a short-lived call ticket crosses into the original renderer. */
export async function mintVoiceCredential({ request, server }, agentId) {
  if (typeof agentId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(agentId))
    throw new Error(grokText('请选择 Bot。', 'Choose a Bot.'));
  const value = await request('/local/voice/session', { agentId, audioProcessing: 'native-aec-v1' }, AbortSignal.timeout(15_000));
  const expected = new URL('/local/voice/realtime', server);
  expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:';
  const expires = value?.expiresAtUnixSeconds;
  if (typeof value?.clientSecret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.clientSecret) ||
      value.websocketUrl !== expected.href || typeof value.model !== 'string' ||
      !value.model || value.model.length > 128 || !Number.isInteger(expires) ||
      expires <= Date.now() / 1000 || expires > Date.now() / 1000 + 90)
    throw new Error(grokText('语音连接信息无效。', 'Invalid voice connection.'));
  return { clientSecret: value.clientSecret, websocketUrl: expected.href,
    expiresAtUnixSeconds: expires, model: value.model };
}
