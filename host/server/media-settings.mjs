import { join } from 'node:path';
import { JsonStore, readJson } from './storage.mjs';
import { check } from './security.mjs';
import { serviceUrl, serviceJson, checkSchema } from './media-http.mjs';

export const mediaDefaults = Object.freeze({ version: 1, providers: [], models: [],
  defaults: { image: '', video: '', watchVideo: '', videoReview: '' } });
const kinds = ['image', 'video', 'watchVideo', 'videoReview'];
const adapters = ['wavespeed', 'openai-images', 'http-json'];
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value);
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\0\r\n]/.test(value);

export function validateMediaSettings(input, previous = mediaDefaults) {
  check(input && typeof input === 'object' && Array.isArray(input.providers) && input.providers.length <= 30
    && Array.isArray(input.models) && input.models.length <= 150, 400, 'Invalid media settings');
  const providerIds = new Set(), modelIds = new Set();
  const providers = input.providers.map(item => {
    check(item && id(item.id) && !providerIds.has(item.id) && adapters.includes(item.adapter), 400, 'Invalid media provider');
    providerIds.add(item.id);
    check(text(item.name, 100) && typeof item.enabled === 'boolean', 400, 'Invalid media provider');
    const baseUrl = serviceUrl(item.baseUrl), old = previous.providers.find(provider => provider.id === item.id);
    const retained = old?.baseUrl === baseUrl && old.adapter === item.adapter && !item.clearApiKey;
    check(item.apiKey === undefined || typeof item.apiKey === 'string', 400, 'Invalid media API key');
    const apiKey = item.apiKey?.trim() || (retained ? old.apiKey : '') || '';
    check(text(apiKey, 4096), 400, 'Invalid media API key');
    return { id: item.id, name: item.name.trim(), adapter: item.adapter, baseUrl, enabled: item.enabled, apiKey };
  });
  const models = input.models.map(item => {
    check(item && id(item.id) && !modelIds.has(item.id) && providerIds.has(item.providerId), 400, 'Invalid media model');
    modelIds.add(item.id);
    check(kinds.includes(item.kind) && typeof item.enabled === 'boolean' && text(item.name, 120)
      && typeof item.description === 'string' && item.description.length <= 2000 && !item.description.includes('\0'), 400, 'Invalid media model');
    check(typeof item.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$/.test(item.model)
      && !item.model.includes('..'), 400, 'Invalid provider model ID');
    check(item.inputSchema === undefined || (item.inputSchema && typeof item.inputSchema === 'object'
      && !Array.isArray(item.inputSchema) && JSON.stringify(item.inputSchema).length <= 60_000), 400, 'Invalid model schema');
    const defaults = item.parameters ?? {};
    check(defaults && typeof defaults === 'object' && !Array.isArray(defaults) && JSON.stringify(defaults).length <= 16_000,
      400, 'Invalid model parameters');
    // Required prompt/reference values arrive with the tool call, not administrator defaults.
    checkSchema(defaults, { ...item.inputSchema, required: [] });
    const provider = providers.find(candidate => candidate.id === item.providerId);
    check(provider.adapter !== 'openai-images' || item.kind === 'image', 400, 'OpenAI Images only supports image generation');
    check(provider.adapter !== 'wavespeed' || ['image', 'video'].includes(item.kind), 400, 'Use an analysis adapter for video understanding');
    check(!item.enabled || provider.adapter !== 'wavespeed' || item.inputSchema?.type === 'object', 400, 'Refresh the WaveSpeed model schema before enabling it');
    return { id: item.id, providerId: item.providerId, model: item.model, kind: item.kind, enabled: item.enabled,
      name: item.name.trim(), description: item.description.trim(), parameters: defaults,
      ...(item.inputSchema ? { inputSchema: item.inputSchema } : {}),
      ...(Number.isFinite(item.basePrice) && item.basePrice >= 0 ? { basePrice: item.basePrice } : {}) };
  });
  const defaults = {};
  for (const kind of kinds) {
    const value = input.defaults?.[kind] ?? '';
    check(value === '' || models.some(model => model.id === value && model.kind === kind && model.enabled
      && providers.find(provider => provider.id === model.providerId)?.enabled), 400, `Invalid default ${kind} model`);
    defaults[kind] = value;
  }
  return { version: 1, providers, models, defaults };
}

export function mediaPublicConfig(config) {
  return { ...config, providers: config.providers.map(({ apiKey, ...provider }) => ({ ...provider, hasApiKey: Boolean(apiKey) })) };
}
export function mediaModels(config, kind) {
  return config.models.filter(model => model.enabled && (!kind || model.kind === kind)
    && config.providers.find(provider => provider.id === model.providerId)?.enabled);
}
/** Supply model choice and parameter limits without putting provider credentials in a prompt. */
export function describeMediaModels(models) {
  return models.map(model => {
    const parameters = Object.fromEntries(Object.entries(model.inputSchema?.properties ?? {})
      .filter(([name]) => !['prompt', 'enable_sync_mode', 'enable_base64_output'].includes(name))
      .map(([name, schema]) => [name, Object.fromEntries(['type', 'enum', 'minimum', 'maximum', 'maxItems', 'default']
        .filter(key => schema?.[key] !== undefined).map(key => [key, schema[key]]))]));
    return `${model.id}: ${model.name}. ${model.description}`
      + (Number.isFinite(model.basePrice) ? `\nCatalog base price: USD ${model.basePrice}; actual cost depends on parameters.` : '')
      + `\nDefaults: ${JSON.stringify(model.parameters ?? {})}`
      + (Object.keys(parameters).length ? `\nParameters: ${JSON.stringify(parameters)}` : '');
  }).join('\n');
}
export async function readMediaSettings(directory) {
  return readJson(join(directory, 'media.json'), mediaDefaults);
}

export class MediaSettings {
  constructor(directory) { this.store = new JsonStore(join(directory, 'media.json'), mediaDefaults); }
  async load() { await this.store.load(); return this; }
  publicConfig() { return mediaPublicConfig(this.store.value); }
  async save(input) {
    await this.store.mutate(current => Object.assign(current, validateMediaSettings(input, current)));
    return this.publicConfig();
  }
  async catalog(providerId, signal) {
    const provider = this.store.value.providers.find(item => item.id === providerId);
    check(provider, 404, 'Media provider not found');
    check(provider.adapter === 'wavespeed', 400, 'This provider uses manually configured models');
    const response = await serviceJson(`${provider.baseUrl}/api/v3/models`, {
      apiKey: provider.apiKey, signal: signal ?? AbortSignal.timeout(30_000), limit: 16 * 1024 * 1024 });
    check(response.code === 200 && Array.isArray(response.data), 502, 'Invalid WaveSpeed catalog');
    return response.data.flatMap(model => {
      const kind = ['text-to-image', 'image-to-image'].includes(model.type) ? 'image'
        : ['text-to-video', 'image-to-video', 'video-to-video'].includes(model.type) ? 'video' : null;
      const schema = model.api_schema?.api_schemas?.find(item => item.type === 'model_run')?.request_schema;
      if (!kind || !schema) return [];
      return [{ model: model.model_id, name: model.name, description: model.description ?? '', kind,
        type: model.type, basePrice: model.base_price, inputSchema: schema }];
    });
  }
}
