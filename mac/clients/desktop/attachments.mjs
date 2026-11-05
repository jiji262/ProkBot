import { open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grokText } from './i18n.mjs';

const CHUNK_BYTES = 4 * 1024 * 1024;
const PREVIEW_BYTES = 25 * 1024 * 1024;
const TEXT_HEAD_BYTES = 6 * 1024 * 1024;

// These are remote Host paths, never files to open on the client's filesystem.
export function remoteAttachmentPath(source) {
  if (typeof source !== 'string' || !source || source.includes('\0')) return null;
  if (/^file:/i.test(source)) {
    try { return fileURLToPath(source); } catch { return null; }
  }
  return /^[a-z][a-z\d+.-]*:/i.test(source) ? null : source;
}

function totalSize(chunk) {
  if (!Number.isSafeInteger(chunk?.totalSize) || chunk.totalSize < 0)
    throw new Error(grokText('附件大小无效。', 'Invalid attachment size.'));
  return chunk.totalSize;
}

export function createAttachmentMediaResolver({ command, readStaged, nativeImage }) {
  return async ({ source, rendition }) => {
    const staged = await readStaged(source);
    const remote = remoteAttachmentPath(source);
    if (!staged && remote === null) throw new Error('Invalid attachment path');
    const result = staged ? { dataUrl: nativeImage.createFromBuffer(staged).toDataURL() }
      : await command('readAttachmentImage', { path: remote,
        rendition: rendition === 'original' ? 'original' : 'preview' }, AbortSignal.timeout(30000));
    if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(result?.dataUrl)) throw new Error('Unsupported attachment');
    const image = nativeImage.createFromDataURL(result.dataUrl);
    if (image.isEmpty()) throw new Error('Invalid image attachment');
    const size = image.getSize();
    const width = Number(/^tile-(\d+)$/.exec(rendition ?? '')?.[1]);
    return { kind: 'image', src: width && size.width > width ? image.resize({ width }).toDataURL() : result.dataUrl, ...size };
  };
}

export function createAttachmentHandlers({ command, chooseDestination, showDownloadError, readStaged = async () => null }) {
  const request = (method, args) => command(method, args, AbortSignal.timeout(30000));
  const scope = ({ path: source, agentId }) => {
    const value = remoteAttachmentPath(source);
    return value === null ? null : { path: value, ...(agentId ? { agentId } : {}) };
  };
  async function readChunk(args, offset, length, expectedSize) {
    const chunk = await request('readAttachmentChunk', { ...args, offset, length });
    if (chunk === null) return null;
    if (totalSize(chunk) !== expectedSize || typeof chunk.bytesBase64 !== 'string')
      throw new Error(grokText('附件已改变，请重试。', 'The attachment changed. Try again.'));
    const bytes = Buffer.from(chunk.bytesBase64, 'base64');
    if (bytes.length === 0 || bytes.length > length)
      throw new Error(grokText('附件读取不完整，请重试。', 'Incomplete attachment. Try again.'));
    return bytes;
  }
  return {
    async readAttachmentText(input) {
      const args = scope(input);
      if (args) {
        const staged = await readStaged(args.path);
        if (staged) return { kind: 'text', text: staged.subarray(0, TEXT_HEAD_BYTES).toString('utf8'),
          bytes: staged.length, truncated: staged.length > TEXT_HEAD_BYTES };
      }
      return args === null ? null : request('readAttachmentText', args);
    },
    async readAttachmentBytes(input) {
      const args = scope(input);
      if (args === null) return null;
      const staged = await readStaged(args.path);
      if (staged) {
        const max = Number.isFinite(input.maxBytes) && input.maxBytes > 0 ? Math.min(Math.floor(input.maxBytes), PREVIEW_BYTES) : PREVIEW_BYTES;
        if (staged.length > max) return { kind: 'too-large', size: staged.length };
        const text = /\.(?:md|markdown|txt|text)$/i.test(args.path);
        return { kind: 'bytes', bytes: new Uint8Array(staged.subarray(0, text ? TEXT_HEAD_BYTES : max)), size: staged.length };
      }
      const info = await request('readAttachmentChunk', { ...args, offset: 0, length: 0 });
      if (info === null) return null;
      const size = totalSize(info);
      const name = info.resolvedName ? { resolvedName: info.resolvedName } : {};
      const maxBytes = Number.isFinite(input.maxBytes) && input.maxBytes > 0
        ? Math.min(Math.floor(input.maxBytes), PREVIEW_BYTES) : PREVIEW_BYTES;
      if (size > maxBytes) return { kind: 'too-large', size, ...name };
      const text = /\.(?:md|markdown|txt|text)$/i.test(info.resolvedName ?? args.path);
      const bytes = new Uint8Array(Math.min(size, text ? TEXT_HEAD_BYTES : maxBytes));
      for (let offset = 0; offset < bytes.length;) {
        const chunk = await readChunk(args, offset, Math.min(CHUNK_BYTES, bytes.length - offset), size);
        if (chunk === null) return null;
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return { kind: 'bytes', bytes, size, ...name };
    },
    async downloadAttachment(input) {
      let temporary;
      try {
        const args = scope(input);
        if (args === null) throw new Error('Invalid attachment path');
        const info = await request('readAttachmentChunk', { ...args, offset: 0, length: 0 });
        if (info === null) throw new Error('Attachment not found');
        const size = totalSize(info);
        const suggestedName = path.basename(input.suggestedName || info.resolvedName || args.path);
        const destination = await chooseDestination(suggestedName);
        if (!destination) return false;
        temporary = path.join(path.dirname(destination), `.grokbot-download-${randomUUID()}.tmp`);
        const file = await open(temporary, 'wx', 0o600);
        try {
          for (let offset = 0; offset < size;) {
            const bytes = await readChunk(args, offset, Math.min(CHUNK_BYTES, size - offset), size);
            if (bytes === null) throw new Error('Attachment not found');
            await file.writeFile(bytes);
            offset += bytes.length;
          }
          await file.sync();
        } finally { await file.close(); }
        await rename(temporary, destination);
        return true;
      } catch (error) {
        console.error('[attachment-download]', error.message);
        await showDownloadError();
        return false;
      } finally {
        if (temporary) await rm(temporary, { force: true }).catch(() => {});
      }
    },
  };
}
