import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { JsonStore, readJson } from './storage.mjs';
import { check } from './security.mjs';

export const promptDigest = value => createHash('sha256').update(value).digest('hex');
export const promptId = (role, original) => `${role}-${promptDigest(original).slice(0, 24)}`;
export const promptRoles = ['parent', 'automation', 'generalPurpose', 'computerUse', 'browserUse', 'videoReview', 'watchVideo'];
export function validatePrompt(value) {
  check(typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 200000 && !value.includes('\0'), 400, 'Invalid prompt content');
  return value;
}

/** The admin owns revisions; the Runner independently publishes original base-prompt variants. */
export class PromptSettings {
  constructor(directory) {
    this.catalogPath = join(directory, 'prompt-catalog.json');
    this.store = new JsonStore(join(directory, 'prompt-settings.json'), { version: 1, entries: {} });
  }
  async load() { await this.store.load(); return this; }
  async catalog() {
    const data = await readJson(this.catalogPath, { version: 1, entries: [] });
    check(data.version === 1 && Array.isArray(data.entries), 500, 'Invalid prompt catalog');
    return data.entries.filter(item => promptRoles.includes(item.role) && item.id === promptId(item.role, item.original));
  }
  async list() {
    return (await this.catalog()).map(item => {
      const revision = this.store.value.entries[item.id]?.revisions.at(-1);
      return { id: item.id, role: item.role, digest: item.digest, observedAt: item.observedAt, observed: item.observed,
        source: item.source, previewAt: item.preview?.at ?? null, revision: revision?.number ?? 0, modified: Boolean(revision && revision.content !== item.original) };
    });
  }
  async get(id) {
    const original = (await this.catalog()).find(item => item.id === id); check(original, 404, 'Prompt not found');
    const revisions = this.store.value.entries[id]?.revisions ?? [], current = revisions.at(-1);
    return { ...original, revision: current?.number ?? 0, content: current?.content ?? original.original,
      previous: revisions.length > 1 ? revisions.at(-2) : current ? { number: 0, content: original.original, action: 'original' } : null,
      revisions: revisions.map(({ content, ...item }) => item) };
  }
  async save(id, input) {
    const original = (await this.catalog()).find(item => item.id === id); check(original, 404, 'Prompt not found');
    check(input.digest === original.digest, 409, 'The original prompt changed; reload before saving');
    await this.store.mutate(state => {
      const entry = state.entries[id] ?? { revisions: [] }, current = entry.revisions.at(-1);
      check(input.expectedRevision === (current?.number ?? 0), 409, 'The prompt changed; reload before saving');
      let content = input.content, action = 'edit';
      if (input.restore === 'original') { content = original.original; action = 'restore-original'; }
      else if (input.restore === 'previous') {
        check(current, 409, 'No previous version');
        content = entry.revisions.at(-2)?.content ?? original.original; action = 'restore-previous';
      } else check(input.restore === undefined, 400, 'Invalid restore target');
      validatePrompt(content);
      if (content === (current?.content ?? original.original)) return;
      const revision = { number: (current?.number ?? 0) + 1, at: Date.now(), digest: promptDigest(content), action, content };
      entry.revisions.push(revision); entry.revisions = entry.revisions.slice(-30); state.entries[id] = entry;
    });
    return this.get(id);
  }
}
