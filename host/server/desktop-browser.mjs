import { check, jsonBody, sendJson } from './security.mjs';

const channels = { webauthn: { setting: 'passkeys', request: 'ceremony', terminal: ['result', 'error'] },
  'cookie-origin-approval': { setting: 'browserLoginImport', request: 'request', terminal: ['listed', 'resolved', 'failed', 'refused'] } };

/** Bind original bridge requests to the paired device receiving their stream. */
export class DesktopBrowserProviders {
  constructor({ authenticate, connections, hostUrl, internalToken, enabled = () => true }) {
    Object.assign(this, { authenticate, connections, hostUrl, internalToken, enabled });
    this.sessions = new Map();
    this.timer = setInterval(() => {
      for (const session of this.sessions.values()) if (!this.enabled(channels[session.channel].setting)) session.response.destroy();
    }, 1000); this.timer.unref();
  }
  async route(request, response, pathname) {
    const match = /^\/(webauthn|cookie-origin-approval)\/(requests|responses)$/.exec(pathname);
    if (!match) return false;
    const [, channel, endpoint] = match, definition = channels[channel];
    check(request.headers.origin === undefined, 403, 'Desktop provider required');
    check(this.enabled(definition.setting), 409, 'Browser capability is disabled');
    const device = this.authenticate(request);
    check(device.platform === 'desktop', 403, 'Paired desktop required');
    check(this.internalToken, 503, 'Host authentication unavailable');
    const key = `${channel}:${device.id}`;
    const headers = { authorization: `Bearer ${this.internalToken}` };
    if (endpoint === 'requests') {
      check(request.method === 'GET', 405, 'GET required');
      this.sessions.get(key)?.response.destroy();
      const abort = new AbortController();
      const session = { channel, response, abort, requests: new Set(), finished: new Set(), providerId: null };
      this.sessions.set(key, session); this.connections.track(device.id, response);
      response.once('close', () => {
        abort.abort(); if (this.sessions.get(key) === session) this.sessions.delete(key);
      });
      const deadline = setTimeout(() => abort.abort(), 15000);
      try {
        const upstream = await fetch(new URL(pathname, this.hostUrl), { headers, signal: abort.signal, redirect: 'error' });
        clearTimeout(deadline);
        check(upstream.ok && upstream.body, 502, 'Host browser provider unavailable');
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        let buffer = ''; const decoder = new TextDecoder();
        for await (const bytes of upstream.body) {
          buffer += decoder.decode(bytes, { stream: true });
          check(buffer.length <= 16 * 1024 * 1024, 502, 'Provider frame too large');
          let boundary;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const block = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
            if (data) {
              const frame = JSON.parse(data);
              if (frame.kind === 'welcome') session.providerId = frame.providerId;
              if (frame.kind === definition.request) {
                session.finished.delete(frame.requestId); session.requests.add(frame.requestId);
              }
              if (frame.kind === 'cancel') { session.requests.delete(frame.requestId); session.finished.add(frame.requestId); }
              while (session.finished.size > 256) session.finished.delete(session.finished.values().next().value);
            }
            response.write(`${block}\n\n`);
          }
        }
        response.end();
      } catch (error) {
        if (!response.headersSent && !response.destroyed) sendJson(response, 502, { error: 'Host browser provider unavailable' });
        else response.destroy();
      } finally { clearTimeout(deadline); abort.abort(); if (this.sessions.get(key) === session) this.sessions.delete(key); }
    } else {
      check(request.method === 'POST', 405, 'POST required');
      const batch = await jsonBody(request, 16 * 1024 * 1024), session = this.sessions.get(key);
      check(session && session.providerId && batch.providerId === session.providerId, 409, 'Provider session expired');
      check(Array.isArray(batch.frames) && batch.frames.length <= 64, 400, 'Invalid provider frames');
      const frames = [];
      for (const frame of batch.frames) {
        check(frame && typeof frame === 'object', 400, 'Invalid provider frame');
        if (['hello', 'ping'].includes(frame.kind)) { frames.push(frame); continue; }
        check(definition.terminal.includes(frame.kind) || channel === 'webauthn' && frame.kind === 'stage', 400, 'Invalid provider response');
        if (session.finished.has(frame.requestId)) continue;
        check(session.requests.has(frame.requestId), 403, 'Request belongs to another desktop');
        frames.push(frame);
      }
      if (frames.length) {
        const upstream = await fetch(new URL(pathname, this.hostUrl), { method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ providerId: session.providerId, frames }),
          signal: AbortSignal.timeout(15000), redirect: 'error' });
        await upstream.body?.cancel(); check(upstream.ok, 502, 'Host rejected provider response');
        for (const frame of frames) if (definition.terminal.includes(frame.kind)) {
          session.requests.delete(frame.requestId); session.finished.add(frame.requestId);
        }
        while (session.finished.size > 256) session.finished.delete(session.finished.values().next().value);
      }
      sendJson(response, 200, { ok: true });
    }
    return true;
  }
  close() { clearInterval(this.timer); for (const session of this.sessions.values()) session.response.destroy(); this.sessions.clear(); }
}
