import { grokText } from './i18n.mjs';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TailcatProcess, tailcatLink } from '../shared/tailcat-process.mjs';

export async function openTransport(address, enabled, { identity, binary } = {}) {
  if (!enabled) return { server: normalizeServer(address), address: normalizeServer(address), tailcat: false, close: async () => {} };
  address = tailcatLink(address);
  let networkIdentity = identity;
  const tunnel = new TailcatProcess({ mode: 'forward', link: address, identity }, { binary, onIdentity: value => { networkIdentity = value; } });
  try {
    const status = await tunnel.start();
    return { server: status.localURL, address, tailcat: true, networkIdentity, tunnel, close: () => tunnel.close() };
  } catch (error) { await tunnel.close(); throw error; }
}

export function normalizeServer(input) {
  const url = new URL(String(input).trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
    throw new Error(grokText('请输入 Host 的 http:// 或 https:// 地址。', 'Enter the Host http:// or https:// address.'));
  return url.origin;
}

export async function pair(server, pairingKey, fetcher = fetch, { tunneled = false } = {}) {
  server = normalizeServer(server);
  if (!pairingKey?.trim()) throw new Error(grokText('请输入配对码。', 'Enter a pairing code.'));
  const response = await fetcher(`${server}/connect/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingKey: pairingKey.trim().toUpperCase(), deviceName: os.hostname(), platform: 'desktop' }),
    signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 401 ? grokText('配对码 无效或已过期。', 'Pairing code is invalid or expired.') : grokText(`连接失败（HTTP ${response.status}）。`, `Connection failed (HTTP ${response.status}).`));
  if (typeof result.token !== 'string' || result.token.length < 16 || !result.deviceId)
    throw new Error(grokText('Host 返回的设备凭证无效。', 'Host returned invalid device credentials.'));
  if (!tunneled && normalizeServer(result.gatewayUrl) !== server)
    throw new Error(grokText('Host 返回了不同的服务地址。', 'Host returned a different server address.'));
  return { server, deviceId: result.deviceId, token: result.token };
}

export function credentialStore(profile, safeStorage) {
  const filename = path.join(profile, 'connection.json');
  function available() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(grokText('请解锁 macOS 钥匙串。', 'Unlock your macOS keychain.'));
  }
  return {
    async load() {
      let record;
      try { record = JSON.parse(await readFile(filename, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      available();
      const network = record.encryptedNetwork ? JSON.parse(safeStorage.decryptString(Buffer.from(record.encryptedNetwork, 'base64'))) : null;
      return { server: network?.tailcat ? '' : normalizeServer(record.server), deviceId: record.deviceId,
        address: network?.tailcat ? tailcatLink(network.address) : normalizeServer(record.server),
        tailcat: network?.tailcat === true, networkIdentity: network?.identity,
        token: safeStorage.decryptString(Buffer.from(record.encryptedToken, 'base64')) };
    },
    async save(config) {
      available();
      await mkdir(profile, { recursive: true, mode: 0o700 });
      const record = { version: 1, server: config.tailcat ? '' : normalizeServer(config.address ?? config.server), deviceId: config.deviceId,
        encryptedToken: safeStorage.encryptString(config.token).toString('base64') };
      if (config.tailcat) record.encryptedNetwork = safeStorage.encryptString(JSON.stringify({ tailcat: true,
        address: tailcatLink(config.address), identity: config.networkIdentity })).toString('base64');
      await writeFile(`${filename}.tmp`, JSON.stringify(record), { mode: 0o600 });
      await rename(`${filename}.tmp`, filename);
    },
    async clear() { await rm(filename, { force: true }); },
  };
}
