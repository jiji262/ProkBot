import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { externalHttpUrl } from './external-url.mjs';

const blocked4 = new BlockList(), blocked6 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blocked4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked6.addSubnet(address, prefix, 'ipv6');

export async function previewAddresses(url, lookupImpl = lookup) {
  if (!externalHttpUrl(url.href)) throw new Error('Invalid preview URL');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))
    throw new Error('Local preview URL');
  const literal = isIP(hostname);
  const addresses = literal ? [{ address: hostname, family: literal }]
    : await lookupImpl(hostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(({ address }) => {
    const family = isIP(address);
    // Fake-IP DNS used by transparent proxies is allowed for hostnames only.
    const proxy = address.startsWith('198.18.') || address.startsWith('198.19.');
    return !family || (proxy && literal) || (family === 4 ? blocked4 : blocked6).check(address, family === 4 ? 'ipv4' : 'ipv6');
  })) throw new Error('Non-public preview address');
  return addresses;
}

/** Use the validated DNS answer for the connection, preserving Host and TLS SNI. */
export function requestPreview(url, options, addresses, requestImpl) {
  return new Promise((resolve, reject) => {
    const request = requestImpl ?? (url.protocol === 'https:' ? https.request : http.request);
    const req = request(url, {
      method: 'GET', signal: options.signal, headers: options.headers,
      lookup: (_host, settings, callback) => {
        const family = typeof settings === 'number' ? settings : settings?.family;
        const matches = family ? addresses.filter(value => value.family === family) : addresses;
        if (!matches.length) return callback(new Error('No validated address for requested family'));
        if (settings?.all) callback(null, matches);
        else callback(null, matches[0].address, matches[0].family);
      },
    }, incoming => {
      try {
        const status = incoming.statusCode;
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const empty = [204, 205, 304].includes(status);
        if (empty) incoming.resume();
        resolve(new Response(empty ? null : Readable.toWeb(incoming), { status, headers }));
      } catch (error) { incoming.destroy(); reject(error); }
    });
    req.once('error', reject);
    req.end();
  });
}

export async function fetchPreview(url, options, lookupImpl, fetchImpl) {
  const signal = options.signal;
  signal?.throwIfAborted();
  let abort;
  let addresses;
  try {
    addresses = await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      previewAddresses(url, lookupImpl).then(resolve, reject);
    });
  } finally { signal?.removeEventListener('abort', abort); }
  return fetchImpl ? fetchImpl(url, options) : requestPreview(url, options, addresses);
}
