import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { JsonStore } from './storage.mjs';
import { check } from './security.mjs';
import { normalizeRecipe, normalizeSharePackage, packShare, unpackShare, shareDigest } from './sharing-package.mjs';

const identifier = () => randomBytes(16).toString('base64url').slice(0, 21);
const selectedMemories = (recipe, ids = []) => {
  check(Array.isArray(ids) && ids.length <= recipe.memory.length && ids.every(index => Number.isInteger(index) && index >= 0 && index < recipe.memory.length), 400, 'Invalid memory selection');
  return { ...recipe, memory: recipe.memory.filter((_, index) => ids.includes(index)) };
};

export class Sharing {
  constructor(dataDir, { skills, plugins, hostCall, profile, publicUrl } = {}) {
    Object.assign(this, { skills, plugins, hostCall, profile, publicUrl });
    this.store = new JsonStore(join(dataDir, 'sharing.json'), { version: 1, items: [], imports: [] });
    this.imports = new Map();
  }
  async load() {
    await this.store.load();
    if (this.skills && !this.skills.list().some(item => item.id === 'export-bot-template')) await this.skills.publish(localExportSkill);
    return this;
  }
  hostName() { return this.profile?.current().hostName ?? 'Host'; }
  list() { return this.store.value.items.map(item => this.view(item)); }
  record(id) { const item = this.store.value.items.find(item => item.id === id); check(item, 404, 'Shared package not found'); return item; }
  version(id, number) {
    const item = this.record(id), version = item.versions.find(version => version.version === (number ?? item.latestVersion));
    check(version, 404, 'Shared version not found'); return { item, version };
  }
  view(item, version = item.versions.at(-1)) {
    const content = version.package.content, profile = item.kind === 'bot' ? content.profile : content;
    return { id: item.id, shareId: item.id, kind: item.kind, name: profile.name, title: profile.title,
      description: profile.description, avatarShape: profile.avatarShape ?? '', avatarColor: profile.avatarColor ?? '',
      sourceAgentId: item.sourceAgentId, workflowId: item.workflowId,
      shareUrl: `${this.publicUrl ?? ''}/admin?view=sharing`, version: version.version,
      activeVersion: item.activeVersion, active: item.activeVersion === version.version,
      published: item.activeVersion != null, visibility: 'team', createdAtMs: item.createdAt, updatedAtMs: version.at,
      ...(item.kind === 'bot' ? { memory: content.memory, skills: content.skills, routines: content.routines, plugins: content.plugins } : {}),
      dependencies: version.package.dependencies, versions: item.versions.map(v => ({ version: v.version, at: v.at, digest: v.digest })),
    };
  }
  details(id, number) {
    const { item, version } = this.version(id, number), content = version.publishedPackage ?? version.package;
    return { ...this.view(item, { ...version, package: content }), package: content,
      digest: version.publishedDigest ?? version.digest, immutable: Boolean(version.publishedPackage) };
  }
  async stage(kind, content, { sourceAgentId, workflowId, dependencies = [] } = {}) {
    const value = normalizeSharePackage({ schemaVersion: 1, kind, content, dependencies });
    let result;
    await this.store.mutate(state => {
      let item = state.items.find(item => item.kind === kind && (sourceAgentId ? item.sourceAgentId === sourceAgentId : workflowId && item.workflowId === workflowId));
      if (!item) { item = { id: identifier(), kind, sourceAgentId, workflowId, createdAt: Date.now(), versions: [] }; state.items.push(item); }
      const version = { version: (item.latestVersion ?? 0) + 1, at: Date.now(), package: value, digest: shareDigest(value) };
      item.latestVersion = version.version; item.versions.push(version); result = this.view(item, version);
    });
    return result;
  }
  async createBot({ sourceAgentId, recipe }) {
    check(typeof sourceAgentId === 'string' && /^[a-f0-9-]{1,128}$/i.test(sourceAgentId), 400, 'Invalid source Bot');
    const normalized = normalizeRecipe(recipe);
    const dependencies = normalized.plugins.map(plugin => {
      const installed = this.plugins?.list().find(item => item.id === plugin.pluginId);
      const name = typeof installed?.name === 'string' ? installed.name : installed?.name?.en;
      return { pluginId: plugin.pluginId, name: name ?? plugin.name, version: installed?.version ?? plugin.version, tools: [] };
    });
    return this.stage('bot', normalized, { sourceAgentId, dependencies });
  }
  async createSkill({ workflowId, skill, dependencies = [] }) {
    check(typeof workflowId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(workflowId), 400, 'Invalid source skill');
    return this.stage('skill', skill, { workflowId, dependencies });
  }
  async publish({ shareId, version: number, memoryIndices = [] }) {
    await this.store.mutate(state => {
      const item = state.items.find(item => item.id === shareId); check(item, 404, 'Shared package not found');
      const version = item.versions.find(version => version.version === number); check(version, 404, 'Shared version not found');
      // The native Publish action has no memory-selection field: its safe default is no memories.
      const value = structuredClone(version.package);
      if (item.kind === 'bot') value.content = selectedMemories(value.content, memoryIndices);
      const nextDigest = shareDigest(value);
      check(!version.publishedDigest || version.publishedDigest === nextDigest, 409, 'Published versions are immutable; stage a new version');
      version.publishedPackage = value; version.publishedDigest = nextDigest; item.activeVersion = number;
    });
    return this.details(shareId, number);
  }
  async unpublish(id) { await this.store.mutate(state => { const item = state.items.find(item => item.id === id); check(item, 404, 'Shared package not found'); delete item.activeVersion; }); return { ok: true }; }
  async remove(id) { await this.store.mutate(state => { check(state.items.some(item => item.id === id), 404, 'Shared package not found'); state.items = state.items.filter(item => item.id !== id); }); return { ok: true }; }
  download(id, number) {
    const { item, version } = this.version(id, number ?? this.record(id).activeVersion);
    check(version.publishedPackage, 409, 'Publish this version first');
    return { bytes: packShare(version.publishedPackage), name: `${item.kind}-${item.id}-v${version.version}.zip` };
  }
  preview(bytes) {
    const value = unpackShare(bytes), content = value.content;
    const installed = new Set(this.plugins?.list().map(item => item.id) ?? []);
    return { package: value, digest: shareDigest(value), name: value.kind === 'bot' ? content.profile.name : content.name,
      kind: value.kind, memory: value.kind === 'bot' ? content.memory : [],
      skills: value.kind === 'bot' ? content.skills.map(s => s.name) : [content.name],
      routines: value.kind === 'bot' ? content.routines.map(r => ({ name: r.name, isEnabled: false })) : [],
      dependencies: value.dependencies.map(item => ({ ...item, installed: installed.has(item.pluginId) })),
    };
  }
  async import(bytes, { digest, importId, memoryIndices = [] }) {
    const preview = this.preview(bytes); check(digest === preview.digest, 409, 'Package changed; review it again');
    check(typeof importId === 'string' && /^[a-f0-9-]{36}$/i.test(importId), 400, 'Invalid import request ID');
    if (this.imports.has(importId)) return this.imports.get(importId);
    const run = this.performImport(preview, { importId, memoryIndices }); this.imports.set(importId, run);
    try { return await run; } finally { this.imports.delete(importId); }
  }
  async performImport(preview, { importId, memoryIndices }) {
    const value = structuredClone(preview.package);
    if (value.kind === 'bot') value.content = selectedMemories(value.content, memoryIndices);
    const importDigest = shareDigest(value);
    let record;
    await this.store.mutate(state => {
      record = state.imports.find(item => item.id === importId);
      if (record) { check(record.digest === importDigest, 409, 'Import request changed'); return; }
      record = { id: importId, digest: importDigest, targetId: value.kind === 'bot' ? randomUUID() : `${value.content.id.slice(0, 46)}-${randomBytes(5).toString('hex')}`, kind: value.kind, at: Date.now(), status: 'pending' };
      state.imports.push(record);
    });
    if (record.status === 'complete') return record.result;
    let result;
    if (value.kind === 'skill') {
      const skill = await this.skills.publish({ ...value.content, id: record.targetId, enabled: true });
      result = { kind: 'skill', id: skill.id, name: skill.name, dependencies: preview.dependencies };
    } else {
      check(this.hostCall, 503, 'Host is unavailable');
      const imported = await this.hostCall('importLocalSharedBot', { agentId: record.targetId, recipe: value.content, digest: importDigest });
      result = { kind: 'bot', id: imported.agent.id, name: imported.agent.name, dependencies: preview.dependencies, routinesPaused: true };
    }
    await this.store.mutate(state => { const saved = state.imports.find(item => item.id === importId); Object.assign(saved, { status: 'complete', result }); });
    return result;
  }
  async internal(method, args) {
    if (method === 'create-bot') return this.createBot(args);
    if (method === 'create-skill') return this.createSkill(args);
    if (method === 'publish') return this.publish(args);
    if (method === 'get-version') {
      const { item, version } = this.version(args.shareId, args.version);
      return this.view(item, version.publishedPackage ? { ...version, package: version.publishedPackage } : version);
    }
    if (method === 'get-source') { const item = this.store.value.items.find(item => item.sourceAgentId === args.sourceAgentId); return item ? this.view(item) : null; }
    if (method === 'get-workflow') { const item = this.store.value.items.find(item => item.workflowId === args.workflowId); return item ? this.view(item) : null; }
    if (method === 'delete') return this.remove(args.shareId);
    if (method === 'unpublish') return this.unpublish(args.shareId);
    if (method === 'targets') return { teams: [{ teamId: 1, name: this.hostName() }], unavailableReason: null };
    check(false, 404, 'Unknown sharing method');
  }
}

export const localExportSkill = {
  id: 'export-bot-template', name: 'Export Bot template',
  description: 'Prepare a reusable Bot recipe for review and publishing to this Host.', requiresTools: [],
  files: [{ path: 'SKILL.md', encoding: 'utf8', content: `# Export Bot template\n\nUse create_bot_share_json to stage a reusable Bot recipe on this Host when the user asks to share a Bot. The original review card lets the user publish the draft. Use visibility team; this means the current self-hosted workspace.\n\nInclude only the reusable profile, selected skill prose, paused routine descriptions and installed plugin references. Exclude credentials, private keys, cookies, chat transcripts, databases, personal identifiers and configuration values. Never include a complete workspace or read historical chats to assemble a package. Default memory to an empty array. If the user asks to review specific memories, include only those candidate facts; exporting memories still requires their explicit selection in the Host sharing review.\n\nPublished versions are downloaded as ZIP packages from the Host Sharing page. Importing creates a new Bot identity and keeps routines paused. Plugins are dependency metadata, not credentials or installed sessions. Do not claim that a draft is published until the user confirms the original review card.\n` }],
};
