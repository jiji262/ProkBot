import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

async function matchesArchive(file, archive) {
  try {
    if ((await stat(file)).size !== archive.bytes) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === archive.sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function acquireDesktopSource({ source, cacheDirectory, supported,
  fetchImpl = globalThis.fetch, onDownload = () => {} }) {
  if (source) return path.resolve(source);
  const archive = supported.archive;
  if (!archive?.url || !archive.bytes || !/^[a-f0-9]{64}$/.test(archive.sha256))
    throw new Error('缺少原版下载信息。');
  let temporary;
  try {
    await mkdir(cacheDirectory, { recursive: true });
    const destination = path.join(cacheDirectory, path.basename(new URL(archive.url).pathname));
    if (await matchesArchive(destination, archive)) return destination;
    temporary = await mkdtemp(path.join(cacheDirectory, '.download-'));
    const partial = path.join(temporary, 'original.dmg');
    onDownload({ version: supported.version, url: archive.url });
    const response = await fetchImpl(archive.url, {
      signal: AbortSignal.timeout(10 * 60 * 1000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; ProkBot-Patcher)' },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`原版下载失败：HTTP ${response.status}`);
    }
    const hash = createHash('sha256');
    let bytes = 0;
    const verify = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > archive.bytes) { callback(new Error('原版下载大小不匹配。')); return; }
      hash.update(chunk); callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
    if (bytes !== archive.bytes || hash.digest('hex') !== archive.sha256)
      throw new Error('原版下载校验失败。');
    await rename(partial, destination);
    return destination;
  } catch (error) {
    throw new Error(`${error.message}\n请自行准备 Grok Bot ${supported.version} 原版 .app 或 .dmg，使用 --source 指定。\n原版地址：${archive.url}`, { cause: error });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
