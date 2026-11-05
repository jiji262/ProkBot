import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireDesktopSource } from '../patchers/desktop/download-original.mjs';

const body = Buffer.alloc(32 * 1024, 97);
async function fixture(t) {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), 'desktop-download-'));
  let requests = 0, mode = 'valid';
  const server = createServer((_req, res) => {
    requests++;
    if (mode === 'unavailable') { res.writeHead(503).end(); return; }
    res.end(mode === 'invalid' ? Buffer.alloc(body.length, 98) : body);
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(cacheDirectory, { recursive: true, force: true });
  });
  const supported = { version: '0.71.2', archive: {
    url: `http://127.0.0.1:${server.address().port}/original.dmg`, bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  } };
  return { options: { cacheDirectory, supported }, requests: () => requests, mode: value => { mode = value; } };
}

test('downloads a verified original, reuses its cache and replaces corrupted cached bytes', async t => {
  const f = await fixture(t);
  const file = await acquireDesktopSource(f.options);
  assert.deepEqual(await readFile(file), body);
  assert.equal(f.requests(), 1);
  assert.equal(await acquireDesktopSource(f.options), file);
  assert.equal(f.requests(), 1, 'valid cached data makes no HTTP request');
  await writeFile(file, Buffer.alloc(body.length, 98));
  assert.equal(await acquireDesktopSource(f.options), file);
  assert.deepEqual(await readFile(file), body);
  assert.equal(f.requests(), 2, 'same-sized corrupted data is downloaded again');
  assert.deepEqual(await readdir(f.options.cacheDirectory), ['original.dmg']);
});

test('failed HTTP and fingerprint checks leave no cached input or partial download', async t => {
  const f = await fixture(t);
  f.mode('unavailable'); await assert.rejects(acquireDesktopSource(f.options), error =>
    /HTTP 503/.test(error.message) && /自行准备/.test(error.message) && /--source/.test(error.message) && error.message.includes(f.options.supported.archive.url));
  assert.deepEqual(await readdir(f.options.cacheDirectory), []);
  f.mode('invalid'); await assert.rejects(acquireDesktopSource(f.options), error =>
    /校验失败/.test(error.message) && /--source/.test(error.message));
  assert.deepEqual(await readdir(f.options.cacheDirectory), []);
  f.mode('valid'); await acquireDesktopSource(f.options);
  assert.equal(f.requests(), 3);
});

test('an explicit original app or DMG is used without contacting the download server', async () => {
  for (const source of ['./original.app', './original.dmg']) {
    assert.equal(await acquireDesktopSource({ source, fetchImpl: () => { throw new Error('Unexpected download'); } }), path.resolve(source));
  }
});
