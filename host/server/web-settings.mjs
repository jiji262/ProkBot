import { join } from 'node:path';
import { JsonStore, readJson } from './storage.mjs';
import { check } from './security.mjs';
import { serviceUrl } from './media-http.mjs';

export const webDefaults = Object.freeze({ version: 1, providers: [], defaults: { search: '', fetch: '' }, models: [] });
const adapters = ['deepseek-tools', 'responses-search', 'anthropic-tools', 'http-json'];
export function validateWebSettings(input, previous = webDefaults) {
  check(input && Array.isArray(input.providers) && input.providers.length <= 30
    && Array.isArray(input.models) && input.models.length <= 150, 400, 'Invalid web service settings');
  const ids = new Set();
  const providers = input.providers.map(item => {
    check(item && typeof item.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(item.id)
      && !ids.has(item.id) && adapters.includes(item.adapter), 400, 'Invalid web provider'); ids.add(item.id);
    check(typeof item.name === 'string' && item.name.length <= 100 && typeof item.enabled === 'boolean', 400, 'Invalid web provider');
    const baseUrl = serviceUrl(item.baseUrl), old = previous.providers.find(provider => provider.id === item.id);
    const retained = old?.baseUrl === baseUrl && old.adapter === item.adapter && !item.clearApiKey;
    check(item.apiKey === undefined || typeof item.apiKey === 'string', 400, 'Invalid web API key');
    const apiKey = item.apiKey?.trim() || (retained ? old.apiKey : '') || '';
    check(typeof apiKey === 'string' && apiKey.length <= 4096 && !/[\0\r\n]/.test(apiKey), 400, 'Invalid web API key');
    const model = item.model || '';
    check(typeof model === 'string' && model.length <= 200 && !/[\0\r\n]/.test(model), 400, 'Invalid web model');
    check(!item.enabled || !['responses-search', 'anthropic-tools'].includes(item.adapter) || model,
      400, 'Native web tools need a model ID');
    return { id: item.id, name: item.name.trim(), adapter: item.adapter, baseUrl, apiKey, enabled: item.enabled, model };
  });
  const routes = value => {
    const result = {};
    for (const kind of ['search', 'fetch']) {
      const selected = value?.[kind] ?? '';
      check(selected === '' || providers.some(provider => provider.id === selected && provider.enabled
        && !(kind === 'fetch' && provider.adapter === 'responses-search')), 400, `Invalid web ${kind} provider`);
      result[kind] = selected;
    }
    return result;
  };
  const modelIds = new Set();
  const models = input.models.map(item => {
    check(item && typeof item.model === 'string' && item.model.length > 0 && item.model.length <= 200 && !modelIds.has(item.model),
      400, 'Invalid model web override'); modelIds.add(item.model);
    return { model: item.model, ...routes(item) };
  });
  return { version: 1, providers, defaults: routes(input.defaults), models };
}
export function webRoute(config, kind, modelId) {
  const route = config.models.find(item => item.model === modelId) ?? config.defaults;
  return config.providers.find(provider => provider.enabled && provider.id === route[kind]);
}
export const readWebSettings = directory => readJson(join(directory, 'web-services.json'), webDefaults);
export class WebSettings {
  constructor(directory) { this.store = new JsonStore(join(directory, 'web-services.json'), webDefaults); }
  async load() { await this.store.load(); return this; }
  publicConfig() { return { ...this.store.value, providers: this.store.value.providers.map(({ apiKey, ...item }) => ({ ...item, hasApiKey: Boolean(apiKey) })) }; }
  async save(input) { await this.store.mutate(state => Object.assign(state, validateWebSettings(input, state))); return this.publicConfig(); }
}
