import { join, dirname } from 'node:path';
import { mkdir, chmod, readFile } from 'node:fs/promises';
import { JsonStore, writePrivate, readJson } from './storage.mjs';
import { check } from './security.mjs';
import { digest, packageId, validateFiles, textField } from './package-files.mjs';

export function validateSkill(input) {
  check(input && typeof input === 'object' && !Array.isArray(input), 400, 'Invalid skill');
  const id = packageId(input.id), name = textField(input.name, 100, 'skill name');
  const description = textField(input.description, 2000, 'skill description');
  const files = validateFiles(input.files);
  const markdown = files.find(file => file.path === 'SKILL.md' && file.encoding === 'utf8');
  check(markdown && markdown.content.trim(), 400, 'SKILL.md is required');
  const requiresTools = input.requiresTools ?? [];
  check(Array.isArray(requiresTools) && requiresTools.length <= 100 && requiresTools.every(tool =>
    typeof tool === 'string' && /^[A-Za-z][\w.-]{0,199}$/.test(tool)), 400, 'Invalid tool dependencies');
  return { id, name, description, files, requiresTools: [...new Set(requiresTools)] };
}

export class Skills {
  constructor(dataDir, { hostDataDir } = {}) {
    this.dataDir = dataDir; this.hostDataDir = hostDataDir;
    this.store = new JsonStore(join(dataDir, 'skill-catalog.json'), { version: 1, skills: [], revision: 0 });
  }
  async load() { await this.store.load(); return this; }
  list() { return this.store.value.skills.map(({ versions, ...item }) => ({ ...item,
    versions: versions.map(({ id, at, name, description }) => ({ id, at, name, description })) })); }
  get(id, version) {
    const item = this.store.value.skills.find(item => item.id === id);
    check(item, 404, 'Skill not found');
    const content = item.versions.find(entry => entry.id === (version ?? item.current));
    check(content, 404, 'Skill version not found');
    return { ...item, versions: item.versions.map(({ id, at, name, description }) => ({ id, at, name, description })), content };
  }
  async publish(input, source = 'host') {
    const content = validateSkill(input), revision = digest(JSON.stringify(content));
    await this.store.mutate(state => {
      let item = state.skills.find(item => item.id === content.id);
      if (!item) {
        item = { id: content.id, source, enabled: input.enabled !== false, baseline: revision, current: revision, versions: [] };
        state.skills.push(item);
      }
      check(item.source === source, 409, 'Skill belongs to another source');
      if (!item.versions.some(item => item.id === revision)) item.versions.push({ ...content, id: revision, at: Date.now() });
      item.previous = item.current === revision ? item.previous : item.current;
      item.current = revision; item.name = content.name; item.description = content.description;
      if (typeof input.enabled === 'boolean') item.enabled = input.enabled;
      state.revision++;
    });
    return this.get(content.id);
  }
  async update(id, { enabled, restore }) {
    await this.store.mutate(state => {
      const item = state.skills.find(item => item.id === id); check(item, 404, 'Skill not found');
      check(item.source === 'host', 409, 'Manage bundled skills through their plugin');
      if (enabled !== undefined) { check(typeof enabled === 'boolean', 400, 'Invalid enabled state'); item.enabled = enabled; }
      if (restore) {
        const target = restore === 'baseline' ? item.baseline : restore === 'previous' ? item.previous : restore;
        const version = item.versions.find(version => version.id === target); check(version, 404, 'Skill version not found');
        item.previous = item.current; item.current = target; item.name = version.name; item.description = version.description;
      }
      state.revision++;
    });
    return this.get(id);
  }
  async setSourceEnabled(source, enabled) {
    await this.store.mutate(state => { for (const item of state.skills) if (item.source === source) item.enabled = enabled; state.revision++; });
  }
  async replaceSource(source, inputs) {
    check(source.startsWith('plugin:'), 400, 'Invalid skill source');
    const contents = inputs.map(input => ({ content: validateSkill(input), enabled: input.enabled === true }));
    await this.store.mutate(state => {
      for (const item of state.skills) if (item.source === source) item.enabled = false;
      for (const { content, enabled } of contents) {
        const revision = digest(JSON.stringify(content));
        let item = state.skills.find(item => item.id === content.id);
        if (!item) { item = { id: content.id, source, baseline: revision, current: revision, versions: [] }; state.skills.push(item); }
        check(item.source === source, 409, 'Skill belongs to another source');
        if (!item.versions.some(version => version.id === revision)) item.versions.push({ ...content, id: revision, at: Date.now() });
        item.previous = item.current === revision ? item.previous : item.current;
        Object.assign(item, { current: revision, name: content.name, description: content.description, enabled });
      }
      state.revision++;
    });
  }
  async remove(id) {
    await this.store.mutate(state => {
      const item = state.skills.find(item => item.id === id); check(item, 404, 'Skill not found');
      check(item.source === 'host', 409, 'Manage bundled skills through their plugin');
      state.skills = state.skills.filter(item => item.id !== id); state.revision++;
    });
    return { ok: true };
  }
}

/** Publish complete version directories first, then atomically expose an original-format index. */
export async function materializeSkills(dataDir, hostDataDir) {
  const catalog = await readJson(join(dataDir, 'skill-catalog.json'), { skills: [], revision: 0 });
  const cacheDir = join(hostDataDir, 'managed-skills'), skills = [];
  await mkdir(cacheDir, { recursive: true, mode: 0o755 });
  for (const item of catalog.skills.filter(item => item.enabled)) {
    const current = item.versions.find(version => version.id === item.current);
    // Stable catalog identity; immutable file paths keep in-flight reads on their selected version.
    const directory = join(cacheDir, 'skills', `${item.id}-${item.current.slice(0, 12)}`);
    for (const file of current.files) {
      const filename = join(directory, file.path);
      await mkdir(dirname(filename), { recursive: true, mode: 0o755 });
      const expected = Buffer.from(file.content, file.encoding);
      const previous = await readFile(filename).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (!previous || !previous.equals(expected)) { await writePrivate(filename, expected); await chmod(filename, 0o444); }
    }
    const source = current.files.find(file => file.path === 'SKILL.md').content;
    skills.push({ id: item.id, name: current.name, description: current.description,
      body: source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''), source: item.source,
      filePath: join(directory, 'SKILL.md'), requiresTools: current.requiresTools, revision: item.current });
  }
  const previous = await readJson(join(cacheDir, 'cache.json'), null);
  if (JSON.stringify(previous?.skills) === JSON.stringify(skills)) return { revision: catalog.revision, skills };
  const index = { fetchedAt: Date.now(), skills };
  await writePrivate(join(cacheDir, 'cache.json'), JSON.stringify(index));
  return { revision: catalog.revision, skills };
}
