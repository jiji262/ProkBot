import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { materializeSkills } from '../server/skills.mjs';

const roots = () => ({ data: process.env.GROKBOT_DATA_DIR ?? process.env.GROKBOT_STATE_DIR ?? '/research/state',
  host: process.env.SAND_DATA_ROOT ?? join(process.env.GROKBOT_STATE_DIR ?? '/research/state', 'host-data') });
export async function startLocalManagedSkills(context) {
  const paths = roots(); let snapshot, disposed = false, pending = Promise.resolve();
  const refresh = () => pending = pending.catch(() => {}).then(async () => {
    if (!disposed) snapshot = await materializeSkills(paths.data, paths.host);
    return snapshot;
  });
  await refresh();
  const timer = setInterval(() => refresh().catch(error => context.host.log(`[skills] ${error.name}`)), 2000);
  timer.unref();
  const dispose = async () => { disposed = true; clearInterval(timer); await pending.catch(() => {}); };
  context.onStop(dispose);
  return { dispose, refresh,
    skillsCatalog: async () => { await refresh(); return snapshot.skills.map(skill => ({
      id: skill.id, name: skill.name, description: skill.description, source: 'managed', publisher: 'Host',
    })); },
    ensureManagedSkill: async id => { await refresh(); return snapshot.skills.some(skill => skill.id === id); },
    resolveTeamRules: async () => { await refresh(); return []; },
  };
}

/** Each Runner filters its own skill catalog with the tools assembled for that turn. */
export function withSkillDependencies(store, { data, host } = roots()) {
  if (!store) return store;
  let tools = new Set(), paths = new Map();
  const json = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return fallback; throw e;
  } };
  function visible(items) {
    const catalog = json(join(host, 'managed-skills/cache.json'), { skills: [] });
    const dependencies = new Map(catalog.skills.map(skill => [skill.id, skill.requiresTools ?? []]));
    const enabled = new Set(tools);
    const connectors = json(join(data, 'connectors/catalog.json'), { connectors: [] });
    for (const connector of connectors.connectors ?? []) if (connector.enabled && connector.installed &&
      connector.connectionStatus === 'connected') for (const tool of connector.tools ?? []) {
      if (!(connector.disabledTools ?? []).includes(tool.name)) enabled.add(`mcp.${connector.id}.${tool.name}`);
    }
    return items.filter(skill => skill.source !== 'managed' || (dependencies.get(skill.id) ?? []).every(name => enabled.has(name)))
      .filter(skill => skill.source !== 'managed' || !paths.size || (paths.has(skill.id) &&
        skill.filePath.includes(paths.get(skill.id).revision.slice(0, 12))))
      .map(skill => paths.has(skill.id) && skill.source === 'managed' ? { ...skill, filePath: paths.get(skill.id).path } : skill);
  }
  return new Proxy(store, { get(target, key) {
    if (key === 'setAvailableTools') return names => { tools = new Set(names); };
    if (key === 'setExecutionPaths') return value => { paths = value; };
    if (key === 'list') return () => visible(target.list());
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
