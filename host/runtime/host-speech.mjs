import { readFile } from 'node:fs/promises';

/** The original inference extension delegates ASR to the self-host service. */
export async function transcribeLocalAudio({ audio, mimeType, language }) {
  const endpoint = process.env.GROKBOT_SPEECH_URL;
  const tokenFile = process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE;
  if (!endpoint || !tokenFile) throw new Error('Speech recognition is not configured');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(125_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ audioBase64: Buffer.from(audio).toString('base64'), mimeType, language }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Speech recognition failed');
  return { text: result.text, transcriptionTimeMs: result.transcriptionTimeMs };
}
