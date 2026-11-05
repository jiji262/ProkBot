import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { check } from './security.mjs';
import { tailcatLink } from '../clients/shared/tailcat-process.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const hostId = publicKey => digest(createPublicKey(publicKey).export({ type: 'spki', format: 'der' }));
export function createIdentity() {
  const pair = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { id: hostId(pair.publicKey), ...pair };
}
export function validateIdentity(identity) {
  check(identity && typeof identity.publicKey === 'string' && identity.publicKey.length < 1000, 400, 'Invalid Host identity');
  let key; try { key = createPublicKey(identity.publicKey); } catch { check(false, 400, 'Invalid Host public key'); }
  check(key.asymmetricKeyType === 'ed25519' && hostId(identity.publicKey) === identity.id, 400, 'Host fingerprint mismatch');
  return { id: identity.id, publicKey: identity.publicKey };
}
export function federationUrl(value, privateNetwork = false, optional = false) {
  if (optional && !value) return '';
  if (String(value).startsWith('tailcat:')) return tailcatLink(value);
  let url; try { url = new URL(value); } catch { check(false, 400, 'Invalid Host URL'); }
  check(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
    && (url.protocol === 'https:' || privateNetwork && url.protocol === 'http:'), 400, 'Use HTTPS or a configured private network');
  return url.origin;
}
export function signedEnvelope(identity, purpose, body, { now = Date.now(), nonce = randomUUID() } = {}) {
  const payload = { version: 1, sender: identity.id, purpose, timestamp: now, nonce, body };
  const bytes = JSON.stringify(payload);
  return { payload, signature: sign(null, Buffer.from(bytes), identity.privateKey).toString('base64url') };
}
export function verifyEnvelope(publicKey, envelope, purpose, { now = Date.now(), nonce } = {}) {
  const payload = envelope?.payload;
  check(payload && payload.version === 1 && payload.sender === hostId(publicKey) && payload.purpose === purpose
    && Number.isSafeInteger(payload.timestamp) && Math.abs(payload.timestamp - now) <= 300000
    && typeof payload.nonce === 'string' && /^[a-f0-9-]{36}$/.test(payload.nonce)
    && (!nonce || payload.nonce === nonce), 401, 'Invalid signed envelope');
  check(typeof envelope.signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(envelope.signature), 401, 'Invalid envelope signature');
  check(verify(null, Buffer.from(JSON.stringify(payload)), publicKey, Buffer.from(envelope.signature, 'base64url')), 401, 'Signature verification failed');
  return payload.body;
}
export const peerAddress = (peerId, agentId) => `peer:${peerId}:${agentId}`;
export function parsePeerAddress(address) {
  const match = /^peer:([a-f0-9]{64}):([A-Za-z0-9_-]{1,128})$/.exec(address ?? '');
  check(match, 400, 'Invalid remote Bot address'); return { peerId: match[1], agentId: match[2] };
}
