import { randomUUID } from 'node:crypto';
import { bearer, check, equal, jsonBody, sendJson } from './security.mjs';

const prefix = '/desktop-capabilities';
const internalPrefix = '/internal/desktop-capabilities';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 160;
const maxResultBytes = 24 * 1024 * 1024;
const computerTool = /^(computer_(screenshot|click|move|drag|type|key|scroll|wait|check_permissions|apps|resolve_app|app_state|set_value|app_action)|codex_(start|status|continue|cancel|list))$/;

/** Outbound device channels. A request is never retried after its provider leaves. */
export class DesktopCapabilities {
  constructor({ authenticate, internalToken, connections, enabled = () => true, requestTimeoutMs = 360000 }) {
    Object.assign(this, { authenticate, internalToken, connections, enabled, requestTimeoutMs });
    this.providers = new Map(); this.pending = new Map();
    this.timer = setInterval(() => {
      for (const provider of this.providers.values()) {
        if (!this.enabled() || Date.now() - provider.lastSeen > 35000) provider.response.destroy();
        else provider.response.write(': heartbeat\n\n');
      }
    }, 10000);
    this.timer.unref();
  }
  list() {
    if (!this.enabled()) return [];
    return [...this.providers.values()].filter(p => p.tools && Date.now() - p.lastSeen <= 35000)
      .map(p => ({ machineId: p.machineId, label: p.label, tools: p.tools }));
  }
  send(provider, value) {
    check(!provider.response.destroyed, 409, 'Computer disconnected');
    provider.response.write(`data: ${JSON.stringify(value)}\n\n`);
  }
  settle(id, error, result) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id); clearTimeout(pending.timer); pending.removeAbort();
    error ? pending.reject(error) : pending.resolve(result);
  }
  async call(args, signal) {
    check(this.enabled(), 409, 'Mac computer control is disabled');
    check(object(args) && validId(args.machineId) && validId(args.conversationId) && computerTool.test(args.toolId), 400, 'Invalid computer call');
    check(object(args.arguments ?? {}) && (!args.approvalId || validId(args.approvalId)) &&
      (!args.authorizedApp || validId(args.authorizedApp)), 400, 'Invalid computer arguments');
    check(Buffer.byteLength(JSON.stringify(args)) <= 512 * 1024, 413, 'Computer arguments too large');
    const provider = [...this.providers.values()].find(p => p.machineId === args.machineId && p.tools?.some(tool => tool.name === args.toolId));
    check(provider && Date.now() - provider.lastSeen <= 35000, 409, 'Computer disconnected');
    signal?.throwIfAborted();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = reason => { try { this.send(provider, { kind: 'cancel', requestId }); } catch {} this.settle(requestId, reason); };
      const abort = () => cancel(new Error('Computer call cancelled'));
      const timer = setTimeout(() => cancel(new Error('Computer call timed out')), this.requestTimeoutMs);
      this.pending.set(requestId, { providerId: provider.id, resolve, reject, timer,
        removeAbort: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.send(provider, { kind: 'call', requestId, machineId: args.machineId,
        conversationId: args.conversationId, toolId: args.toolId, arguments: args.arguments ?? {},
        approvalId: args.approvalId, authorizedApp: args.authorizedApp }); }
      catch (error) { this.settle(requestId, error); }
    });
  }
  disconnect(provider) {
    if (this.providers.get(provider.deviceId) !== provider) return;
    this.providers.delete(provider.deviceId);
    for (const [id, call] of this.pending) if (call.providerId === provider.id)
      this.settle(id, new Error('Computer disconnected during execution; check its state before retrying'));
  }
  async route(request, response, pathname) {
    if (pathname.startsWith(`${internalPrefix}/`)) {
      check(request.headers.origin === undefined && this.internalToken && equal(bearer(request), this.internalToken), 401, 'Unauthorized');
      check(request.method === 'POST', 405, 'POST required');
      const args = await jsonBody(request, 512 * 1024);
      if (pathname === `${internalPrefix}/tools`) sendJson(response, 200, { computers: this.list() });
      else if (pathname === `${internalPrefix}/call`) {
        const abort = new AbortController();
        response.once('close', () => abort.abort());
        sendJson(response, 200, await this.call(args, abort.signal));
      } else check(false, 404, 'Unknown native desktop method');
      return true;
    }
    if (![`${prefix}/requests`, `${prefix}/responses`].includes(pathname)) return false;
    check(request.headers.origin === undefined, 403, 'Desktop providers cannot run in a browser');
    const device = this.authenticate(request);
    check(device.platform === 'desktop', 403, 'Desktop device required');
    if (pathname.endsWith('/requests')) {
      check(request.method === 'GET', 405, 'GET required');
      const previous = this.providers.get(device.id);
      if (previous) { this.disconnect(previous); previous.response.destroy(); }
      const provider = { id: randomUUID(), deviceId: device.id, machineId: `mac-${device.id}`, response, lastSeen: Date.now() };
      this.providers.set(device.id, provider);
      this.connections?.track(device.id, response);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      response.once('close', () => this.disconnect(provider));
      this.send(provider, { kind: 'welcome', providerId: provider.id, machineId: provider.machineId });
    } else {
      check(request.method === 'POST', 405, 'POST required');
      const batch = await jsonBody(request, maxResultBytes);
      const provider = this.providers.get(device.id);
      check(provider && batch.providerId === provider.id, 409, 'Provider session expired');
      check(Array.isArray(batch.frames) && batch.frames.length <= 32, 400, 'Invalid frames');
      for (const frame of batch.frames) {
        check(object(frame), 400, 'Invalid frame');
        if (frame.kind === 'hello') {
          check(typeof frame.label === 'string' && frame.label.length <= 200 && Array.isArray(frame.tools) && frame.tools.length <= 32, 400, 'Invalid computer catalog');
          check(frame.tools.every(tool => object(tool) && computerTool.test(tool.name) && object(tool.inputSchema) && typeof tool.description === 'string'), 400, 'Invalid computer tool');
          check(Buffer.byteLength(JSON.stringify(frame.tools)) <= 512 * 1024, 413, 'Computer catalog too large');
          provider.tools = frame.tools; provider.label = frame.label;
        } else if (frame.kind === 'result') {
          const pending = this.pending.get(frame.requestId);
          check(!pending || pending.providerId === provider.id, 403, 'Result belongs to another computer');
          check(object(frame.outcome) && ['done', 'ask', 'failed', 'needs_permission'].includes(frame.outcome.status), 400, 'Invalid computer outcome');
          if (frame.outcome.status === 'done') check(typeof frame.outcome.outputJson === 'string', 400, 'Invalid tool output');
          if (frame.outcome.status === 'ask') check(validId(frame.outcome.app?.bundleId), 400, 'Invalid app permission request');
          this.settle(frame.requestId, null, frame.outcome);
        } else check(['ping', 'progress'].includes(frame.kind), 400, 'Unknown provider frame');
      }
      provider.lastSeen = Date.now();
      sendJson(response, 200, { ok: true });
    }
    return true;
  }
  close() {
    clearInterval(this.timer);
    for (const provider of this.providers.values()) { this.disconnect(provider); provider.response.destroy(); }
  }
}
