import QRCode from 'qrcode';
import { createHash } from 'node:crypto';
import { tailcatIngress } from './tailcat-ingress.mjs';
import { join } from 'node:path';
import { JsonStore, readJson, writePrivate } from './storage.mjs';
import { check, jsonBody, sendJson } from './security.mjs';
import { TailcatProcess, tailcatLink } from '../clients/shared/tailcat-process.mjs';

/** Service-side transport configuration. Keys and connection links stay private. */
export class TailcatNetwork {
  constructor(directory, options = {}) {
    this.directory = directory; this.options = options;
    this.store = new JsonStore(join(directory, 'tailcat.json'), { version: 1, enabled: false, derpMapURL: '', relay: '', identity: null });
    this.outbound = new Map(); this.operations = Promise.resolve(); this.closed = false;
  }
  async load() { await this.store.load(); return this; }
  config() {
    const { enabled, derpMapURL, relay } = this.store.value;
    const { state = enabled ? 'connecting' : 'disabled', path = 'unknown', publicKey = '', error = '' } = this.listener?.status ?? {};
    return { enabled, derpMapURL, relay, state, path, publicKey, error };
  }
  start(target) { this.starting = (async () => { this.ingress = await tailcatIngress(target); this.target = this.ingress.target; if (this.store.value.enabled) await this.listen(); })(); return this.starting; }
  isIngress(request) { return this.ingress?.matches(request) === true; }
  async listen() {
    if (this.closed || !this.target) return;
    const { identity, derpMapURL, relay } = this.store.value;
    this.listener = new TailcatProcess({ mode: 'serve', target: this.target, port: 8000, identity, derpMapURL, relay }, {
      ...this.options, onIdentity: value => this.store.mutate(state => { state.identity = value; }),
    });
    await this.listener.start();
  }
  save(input) {
    const next = this.operations.then(async () => {
      check(typeof input.enabled === 'boolean', 400, 'Select Tailcat state');
      const derpMapURL = String(input.derpMapURL ?? '').trim(), relay = String(input.relay ?? '').trim();
      if (derpMapURL) {
        let url; try { url = new URL(derpMapURL); } catch { check(false, 400, 'Invalid DERP map URL'); }
        check(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 400, 'Use an HTTPS DERP map URL');
      }
      check(!relay || /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(relay), 400, 'Invalid DERP relay');
      check(!relay || !derpMapURL, 400, 'Choose a relay or a DERP map');
      await this.listener?.close(); this.listener = null;
      await this.store.mutate(state => {
        if (input.rotate === true) state.identity = null;
        else if (state.identity && (state.derpMapURL !== derpMapURL || state.relay !== relay)) {
          delete state.identity.Public.Region; delete state.identity.Public.RegionID;
        }
        Object.assign(state, { enabled: input.enabled, derpMapURL, relay });
      });
      if (input.enabled) await this.listen();
      return this.config();
    });
    this.operations = next.catch(() => {}); return next;
  }
  link() { check(this.listener?.status.link, 409, 'Tailcat is not ready'); return { link: this.listener.status.link }; }
  async connect(link, name = 'peer') {
    link = tailcatLink(link);
    const existing = this.outbound.get(link); if (existing) return existing;
    const pending = (async () => {
      const file = join(this.directory, `tailcat-client-${createHash('sha256').update(link).digest('hex').slice(0, 24)}.json`);
      const identity = await readJson(file, null);
      const process = new TailcatProcess({ mode: 'forward', link, identity }, {
        ...this.options, onIdentity: value => writePrivate(file, JSON.stringify(value)),
      });
      try { const status = await process.start(); return { process, url: status.localURL, name }; }
      catch (error) { await process.close(); this.outbound.delete(link); throw error; }
    })();
    this.outbound.set(link, pending); return pending;
  }
  async resolve(address) { return String(address).startsWith('tailcat:') ? (await this.connect(address)).url : address; }
  async close() {
    this.closed = true; await this.starting?.catch(() => {}); await this.operations;
    await this.listener?.close();
    await Promise.allSettled([...this.outbound.values()].map(async value => (await value).process.close()));
    this.outbound.clear(); await this.ingress?.close(); await this.store.tail;
  }
}

export async function tailcatAdmin(request, response, path, network) {
  if (!path.startsWith('/admin/api/network')) return false;
  let result;
  if (path === '/admin/api/network' && request.method === 'GET') result = network.config();
  else if (path === '/admin/api/network' && request.method === 'PUT') result = await network.save(await jsonBody(request));
  else if (path === '/admin/api/network/qr' && request.method === 'POST') result = { svg: await QRCode.toString(network.link().link, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }) };
  else if (path === '/admin/api/network/test' && request.method === 'POST') {
    const connection = await network.connect(network.link().link);
    const response = await fetch(connection.url + '/health', { signal: AbortSignal.timeout(35000), redirect: 'error' });
    check(response.ok && (await response.json()).ok, 502, 'Tailcat test failed');
    result = { ok: true, path: connection.process.status.path };
  }
  else if (path === '/admin/api/network/link' && request.method === 'POST') result = network.link();
  else check(false, 404, 'Network setting not found');
  sendJson(response, 200, result); return true;
}
