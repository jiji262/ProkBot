import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { check, HttpError } from './security.mjs';

export function serviceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400, 'Invalid service URL'); }
  check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
    400, 'Invalid service URL');
  return url.href.replace(/\/$/, '');
}
export async function boundedBody(response, limit = 8 * 1024 * 1024) {
  const parts = []; let size = 0;
  try {
    for await (const chunk of response.body ?? response) {
      size += chunk.length; check(size <= limit, 502, 'Service response is too large'); parts.push(chunk);
    }
    return Buffer.concat(parts);
  } catch (error) { response.destroy?.(); throw error; }
}
export async function serviceJson(url, { apiKey, signal, body, method, limit } = {}) {
  const response = await fetch(url, { method: method ?? (body === undefined ? 'GET' : 'POST'),
    redirect: 'error', signal, headers: { accept: 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new HttpError(502, `Service returned HTTP ${response.status}`), { upstreamStatus: response.status });
  }
  let data;
  try { data = JSON.parse((await boundedBody(response, limit)).toString('utf8')); }
  catch (error) { if (error.status) throw error; throw new HttpError(502, 'Service returned invalid JSON'); }
  check(data && typeof data === 'object', 502, 'Service returned invalid JSON'); return data;
}

function publicAddress(address) {
  const value = address.toLowerCase();
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return ![0, 10, 127].includes(a) && a < 224 && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
      && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18, 19].includes(b));
  }
  return isIP(value) === 6 && !/^(::|f[cd]|fe[89ab]|ff)/.test(value);
}

/** Provider output URLs never receive provider credentials or access private networks. */
export async function downloadMedia(value, { signal, maxBytes = 64 * 1024 * 1024, redirects = 3 } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new HttpError(502, 'Invalid media URL'); }
  check(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, 502, 'Invalid media URL');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  check(addresses.length && addresses.every(item => publicAddress(item.address)), 502, 'Media URL must use a public address');
  const selected = addresses[0];
  const response = await new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(url, { signal,
      lookup: (_host, options, done) => options.all ? done(null, [selected]) : done(null, selected.address, selected.family),
      headers: { accept: 'image/*,video/*' } }, resolve);
    req.once('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume(); check(redirects > 0 && response.headers.location, 502, 'Too many media redirects');
    return downloadMedia(new URL(response.headers.location, url).href, { signal, maxBytes, redirects: redirects - 1 });
  }
  if (response.statusCode !== 200) { response.resume(); throw new HttpError(502, `Media download returned HTTP ${response.statusCode}`); }
  return { bytes: await boundedBody(response, maxBytes), mimeType: String(response.headers['content-type'] ?? '').split(';')[0] };
}

export function checkSchema(value, schema, path = 'input', depth = 0) {
  check(depth <= 12, 400, 'Input schema is too deep');
  if (!schema || typeof schema !== 'object') return;
  if (schema.enum) check(schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value)), 400, `Invalid ${path}`);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type) check(types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
    : type === 'integer' ? Number.isInteger(value) : type === 'object' ? value && typeof value === 'object' && !Array.isArray(value)
    : typeof value === type), 400, `Invalid ${path}`);
  if (typeof value === 'number') check(Number.isFinite(value) && (schema.minimum === undefined || value >= schema.minimum)
    && (schema.maximum === undefined || value <= schema.maximum), 400, `Invalid ${path}`);
  if (typeof value === 'string') check((schema.minLength === undefined || value.length >= schema.minLength)
    && (schema.maxLength === undefined || value.length <= schema.maxLength), 400, `Invalid ${path}`);
  if (Array.isArray(value)) {
    check(value.length <= (schema.maxItems ?? 100) && value.length >= (schema.minItems ?? 0), 400, `Invalid ${path}`);
    value.forEach((item, index) => checkSchema(item, schema.items, `${path}[${index}]`, depth + 1));
  } else if (value && typeof value === 'object') {
    for (const key of schema.required ?? []) check(Object.hasOwn(value, key), 400, `${path}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      check(schema.additionalProperties !== false || Object.hasOwn(schema.properties ?? {}, key), 400, `Unknown ${path}.${key}`);
      checkSchema(item, schema.properties?.[key], `${path}.${key}`, depth + 1);
    }
  }
}
