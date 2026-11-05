import { createBoxApplications } from './box-applications.mjs';
import { createRemoteMcp } from './host-mcp-remote.mjs';
import { watchFile, unwatchFile } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { decorateNativeMcp } from './native-mcp.mjs';

const empty = () => ({ mcpServers: {} });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateLocalMcp(value) {
  if (!object(value) || !object(value.mcpServers)) throw new Error('Expected {mcpServers:{...}}');
  const servers = {};
  for (const [name, config] of Object.entries(value.mcpServers)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) throw new Error('Invalid local MCP server name');
    if (name === 'cursor-box-computer') throw new Error('cursor-box-computer is reserved by the original Harness');
    if (!object(config) || typeof config.command !== 'string' || !config.command.trim() ||
        Object.keys(config).some(key => !['command', 'args', 'env'].includes(key)) ||
        (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string'))) ||
        (config.env !== undefined && (!object(config.env) || Object.values(config.env).some(v => typeof v !== 'string')))) {
      throw new Error(`Invalid stdio configuration for ${name}; supported fields: command, args, env`);
    }
    servers[name] = { command: config.command, args: config.args ?? [], ...(config.env ? { env: config.env } : {}) };
  }
  return { mcpServers: servers };
}

async function jsonFile(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) throw new Error('Local MCP JSON is invalid');
    throw error;
  }
}
async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
const idFor = name => (BigInt(`0x${createHash('sha256').update(`local-mcp:${name}`).digest('hex').slice(0, 15)}`) + 1n).toString();

/** One config owner per Exec; retain original manager, tools, settings and transport. */
export async function startLocalHostMcp(context, library, { nativeEnabled = () => true, permission = () => context.deps['local-tool-permission'] } = {}) {
  const stateDir = process.env.GROKBOT_STATE_DIR ?? '/research/state';
  const configPath = join(stateDir, 'mcp.json');
  const ownerPath = join(stateDir, 'mcp-owned.json');
  const statusPath = join(stateDir, 'mcp-status.json');
  const lastGoodPath = join(stateDir, 'mcp-last-good.json');
  const listeners = new Set();
  let config = empty();
  let requested;
  let startupError;
  try { requested = validateLocalMcp(await jsonFile(configPath, empty())); }
  catch (error) {
    startupError = error;
    requested = await jsonFile(lastGoodPath, empty()).then(validateLocalMcp).catch(() => empty());
  }
  let owned = new Set(await jsonFile(ownerPath, []));
  let stopped = false;
  let revision = 0;
  let rejected = false;
  let operations = Promise.resolve();
  let registryOperations = Promise.resolve();
  const log = message => context.host.log(`[local-mcp] ${message}`);
  const boxExec = library.createBoxSandMcpExec(context.deps['forever-box'].box);
  let appServers = {}, requestedServers = empty();
  const guardedExec = {
    ...boxExec,
    loadServers: value => {
      const run = registryOperations.catch(() => {}).then(async () => {
        requestedServers = JSON.parse(value);
        value = JSON.stringify({ mcpServers: { ...requestedServers.mcpServers, ...appServers } });
        const registered = await boxExec.listTools([]);
        const foreign = registered.filter(server => !owned.has(server.serverIdentifier));
        if (foreign.length) throw new Error(`Exec has services outside this Host's ownership: ${foreign.map(s => s.serverIdentifier).join(', ')}`);
        const nextNames = Object.keys(JSON.parse(value).mcpServers);
        // Record intent first so interrupted loads remain recoverable on restart.
        owned = new Set([...owned, ...nextNames]);
        await atomicJson(ownerPath, [...owned]);
        const result = await boxExec.loadServers(value);
        owned = new Set(nextNames);
        await atomicJson(ownerPath, [...owned]);
        return result;
      });
      registryOperations = run;
      return run;
    },
  };
  const applications = createBoxApplications({ box: context.deps['forever-box'].box, library, exec: boxExec,
    updateRegistry: async servers => { appServers = servers; await guardedExec.loadServers(JSON.stringify(requestedServers)); } });
  const emit = () => { for (const listener of listeners) listener({ servers: [] }); };
  const unavailable = async () => { throw new Error('This local Host supports configured stdio MCP services; account services are unavailable'); };
  const backendMcpExec = new Proxy({}, { get: (_, name) => name === 'then' ? undefined : unavailable });
  const remote = await createRemoteMcp(library);
  if (remote.enabled) await remote.refresh().catch(() => log('connector service is starting; retry scheduled'));
  const hostMcp = library.createHostMcp({
    accountConfigProvider: async () => ({mcpServers:{...config.mcpServers,...remote.snapshot().config.mcpServers}}),
    accountDisplayConfigProvider: async () => ({ servers: Object.entries(config.mcpServers).map(([name, entry]) => ({
      id: idFor(name), name, serverIdentifier: name, config: entry,
      isTeamServer: false, disabledByTeamAdminPolicy: false,
    })).concat(remote.snapshot().display.servers) }),
    effectivePluginsProvider: remote.enabled ? remote.effective : async () => [],
    fetchMarketplacePlugins: remote.enabled ? remote.fetchMarketplacePlugins : async () => ({ plugins: [] }),
    ...(remote.enabled ? { marketplace: remote.marketplace, accountMcpWriter: remote.writer } : {}),
    backendMcpExec: remote.enabled ? remote.backend : backendMcpExec, boxMcpExec: guardedExec,
    settingsStore: context.deps.settings, resolveToolsAtTurnStart: true,
    onServersMutated: emit, log,
  });
  async function apply(next) {
    // Explicitly push empty configurations too; a newly created discovery cache
    // otherwise skips its first empty set and could retain pre-restart services.
    await guardedExec.loadServers(JSON.stringify(next));
    config = next;
    await hostMcp.management.restart();
    const state = await hostMcp.plugins.listServers();
    await atomicJson(lastGoodPath, config);
    revision++;
    rejected = false;
    await atomicJson(statusPath, { ready: true, pid: process.pid, revision,
      updatedAt: new Date().toISOString(), servers: state.servers.map(({ id, name, status, toolCount }) => ({ id, name, status, toolCount })) });
    log(`configuration applied: revision=${revision}, servers=${Object.keys(config.mcpServers).join(',') || '(empty)'}`);
    emit();
  }
  async function reject(error) {
    rejected = true;
    // Never log config values; env entries may contain credentials.
    log(`configuration rejected: ${error.message}`);
    await atomicJson(statusPath, { ready: false, pid: process.pid, revision,
      updatedAt: new Date().toISOString(), error: error.message, retainedServers: Object.keys(config.mcpServers) });
  }
  const reload = () => {
    operations = operations.catch(() => {}).then(async () => {
      if (stopped) return;
      try {
        const next = validateLocalMcp(await jsonFile(configPath, empty()));
        if (rejected || JSON.stringify(next) !== JSON.stringify(config)) await apply(next);
      } catch (error) {
        await reject(error);
      }
    });
  };
  try { await apply(requested); if (startupError) await reject(startupError); }
  catch (error) { await reject(error); }
  watchFile(configPath, { interval: 500, persistent: false }, reload);
  let refreshing = false;
  const remoteTimer = remote.enabled ? setInterval(() => {
    if (refreshing || stopped) return;
    refreshing = true;
    operations = operations.catch(() => {}).then(async () => {
      if (await remote.refresh()) { await hostMcp.management.restart(); emit(); }
    }).catch(() => {}).finally(() => { refreshing = false; });
  }, 2000) : null;
  remoteTimer?.unref();
  if (remote.enabled) {
    const localInstructions = hostMcp.mcp.getCustomInstructions;
    hostMcp.mcp.getCustomInstructions = async () => new Map([
      ...await localInstructions(), ...Object.entries(await remote.instructions()),
    ]);
  }
  context.onStop(async () => {
    stopped = true;
    clearInterval(remoteTimer);
    unwatchFile(configPath, reload);
    await operations;
    await registryOperations.catch(() => {});
    listeners.clear();
    await applications.close();
    await hostMcp.dispose();
  });
  return {
    mcp: await decorateNativeMcp(hostMcp.mcp, { library, enabled: nativeEnabled, permission }),
    applicationRpc: applications.rpc,
    management: hostMcp.management, plugins: hostMcp.plugins,
    listBoxServers: names => hostMcp.listBoxServers(names),
    subscribeToAuthCompletion: () => () => {},
    noteAuthCompletedElsewhere: hostMcp.noteAuthCompletedElsewhere,
    subscribeToServersUpdated: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    syncPluginSkills: async () => remote.enabled ? remote.request('sync-skills') : [], pluginSyncStatus: () => ({ authBlocked: [] }),
    skillPublish: await createLocalSkillPublish(),
  };
}
import { createLocalSkillPublish } from './sharing-client.mjs';
