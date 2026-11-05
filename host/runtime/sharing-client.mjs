import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { packageId, digest } from '../server/package-files.mjs';
import { check } from '../server/security.mjs';
import { readJson } from '../server/storage.mjs';

export async function sharingClient() {
  const configured = process.env.GROKBOT_SHARING_URL ?? process.env.GROKBOT_CONNECTORS_URL?.replace(/\/connectors\/?$/, '/sharing');
  check(configured, 503, 'Host sharing service is unavailable');
  const base = new URL(configured);
  check(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) && !base.username && !base.password && !base.search && !base.hash, 500, 'Sharing service must be loopback');
  const token = (await readFile(process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE, 'utf8')).trim();
  return async (method, args = {}) => {
    const response = await fetch(`${base.toString().replace(/\/$/, '')}/${method}`, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(30_000) });
    const result = await response.json(); check(response.ok, response.status, result?.error ?? 'Sharing request failed'); return result;
  };
}

async function skillFiles(directory) {
  check(await realpath(directory) === directory, 400, 'Skill directory must not be a symbolic link');
  const files = []; let size = 0;
  async function walk(relative = '') {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      if (!relative && ['runs.json', 'workflow.json'].includes(entry.name)) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const metadata = await lstat(join(directory, path));
      check(!metadata.isSymbolicLink(), 400, 'Shared skills cannot contain symbolic links');
      if (entry.isDirectory()) { await walk(path); continue; }
      check(metadata.isFile(), 400, 'Unsupported skill file'); size += metadata.size;
      check(size <= 10 * 1024 * 1024 && files.length < 255, 413, 'Skill exceeds size limit');
      const bytes = await readFile(join(directory, path));
      const source = bytes.toString('utf8'), utf8 = Buffer.from(source).equals(bytes);
      files.push({ path, encoding: utf8 ? 'utf8' : 'base64', content: utf8 ? source : bytes.toString('base64') });
    }
  }
  await walk(); return files;
}

export async function createLocalSkillPublish() {
  const request = await sharingClient(), root = process.env.SAND_DATA_ROOT ?? join(process.env.GROKBOT_STATE_DIR, 'host-data');
  async function publish({ workflowId, teamId = 1 }) {
    check(teamId === 1, 400, 'Select this Host');
    check(typeof workflowId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(workflowId), 400, 'Invalid skill ID');
    const managed = await readJson(join(root, 'managed-skills/cache.json'), { skills: [] });
    const item = managed.skills.find(item => item.id === workflowId);
    const directory = item ? dirname(item.filePath) : join(root, 'workflows', workflowId);
    const files = await skillFiles(directory), markdown = files.find(file => file.path === 'SKILL.md');
    check(markdown, 404, 'SKILL.md not found');
    const field = name => {
      const found = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(markdown.content)?.[1]?.trim();
      if (!found) return undefined; try { return JSON.parse(found); } catch { return found.replace(/^['"]|['"]$/g, ''); }
    };
    const id = /^[a-z][a-z0-9-]{0,63}$/.test(workflowId) ? workflowId : `skill-${digest(workflowId).slice(0, 20)}`;
    const skill = { id: packageId(id), name: item?.name ?? field('name') ?? workflowId,
      description: item?.description ?? field('description') ?? '', files, requiresTools: item?.requiresTools ?? [] };
    const dependencies = item?.source?.startsWith('plugin:') ? [{ pluginId: item.source.slice(7), name: item.source.slice(7), tools: skill.requiresTools }] : [];
    const staged = await request('create-skill', { workflowId, skill, dependencies });
    const published = await request('publish', { shareId: staged.shareId, version: staged.version });
    return { pluginId: staged.shareId, commitSha: published.digest, promotedWorkflowId: workflowId };
  }
  return { listTargets: () => request('targets'), publish, resync: publish,
    unpublish: async ({ workflowId }) => { const item = await request('get-workflow', { workflowId });
      check(item, 404, 'Published skill not found'); await request('unpublish', { shareId: item.shareId }); return { restoredWorkflowId: workflowId }; } };
}
