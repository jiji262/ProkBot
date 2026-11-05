import { join } from 'node:path';
import { JsonStore } from './storage.mjs';
import { check, HttpError, jsonBody, sendJson } from './security.mjs';
import { recognizeAudio, speechProviders } from './speech-providers.mjs';

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const bodyLimit = Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 4096;
const defaults = { version: 1, enabled: false, provider: 'fish',
  endpoint: speechProviders.fish.endpoint, apiKey: '', model: '', language: '', timeoutMs: 60_000 };

function languageCode(value) {
  const language = String(value || '').trim().toLowerCase();
  if (!language || language === 'auto') return '';
  check(/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/.test(language), 400, 'Invalid speech language');
  return language.split(/[-_]/)[0];
}

function endpoint(value) {
  try {
    const url = new URL(value);
    check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      !url.search && !url.hash, 400, 'Invalid speech endpoint');
    return url.href;
  } catch { throw new HttpError(400, 'Invalid speech endpoint'); }
}

export function audioInput(body, fallbackLanguage = '') {
  check(typeof body.audioBase64 === 'string' && body.audioBase64.length > 0, 400, 'Audio is required');
  check(body.audioBase64.length <= Math.ceil(MAX_AUDIO_BYTES / 3) * 4, 413, 'Audio exceeds 25 MB');
  check(body.audioBase64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(body.audioBase64),
    400, 'Invalid audio encoding');
  const audio = Buffer.from(body.audioBase64, 'base64');
  check(audio.length > 0 && audio.length <= MAX_AUDIO_BYTES, 413, 'Audio exceeds 25 MB');
  const mimeType = String(body.mimeType || '').split(';')[0].trim().toLowerCase();
  check(/^audio\/[a-z0-9.+-]+$/.test(mimeType) || ['video/webm', 'video/mp4'].includes(mimeType), 415, 'Unsupported audio format');
  return { audio, mimeType, language: languageCode(body.language ?? fallbackLanguage) };
}

export class Speech {
  constructor(dataDir) {
    this.store = new JsonStore(join(dataDir, 'speech.json'), defaults);
    this.active = new Set();
  }
  async load() { await this.store.load(); return this; }
  publicConfig() {
    const { apiKey, version, ...config } = this.store.value;
    return { ...config, hasApiKey: Boolean(apiKey), maxAudioBytes: MAX_AUDIO_BYTES };
  }
  async save(input) {
    await this.store.mutate(config => {
      check(input && typeof input === 'object', 400, 'Invalid speech configuration');
      const provider = input.provider ?? config.provider;
      check(Object.hasOwn(speechProviders, provider), 400, 'Unknown speech provider');
      const address = String(input.endpoint ?? (provider === config.provider ? config.endpoint : speechProviders[provider].endpoint)).trim();
      const nextEndpoint = address ? endpoint(address) : '';
      if (provider !== config.provider || nextEndpoint !== config.endpoint || input.clearApiKey) config.apiKey = '';
      if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
        check(input.apiKey.length <= 4096 && !/[\r\n]/.test(input.apiKey), 400, 'Invalid speech API key');
        config.apiKey = input.apiKey.trim();
      }
      const enabled = input.enabled ?? config.enabled;
      check(typeof enabled === 'boolean', 400, 'Invalid speech enabled value');
      const model = String(input.model ?? config.model).trim();
      check(model.length <= 200 && !/[\r\n]/.test(model), 400, 'Invalid speech model');
      const timeoutMs = input.timeoutMs ?? config.timeoutMs;
      check(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 120_000, 400, 'Speech timeout must be 1000–120000 ms');
      check(!enabled || nextEndpoint, 400, 'Speech endpoint is required');
      check(!enabled || provider !== 'fish' || config.apiKey, 400, 'Fish Audio API key is required');
      Object.assign(config, { enabled, provider, endpoint: nextEndpoint, model, timeoutMs,
        language: languageCode(input.language ?? config.language) });
    });
    return this.publicConfig();
  }
  async transcribe(body, signal) {
    const config = { ...this.store.value };
    check(config.enabled, 503, 'Speech recognition is not configured');
    check(this.active.size < 4, 429, 'Speech recognition is busy; try again');
    const input = audioInput(body, config.language);
    const abort = new AbortController();
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const combined = AbortSignal.any([abort.signal, timeout, ...(signal ? [signal] : [])]);
    this.active.add(abort);
    const started = performance.now();
    try {
      const text = await recognizeAudio(input, config, combined);
      return { text, transcriptionTimeMs: Math.round(performance.now() - started), provider: config.provider };
    } catch (error) {
      if (timeout.aborted) throw new HttpError(504, 'Speech recognition timed out');
      if (combined.aborted) throw new HttpError(499, 'Speech recognition cancelled');
      if (error.status) throw error;
      throw new HttpError(502, 'Could not reach the speech service');
    } finally { this.active.delete(abort); }
  }
  async route(request, response) {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    response.once('close', cancel);
    try {
      const body = await jsonBody(request, bodyLimit);
      return sendJson(response, 200, await this.transcribe(body, abort.signal));
    } finally { response.off('close', cancel); }
  }
  async close() {
    for (const abort of this.active) abort.abort();
    await this.store.tail;
  }
}
