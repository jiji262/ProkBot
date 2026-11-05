import { encode } from '@msgpack/msgpack';
import { check, HttpError } from './security.mjs';
import { fishAudioBytes } from './speech-audio.mjs';

const extensions = { 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/mp4': 'm4a',
  'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'video/mp4': 'mp4', 'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg',
  'audio/flac': 'flac', 'audio/aac': 'aac' };

/** A provider converts normalized audio to its wire format and returns plain text. */
export const speechProviders = {
  fish: {
    endpoint: 'https://api.fish.audio/v1/asr',
    async request(input, config, signal) {
      const audio = await fishAudioBytes(input, signal);
      const { language } = input;
      return { headers: { 'content-type': 'application/msgpack' },
        body: encode({ audio, ignore_timestamps: true, ...(language ? { language } : {}) }) };
    },
  },
  openai: {
    endpoint: '',
    request({ audio, mimeType, language }, config) {
      const body = new FormData();
      body.append('file', new Blob([audio], { type: mimeType }), `recording.${extensions[mimeType] || 'bin'}`);
      if (config.model) body.append('model', config.model);
      if (language) body.append('language', language);
      body.append('response_format', 'json');
      return { body };
    },
  },
};

async function responseJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    check(size <= 1024 * 1024, 502, 'Speech service response is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(502, 'Speech service returned an invalid response'); }
}

export async function recognizeAudio(input, config, signal) {
  const request = await speechProviders[config.provider].request(input, config, signal);
  const response = await fetch(config.endpoint, {
    ...request, method: 'POST', redirect: 'error', signal,
    headers: { ...request.headers, accept: 'application/json',
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
  });
  if (!response.ok) {
    await response.body?.cancel();
    // Upstream bodies can contain request data or credentials. Keep them private.
    if (response.status === 402) throw new HttpError(502, 'Speech service API credit is insufficient');
    if ([401, 403].includes(response.status)) throw new HttpError(502, 'Speech service rejected the API key');
    throw new HttpError(502, `Speech service returned HTTP ${response.status}`);
  }
  const result = await responseJson(response);
  check(typeof result.text === 'string', 502, 'Speech service returned no transcript');
  return result.text.trim();
}
