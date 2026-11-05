import { hostname } from 'node:os';
import { subscribe } from './streams.mjs';

export function startNativeProvider({ config, computer, onUnauthorized }) {
  const abort = new AbortController(), calls = new Map();
  let providerId, heartbeat;
  const post = async (frames, session = providerId) => {
    if (!session || abort.signal.aborted) return;
    const response = await fetch(`${config.server}/desktop-capabilities/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: session, frames }), redirect: 'error',
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Computer provider HTTP ${response.status}`);
  };
  const clear = () => { clearInterval(heartbeat); providerId = undefined; for (const call of calls.values()) call.abort(); calls.clear(); };
  const accept = async ({ data }) => {
    if (data.kind === 'welcome') {
      clear(); providerId = data.providerId;
      await post([{ kind: 'hello', label: hostname(), tools: computer.tools }]);
      heartbeat = setInterval(() => post([{ kind: 'ping' }]).catch(() => {}), 10000); heartbeat.unref();
    } else if (data.kind === 'cancel') calls.get(data.requestId)?.abort();
    else if (data.kind === 'call' && !calls.has(data.requestId)) {
      const controller = new AbortController(), session = providerId;
      calls.set(data.requestId, controller);
      void computer.call(data, { signal: AbortSignal.any([abort.signal, controller.signal]),
        onProgress: state => void post([{ kind: 'progress', requestId: data.requestId, state }], session).catch(() => {}),
      }).catch(error => ({ status: 'failed', error: error.message })).then(outcome =>
        post([{ kind: 'result', requestId: data.requestId, outcome }], session)
      ).catch(() => {}).finally(() => calls.delete(data.requestId));
    }
  };
  void subscribe(config, '/desktop-capabilities/requests', accept, abort.signal, {
    onUnauthorized: () => { clear(); computer.close(); onUnauthorized?.(); },
    onDisconnected: () => { clear(); computer.disconnected?.(); },
  });
  return { close() { abort.abort(); clear(); computer.close(); } };
}
