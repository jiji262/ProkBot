import { randomUUID } from 'node:crypto';
import { check } from '../server/security.mjs';

function deferred() {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {}); return { promise, resolve, reject };
}
/** The original Task subagent owns attachment validation, scheduling and result delivery. */
export function createVideoAnalysisSession(media, kind, onRequestId) {
  const modelId = `host-${kind}`;
  class Executor {
    constructor(initial) { this.messages = initial ? [...(Array.isArray(initial) ? initial : [initial])] : []; }
    appendMessages(value) { this.messages.push(...(Array.isArray(value) ? value : [value])); return this; }
    getMessages() { return [...this.messages]; }
    getState() { return this.getMessages(); }
    clearMessages() { this.messages = []; }
    stream(ctx, invocationId) {
      const slots = Object.fromEntries(['response', 'usage', 'extendedUsage', 'providerMetadata', 'invocationId'].map(key => [key, deferred()]));
      const abort = new AbortController(), signal = AbortSignal.any([abort.signal, ...(ctx?.signal ? [ctx.signal] : [])]);
      const messages = this.getMessages(); let settled = false;
      function fail(error) { if (settled) return; settled = true; for (const slot of Object.values(slots)) slot.reject(error); }
      async function* produce() {
        try {
          const videos = [], prompt = [];
          for (const message of messages) {
            const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
            for (const part of parts) {
              if (part.type === 'text') prompt.push(`${message.role}: ${part.text}`);
              else if (part.mimeType?.startsWith('video/')) {
                let value = part.image ?? part.data;
                if (typeof value === 'string' && value.startsWith('data:')) {
                  const match = /^data:(video\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+=*)$/i.exec(value);
                  check(match, 400, 'Invalid video attachment'); value = match[2];
                } else if (ArrayBuffer.isView(value)) value = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
                check(typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value), 400, 'Video analysis requires an inline video attachment');
                if (!videos.some(video => video.videoBase64 === value)) videos.push({ videoBase64: value, mimeType: part.mimeType });
              }
            }
          }
          check(videos.length > 0 && videos.length <= 4, 400, 'Video analysis requires one to four video attachments');
          const findings = [];
          for (const video of videos) {
            signal.throwIfAborted(); const result = await media.analyze(kind, { ...video, prompt: prompt.join('\n\n') }, { signal });
            findings.push(result.text);
          }
          const text = findings.map((value, index) => findings.length === 1 ? value : `Video ${index + 1}:\n${value}`).join('\n\n');
          const id = randomUUID(), timestamp = new Date(); try { onRequestId?.(id); } catch { /* observation */ }
          yield { type: 'text-delta', textDelta: text };
          const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
          slots.response.resolve({ id, timestamp, modelId, messages: [{ id, role: 'assistant', content: [{ type: 'text', text }] }] });
          slots.usage.resolve(usage); slots.extendedUsage.resolve({ inputTokens: 0, outputTokens: 0, maxTokens: 0 });
          slots.providerMetadata.resolve({ host: { mediaKind: kind, tokenUsageAvailable: false } });
          slots.invocationId.resolve(invocationId ?? id); settled = true;
          yield { type: 'finish', finishReason: 'stop', usage, response: { id, timestamp, modelId } };
        } catch (error) { fail(error); throw error; }
        finally { if (!settled) fail(new DOMException('Video analysis interrupted', 'AbortError')); }
      }
      const iterator = produce(), fullStream = {
        [Symbol.asyncIterator]() { return this; }, next: value => iterator.next(value),
        return: value => { abort.abort(); fail(new DOMException('Video analysis cancelled', 'AbortError')); return iterator.return(value); },
        throw: error => { abort.abort(error); fail(error); return iterator.throw(error); },
      };
      return { fullStream, ...Object.fromEntries(Object.entries(slots).map(([key, slot]) => [key, slot.promise])) };
    }
  }
  return { getModelId: () => modelId, getResolvedModelId: () => modelId, getEarlyCompaction: () => undefined,
    getExecutor: state => new Executor(state), getExecutorWithoutResolvedModelTracking: state => new Executor(state) };
}
