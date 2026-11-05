import { readFile } from 'node:fs/promises';
import { boundedBody } from '../server/media-http.mjs';
import { check, HttpError } from '../server/security.mjs';
import { createHostImageService } from './media-services.mjs';

/** Never expand the recovered Host's outbound network capability for provider traffic. */
export async function internalMediaClient() {
  const endpoint = process.env.GROKBOT_MEDIA_URL ?? process.env.GROKBOT_NOTIFICATION_URL;
  const tokenFile = process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE;
  if (!endpoint) return null;
  check(tokenFile, 503, 'Internal media authentication is not configured');
  const base = new URL(endpoint), token = (await readFile(tokenFile, 'utf8')).trim();
  check(/^[A-Za-z0-9_-]{32,256}$/.test(token), 500, 'Invalid internal Host credential');
  return async (path, body, signal) => {
    const response = await fetch(new URL(path, base), { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(21 * 60_000), ...(signal ? [signal] : [])]) });
    let result;
    try { result = JSON.parse((await boundedBody(response, 96 * 1024 * 1024)).toString('utf8')); }
    catch (error) { if (error.status) throw error; throw new HttpError(502, 'Invalid internal service response'); }
    if (!response.ok) throw new HttpError(response.status, result.error || 'Internal service request failed');
    return result;
  };
}

export function remoteMediaServices(call) {
  return {
    async generate(kind, input, { signal, requestId, jobId, onRequestId } = {}) {
      const result = await call('/internal/media/generate', { kind, input, requestId, jobId }, signal);
      check(Array.isArray(result.outputs) && result.outputs.length > 0, 502, 'Invalid internal media result');
      await onRequestId?.(result.jobId);
      return { jobId: result.jobId, modelId: result.modelId, outputs: result.outputs.map(output => {
        check(typeof output.base64 === 'string' && typeof output.mimeType === 'string', 502, 'Invalid internal media result');
        return { bytes: Buffer.from(output.base64, 'base64'), mimeType: output.mimeType };
      }) };
    },
    analyze: (kind, input, { signal } = {}) => call('/internal/media/analyze', { kind, input }, signal),
    createGenerateImageService(options) { return createHostImageService(this.generate.bind(this), options); },
  };
}
export function remoteWebServices(call) {
  const invoke = (kind, value, { modelId, signal } = {}) => call('/internal/web-services/invoke', {
    kind, value, modelId: typeof modelId === 'function' ? modelId() : modelId,
  }, signal);
  const tool = (kind, options) => {
    const service = (ctx, value) => invoke(kind, kind === 'search' ? value.searchTerm : value, { ...options, signal: ctx?.signal });
    service.forModel = modelId => tool(kind, { ...options, modelId }); return service;
  };
  return { invoke, createWebSearch: options => tool('search', options), createWebFetch: options => tool('fetch', options) };
}
