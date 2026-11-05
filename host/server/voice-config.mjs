import { join } from 'node:path';
import { JsonStore } from './storage.mjs';
import { check, HttpError } from './security.mjs';

export const VOICE_OUTPUT = Object.freeze({ sampleRate: 24_000, channels: 1, encoding: 'pcm16le' });
export const MAX_VOICE_TEXT = 8000;
export const MAX_VOICE_CONCURRENT = 4;
export const voiceProviders = Object.freeze({
  fish: { endpoint: 'https://api.fish.audio/v1/tts' },
  openai: { endpoint: '' },
});
const defaults = { version: 1, enabled: false, tts: {
  provider: 'fish', endpoint: voiceProviders.fish.endpoint, model: '', referenceId: '', voice: '',
  apiKeySource: 'own', apiKey: '', speed: 1, latency: 'balanced', timeoutMs: 60_000,
} };

function endpoint(value) {
  check(typeof value === 'string' && value.length <= 2048, 400, 'Invalid voice endpoint');
  if (!value.trim()) return '';
  try {
    const url = new URL(value.trim());
    check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      !url.search && !url.hash, 400, 'Invalid voice endpoint');
    return url.href;
  } catch { throw new HttpError(400, 'Invalid voice endpoint'); }
}

function field(value, label, max = 200) {
  check(typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value),
    400, `Invalid voice ${label}`);
  return value.trim();
}

/** Private TTS configuration; ASR continues to use the existing Speech service. */
export class VoiceConfig {
  constructor(dataDir, { speech } = {}) {
    this.store = new JsonStore(join(dataDir, 'voice.json'), structuredClone(defaults));
    this.speech = speech;
  }
  async load() { await this.store.load(); return this; }
  speechKey(config) {
    const speech = this.speech?.store?.value;
    if (config.provider !== 'fish' || speech?.provider !== 'fish' || !speech.apiKey) return '';
    try {
      // Reusing an ASR credential never authorizes sending it to another provider or host.
      return new URL(config.endpoint).origin === new URL(speech.endpoint).origin ? speech.apiKey : '';
    } catch { return ''; }
  }
  publicConfig() {
    const { apiKey, ...tts } = this.store.value.tts;
    return { enabled: this.store.value.enabled,
      asr: { source: 'speech', configured: Boolean(this.speech?.publicConfig().enabled) },
      tts: { ...tts, hasApiKey: Boolean(tts.apiKeySource === 'speech' ? this.speechKey(tts) : apiKey) },
      output: { ...VOICE_OUTPUT }, maxTextCharacters: MAX_VOICE_TEXT, maxConcurrent: MAX_VOICE_CONCURRENT };
  }
  validateReady(tts, status = 400) {
    check(tts.endpoint, status, 'Voice endpoint is required');
    const apiKey = tts.apiKeySource === 'speech' ? this.speechKey(tts) : tts.apiKey;
    if (tts.apiKeySource === 'speech')
      check(apiKey, status, 'A Fish speech key with the same service origin is required');
    if (tts.provider === 'fish') {
      check(apiKey, status, 'Fish Audio API key is required');
      check(tts.referenceId, status, 'Choose a Fish voice or enter a reference ID');
    }
    if (tts.provider === 'openai') {
      check(tts.model, status, 'Voice model is required');
      check(tts.voice, status, 'Voice is required');
    }
    return { ...tts, apiKey };
  }
  resolveCatalogConfig(values = {}) {
    check(values && typeof values === 'object' && !Array.isArray(values), 400, 'Invalid voice configuration');
    const previous = this.store.value.tts;
    const address = endpoint(values.endpoint ?? previous.endpoint);
    const apiKeySource = values.apiKeySource ?? previous.apiKeySource;
    check(['own', 'speech'].includes(apiKeySource), 400, 'Invalid voice API key source');
    let apiKey = previous.provider === 'fish' && address === previous.endpoint ? previous.apiKey : '';
    if (values.clearApiKey) apiKey = '';
    if (values.apiKey !== undefined) apiKey = field(values.apiKey, 'API key', 4096) || apiKey;
    const config = { provider: 'fish', endpoint: address, apiKeySource, apiKey };
    if (apiKeySource === 'speech') config.apiKey = this.speechKey(config);
    check(config.endpoint, 400, 'Voice endpoint is required');
    check(config.apiKey, 400, 'Fish Audio API key is required');
    return config;
  }
  async save(input) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, 'Invalid voice configuration');
    await this.store.mutate(config => {
      const enabled = input.enabled ?? config.enabled;
      check(typeof enabled === 'boolean', 400, 'Invalid voice enabled value');
      const values = input.tts ?? {};
      check(values && typeof values === 'object' && !Array.isArray(values), 400, 'Invalid voice synthesis configuration');
      const previous = config.tts;
      const provider = values.provider ?? previous.provider;
      check(Object.hasOwn(voiceProviders, provider), 400, 'Unknown voice provider');
      const changedProvider = provider !== previous.provider;
      const address = endpoint(values.endpoint ?? (changedProvider ? voiceProviders[provider].endpoint : previous.endpoint));
      const changedEndpoint = address !== previous.endpoint;
      const apiKeySource = values.apiKeySource ?? (changedProvider ? 'own' : previous.apiKeySource);
      check(['own', 'speech'].includes(apiKeySource), 400, 'Invalid voice API key source');
      check(apiKeySource !== 'speech' || provider === 'fish', 400, 'Speech API key reuse requires Fish Audio');
      let apiKey = changedProvider || changedEndpoint || values.clearApiKey ? '' : previous.apiKey;
      if (values.apiKey !== undefined) {
        const supplied = field(values.apiKey, 'API key', 4096);
        if (supplied) apiKey = supplied;
      }
      if (apiKeySource === 'speech') apiKey = '';
      const base = changedProvider ? defaults.tts : previous;
      const next = { provider, endpoint: address, apiKeySource, apiKey,
        model: field(values.model ?? base.model, 'model'),
        referenceId: field(values.referenceId ?? base.referenceId, 'reference ID'),
        voice: field(values.voice ?? base.voice, 'voice'),
        speed: values.speed ?? base.speed, latency: values.latency ?? base.latency,
        timeoutMs: values.timeoutMs ?? previous.timeoutMs };
      check(Number.isFinite(next.speed) && next.speed >= 0.5 && next.speed <= 2, 400, 'Voice speed must be 0.5–2');
      check(['normal', 'balanced', 'low'].includes(next.latency), 400, 'Invalid voice latency');
      check(Number.isInteger(next.timeoutMs) && next.timeoutMs >= 1000 && next.timeoutMs <= 120_000,
        400, 'Voice timeout must be 1000–120000 ms');
      if (enabled) this.validateReady(next);
      Object.assign(config, { enabled, tts: next });
    });
    return this.publicConfig();
  }
  resolveSynthesisConfig() {
    check(this.store.value.enabled, 503, 'Voice chat is not configured');
    return this.validateReady(this.store.value.tts, 503);
  }
  async close() { await this.store.tail; }
}
