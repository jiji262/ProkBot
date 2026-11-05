import { join } from 'node:path';
import { readJson, writePrivate } from '../server/storage.mjs';
import { TailcatProcess } from '../clients/shared/tailcat-process.mjs';

export async function startExecutionTailcat(port) {
  if (process.env.GROKBOT_TAILCAT_ENABLED !== '1') return null;
  const directory = process.env.GROKBOT_NODE_DATA_DIR ?? '/data';
  const identityFile = join(directory, 'tailcat-identity.json');
  const tunnel = new TailcatProcess({ mode: 'serve', target: `127.0.0.1:${port}`, port: 8443,
    identity: await readJson(identityFile, null), derpMapURL: process.env.GROKBOT_TAILCAT_DERP_MAP_URL ?? '',
    relay: process.env.GROKBOT_TAILCAT_RELAY ?? '' }, {
    onIdentity: value => writePrivate(identityFile, JSON.stringify(value)),
    onStatus: value => { void writePrivate(join(directory, 'tailcat-status.json'), JSON.stringify({ state: value.state, path: value.path, accepted: value.accepted, forwarded: value.forwarded, error: value.error })).catch(() => {}); if (value.link) void writePrivate(join(directory, 'tailcat-link'), value.link + '\n').catch(() => {}); },
  });
  await tunnel.start(); return tunnel;
}
