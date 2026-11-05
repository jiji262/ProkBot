import { createRequire } from 'node:module';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { createHash } from 'node:crypto';

/** Shipped UI, cookie selection/filtering, signer, cancellation and retry policy. */
export async function createBrowserProviders({ payload, profile, config, window, BrowserWindow, locale }) {
  const require = createRequire(import.meta.url);
  const original = require(join(payload, 'electron-main/local-browser.cjs'));
  const shared = require(join(payload, 'electron-main/local-shared.cjs'));
  const transport = require(join(payload, 'node-agent-coordinator/local-browser.cjs'));
  const activateLocale = () => shared.activateLocale(locale() === 'zh-CN' ? 'zh-CN' : 'en');
  activateLocale();
  const importer = original.createChromeImport({ platform: process.platform, homeDir: homedir(),
    workerEntryPath: join(payload, 'electron-main/chrome-import-worker.cjs') });
  const scope = createHash('sha256').update(`${config.server}\0${config.deviceId}`).digest('hex').slice(0, 24);
  const accessPath = join(profile, `browser-consent-${scope}.json`);
  let access = { granted: false, origins: [] }, pending, writes = Promise.resolve();
  try { const stored = JSON.parse(await readFile(accessPath, 'utf8'));
    access = { granted: stored.granted === true, origins: original.normalizeCookieGrants(stored.origins ?? []) }; } catch {}
  const saveAccess = change => writes = writes.catch(() => {}).then(async () => {
    const next = change(access);
    await writeFile(`${accessPath}.tmp`, JSON.stringify(next), { mode: 0o600 });
    await rename(`${accessPath}.tmp`, accessPath); access = next;
  });
  const windows = () => window.isDestroyed() ? [] : [window];
  const cancel = () => { pending?.abort(); return original.cancelCookieUI(windows()); };
  const present = async ({ origins, requestId, agentId }) => {
    await cancel(); activateLocale();
    const abort = new AbortController(); pending = abort;
    try {
      if (window.isDestroyed()) return { kind: 'refused', message: 'Desktop window is closed', reason: 'no-window' };
      window.show();
      return await original.presentCookieApproval({
        listCookieAllowItems: signal => importer.listCookieAllowItems(signal), listProfiles: () => importer.listProfiles(),
        collectProfileCookies: (profileId, signal) => importer.collectProfileCookies(profileId, signal),
        hasCookieListAccess: () => access.granted,
        grantCookieListAccess: () => saveAccess(value => ({ ...value, granted: true })),
        present: (request, signal) => original.presentCookieUI(windows, request, signal),
        settle: value => original.settleCookieUI(windows(), value),
        cancel: () => original.cancelCookieUI(windows()),
      }, origins, { requestId, ...(agentId ? { agentId } : {}) }, abort.signal);
    } finally { if (pending === abort) pending = null; }
  };
  function options(name) {
    return { resolveConnection: async () => ({ baseUrl: config.server, token: config.token }), label: hostname(),
      heartbeatPolicy: transport.interval({ name: `${name}-heartbeat`, intervalMs: 10000 }),
      reconnectPolicy: transport.reconnect(), connectDeadline: transport.deadline({ name: `${name}-connect`, timeoutMs: 15000 }),
      stallWatchdog: transport.watchdog({ name: `${name}-stall`, idleMs: 45000 }),
      deliveryPolicy: transport.delivery({ name: `${name}-delivery`, maxAttempts: 5, initialDelayMs: 250, maxDelayMs: 4000 }),
    };
  }
  const cookies = transport.cookieProvider({ ...options('local-cookies'), present, cancel });
  const binaryPath = transport.findSigner({ isPackaged: true });
  const passkeys = binaryPath ? transport.passkeyProvider({ ...options('local-passkeys'),
    consent: { requestConsent: ceremony => {
      activateLocale();
      return original.requestPasskey({ origin: ceremony.origin,
        rpId: transport.relyingParty(ceremony.optionsJson) ?? ceremony.origin }, BrowserWindow);
    }, finish: () => original.finishPasskey() },
    signer: transport.signer({ binaryPath, onStatus: status => original.updatePasskey(status),
      onPinRequest: async (value, promptId) => (await original.requestPin({ promptId, ...value })).pin ?? undefined }),
    denialMute: transport.expiry({ name: 'local-passkeys-denied', ttlMs: 60000 }),
  }) : null;
  cookies.start(); passkeys?.start();
  return { handlers: {
    listCookieOriginGrants: () => access.origins,
    putCookieOriginGrants: async ({ grants }) => {
      const normalized = original.normalizeCookieGrants(grants);
      await saveAccess(value => ({ ...value, origins: [...new Map([...value.origins, ...normalized]
        .map(item => [JSON.stringify([item.profileId, item.origin]), item])).values()] }));
      return access.origins;
    },
  }, close() { cookies.stop(); passkeys?.stop(); void cancel(); original.finishPasskey(); },
    capabilities: { browserLoginImport: true, passkeys: Boolean(passkeys) } };
}
