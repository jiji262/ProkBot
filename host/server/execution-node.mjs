import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JsonStore, readJson, writePrivate } from './storage.mjs';
import { check } from './security.mjs';
import { tailcatLink, TailcatProcess } from '../clients/shared/tailcat-process.mjs';

export function validateExecutionNode(input, previous = {}) {
  check(input && typeof input === 'object' && !Array.isArray(input), 400, 'Invalid execution node');
  const enabled = input.enabled ?? previous.enabled ?? false;
  const privateNetwork = input.privateNetwork ?? previous.privateNetwork ?? false;
  check(typeof enabled === 'boolean' && typeof privateNetwork === 'boolean', 400, 'Invalid execution node state');
  check(input.name === undefined || typeof input.name === 'string', 400, 'Invalid execution node name');
  check(input.token === undefined || typeof input.token === 'string', 400, 'Invalid execution node key');
  const name = (input.name ?? previous.name ?? 'Bot computer').trim();
  check(name && name.length <= 100 && !/[\r\n\0]/.test(name), 400, 'Invalid execution node name');
  let address = String(input.url ?? previous.url ?? '').trim().replace(/\/+$/, '');
  if (address.startsWith('tailcat:')) address = tailcatLink(address);
  else if (address) {
    let url; try { url = new URL(address); } catch { check(false, 400, 'Invalid execution node URL'); }
    check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash &&
      !/%2f|%5c|%2e/i.test(url.pathname), 400, 'Invalid execution node URL');
    check(url.protocol === 'https:' || privateNetwork, 400, 'Use HTTPS or select a private network');
    address = url.href.replace(/\/+$/, '');
  }
  const changed = address !== previous.url;
  const token = input.token?.trim() || (changed || input.clearToken ? '' : previous.token ?? '');
  check(!token || /^[A-Za-z0-9_-]{32,256}$/.test(token), 400, 'Execution node key must contain 32–256 letters, digits, underscores or hyphens');
  check(!enabled || (address && token), 400, 'Execution node URL and key are required');
  return { enabled, name, url: address, privateNetwork, token };
}

export async function loadExecutionNode(dataDir) {
  const stored = await readJson(join(dataDir, 'execution-node.json'), null);
  return stored ? { ...validateExecutionNode(stored.config), revision: stored.revision } : null;
}

export class ExecutionNode {
  constructor(dataDir, { network } = {}) {
    this.dataDir = dataDir;
    this.network = network;
    this.store = new JsonStore(join(dataDir, 'execution-node.json'), { version: 1, revision: '', config: validateExecutionNode({}) });
  }
  async load() { await this.store.load(); return this; }
  active() {
    try { return JSON.parse(readFileSync(join(this.dataDir, 'execution-active.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  publicConfig() {
    const { token, ...config } = this.store.value.config, active = this.active();
    return { ...config, hasToken: Boolean(token), revision: this.store.value.revision,
      applied: active?.revision === this.store.value.revision, activeName: active?.config?.name ?? null };
  }
  async save(input) {
    await this.store.mutate(state => { state.config = validateExecutionNode(input, state.config); state.revision = randomUUID(); });
    // Shares the existing idle/quiesce/restart mechanism with model changes.
    await writePrivate(join(this.dataDir, 'model-reload-request.json'), JSON.stringify({
      revision: randomUUID(), reason: 'execution-node', requestedAt: new Date().toISOString(),
    }));
    return this.publicConfig();
  }
  async test(input = {}) {
    const config = validateExecutionNode(input, this.store.value.config);
    check(config.url && config.token, 400, 'Execution node URL and key are required');
    try {
      const url = this.network ? await this.network.resolve(config.url) : config.url;
      const response = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) return { ok: false, status: response.status };
      const body = await response.json();
      return { ok: body.protocol === 'grokbot-execution/v1' && body.ready === true,
        protocol: body.protocol, services: body.services };
    } catch { return { ok: false, error: 'Execution node is unavailable' }; }
  }
  vnc(slot, path) {
    const active = this.active(); if (!active?.config?.enabled) return null;
    const target = new URL(active.config.url);
    return { target, path: `${target.pathname.replace(/\/$/, '')}/vnc/${slot}${path}`, token: active.config.token, revision: active.revision };
  }
}

export async function connectExecutionNode(config, dataDir) {
  if (!config?.enabled || !config.url.startsWith('tailcat:')) return { config, close: async () => {} };
  const file = join(dataDir, 'execution-tailcat-identity.json'), identity = await readJson(file, null);
  const tunnel = new TailcatProcess({ mode: 'forward', link: config.url, identity }, {
    onIdentity: value => writePrivate(file, JSON.stringify(value)),
  });
  try {
    const state = await tunnel.start();
    return { config: { ...config, sourceURL: config.url, url: state.localURL }, close: () => tunnel.close() };
  } catch (error) { await tunnel.close(); throw error; }
}
