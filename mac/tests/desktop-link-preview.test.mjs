import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLinkPreview } from '../clients/desktop/link-preview.mjs';
import { previewAddresses, requestPreview, fetchPreview } from '../clients/desktop/link-preview-fetch.mjs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const lookupImpl = async () => [{ address: '93.184.215.14', family: 4 }];

async function profile(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'grokbot-link-preview-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('builds a preview and reuses the disk cache', async t => {
  const cacheRoot = await profile(t);
  let requests = 0;
  const fetchImpl = async input => {
    requests += 1;
    const url = new URL(input);
    if (url.pathname === '/cover.png') {
      return new Response(Buffer.from([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    }
    if (url.pathname === '/favicon.ico') {
      return new Response(Buffer.from([0, 0, 1, 0]), { headers: { 'content-type': 'image/x-icon' } });
    }
    return new Response(`<!doctype html>
      <html><head>
        <title>Fallback title</title>
        <meta property="og:title" content="Preview title &amp; more">
        <meta property="og:description" content="Preview description">
        <meta property="og:site_name" content="Preview site">
        <meta property="og:image" content="/cover.png">
        <link rel="icon" href="/favicon.ico">
      </head></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  const preview = createLinkPreview({ profile: cacheRoot, fetchImpl, lookupImpl });

  assert.equal(await preview.getMetadata({ url: 'https://preview.test/article', beforeHover: true }), null);
  assert.equal(requests, 0);

  const value = await preview.getMetadata({ url: 'https://preview.test/article', image: 'card' });
  assert.equal(value.title, 'Preview title & more');
  assert.equal(value.description, 'Preview description');
  assert.equal(value.hostname, 'preview.test');
  assert.match(value.imageDataUrl, /^data:image\/png;base64,/);
  assert.match(value.faviconDataUrl, /^data:image\/x-icon;base64,/);
  assert.equal(requests, 3);

  assert.equal((await preview.getMetadata({ url: 'https://preview.test/article' })).title, value.title);
  assert.equal((await preview.getMetadata({ url: 'https://preview.test/article', beforeHover: true })).title, value.title);
  assert.equal(requests, 3);
});

test('returns null for restricted and failed pages', async t => {
  const cacheRoot = await profile(t);
  let requests = 0;
  const preview = createLinkPreview({
    profile: cacheRoot,
    lookupImpl,
    fetchImpl: async () => {
      requests += 1;
      return new Response('forbidden', { status: 403, headers: { 'content-type': 'text/html' } });
    },
  });

  assert.equal(await preview.getMetadata({ url: 'https://preview.test/private' }), null);
  assert.equal(await preview.getMetadata({ url: 'http://127.0.0.1/admin' }), null);
  assert.equal(await preview.getMetadata({ url: 'file:///etc/passwd' }), null);
  assert.equal(requests, 1);
});

test('blocks mapped loopback addresses, local DNS and redirect destinations', async t => {
  for (const value of ['https://[::ffff:127.0.0.1]/', 'http://127.0.0.1/',
    'https://localhost./', 'https://[::1]/', 'https://[64:ff9b::7f00:1]/', 'http://198.18.0.1/'])
    await assert.rejects(previewAddresses(new URL(value), lookupImpl));
  await assert.rejects(previewAddresses(new URL('https://public.test/'), async () => [{address:'192.168.1.1',family:4}]));
  let count = 0;
  const preview = createLinkPreview({profile:await profile(t),lookupImpl,fetchImpl:async () => {
    count++; return new Response(null,{status:302,headers:{location:'http://127.0.0.1/admin'}});
  }});
  assert.equal(await preview.getMetadata({url:'https://public.test/'}), null);
  assert.equal(count, 1);
});

test('pins validated DNS answers and preserves the original HTTP host', async () => {
  const url = new URL('https://public.test/page'), addresses = [{address:'93.184.215.14',family:4}];
  let lookups = 0;
  const response = await requestPreview(url, {signal:AbortSignal.timeout(1000),headers:{}}, addresses,
    (target, options, respond) => {
      assert.equal(target.hostname,'public.test');
      options.lookup('public.test',{all:true},(error,values)=>{assert.equal(error,null);assert.deepEqual(values,addresses);lookups++;});
      const request = new EventEmitter();
      request.end = () => {
        const incoming = Readable.from([Buffer.from('<title>Pinned</title>')]);
        incoming.statusCode=200; incoming.headers={'content-type':'text/html'}; respond(incoming);
      };
      return request;
    });
  assert.equal(await response.text(),'<title>Pinned</title>'); assert.equal(lookups,1);
});

test('includes unresolved DNS in the request deadline', async () => {
  const controller = new AbortController();
  const request = fetchPreview(new URL('https://unresolved.test/'), {signal:controller.signal},
    () => new Promise(() => {}));
  controller.abort(new Error('Preview deadline exceeded'));
  await assert.rejects(request, /deadline exceeded/);
});

test('uses the site favicon, preserves HTTP and coalesces concurrent requests', async t => {
  const requests=[];
  const preview=createLinkPreview({profile:await profile(t),lookupImpl,fetchImpl:async input=>{
    requests.push(String(input));
    await new Promise(resolve=>setTimeout(resolve,5));
    return new Response('<title>HTTP only</title>',{headers:{'content-type':'text/html'}});
  }});
  const results=await Promise.all(Array.from({length:8},()=>preview.getMetadata({url:'http://public.test/article'})));
  assert.ok(results.every(value=>value.title==='HTTP only'));
  assert.deepEqual(requests,['http://public.test/article','http://public.test/favicon.ico']);
});

test('falls back on gated, oversized and failed pages without blocking other previews', async t => {
  const preview=createLinkPreview({profile:await profile(t),lookupImpl,fetchImpl:async input=>{
    if(new URL(input).pathname==='/big')return new Response('x',{headers:{'content-type':'text/html','content-length':String(2*1024*1024)}});
    return new Response('<title>Just a moment...</title>',{headers:{'content-type':'text/html'}});
  }});
  assert.equal(await preview.getMetadata({url:'https://public.test/big'}),null);
  assert.equal(await preview.getMetadata({url:'https://public.test/gated'}),null);
});
