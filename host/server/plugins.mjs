import { join } from 'node:path';
import { JsonStore } from './storage.mjs';
import { check } from './security.mjs';
import { validateConnector } from './connectors-store.mjs';
import { validatePlugin, pluginDigest, bundledSkills, pluginIcon, validatePluginConfiguration } from './plugin-package.mjs';
import { openPluginClient } from './plugin-client.mjs';

export class Plugins {
  constructor(dataDir, { connectors, skills, hostCall }) {
    this.hostCall = hostCall;
    this.connectors = connectors; this.skills = skills; this.syncSignature = '';
    this.store = new JsonStore(join(dataDir, 'plugins.json'), { version: 1, plugins: [] });
    this.operations = Promise.resolve();
  }
  async load() {
    await this.store.load();
    this.connectors.plugins = this;
    this.connectors.mcp.pluginClient = row => this.client(row);
    this.connectors.store.onChanged = () => this.sync();
    // Recover an interrupted package/connector write from the authoritative version catalog.
    for (const item of this.store.value.plugins) await this.applyConnector(item);
    await this.sync(); return this;
  }
  serialize(callback) { const next = this.operations.catch(() => {}).then(callback); this.operations = next; return next; }
  item(id) { const item = this.store.value.plugins.find(item => item.id === id); check(item, 404, 'Plugin not found'); return item; }
  package(id, revision) {
    const item = this.item(id), version = item.versions.find(version => version.id === (revision ?? item.current));
    check(version, 404, 'Plugin version not found'); return version.package;
  }
  list() { return this.store.value.plugins.map(item => this.get(item.id, false)); }
  get(id, includePackage = true) {
    const item = this.item(id), pkg = this.package(id), row = this.connectors.store.data.connectors.find(row => row.id === id);
    const values = this.connectors.store.unseal(row?.pluginConfiguration) ?? {};
    return { id, enabled: item.enabled, current: item.current, previous: item.previous,
      versions: item.versions.map(({ id, at, package: pkg }) => ({ id, at, version: pkg.version })),
      version: pkg.version, name: pkg.name, description: pkg.description, iconDataUrl: pluginIcon(pkg),
      runtime: pkg.runtime, skills: pkg.skills, permissions: pkg.permissions, configuration: pkg.configuration,
      values: Object.fromEntries(pkg.configuration.filter(field => !field.secret).map(field => [field.key, values[field.key] ?? ''])),
      configured: pkg.configuration.filter(field => values[field.key]).map(field => field.key),
      installed: row?.installed ?? false, connectionStatus: row?.connectionStatus ?? 'unchecked',
      ...(includePackage ? { package: pkg } : {}) };
  }
  preview(input) {
    const pkg = validatePlugin(input), current = this.store.value.plugins.find(item => item.id === pkg.id);
    return { package: pkg, revision: pluginDigest(pkg), previous: current?.current,
      files: pkg.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) };
  }
  async applyConnector(item, force = false) {
    const pkg = this.package(item.id), store = this.connectors.store;
    const previous = store.data.connectors.find(row => row.id === item.id);
    check(!previous || previous.pluginId === item.id, 409, 'Plugin ID conflicts with an existing connector');
    if (!force && previous?.pluginRevision === item.current && previous.enabled === item.enabled) return;
    const values = store.unseal(previous?.pluginConfiguration) ?? {};
    const auth = pkg.auth?.type === 'oauth2' ? { ...pkg.auth, clientId: values.OAUTH_CLIENT_ID || pkg.auth.clientId || 'unconfigured' } : pkg.auth ?? { type: 'none' };
    const definition = pkg.runtime.kind === 'remote-mcp' ? pkg.runtime : { url: `http://app.invalid/${pkg.id}`, auth };
    const next = validateConnector({ ...definition, id: pkg.id, name: pkg.name.en, description: pkg.description.en,
      enabled: item.enabled, iconDataUrl: pluginIcon(pkg) }, previous);
    Object.assign(next, { pluginId: pkg.id, pluginRevision: item.current, pluginRuntime: pkg.runtime.kind,
      localizedName: pkg.name, localizedDescription: pkg.description,
      bundledSkills: pkg.skills.map(skill => ({ id: skill.id, name: skill.name.en, description: skill.description.en })),
      pluginFields: pkg.configuration, pluginConfiguration: previous?.pluginConfiguration, pluginConfiguredKeys: previous?.pluginConfiguredKeys ?? [] });
    if (pkg.auth?.type === 'oauth2') next.clientSecret = values.OAUTH_CLIENT_SECRET ? store.seal(values.OAUTH_CLIENT_SECRET) : undefined;
    // Address/auth changes invalidate the original credential; code configuration never crosses plugins.
    await this.connectors.mcp.close(item.id);
    await store.mutate(data => { const index = data.connectors.findIndex(row => row.id === item.id);
      if (index < 0) data.connectors.push(next); else data.connectors[index] = next; });
  }
  async publish(input) { return this.serialize(async () => {
    const pkg = validatePlugin(input), before = this.store.value.plugins.find(item => item.id === pkg.id);
    const revision = before?.versions.find(version => pluginDigest(version.package) === pluginDigest(pkg))?.id ?? pluginDigest(pkg);
    const old = this.connectors.store.data.connectors.find(row => row.id === pkg.id);
    check(!old || old.pluginId === pkg.id, 409, 'Plugin ID conflicts with an existing connector');
    check(!before?.versions.some(version => version.package.version === pkg.version && version.id !== revision), 409, 'This version already contains different files');
    if (before?.enabled && old?.installed && pkg.runtime.kind === 'node-stdio' && (old.auth.type === 'none' || old.credential)) {
      const config = validatePluginConfiguration(pkg, {}, this.connectors.store.unseal(old.pluginConfiguration) ?? {});
      const client = await openPluginClient(this.hostCall, pkg, config, () => this.connectors.oauth.headers(old));
      try { await client.listTools(); } finally { await client.close(); }
    }
    await this.store.mutate(state => {
      let item = state.plugins.find(item => item.id === pkg.id);
      if (!item) { check(state.plugins.length < 100, 400, 'Too many plugins'); item = { id: pkg.id, enabled: false, versions: [] }; state.plugins.push(item); }
      if (!item.versions.some(version => version.id === revision)) item.versions.push({ id: revision, at: Date.now(), package: pkg });
      if (item.current !== revision) { item.previous = item.current; item.current = revision; }
    });
    await this.applyConnector(this.item(pkg.id)); await this.sync(); return this.get(pkg.id);
  }); }
  async update(id, input) { return this.serialize(async () => {
    const previous = this.item(id); check(input.enabled === undefined || typeof input.enabled === 'boolean', 400, 'Invalid plugin state');
    let revision = previous.current;
    if (input.restore) { revision = input.restore === 'previous' ? previous.previous : input.restore; this.package(id, revision); }
    check(revision, 404, 'Plugin version not found');
    const pkg = this.package(id, revision), row = this.connectors.resolve(id);
    if ((input.enabled ?? previous.enabled) && row.installed && pkg.runtime.kind === 'node-stdio' && (row.auth.type === 'none' || row.credential)) {
      const client = await openPluginClient(this.hostCall, pkg,
        validatePluginConfiguration(pkg, {}, this.connectors.store.unseal(row.pluginConfiguration) ?? {}), () => this.connectors.oauth.headers(row));
      try { await client.listTools(); } finally { await client.close(); }
    }
    await this.store.mutate(state => { const item = state.plugins.find(item => item.id === id);
      if (revision !== item.current) { item.previous = item.current; item.current = revision; }
      if (input.enabled !== undefined) item.enabled = input.enabled;
    });
    await this.applyConnector(this.item(id)); await this.sync(); return this.get(id);
  }); }
  async configure(id, input, { install = false } = {}) {
    const pkg = this.package(id), row = this.connectors.resolve(id);
    const configuration = validatePluginConfiguration(pkg, input, this.connectors.store.unseal(row.pluginConfiguration) ?? {}, { requireAll: install });
    await this.connectors.mcp.close(id);
    await this.connectors.store.update(row, () => { row.pluginConfiguration = this.connectors.store.seal(configuration);
      row.pluginConfiguredKeys = Object.keys(configuration).filter(key => configuration[key]);
      if (install) row.installed = true; row.connectionStatus = 'unchecked'; row.tools = []; });
    if (pkg.auth) await this.applyConnector(this.item(id), true);
    return { ok: true };
  }
  async remove(id) { return this.serialize(async () => {
    this.item(id); await this.connectors.disconnect(id);
    await this.store.mutate(state => { state.plugins = state.plugins.filter(item => item.id !== id); });
    await this.connectors.store.mutate(data => { data.connectors = data.connectors.filter(row => row.id !== id); });
    await this.skills.replaceSource(`plugin:${id}`, []); return { ok: true };
  }); }
  async client(row) {
    const pkg = this.package(row.pluginId, row.pluginRevision);
    if (pkg.runtime.kind === 'skills-only') return { listTools: async () => ({ tools: [] }), close: async () => {} };
    const configuration = validatePluginConfiguration(pkg, {}, this.connectors.store.unseal(row.pluginConfiguration) ?? {});
    return openPluginClient(this.hostCall, pkg, configuration, () => this.connectors.oauth.headers(row));
  }
  async sync() {
    const entries = this.store.value.plugins.map(item => {
      const row = this.connectors.store.data.connectors.find(row => row.id === item.id);
      return { item, enabled: item.enabled && row?.installed === true && row?.pluginRevision === item.current &&
        (row.auth.type === 'none' || Boolean(row.credential)) };
    });
    const orphans = [...new Set(this.skills.store.value.skills.filter(skill => skill.enabled && skill.source.startsWith('plugin:') &&
      !this.store.value.plugins.some(item => skill.source === `plugin:${item.id}`)).map(skill => skill.source))];
    const signature = JSON.stringify([entries.map(({ item, enabled }) => [item.id, item.current, enabled]), orphans]);
    if (signature === this.syncSignature) return;
    for (const { item, enabled } of entries) await this.skills.replaceSource(`plugin:${item.id}`, bundledSkills(this.package(item.id), enabled));
    for (const source of orphans) await this.skills.replaceSource(source, []);
    this.syncSignature = signature;
  }
  async syncResult() {
    await this.sync(); return this.skills.list().filter(skill => skill.source.startsWith('plugin:') && skill.enabled)
      .map(skill => ({ id: skill.id, name: skill.name, pluginId: skill.source.slice(7) }));
  }
}
