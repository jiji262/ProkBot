import { createPrivateKey, X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { JsonStore } from './storage.mjs';
import { check } from './security.mjs';

export const validTopic = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/.test(value);
const validId = value => typeof value === 'string' && /^[A-Z0-9]{10}$/.test(value);
// Grok Bot 1.16.0 artwork from Apple's public lookup API, verified 2026-10-21.
// Store the URL only; release packages do not redistribute the original image.
export const DEFAULT_BARK_ICON_URL = 'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/15/7d/6d/157d6dc5-51be-d2d1-488b-df875e436c3e/app-0-0-1x_U007epad-0-0-0-1-0-0-P3-85-220.png/512x512bb.jpg';
export class PushConfig {
  constructor(dataDir) {
    this.store = new JsonStore(join(dataDir, 'push-provider.json'), {
      version: 1, enabled: false, mode: 'token', topic: '', teamId: '', keyId: '',
    });
  }
  async load() { await this.store.load(); return this; }
  publicConfig() {
    const { enabled, mode, topic, teamId, keyId, privateKey, certificate, certificateExpiresAt, barkIconUrl = '' } = this.store.value;
    return { enabled, mode, topic, teamId, keyId, barkIconUrl, hasPrivateKey: Boolean(privateKey),
      hasCertificate: Boolean(certificate), certificateExpiresAt: certificateExpiresAt ?? null,
      ready: Boolean(enabled && privateKey && validTopic(topic) &&
        (mode === 'token' ? validId(teamId) && validId(keyId) : certificate && Date.parse(certificateExpiresAt) > Date.now())) };
  }
  async save(input) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '推送配置无效');
    await this.store.mutate(current => {
      const next = { ...current };
      for (const key of ['enabled', 'mode', 'topic', 'teamId', 'keyId'])
        if (input[key] !== undefined) next[key] = input[key];
      if (input.barkIconUrl !== undefined) next.barkIconUrl = normalizeBarkIconUrl(input.barkIconUrl);
      if (input.clearCredentials || next.mode !== current.mode) {
        delete next.privateKey; delete next.certificate; delete next.certificateExpiresAt;
      }
      for (const key of ['privateKey', 'certificate']) {
        if (input[key] === undefined || input[key] === '') continue;
        check(typeof input[key] === 'string' && input[key].length <= 32768, 400, '推送凭证文件过大');
        next[key] = input[key].trim();
      }
      check(typeof next.enabled === 'boolean' && ['token', 'certificate'].includes(next.mode), 400, '推送认证方式无效');
      check(!next.topic || validTopic(next.topic), 400, 'App Bundle ID 无效');
      check(!next.teamId || validId(next.teamId), 400, 'Team ID 应为 10 位字母或数字');
      check(!next.keyId || validId(next.keyId), 400, 'Key ID 应为 10 位字母或数字');
      let key;
      if (next.privateKey) {
        try { key = createPrivateKey(next.privateKey); }
        catch { check(false, 400, '无法读取私钥，请上传未加密的 PEM 或 APNs .p8 文件'); }
      }
      if (next.mode === 'token' && key) {
        check(key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1', 400, 'APNs .p8 必须是 P-256 私钥');
      }
      if (next.mode === 'certificate' && next.certificate) {
        let cert;
        try { cert = new X509Certificate(next.certificate); }
        catch { check(false, 400, '无法读取 PEM 推送证书'); }
        check(Date.parse(cert.validTo) > Date.now(), 400, '推送证书已过期');
        if (key) check(cert.checkPrivateKey(key), 400, '推送证书与私钥不匹配');
        next.certificateExpiresAt = new Date(cert.validTo).toISOString();
      }
      if (next.enabled) {
        check(key && validTopic(next.topic), 400, '启用 APNs 需要私钥和 App Bundle ID');
        check(next.mode === 'token' ? validId(next.keyId) && validId(next.teamId) : next.certificate, 400, '请填写完整的 APNs 凭证');
      }
      Object.keys(current).forEach(key => delete current[key]);
      Object.assign(current, next);
    });
    return this.publicConfig();
  }
}

export function normalizeBarkIconUrl(input) {
  check(typeof input === 'string' && input.length <= 2048, 400, 'Bark 图标地址无效');
  if (!input.trim()) return '';
  let url;
  try { url = new URL(input.trim()); } catch { check(false, 400, 'Bark 图标地址无效'); }
  check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash,
    400, 'Bark 图标需要不含凭据的 HTTP(S) 地址');
  return url.href;
}

/** Accept the complete command copied from Bark, or its URL. Never execute it. */
export function parseBarkLink(input) {
  check(typeof input === 'string' && input.length <= 4096, 400, '请输入 Bark 推送链接');
  const match = input.trim().match(/https?:\/\/[^\s"'<>`]+/i);
  check(match, 400, '未找到 Bark 的 HTTP(S) 链接');
  let url;
  try { url = new URL(match[0]); } catch { check(false, 400, 'Bark 链接无效'); }
  check(!url.username && !url.password && !url.hash, 400, 'Bark 链接不能包含登录信息或片段');
  let segments;
  try { segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { check(false, 400, 'Bark 链接路径无效'); }
  const queryKey = url.searchParams.get('device_key');
  const key = queryKey || segments[0];
  check(typeof key === 'string' && /^[A-Za-z0-9_-]{8,256}$/.test(key), 400, '无法识别 Bark Key，请复制应用提供的完整推送链接');
  const prefix = queryKey ? url.pathname.replace(/\/push\/?$/, '').replace(/\/$/, '') : '';
  return { endpoint: `${url.origin}${prefix}/push`, key, host: url.host };
}
