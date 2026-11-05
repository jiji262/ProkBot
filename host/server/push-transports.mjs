import http2 from 'node:http2';
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';

export class PushError extends Error {
  constructor(reason, { retryable = false, invalidToken = false } = {}) {
    super(reason); this.retryable = retryable; this.invalidToken = invalidToken;
  }
}
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export function signApnsToken(config, now = Date.now()) {
  const unsigned = `${b64({ alg: 'ES256', kid: config.keyId })}.${b64({ iss: config.teamId, iat: Math.floor(now / 1000) })}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key: createPrivateKey(config.privateKey), dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${signature.toString('base64url')}`;
}
export function apnsPayload(item) {
  const payload = { aps: { alert: { title: item.title, body: item.body }, sound: 'default', 'thread-id': item.agentId },
    notificationId: item.id, agentId: item.agentId, deepLink: item.deepLink };
  while (Buffer.byteLength(JSON.stringify(payload)) > 4096 && payload.aps.alert.body.length)
    payload.aps.alert.body = [...payload.aps.alert.body].slice(0, -100).join('');
  return JSON.stringify(payload);
}
export class PushTransports {
  constructor({ fetchImpl = fetch, connect = http2.connect } = {}) {
    this.fetch = fetchImpl; this.connect = connect; this.sessions = new Map(); this.tokens = new Map();
    this.abort = new AbortController();
  }
  async bark(device, item) {
    let response;
    try {
      response = await this.fetch(device.bark.endpoint, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_key: device.bark.key, title: item.title, body: item.body,
          group: 'Grok Bot', ...(device.iconUrl ? { icon: device.iconUrl } : {}), url: item.deepLink, isArchive: '1' }),
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]) });
    } catch { throw new PushError('Bark 连接失败', { retryable: true }); }
    // Do not retain arbitrary response text, which may contain the credential URL.
    let raw = '';
    try {
      for await (const chunk of response.body ?? []) {
        raw += Buffer.from(chunk).toString('utf8');
        if (raw.length > 16384) throw new Error('oversize');
      }
    } catch { throw new PushError('Bark 响应无效', { retryable: true }); }
    let result; try { result = JSON.parse(raw); } catch {}
    if (!response.ok || result?.code !== 200)
      throw new PushError(`Bark 返回 ${response.status}${Number.isInteger(result?.code) ? ` / ${result.code}` : ''}`, { retryable: response.status === 429 || response.status >= 500 });
    return { provider: 'bark', accepted: true };
  }
  session(config, environment) {
    const origin = environment === 'development' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    const identity = createHash('sha256').update(`${config.mode}:${config.privateKey}:${config.certificate ?? ''}`).digest('hex');
    const id = `${origin}:${identity}`;
    let session = this.sessions.get(id);
    if (!session || session.destroyed || session.closed) {
      session = this.connect(origin, config.mode === 'certificate' ? { cert: config.certificate, key: config.privateKey } : {});
      session.on('error', () => {});
      session.once('close', () => { if (this.sessions.get(id) === session) this.sessions.delete(id); });
      session.setTimeout?.(60000, () => session.close());
      this.sessions.set(id, session);
    }
    return session;
  }
  token(config) {
    const id = createHash('sha256').update(`${config.keyId}:${config.teamId}:${config.privateKey}`).digest('hex');
    const cached = this.tokens.get(id);
    if (cached && Date.now() - cached.created < 40 * 60000) return cached.value;
    this.tokens.clear();
    const value = signApnsToken(config); this.tokens.set(id, { value, created: Date.now() }); return value;
  }
  async apns(device, item, config) {
    const headers = { ':method': 'POST', ':path': `/3/device/${device.token}`,
      'apns-topic': config.topic, 'apns-push-type': 'alert', 'apns-priority': '10',
      'apns-id': randomUUID(), 'apns-collapse-id': createHash('sha256').update(item.id).digest('hex'),
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 86400), 'content-type': 'application/json' };
    if (config.mode === 'token') headers.authorization = `bearer ${this.token(config)}`;
    let reply;
    try {
      reply = await new Promise((resolve, reject) => {
        const request = this.session(config, device.environment).request(headers);
        let status, text = '';
        const timer = setTimeout(() => { request.destroy(); reject(new Error('timeout')); }, 15000);
        request.on('response', headers => { status = Number(headers[':status']); });
        request.on('data', chunk => { text += chunk; if (text.length > 16384) request.destroy(new Error('oversize')); });
        request.on('end', () => { clearTimeout(timer); resolve({ status, text }); });
        request.on('error', error => { clearTimeout(timer); reject(error); });
        request.end(apnsPayload(item));
      });
    } catch { throw new PushError('APNs 连接失败', { retryable: true }); }
    if (reply.status === 200) return { provider: 'apns', accepted: true };
    let reason; try { reason = JSON.parse(reply.text).reason; } catch {}
    const safeReason = typeof reason === 'string' && /^[A-Za-z]{1,80}$/.test(reason) ? reason : 'Unknown';
    if (safeReason === 'ExpiredProviderToken') this.tokens.clear();
    throw new PushError(`APNs ${reply.status} ${safeReason}`, {
      retryable: reply.status === 429 || reply.status >= 500 || safeReason === 'ExpiredProviderToken',
      invalidToken: reply.status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic'].includes(safeReason),
    });
  }
  close() { this.abort.abort(); for (const session of this.sessions.values()) session.destroy(); this.sessions.clear(); }
}
