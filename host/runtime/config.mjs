import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseModelPolicy } from './model-policy.mjs';

export const root = resolve(import.meta.dirname, '..');
export async function loadModelConfig({ env = process.env } = {}) {
  const path = env.GROKBOT_MODEL_ENV ?? resolve(root, '.runtime/model.env');
  const file = await readFile(path, 'utf8');
  const values = Object.fromEntries(file.split(/\r?\n/).filter(line => line && !line.startsWith('#'))
    .map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (!values.OPENAI_BASE_URL || !values.OPENAI_API_KEY) throw new Error('Missing model configuration');
  const capacity = String(env.OPENAI_CONTEXT_WINDOW_TOKENS ?? values.OPENAI_CONTEXT_WINDOW_TOKENS ?? '').trim();
  const contextWindowTokens = capacity === '' ? 0 : Number(capacity);
  if ((capacity !== '' && !/^\d+$/.test(capacity)) || !Number.isSafeInteger(contextWindowTokens)) {
    throw new Error('OPENAI_CONTEXT_WINDOW_TOKENS must be a nonnegative safe integer');
  }
  return {
    baseUrl: values.OPENAI_BASE_URL,
    apiKey: values.OPENAI_API_KEY,
    model: env.GROKBOT_MODEL ?? values.OPENAI_MODEL ?? 'deepseek-v4.1-flash',
    contextWindowTokens,
    policy: parseModelPolicy(values.GROKBOT_MODEL_POLICY, env.GROKBOT_MODEL ?? values.OPENAI_MODEL),
    jevApiKey: values.JEV_API_KEY || '',
    usageDirectory: resolve(env.GROKBOT_DATA_DIR ?? resolve(path, '..'), 'usage'),
    routingDirectory: resolve(env.GROKBOT_DATA_DIR ?? resolve(path, '..'), 'routing'),
  };
}
