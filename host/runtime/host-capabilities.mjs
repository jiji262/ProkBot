import { join } from 'node:path';
import { readJson } from '../server/storage.mjs';
import { defaultHarnessSettings, validateHarnessSettings } from '../server/harness-settings.mjs';

const controlled = {
  sand_browser_use_subagent: 'browserUse', sand_user_form: 'userForm',
  agent_prompted_cookie_sync: 'browserLoginImport',
  sand_teach_by_demonstration: 'teachTask',
};
const disabled = new Set(['sand_draft_external_message', 'grok_bot_stripe_link', 'sand_voice_call']);

/** Original stateful services keep their lifetime; only local feature decisions change. */
export async function createLocalCapabilities(directory) {
  const filename = join(directory, 'harness-settings.json');
  let settings = { ...defaultHarnessSettings }, stopped = false, reading = false;
  const listeners = new Set();
  async function refresh() {
    if (stopped || reading) return;
    reading = true;
    try {
      const stored = await readJson(filename, null);
      const next = validateHarnessSettings(stored?.settings ?? defaultHarnessSettings);
      if (JSON.stringify(next) !== JSON.stringify(settings)) {
        settings = next;
        for (const listener of listeners) listener(settings);
      }
    } finally { reading = false; }
  }
  await refresh();
  const timer = setInterval(() => refresh().catch(error => console.warn('[capabilities]', error.name)), 1000);
  timer.unref();
  return {
    get: () => ({ ...settings }), refresh,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    experiments(original) {
      return new Proxy(original, { get(target, key) {
        if (key === 'checkFeatureGate') return (name, ...args) => name === 'sand_share_bot' ? true : controlled[name] ? settings[controlled[name]] :
          disabled.has(name) ? false : target.checkFeatureGate(name, ...args);
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
    close() { stopped = true; clearInterval(timer); listeners.clear(); },
  };
}

export async function startLocalMemory(context, extension, capabilities) {
  let enable;
  const experiments = new Proxy(context.deps.experiments, { get(target, key) {
    if (key === 'pinGateOnAuthenticatedBootstrap') return (name, callback) => {
      if (name === 'sand_memory_dreaming') { enable = callback; return () => {}; }
      return target.pinGateOnAuthenticatedBootstrap(name, callback);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const service = await extension.start({ ...context, deps: { ...context.deps, experiments } });
  const apply = ({ dreaming }) => {
    if (dreaming) enable?.(true);
    else {
      service.synthesisService?.dispose();
      service.synthesisService = null;
    }
  };
  apply(capabilities.get());
  context.onStop(capabilities.subscribe(apply));
  return service;
}
