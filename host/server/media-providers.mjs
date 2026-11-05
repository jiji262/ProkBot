import { setTimeout as delay } from 'node:timers/promises';
import { check, HttpError } from './security.mjs';
import { checkSchema, downloadMedia, serviceJson } from './media-http.mjs';

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
function reference(value) {
  check(value && imageTypes.has(value.mimeType) && typeof value.data === 'string'
    && value.data.length < 40 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.data), 400, 'Invalid reference image');
  return `data:${value.mimeType};base64,${value.data}`;
}
export function mediaInput(model, input) {
  check(typeof input.prompt === 'string' && input.prompt.trim().length > 0 && input.prompt.length <= 30_000, 400, 'Invalid media prompt');
  check(!input.references || Array.isArray(input.references) && input.references.length <= 10, 400, 'Too many reference images');
  const body = { ...model.parameters, prompt: input.prompt };
  const properties = model.inputSchema?.properties;
  if (input.aspectRatio) {
    check(typeof input.aspectRatio === 'string' && /^\d{1,2}:\d{1,2}$/.test(input.aspectRatio), 400, 'Invalid aspect ratio');
    check(!properties || properties.aspect_ratio, 400, 'This model does not accept aspect_ratio; configure its size parameter');
    body.aspect_ratio = input.aspectRatio;
  }
  if (input.references?.length) {
    const images = input.references.map(reference);
    if (properties?.images || !properties) body.images = images;
    else if (properties.image && images.length === 1) body.image = images[0];
    else throw new HttpError(400, 'Choose an image editing model that accepts these references');
  }
  if (input.parameters !== undefined) {
    check(input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters)
      && JSON.stringify(input.parameters).length <= 16_000, 400, 'Invalid generation parameters');
    for (const key of Object.keys(input.parameters)) check(!['prompt', 'images', 'image', 'model'].includes(key), 400, `Reserved parameter ${key}`);
    Object.assign(body, input.parameters);
  }
  checkSchema(body, model.inputSchema);
  return body;
}
function waveResult(result) {
  check(result.code === 200 && result.data, 502, 'Invalid WaveSpeed response'); return result.data;
}

export async function submitMedia(provider, model, body, signal) {
  const common = { apiKey: provider.apiKey, signal, limit: 96 * 1024 * 1024 };
  if (provider.adapter === 'wavespeed') {
    return waveResult(await serviceJson(`${provider.baseUrl}/api/v3/${model.model}`, { ...common, body }));
  }
  if (provider.adapter === 'openai-images') {
    check(!body.images?.length, 400, 'Configure an editing adapter for image references');
    const { aspect_ratio, ...parameters } = body;
    check(!aspect_ratio, 400, 'OpenAI Images uses the configured size parameter');
    const result = await serviceJson(`${provider.baseUrl}/images/generations`, {
      ...common, body: { ...parameters, model: model.model, n: 1 } });
    check(Array.isArray(result.data) && result.data.length, 502, 'Image service returned no image');
    return { status: 'completed', outputs: result.data.map(item => item.b64_json
      ? { base64: item.b64_json, mimeType: 'image/png' } : item.url) };
  }
  return serviceJson(`${provider.baseUrl}/generate`, { ...common,
    body: { model: model.model, kind: model.kind, ...body } });
}

export async function pollMedia(provider, id, signal, { onProgress, intervalMs = 1000 } = {}) {
  check(typeof id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(id), 502, 'Invalid media job ID');
  for (;;) {
    const url = provider.adapter === 'wavespeed' ? `${provider.baseUrl}/api/v3/predictions/${id}/result`
      : `${provider.baseUrl}/jobs/${id}`;
    const response = await serviceJson(url, { apiKey: provider.apiKey, signal, limit: 96 * 1024 * 1024 });
    const result = provider.adapter === 'wavespeed' ? waveResult(response) : response;
    if (result.status === 'completed') return result;
    if (['failed', 'cancelled', 'timeout'].includes(result.status))
      throw Object.assign(new HttpError(502, `Media generation ${result.status}`), { mediaStatus: result.status });
    check(['created', 'pending', 'processing', 'queued'].includes(result.status), 502, 'Invalid media job status');
    await onProgress?.(result.status); await delay(intervalMs, undefined, { signal });
  }
}

function sniff(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return 'video/webm';
  return null;
}
export async function collectMedia(result, kind, signal, download = downloadMedia) {
  check(Array.isArray(result.outputs) && result.outputs.length > 0 && result.outputs.length <= 16,
    502, 'Media service returned no outputs');
  const outputs = [];
  for (const item of result.outputs) {
    let bytes;
    const base64 = typeof item === 'object' ? item?.base64 : typeof item === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(item) ? item : undefined;
    if (base64 !== undefined) {
      check(typeof base64 === 'string' && base64.length <= 90 * 1024 * 1024
        && base64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(base64), 502, 'Invalid media encoding');
      bytes = Buffer.from(base64, 'base64');
    } else {
      const url = typeof item === 'string' ? item : item?.url;
      ({ bytes } = await download(url, { signal }));
    }
    const mimeType = sniff(bytes);
    check(mimeType?.startsWith(`${kind}/`), 502, 'Media output has an unexpected format');
    outputs.push({ bytes, mimeType });
  }
  return outputs;
}

export async function analyzeVideo(provider, model, input, signal) {
  check(provider.adapter === 'http-json', 400, 'Video analysis needs an HTTP JSON adapter');
  check(typeof input.prompt === 'string' && input.prompt.length <= 30_000 && typeof input.videoBase64 === 'string'
    && /^video\/[a-zA-Z0-9.+-]+$/.test(input.mimeType) && input.videoBase64.length % 4 === 0
    && input.videoBase64.length <= 90 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(input.videoBase64), 400, 'Invalid video analysis input');
  const result = await serviceJson(`${provider.baseUrl}/analyze`, { apiKey: provider.apiKey, signal,
    body: { ...model.parameters, ...input, model: model.model, kind: model.kind } });
  check(typeof result.text === 'string' && result.text.length <= 200_000, 502, 'Invalid video analysis response');
  return { text: result.text };
}
