import { sharingClient } from './sharing-client.mjs';
import { check } from '../server/security.mjs';

/** Preserve the original draft/review/publish protocol, with this Host as its destination. */
export async function localTemplates() {
  const request = await sharingClient(), cache = new Map();
  const view = value => value == null ? value : Object.fromEntries(['shareId', 'name', 'title', 'description', 'avatarShape', 'avatarColor',
    'shareUrl', 'memory', 'skills', 'routines', 'plugins', 'published', 'version', 'activeVersion', 'active', 'sourceAgentId',
    'createdAtMs', 'updatedAtMs', 'visibility'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  const remember = input => { const value = view(input); if (value?.sourceAgentId) cache.set(value.sourceAgentId, value); return value; };
  return {
    create: async input => {
      check(input.blob?.contentType === 'application/json', 400, 'Bot recipe is required');
      const bytes = Buffer.from(input.blob.bytes); check(bytes.length <= 10 * 1024 * 1024, 413, 'Bot recipe exceeds size limit');
      let recipe; try { recipe = JSON.parse(bytes.toString('utf8')); } catch { check(false, 400, 'Invalid Bot recipe'); }
      const created = remember(await request('create-bot', { sourceAgentId: input.sourceAgentId, recipe }));
      return { ...created, id: created.shareId };
    },
    getForSourceAgent: async args => { const value = remember(await request('get-source', args)); cache.set(args.sourceAgentId, value); return value; },
    peekForSourceAgent: ({ sourceAgentId }) => cache.get(sourceAgentId),
    getExportPolicy: async () => 'team_only', peekExportPolicy: () => 'team_only', peekHasTeam: () => true,
    publish: async args => remember(await request('publish', args)),
    getVersion: async args => {
      const value = view(await request('get-version', args));
      return value == null ? value : { ...value, published: value.active === true };
    },
    delete: async args => { await request('delete', args); for (const [id, value] of cache) if (value?.shareId === args.shareId) cache.delete(id); },
    setVisibility: async args => { check(args.visibility === 'team', 400, 'Packages are shared through this Host'); return view(await request('get-version', args)); },
  };
}
