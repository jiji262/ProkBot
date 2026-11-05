import { check, HttpError, RateLimit } from './security.mjs';
import { MAX_VOICE_CONCURRENT, MAX_VOICE_TEXT, VOICE_OUTPUT } from './voice-config.mjs';

export const MAX_SYNTHESIS_BYTES = VOICE_OUTPUT.sampleRate * 2 * 300;
const maxChunkBytes = 24_000;

function synthesisRequest(text, config) {
  const headers = { 'content-type': 'application/json', accept: 'audio/pcm, application/octet-stream',
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) };
  if (config.provider === 'fish') return { headers: { ...headers, ...(config.model ? { model: config.model } : {}) },
    body: JSON.stringify({ text, format: 'pcm', sample_rate: VOICE_OUTPUT.sampleRate,
      latency: config.latency, prosody: { speed: config.speed },
      ...(config.referenceId ? { reference_id: config.referenceId } : {}) }) };
  check(config.provider === 'openai', 503, 'Unknown voice provider');
  check(text.length <= 4096, 413, 'Voice text exceeds the provider limit');
  return { headers, body: JSON.stringify({ input: text, model: config.model, voice: config.voice,
    response_format: 'pcm', speed: config.speed }) };
}

function upstreamError(status) {
  if (status === 402) return new HttpError(502, 'Voice service API credit is insufficient');
  if ([401, 403].includes(status)) return new HttpError(502, 'Voice service rejected the API key');
  if (status === 429) return new HttpError(429, 'Voice service is busy; try again');
  return new HttpError(502, `Voice service returned HTTP ${status}`);
}

/** Yields PCM as it arrives, preserving sample boundaries and bounding output memory. */
async function* audioChunks(body, signal) {
  const reader = body.getReader();
  let remainder = Buffer.alloc(0), total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      check(total <= MAX_SYNTHESIS_BYTES, 502, 'Voice service audio exceeds five minutes');
      const data = remainder.length ? Buffer.concat([remainder, value]) : Buffer.from(value);
      const end = data.length - (data.length % 2);
      for (let offset = 0; offset < end; offset += maxChunkBytes) {
        signal.throwIfAborted();
        yield data.subarray(offset, Math.min(end, offset + maxChunkBytes));
      }
      remainder = end === data.length ? Buffer.alloc(0) : Buffer.from(data.subarray(end));
    }
    check(total > 0 && remainder.length === 0, 502, 'Voice service returned incomplete PCM audio');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** HTTP streaming adapter shared by Fish Audio and OpenAI-compatible speech services. */
export class VoiceSynthesis {
  constructor(config) {
    this.config = config;
    this.active = new Set();
    this.limiter = new RateLimit();
    this.closed = false;
  }
  async *stream(text, { signal } = {}) {
    check(!this.closed, 503, 'Voice service is shutting down');
    check(typeof text === 'string' && text.trim().length > 0, 400, 'Voice text is required');
    check(text.length <= MAX_VOICE_TEXT, 413, 'Voice text is too long');
    const config = this.config.resolveSynthesisConfig();
    check(this.active.size < MAX_VOICE_CONCURRENT, 429, 'Voice synthesis is busy; try again');
    const request = synthesisRequest(text.trim(), config);
    const abort = new AbortController();
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const combined = AbortSignal.any([abort.signal, timeout, ...(signal ? [signal] : [])]);
    let response;
    this.active.add(abort);
    try {
      combined.throwIfAborted();
      this.limiter.check('synthesis', 120);
      response = await fetch(config.endpoint, { ...request, method: 'POST', redirect: 'error', signal: combined });
      if (!response.ok) throw upstreamError(response.status);
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      check(!type || ['audio/pcm', 'audio/x-pcm', 'audio/raw', 'application/octet-stream'].includes(type),
        502, 'Voice service did not return PCM audio');
      check(response.body, 502, 'Voice service returned no audio');
      yield* audioChunks(response.body, combined);
    } catch (error) {
      if (timeout.aborted) throw new HttpError(504, 'Voice synthesis timed out');
      if (combined.aborted) throw new HttpError(499, 'Voice synthesis cancelled');
      if (error instanceof HttpError) throw error;
      // Upstream bodies and transport errors can contain text, endpoints or credentials.
      throw new HttpError(502, 'Could not reach the voice service');
    } finally {
      abort.abort();
      await response?.body?.cancel().catch(() => {});
      this.active.delete(abort);
    }
  }
  async close() {
    this.closed = true;
    for (const abort of this.active) abort.abort();
  }
}
