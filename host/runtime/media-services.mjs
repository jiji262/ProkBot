import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonStore } from '../server/storage.mjs';
import { check, HttpError } from '../server/security.mjs';
import { mediaModels, readMediaSettings, describeMediaModels } from '../server/media-settings.mjs';
import { analyzeVideo, collectMedia, mediaInput, pollMedia, submitMedia } from '../server/media-providers.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm' };

/** Paid submissions are recorded before sending; uncertain submissions are never automatically repeated. */
export class MediaServices {
  constructor(directory, { download } = {}) {
    this.directory = directory; this.download = download; this.active = new Map(); this.requests = new Map();
    this.store = new JsonStore(join(directory, 'media-jobs.json'), { version: 1, jobs: [] });
  }
  async load() { await this.store.load(); return this; }
  async configuration() { return readMediaSettings(this.directory); }
  async models(kind) { return mediaModels(await this.configuration(), kind); }
  async resolve(kind, modelId) {
    const config = await this.configuration();
    const selected = modelId || config.defaults[kind];
    const model = mediaModels(config, kind).find(item => item.id === selected);
    check(model, 503, `No enabled ${kind} model is selected`);
    return { model, provider: config.providers.find(item => item.id === model.providerId) };
  }
  async available(kind) {
    const config = await this.configuration();
    return Boolean(config.defaults[kind] && mediaModels(config, kind).some(item => item.id === config.defaults[kind]));
  }
  async describe(kind) {
    return describeMediaModels(await this.models(kind));
  }
  jobs() { return this.store.value.jobs.map(({ inputHash, requestKey, ...item }) => item); }
  async update(id, changes) {
    await this.store.mutate(state => Object.assign(state.jobs.find(item => item.id === id), changes, { updatedAt: new Date().toISOString() }));
  }
  async generate(kind, input, options = {}) {
    const key = options.requestId || options.jobId || randomUUID();
    const fingerprint = digest(JSON.stringify({ kind, input }));
    if (this.requests.has(key)) {
      const saved = this.requests.get(key); check(saved.fingerprint === fingerprint, 409, 'Media job input changed');
      return saved.operation;
    }
    check(this.requests.size < 4, 429, 'Media generation is busy');
    const operation = this.generateOnce(kind, input, options); this.requests.set(key, { operation, fingerprint });
    try { return await operation; } finally { this.requests.delete(key); }
  }
  async generateOnce(kind, input, { requestId, jobId, signal, onRequestId } = {}) {
    check(['image', 'video'].includes(kind), 400, 'Invalid media generation kind');
    if (jobId) check(typeof jobId === 'string' && /^[0-9a-f-]{36}$/.test(jobId), 400, 'Invalid media job');
    const { model, provider } = await this.resolve(kind, input.model);
    const body = mediaInput(model, input), inputHash = digest(JSON.stringify({ kind, model: model.id, body }));
    if (kind === 'image') check((body.n ?? 1) === 1 && (body.max_images ?? 1) === 1 && (body.num_images ?? 1) === 1,
      400, 'Configure one image per GenerateImage request');
    const requestKey = requestId ? digest(String(requestId)) : randomUUID();
    let job = this.store.value.jobs.find(item => jobId ? item.id === jobId : item.requestKey === requestKey);
    if (job) check(job.inputHash === inputHash, 409, 'Media job input changed');
    else {
      check(!jobId, 404, 'Media job not found');
      check(this.active.size < 4, 429, 'Media generation is busy');
      job = { id: randomUUID(), requestKey, inputHash, kind, modelId: model.id, providerId: provider.id,
        providerUrl: provider.baseUrl, status: 'submitting', createdAt: new Date().toISOString() };
      await this.store.mutate(state => {
        check(state.jobs.length < 2000, 507, 'Media job history is full');
        state.jobs.push(job);
      });
      const task = this.execute(job, model, provider, body, { signal, onRequestId, submit: true });
      this.active.set(job.id, task);
      try { return await task; } finally { this.active.delete(job.id); }
    }
    if (this.active.has(job.id)) return this.active.get(job.id);
    if (job.status === 'completed') return this.cached(job);
    check(!['failed', 'cancelled', 'timeout'].includes(job.status), 409, `Media job ${job.status}`);
    check(job.providerJobId, 409, `Submission status is unknown; inspect media job ${job.id} before submitting again`);
    check(provider.baseUrl === job.providerUrl, 409, 'Media provider address changed');
    const task = this.execute(job, model, provider, body, { signal, onRequestId, submit: false });
    this.active.set(job.id, task);
    try { return await task; } finally { this.active.delete(job.id); }
  }
  async execute(job, model, provider, body, { signal, onRequestId, submit }) {
    const combined = AbortSignal.any([AbortSignal.timeout(20 * 60_000), ...(signal ? [signal] : [])]);
    try {
      let result;
      if (submit) {
        result = await submitMedia(provider, model, body, combined);
        if (result.id) {
          check(typeof result.id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(result.id), 502, 'Invalid provider job ID');
          await this.update(job.id, { providerJobId: result.id, status: 'processing' });
          await onRequestId?.(result.id);
        }
      }
      if (result?.status !== 'completed') {
        const providerJobId = result?.id ?? job.providerJobId;
        check(providerJobId, 502, 'Media service returned no job ID');
        result = await pollMedia(provider, providerJobId, combined);
      }
      const outputs = await collectMedia(result, job.kind, combined, this.download);
      const directory = join(this.directory, 'media-results'); await mkdir(directory, { recursive: true, mode: 0o700 });
      const saved = [];
      for (const output of outputs) {
        const filename = `${digest(output.bytes)}.${extensions[output.mimeType]}`;
        const filePath = join(directory, filename), temporary = `${filePath}.${randomUUID()}.tmp`;
        await writeFile(temporary, output.bytes, { mode: 0o600 }); await rename(temporary, filePath);
        saved.push({ filename, mimeType: output.mimeType, bytes: output.bytes.length });
      }
      await this.update(job.id, { status: 'completed', outputs: saved });
      return { jobId: job.id, modelId: model.id, outputs: outputs.map((item, index) => ({ ...item, filePath: join(directory, saved[index].filename) })) };
    } catch (error) {
      const current = this.store.value.jobs.find(item => item.id === job.id);
      await this.update(job.id, { status: error.mediaStatus || (error.upstreamStatus >= 400 && error.upstreamStatus < 500 ? 'failed'
        : current.providerJobId ? 'pending' : 'uncertain'),
        error: error.status ? error.message : combined.aborted ? 'Media request interrupted' : 'Media request failed' });
      throw new HttpError(error.status || 502, `${error.status ? error.message : 'Media request interrupted'} (job ${job.id})`);
    }
  }
  async cached(job) {
    const outputs = await Promise.all(job.outputs.map(async item => {
      const filePath = join(this.directory, 'media-results', item.filename);
      return { filePath, mimeType: item.mimeType, bytes: await readFile(filePath) };
    }));
    return { jobId: job.id, modelId: job.modelId, outputs };
  }
  createGenerateImageService(options) {
    const service = createHostImageService(this.generate.bind(this), options);
    service.available = () => this.available('image');
    service.describeModels = () => this.describe('image');
    return service;
  }
  async analyze(kind, input, { signal } = {}) {
    check(['watchVideo', 'videoReview'].includes(kind), 400, 'Invalid video analysis kind');
    const { model, provider } = await this.resolve(kind, input.model);
    return analyzeVideo(provider, model, input, AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]));
  }
}

export function createHostImageService(generate, { persistImage, onRequestId }) {
  return async (ctx, description, _filename, references, aspectRatio, options = {}) => {
    const result = await generate('image', { prompt: description, references, aspectRatio, model: options.model,
      parameters: options.parameters }, { requestId: options.toolCallId, jobId: options.jobId,
      signal: options.signal ?? ctx?.signal, onRequestId });
    check(result.outputs.length === 1, 502, 'GenerateImage requires one output; configure one image per request');
    const image = result.outputs[0], persisted = await persistImage(image.bytes, image.mimeType);
    check(persisted?.absolutePath, 500, 'Could not save generated image');
    return { filePath: persisted.absolutePath, imageData: image.bytes.toString('base64') };
  };
}
