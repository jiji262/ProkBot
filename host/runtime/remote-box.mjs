import { posix } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 12 * 1024;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const reader = `import os,sys,json,base64,stat
p=sys.argv[1];offset=int(sys.argv[2])
with open(p,'rb') as f:
 s=os.fstat(f.fileno())
 if not stat.S_ISREG(s.st_mode): raise ValueError('not a regular file')
 if s.st_size>${MAX_FILE_BYTES}: raise ValueError('file exceeds download limit')
 f.seek(offset);chunk=f.read(${CHUNK_BYTES})
 print(json.dumps({'identity':[s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns],'data':base64.b64encode(chunk).decode()}))`;

/** Keep the original Exec/window protocol; replace assumptions about shared local files. */
export function installRemoteBoxAdapter(bindings, original, env = process.env) {
  const host = env.GROKBOT_BOX_HOST?.trim();
  if (!host) return { mode: 'in-container' };
  if (!/^[A-Za-z0-9.-]+$/.test(host) && !/^\[[0-9a-f:]+\]$/i.test(host)) throw new Error('GROKBOT_BOX_HOST must be a hostname or IP address');
  const token = env.GROKBOT_BOX_TOKEN || 'local';
  const { LoopbackSandBox, buildHostShellArgs } = bindings;
  const { shellExecutorResource, BoxFileUnreadableError } = original;
  if (!LoopbackSandBox || !buildHostShellArgs || !shellExecutorResource) throw new Error('Remote Box dependencies are missing');
  class RemoteBox extends LoopbackSandBox {
    describe() { return { backend: 'remote-exec', host }; }
    async downloadFile(ctx, agentId, boxPath) {
      const resolved = posix.resolve('/workspace', boxPath);
      await this.assertFileReadAllowed(resolved);
      const { remoteAccessor } = await this.ensureReady(ctx, agentId);
      const shell = remoteAccessor.get(shellExecutorResource);
      const chunks = [];
      let identity, size = 0;
      do {
        ctx?.signal?.throwIfAborted();
        const result = await shell.execute(ctx, buildHostShellArgs({
          command: `python3 -c ${quote(reader)} ${quote(resolved)} ${size}`,
          name: 'python3', workingDirectory: '/workspace', toolCallId: `remote-file-${randomUUID()}`,
        }));
        if (result.result?.case !== 'success' || result.result.value.exitCode !== 0) {
          throw new BoxFileUnreadableError(`Remote file could not be read: ${resolved}`);
        }
        let part;
        try { part = JSON.parse(result.result.value.stdout); }
        catch { throw new Error('Remote file response was truncated or invalid'); }
        const stamp = JSON.stringify(part.identity);
        if (identity && identity !== stamp) throw new Error('Remote file changed during download');
        identity = stamp;
        const length = part.identity?.[2];
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FILE_BYTES || typeof part.data !== 'string') {
          throw new Error('Invalid remote file metadata');
        }
        const chunk = Buffer.from(part.data, 'base64');
        if (chunk.length > CHUNK_BYTES || size + chunk.length > length || (!chunk.length && size < length)) {
          throw new Error('Invalid remote file chunk');
        }
        chunks.push(chunk); size += chunk.length;
        if (size === length) return Buffer.concat(chunks, size);
      } while (size <= MAX_FILE_BYTES);
      throw new Error('Remote file exceeds download limit');
    }
  }
  bindings.createSandBox = options => new RemoteBox({ ...options, host, authToken: token, homeDir: '/home/box' });
  bindings.formatSandBoxStartupSummary = () => `[sand-host] remote execution desktop: ${host}`;
  return { mode: 'remote-exec', host, maxDownloadBytes: MAX_FILE_BYTES };
}
