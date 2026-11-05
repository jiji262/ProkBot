import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonStore } from '../server/storage.mjs';

/** A claimed event enters the original event-automation runtime, never the user-send API. */
export async function startLocalWebhooks(context, { call, interval = 1500, directory = process.env.GROKBOT_DATA_DIR } = {}) {
  if (!call) {
    if (!process.env.GROKBOT_NOTIFICATION_URL || !process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE) return { suspend() {}, resume() {}, close() {} };
    const base = new URL(process.env.GROKBOT_NOTIFICATION_URL), token = (await readFile(process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE, 'utf8')).trim();
    call = async (method, body) => {
      const response = await fetch(new URL(`/internal/webhooks/${method}`, base), { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Webhook service: ${response.status}`); }
      return response.json();
    };
  }
  const mappings = await new JsonStore(join(directory, 'webhook-automations.json'), { version: 1, mappings: {} }).load();
  const worker = randomUUID(), transcript = context.deps.transcript;
  let stopped = false, suspended = false, timer, busy = false, pendingFinish, activeId;
  async function ensureAutomation(hook) {
    const stored = mappings.value.mappings[hook.id];
    const definitions = await transcript.getAgentAutomations(hook.agentId);
    const marker = ` · ${hook.id.slice(0, 8)}`, name = hook.name.slice(0, 60) + marker;
    let automation = definitions.find(item => item.id === stored?.id) ?? definitions.find(item => item.name.endsWith(marker) && item.trigger.type === 'webhook');
    if (automation && stored?.revision === hook.revision) return automation;
    const spec = { name, prompt: hook.prompt, trigger: { type: 'webhook' }, isEnabled: hook.enabled };
    const next = automation ? await transcript.updateAgentAutomation(hook.agentId, automation.id, spec)
      : await transcript.createAgentAutomation(hook.agentId, spec, 'user');
    automation = next.find(item => item.id === automation?.id) ?? next.find(item => item.name === name);
    if (!automation) throw new Error('Could not create the webhook routine');
    await mappings.mutate(state => { state.mappings[hook.id] = { id: automation.id, revision: hook.revision }; });
    return automation;
  }
  async function tick() {
    if (stopped || suspended || busy) return;
    busy = true;
    try {
      if (pendingFinish) { await call('finish', pendingFinish); pendingFinish = null; activeId = null; }
      if (!await context.deps['turn-execution'].isRunReady() || stopped || suspended) return;
      const claimed = await call('claim', { worker });
      if (!claimed || stopped) return;
      const { event, hook } = claimed;
      // A response lost after claiming remains owned by this worker; execution starts only here.
      if (activeId === event.id) return;
      activeId = event.id;
      let outcome = 'skipped', detail = '';
      try {
        if (hook?.enabled) {
          const automation = await ensureAutomation(hook);
          if (automation.isEnabled) {
            const result = await transcript.runServerAutomationForEvent({ agentId: hook.agentId, automation, runUuid: event.runUuid,
              event: { source: 'webhook', headers: { 'x-grokbot-event-id': event.eventId }, bodyDigest: event.digest,
                body: event.body, context: `${hook.name}${event.type ? `: ${event.type}` : ''}`, timestampMs: event.receivedAt } });
            outcome = result === 'ok' ? 'completed' : result === 'error' ? 'failed' : 'skipped';
          }
        }
      } catch (error) { outcome = 'failed'; detail = String(error?.message ?? error); }
      pendingFinish = { worker, id: event.id, runUuid: event.runUuid, state: outcome, detail };
      await call('finish', pendingFinish); pendingFinish = null; activeId = null;
    } catch (error) { context.host.log(`[webhooks] ${error.message}`); }
    finally { busy = false; }
  }
  timer = setInterval(() => void tick(), interval); timer.unref();
  const api = { tick, suspend() { suspended = true; }, resume() { suspended = false; void tick(); },
    async close() { stopped = true; clearInterval(timer); await mappings.tail; } };
  context.onStop(() => api.close()); void tick(); return api;
}
