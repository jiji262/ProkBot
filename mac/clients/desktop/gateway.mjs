import { grokText } from './i18n.mjs';
import { subscribe } from './streams.mjs';

export function createGateway(config, onUnauthorized, onConnected, onStateChanged) {
  const lifetime = new AbortController();
  const streams = new Set();
  let state = 'connecting';
  const updateState = value => { if (state !== value) { state = value; onStateChanged?.(value); } };
  async function request(endpoint, args, signal, method = 'POST') {
    if (lifetime.signal.aborted) throw new Error(grokText('已退出连接，请重新连接。', 'Disconnected. Connect again.'));
    const response = await fetch(`${config.server}${endpoint}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      ...(method === 'GET' ? {} : { body: JSON.stringify(args) }),
      signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal, redirect: 'error',
    });
    if (response.status === 401) onUnauthorized();
    const value = await response.json();
    if (process.env.GROKBOT_LOCAL_DEBUG_PORT) console.log('[gateway]', endpoint, response.status);
    if (!response.ok) throw Object.assign(new Error(value?.message ?? value?.error ?? `HTTP ${response.status}`),
      { httpStatus: response.status, failureCode: value?.failureCode });
    return value;
  }
  async function command(method, args = {}, signal) {
    if (lifetime.signal.aborted) throw new Error(grokText('已退出连接，请重新连接。', 'Disconnected. Connect again.'));
    if (method === 'getServerAgentRoster') return { status: 'disabled' };
    if (method === 'getMainAgent') return { agentId: null };
    if (method === 'resolveAgentCreation') return { kind: 'box' };
    if (method === 'restoreTemporalAgentRouting' || method === 'noteMountedAgent') return null;
    if (method === 'createAgent') { const { creationRoute, ...rest } = args; args = rest; }
    return request(`/api/${encodeURIComponent(method)}`, args, signal);
  }
  function attach(port) {
    const controller = new AbortController();
    if (lifetime.signal.aborted) { port.close(); return () => {}; }
    let subscribed = false, generation = 0;
    const send = frame => { if (!controller.signal.aborted) port.postMessage(frame); };
    const emit = (family, payload) => send({ kind: 'event', family, payload });
    const receive = async ({ data: frame }) => {
      if (!frame || controller.signal.aborted) return;
      if (frame.kind === 'lifecycle' && frame.phase === 'hello') {
        send({ kind: 'lifecycle', phase: 'ready', protocolVersion: 3 });
        if (!subscribed) {
          subscribed = true;
          void subscribe(config, '/events', ({ data }) => {
            if (data.channel) emit(data.channel, data.payload);
          }, controller.signal, {
            onConnected: () => { streams.add(controller); updateState('online'); emit('transport-connected', { generation: ++generation }); onConnected?.(); },
            onDisconnected: () => { streams.delete(controller); if (!streams.size) updateState('reconnecting'); emit('transport-down', { generation, reason: 'stream-error', cause: null }); },
            onUnauthorized,
          });
        }
      } else if (frame.kind === 'request') {
        try { send({ kind: 'reply', requestId: frame.requestId,
          outcome: { status: 'ok', value: await command(frame.method, frame.args, controller.signal) } }); }
        catch (error) { send({ kind: 'reply', requestId: frame.requestId, outcome: { status: 'failed', failure: {
          code: 'gateway-command-failed', message: error.message,
          ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
          ...(error.failureCode ? { failureCode: error.failureCode } : {}),
        } } }); }
      }
    };
    const cleanup = () => {
      controller.abort(); streams.delete(controller);
      lifetime.signal.removeEventListener('abort', cleanup);
      port.off('message', receive); port.off('close', cleanup);
      if (!streams.size && !lifetime.signal.aborted) updateState('reconnecting');
    };
    lifetime.signal.addEventListener('abort', cleanup, { once: true });
    port.on('message', receive); port.on('close', cleanup); port.start();
    return () => { cleanup(); port.close(); };
  }
  return { command, request, attach, getState: () => state,
    close: () => { lifetime.abort(); updateState('disconnected'); } };
}
