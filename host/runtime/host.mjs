import { createRequire } from 'node:module';
import { mkdir, readdir, symlink, lstat, writeFile, rename, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadModelConfig } from './config.mjs';
import { createExtensionStarter } from './host-extensions.mjs';
import { installHostNetworkBoundary } from './host-network.mjs';
import { loadRecoveredHostCore } from './recovered-host-core.mjs';
import { prepareHostReliability } from './reliability/prepare.mjs';
import { withLibraryCleanup } from './host-library-files.mjs';
import { observeHostComputers } from './host-computers.mjs';
import { loadExecutionNode, connectExecutionNode } from '../server/execution-node.mjs';
import { writePrivate } from '../server/storage.mjs';
import { decorateLocalSharingApi } from './sharing-import.mjs';
import { installLocalPromptPolicy } from './prompt-runtime.mjs';

const stateDir = process.env.GROKBOT_STATE_DIR ?? '/research/state';
const originalDir = process.env.GROKBOT_ORIGINAL_HOST ?? '/research/original-host';
Object.assign(process.env, {
  SAND_DATA_ROOT: join(stateDir, 'host-data'),
  SAND_BACKEND_URL: 'http://127.0.0.1:9',
  SAND_DISABLE_TELEMETRY: '1', SAND_DISABLE_ANALYTICS: '1',
  SAND_BOX_AUTO_UPDATE: '0', SAND_BOX_STORE_SYNC: '0', SAND_BOX_STORE_COPY_IN: '0',
  SAND_HOST_IN_BOX: '1', SAND_PACKAGED: '1',
});

async function provisionResources() {
  await mkdir(process.env.SAND_DATA_ROOT, { recursive: true });
  for (const entry of await readdir(originalDir, { withFileTypes: true })) {
    if (['host-main.cjs', 'package.json', 'sand-eval-runner.cjs'].includes(entry.name)) continue;
    const destination = join(stateDir, entry.name);
    if (await lstat(destination).catch(() => null)) continue;
    await symlink(join(originalDir, entry.name), destination, entry.isDirectory() ? 'dir' : 'file');
  }
}

await provisionResources();
const executionTransport = await connectExecutionNode(await loadExecutionNode(process.env.GROKBOT_DATA_DIR ?? stateDir), process.env.GROKBOT_DATA_DIR ?? stateDir);
const executionNode = executionTransport.config;
if (executionNode?.enabled) {
  process.env.GROKBOT_EXECUTION_URL = executionNode.url;
  process.env.GROKBOT_BOX_HOST = new URL(executionNode.url).hostname;
  process.env.GROKBOT_BOX_TOKEN = executionNode.token;
}
const model = await loadModelConfig();
const internalToken = process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE
  ? (await readFile(process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE, 'utf8')).trim() : undefined;
if (internalToken !== undefined && !/^[A-Za-z0-9_-]{32,256}$/.test(internalToken)) throw new Error('Invalid internal Host token');
const allowedHosts = process.env.GROKBOT_BOX_HOST ? [process.env.GROKBOT_BOX_HOST] : [];
if (process.env.GROKBOT_NOTIFICATION_URL) allowedHosts.push(new URL(process.env.GROKBOT_NOTIFICATION_URL).hostname);
if (model.policy.mode === 'adaptive') allowedHosts.push('api.typesafe.ai');
installHostNetworkBoundary(model.baseUrl, { additionalHosts: allowedHosts });
const require = createRequire(import.meta.url);
const recovered = process.env.GROKBOT_RECOVERED_CORE === '1';
let libraryPath = resolve(stateDir, 'host-library.cjs'), repaired;
if (recovered) {
  repaired = await prepareHostReliability(stateDir);
  libraryPath = repaired.libraryPath;
}
const library = require(libraryPath);
const core = recovered ? await loadRecoveredHostCore(library, repaired.directory) : { mode: 'bundled' };
if (recovered) core.reliability = repaired.status;
library.activateHostLocale();
const prompts = await installLocalPromptPolicy(process.env.GROKBOT_DATA_DIR ?? stateDir, library);
const host = new library.SandHost({ startExtensions: createExtensionStarter(library, model) });
let gateway, computers;
let stopping = false;
async function saveHostStatus(status) {
  const destination = join(stateDir, 'host-status.json');
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(status, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, destination);
}
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[local-host] stopping (${signal})`);
  computers?.close();
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  await gateway?.close();
  await host.dispose();
  await executionTransport.close();
  await prompts.close();
  await saveHostStatus({
    ready: false, stoppedAt: new Date().toISOString(), pid: process.pid,
  });
  clearTimeout(deadline);
  process.exit(0);
}
process.once('SIGTERM', () => void stop('SIGTERM'));
process.once('SIGINT', () => void stop('SIGINT'));

try {
  await host.start();
  computers = observeHostComputers(host.getLocalExecBridge());
  gateway = await library.startGatewayServer({
    api: decorateLocalSharingApi({ api: { ...withLibraryCleanup(host.getApi(), host, library), localApplicationRpc: args => host.requireHostExtensions().api('mcp').applicationRpc(args) }, host }), subscribe: listener => host.subscribe(listener),
    getHealth: () => host.getHealth(), startedAt: host.startedAt,
    host: process.env.GROKBOT_HOST_BIND ?? '0.0.0.0', port: Number(process.env.GROKBOT_HOST_PORT ?? 1340),
    ...(internalToken ? { authToken: internalToken } : {}),
    onEventStreamClosed: () => host.noteEventStreamClosed(),
    onDesktopContact: () => host.noteDesktopContact(),
    prepareForUpgrade: async () => {
      if (internalToken) {
        // Freeze new turns in the same synchronous step as the idle check.
        // The original upgrade path otherwise awaits work before pausing turns.
        if (!host.transcript.isForcedUpgradePauseActive() && host.getHealth().isBusy)
          return { quiescing: false, runningTurns: 1 };
        const paused = await host.transcript.pauseTurnsForUpgrade();
        if (!paused.quiescing || paused.runningTurns > 0) return paused;
      }
      return host.prepareForUpgrade();
    },
    localExec: computers.bridge, webauthn: host.getWebAuthnBridge(),
    cookieOriginApproval: host.getCookieOriginApprovalBridge(),
    onCommandError: report => host.reportGatewayCommandError(report),
    onCommandComplete: report => host.reportGatewayCommandSuccess(report),
  });
  const status = { ready: true, revision: 'd0a4baa', model: model.model, pid: process.pid,
    port: gateway.port, dataRoot: process.env.SAND_DATA_ROOT, identity: 'local-workspace',
    officialAccount: false, officialBackend: false, telemetry: false, updates: false, core };
  await saveHostStatus(status);
  await writePrivate(join(process.env.GROKBOT_DATA_DIR ?? stateDir, 'execution-active.json'), JSON.stringify({
    revision: executionNode?.revision ?? '', pid: process.pid,
    config: executionNode ?? { enabled: false }, appliedAt: new Date().toISOString(),
  }));
  console.log(`[local-host] ready ${JSON.stringify({ revision: status.revision, model: status.model,
    pid: status.pid, port: status.port, core: core.mode, dataRoot: status.dataRoot })}`);
} catch (error) {
  console.error('[local-host] startup failed:', error);
  process.exitCode = 1;
  await host.dispose().catch(() => {});
  await executionTransport.close();
  await prompts.close();
  process.exit(1);
}
