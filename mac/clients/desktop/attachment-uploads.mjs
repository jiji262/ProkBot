import { constants } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grokText } from './i18n.mjs';

const CHUNK_BYTES = 4 * 1024 * 1024;
const FILE_LIMIT = 25 * 1024 * 1024;
const VIDEO_LIMIT = 200 * 1024 * 1024;
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[/\\\0]/.test(name);
const byteLimit = name => /\.(mp4|mov|webm|mkv|avi|m4v|mpeg|mpg|ogv)$/i.test(name) ? VIDEO_LIMIT : FILE_LIMIT;
const sizeFailure = (size, name) => size === 0 ? 'empty' : size > byteLimit(name) ? 'too-large' : null;

// The renderer owns the file picker and clipboard. Both enter through the
// original staging RPC, keeping its attachment previews and send journal.
export function createAttachmentUploads({ profile, command, onProgress = () => {} }) {
  const directory = path.join(profile, 'attachment-staging');
  const commits = new Map();
  function localPath(source) {
    try {
      const filename = source?.startsWith('file:') ? fileURLToPath(source) : source;
      return typeof filename === 'string' && path.dirname(filename) === directory &&
        /^[0-9a-f-]{36}(?:\.[a-zA-Z0-9]{1,16})?$/.test(path.basename(filename)) ? filename : null;
    } catch { return null; }
  }
  async function openStaged(source) {
    const filename = localPath(source);
    if (!filename) throw new Error('Invalid staged attachment');
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > VIDEO_LIMIT) { await file.close(); throw new Error('Invalid staged attachment'); }
    return file;
  }
  async function stage(filename, write) {
    if (!validName(filename)) return { ok: false, reason: 'failed' };
    const extension = /^\.[a-zA-Z0-9]{1,16}$/.test(path.extname(filename)) ? path.extname(filename) : '';
    const destination = path.join(directory, `${randomUUID()}${extension}`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const output = await open(destination, 'wx', 0o600);
      try { await write(output); } finally { await output.close(); }
      return { ok: true, path: destination };
    } catch {
      await rm(destination, { force: true }).catch(() => {});
      return { ok: false, reason: 'failed' };
    }
  }
  async function upload({ agentId, path: source, filename }, progress) {
    const input = await openStaged(source);
    try {
      const { size } = await input.stat();
      if (sizeFailure(size, filename)) throw new Error(grokText('附件为空或超过大小限制。', 'The attachment is empty or too large.'));
      const uploadId = randomUUID();
      const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, size));
      const signal = AbortSignal.timeout(120000);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await input.read(bytes, 0, Math.min(bytes.length, size - offset), offset);
        if (!bytesRead) throw new Error('Staged attachment changed');
        const result = await command('uploadAttachmentChunk', { agentId, uploadId, filename,
          offset, totalSize: size, bytesBase64: bytes.toString('base64', 0, bytesRead) }, signal);
        offset += bytesRead;
        progress(offset / size);
        if (result?.committedPath) {
          if (offset !== size || typeof result.committedPath !== 'string') throw new Error('Incomplete attachment upload');
          return result.committedPath;
        }
      }
      throw new Error(grokText('附件上传未完成，请重试。', 'The attachment upload did not complete. Try again.'));
    } finally { await input.close(); }
  }
  const handlers = {
    async stageAttachmentBytes({ filename, bytes }) {
      if (!validName(filename) || !(bytes instanceof Uint8Array)) return { ok: false, reason: 'failed' };
      const reason = sizeFailure(bytes.byteLength, filename);
      return reason ? { ok: false, reason } : stage(filename, file => file.writeFile(bytes));
    },
    async stageAttachmentPath({ filename, sourcePath }) {
      if (!validName(filename) || typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) return { ok: false, reason: 'failed' };
      let input;
      try {
        input = await open(sourcePath, 'r');
        const info = await input.stat();
        if (!info.isFile()) return { ok: false, reason: 'failed' };
        const reason = sizeFailure(info.size, filename);
        if (reason) return { ok: false, reason };
        return await stage(filename, async output => {
          const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, info.size));
          for (let offset = 0; offset < info.size;) {
            const { bytesRead } = await input.read(bytes, 0, Math.min(bytes.length, info.size - offset), offset);
            if (!bytesRead) throw new Error('Source attachment changed');
            await output.writeFile(bytes.subarray(0, bytesRead));
            offset += bytesRead;
          }
          if ((await input.stat()).size !== info.size) throw new Error('Source attachment changed');
        });
      } catch { return { ok: false, reason: 'failed' }; }
      finally { await input?.close(); }
    },
    async commitStagedAttachments({ agentId, paths, filenames, progressKey }) {
      if (typeof agentId !== 'string' || !agentId || !Array.isArray(paths) || !Array.isArray(filenames) ||
          paths.length !== filenames.length || paths.some(source => !localPath(source)) || filenames.some(name => !validName(name)))
        throw new Error('Invalid attachment upload');
      const report = fraction => { if (progressKey) onProgress({ key: progressKey, fraction }); };
      const results = [];
      report(0);
      for (let index = 0; index < paths.length; index++) {
        const source = paths[index], filename = filenames[index];
        const key = JSON.stringify([agentId, source, filename]);
        let pending = commits.get(key);
        if (!pending) {
          pending = upload({ agentId, path: source, filename }, fraction => report((index + fraction) / paths.length));
          commits.set(key, pending);
          pending.catch(() => { if (commits.get(key) === pending) commits.delete(key); });
        }
        results.push(await pending);
        report((index + 1) / paths.length);
      }
      return results;
    },
    async discardStagedAttachment({ path: source }) {
      const filename = localPath(source);
      if (!filename) return;
      await rm(filename, { force: true });
      for (const key of commits.keys()) if (JSON.parse(key)[1] === filename) commits.delete(key);
    },
    // The original eager upload and image captioning target the cloud store.
    // Local Host attachments are committed to the execution node at send time.
    preuploadStagedAttachment: async () => {},
    releaseStagedAttachmentPreupload: async () => {},
    precaptionStagedAttachment: async () => {},
  };
  return { handlers,
    async readStaged(source) {
      if (!localPath(source)) return null;
      const input = await openStaged(source);
      try { return await input.readFile(); } finally { await input.close(); }
    },
  };
}
