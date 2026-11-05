import { createReplyNotifier } from './reply-notifier.mjs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { readNotificationSettings } from '../server/notification-settings.mjs';
import { DEFAULT_NOTIFICATION_FREQUENCY } from '../clients/shared/notification-frequency.mjs';

const readJson = async filename => {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};

/** Reuse the original notification decider, replacing only its official-cloud sender. */
export async function startLocalNotifications(context, library) {
  const endpoint = process.env.GROKBOT_NOTIFICATION_URL;
  const token = (await readFile(process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE, 'utf8')).trim();
  const directory = process.env.GROKBOT_STATE_DIR ?? '/research/state';
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = join(directory, 'notification-outbox.json');
  const pending = new Map((await readJson(filename)).map(item => [item.id, item]));
  let serial = Promise.resolve(), delivering, timer, stopping = false;
  const abort = new AbortController();
  const save = async () => {
    const temporary = `${filename}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify([...pending.values()]) + '\n', { mode: 0o600 });
    await rename(temporary, filename);
  };
  const mutate = work => {
    const task = serial.then(work);
    serial = task.catch(() => {});
    return task;
  };
  const schedule = () => {
    if (stopping || timer || delivering || !pending.size) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, 5000);
    timer.unref();
  };
  async function flush() {
    if (stopping || delivering) return;
    delivering = (async () => {
      await serial;
      for (const item of pending.values()) {
        if (stopping) break;
        try {
          const response = await fetch(endpoint, { method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(item), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await response.arrayBuffer();
          await mutate(async () => { pending.delete(item.id); await save(); });
        } catch {
          if (!stopping) context.host.log('Local notification delivery deferred; the durable outbox will retry.');
          break;
        }
      }
    })();
    try { await delivering; } finally { delivering = undefined; schedule(); }
  }
  async function notify(input) {
    const type = input.awaitingUserResponse ? 'attention' : 'message';
    const id = createHash('sha256').update(JSON.stringify([input.agentId, type, input.lastMessageId ?? ''])).digest('hex');
    const item = { id, type, agentId: input.agentId,
      title: `${input.agentName || 'Grok Bot'}${type === 'attention' ? ' · 需要处理' : ''}`.slice(0, 160),
      body: String(input.messagePreview ?? '').slice(0, 1024), createdAt: new Date().toISOString(),
      deepLink: `grokbot-local://agent/${encodeURIComponent(input.agentId)}` };
    try {
      await mutate(async () => { pending.set(id, item); await save(); });
      void flush();
    } catch {
      context.host.log('Local notification could not be saved; inspect the Host data volume.');
    }
  }
  let frequency = DEFAULT_NOTIFICATION_FREQUENCY, updates = Promise.resolve();
  const notifier = createReplyNotifier(library, notify, { getFrequency: () => frequency });
  const unsubscribe = context.host.events.subscribe(event => {
    if (!event.kind.startsWith('notification-') || stopping) return;
    updates = updates.then(async () => {
      frequency = (await readNotificationSettings(process.env.GROKBOT_DATA_DIR ?? directory)).frequency;
      if (event.kind === 'notification-baseline') notifier.seedBaseline(event.agents);
      else if (event.kind === 'notification-agents') notifier.handleAgentsEvent(event.event, event.presence);
      else if (event.kind === 'notification-agent-upserted') notifier.handleAgentUpsertedEvent(event.event, event.presence);
      else if (event.kind === 'notification-agent-forgotten') notifier.forget(event.agentId);
    }).catch(error => context.host.log(`Local notification settings/update failed: ${error.name}`));
  });
  context.onStop(async () => {
    stopping = true; unsubscribe(); clearTimeout(timer); abort.abort();
    await updates; await serial; await delivering;
  });
  void flush();
  return {};
}
