import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { check, HttpError } from './security.mjs';

const formats = { 'audio/webm': 'matroska', 'video/webm': 'matroska',
  'audio/mp4': 'mov', 'video/mp4': 'mov', 'audio/m4a': 'mov', 'audio/x-m4a': 'mov',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/aac': 'aac' };

/** Fish's decoder rejects browser WebM and iOS M4A. Normalize these on the Host. */
export async function fishAudioBytes({ audio, mimeType }, signal) {
  if (['audio/wav', 'audio/x-wav', 'audio/flac'].includes(mimeType)) return audio;
  const format = formats[mimeType];
  check(format, 415, 'Unsupported audio format');
  signal?.throwIfAborted();
  // M4A metadata can follow its audio; a seekable file is required for reliable decoding.
  const directory = await mkdtemp(join(tmpdir(), 'grokbot-audio-'));
  try {
    const filename = join(directory, 'recording');
    await writeFile(filename, audio, { mode: 0o600 });
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const child = spawn(process.env.GROKBOT_FFMPEG_PATH || 'ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
        '-f', format, '-i', filename, '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'], signal });
      const chunks = []; let bytes = 0, settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true;
        if (error) { child.kill('SIGKILL'); reject(error); } else resolve(value);
      }
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 25 * 1024 * 1024) return finish(new HttpError(413, 'Decoded audio exceeds 25 MB'));
        chunks.push(chunk);
      });
      child.on('error', error => finish(error.code === 'ENOENT'
        ? new HttpError(503, 'Audio conversion requires FFmpeg') : error));
      child.on('close', code => {
        if (!settled) finish(code === 0 && bytes > 44 ? null
          : new HttpError(400, 'Could not decode the recording'), Buffer.concat(chunks));
      });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
