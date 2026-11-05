import { validateContextPolicy } from './context-policy.mjs';
export const TIERS = ['routine', 'reasoning', 'expert'];
export const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
export function effortLevels(model) {
  if (/deepseek-v4/i.test(model)) return ['none', 'low', 'high', 'max'];
  if (/claude-(opus|sonnet)-5-5/i.test(model)) return ['low', 'medium', 'high', 'xhigh', 'max'];
  return [];
}
export function defaultPolicy(model = 'deepseek-v4.1-flash') {
  return { mode: 'manual', effort: 'default', classifierModel: 'jev-latest',
    models: [{ id: model, efforts: effortLevels(model) }],
    routes: Object.fromEntries(TIERS.map(tier => [tier, { model, effort: 'auto' }])) };
}
export function parseModelPolicy(value, model) {
  return value ? JSON.parse(value) : defaultPolicy(model);
}
export function validatePolicy(value, model) {
  const fail = message => { throw new TypeError(message); };
  const policy = value ?? defaultPolicy(model);
  if (!['manual', 'adaptive'].includes(policy.mode)) fail('Invalid routing mode');
  if (!Array.isArray(policy.models) || policy.models.length > 100) fail('Invalid model catalog');
  const models = policy.models.map(item => {
    if (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 256 || /[\r\n\0]/.test(item.id)) fail('Invalid model ID');
    if (!Array.isArray(item.efforts) || item.efforts.some(effort => !EFFORTS.includes(effort))) fail('Invalid effort levels');
    const context = validateContextPolicy(item);
    return { id: item.id.trim(), efforts: EFFORTS.filter(effort => item.efforts.includes(effort)),
      ...(item.contextWindowTokens !== undefined || item.summaryThresholdTokens !== undefined ? context : {}) };
  });
  if (new Set(models.map(item => item.id)).size !== models.length) fail('Duplicate model ID');
  if (!models.some(item => item.id === model)) models.unshift({ id: model, efforts: effortLevels(model) });
  const validEffort = (id, effort, auto = false) => {
    const entry = models.find(item => item.id === id);
    if (!entry || !(effort === 'default' || (auto && effort === 'auto') || entry.efforts.includes(effort))) fail(`Unsupported effort for ${id}`);
    return effort;
  };
  const effort = validEffort(model, policy.effort ?? 'default');
  const routes = Object.fromEntries(TIERS.map(tier => {
    const route = policy.routes?.[tier];
    if (!route) fail('Missing task tier');
    return [tier, { model: route.model, effort: validEffort(route.model, route.effort, true) }];
  }));
  const classifierModel = policy.classifierModel ?? 'jev-latest';
  if (typeof classifierModel !== 'string' || !/^jev-[a-zA-Z0-9._-]{1,80}$/.test(classifierModel)) fail('Invalid classifier model');
  return { mode: policy.mode, effort, models, routes, classifierModel };
}
export function reasoningOptions(model, effort) {
  if (!effort || effort === 'default') return {};
  return { reasoning_effort: effort,
    ...(/deepseek/i.test(model) ? { thinking: { type: effort === 'none' ? 'disabled' : 'enabled' } } : {}) };
}
