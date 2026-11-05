import { join } from 'node:path';
import { readJson, writePrivate } from '../server/storage.mjs';
import { promptDigest, promptId, promptRoles, validatePrompt } from '../server/prompt-settings.mjs';

/** Only base instructions are catalogued. Profile, memory, skills and user content stay in the original assembler. */
export async function installLocalPromptPolicy(directory, library, { pollMs = 1000 } = {}) {
  const settingsPath = join(directory, 'prompt-settings.json'), catalogPath = join(directory, 'prompt-catalog.json');
  let settings = { version: 1, entries: {} }, catalog = await readJson(catalogPath, { version: 1, entries: [] }), tail = Promise.resolve(), reading = false;
  let stopped = false;
  const flush = () => {
    const snapshot = JSON.stringify(catalog);
    tail = tail.catch(() => {}).then(() => writePrivate(catalogPath, snapshot));
    tail.catch(error => console.warn('[prompt-catalog]', error.name)); return tail;
  };
  function observe(role, original, observed = true) {
    if (!promptRoles.includes(role) || typeof original !== 'string') return null;
    try { validatePrompt(original); } catch { return null; }
    const id = promptId(role, original), old = catalog.entries.find(item => item.id === id);
    if (old) {
      if (observed && !old.observed) { old.observed = true; old.observedAt = Date.now(); void flush(); }
      return id;
    }
    catalog.entries.push({ id, role, original, digest: promptDigest(original), observedAt: Date.now(), observed,
      source: 'd0a4baa · system-prompt-assembly' });
    catalog.entries = catalog.entries.slice(-100); void flush(); return id;
  }
  async function refresh() {
    if (stopped || reading) return; reading = true;
    try {
      const value = await readJson(settingsPath, { version: 1, entries: {} });
      if (value.version !== 1 || !value.entries || typeof value.entries !== 'object') throw new Error('Invalid prompt settings');
      settings = value;
    } finally { reading = false; }
  }
  await refresh();
  const bindings = library?.getPromptToolsRecoveryBindings?.();
  if (bindings) {
    observe('parent', bindings.sandBaseSystemPromptVariant({ cloudAgentsEnabled: false, dynamicToolsEnabled: false, multiMachineLocalExecEnabled: false, voiceCallEnabled: false }), false);
    observe('automation', bindings.sandAutomationSubagentSystemPromptVariant({ cloudAgentsEnabled: false, dynamicToolsEnabled: false, multiMachineLocalExecEnabled: false, voiceCallEnabled: false }), false);
    for (const role of ['generalPurpose', 'computerUse', 'browserUse']) observe(role, bindings.buildSandSubagentSystemPrompt({ subagentType: role, readonly: false }), false);
  }
  await tail;
  const policy = {
    snapshot() {
      const frozen = structuredClone(settings.entries);
      let id, assembly, tools;
      function publish() {
        if (!id || !assembly) return;
        const item = catalog.entries.find(entry => entry.id === id); if (!item) return;
        item.preview = { at: Date.now(), revision: frozen[id]?.revisions?.at(-1)?.number ?? 0,
          base: assembly.base, sections: assembly.sections, tools: tools ?? null };
        void flush();
      }
      const render = (role, original) => {
        id = observe(role, original); if (!id) return original;
        const selected = frozen[id]?.revisions?.at(-1)?.content;
        if (selected === undefined) return original;
        try { return validatePrompt(selected); } catch { return original; }
      };
      render.recordAssembly = value => { assembly = value; publish(); };
      render.recordTools = values => {
        tools = values.filter(value => typeof value.name === 'string').map(value => ({ name: value.name.slice(0, 150),
          source: /MCP/i.test(value.identifier ?? '') || /^mcp[_.]/i.test(value.name) ? 'MCP' : 'Harness',
          identifier: typeof value.identifier === 'string' ? value.identifier.slice(0, 150) : '',
          placement: value.placement === 'dynamic' ? 'dynamic' : 'static', enabled: true })); publish();
      };
      return render;
    },
  };
  const previous = globalThis.__grokbotPromptPolicy;
  if (previous) throw new Error('A prompt policy is already installed');
  globalThis.__grokbotPromptPolicy = policy;
  const timer = setInterval(() => refresh().catch(error => console.warn('[prompt-policy]', error.name)), pollMs); timer.unref();
  return { refresh, flush: () => tail, snapshot: policy.snapshot, async close() {
    stopped = true; clearInterval(timer); if (globalThis.__grokbotPromptPolicy === policy) delete globalThis.__grokbotPromptPolicy; await tail;
  } };
}
