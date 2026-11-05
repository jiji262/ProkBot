import { join } from 'node:path';
import { JsonStore, readJson } from './storage.mjs';
import { check } from './security.mjs';
import { DEFAULT_NOTIFICATION_FREQUENCY, NOTIFICATION_FREQUENCIES } from '../clients/shared/notification-frequency.mjs';

function validate(input) {
  const frequency = input?.frequency ?? DEFAULT_NOTIFICATION_FREQUENCY;
  check(NOTIFICATION_FREQUENCIES.includes(frequency), 400, 'Invalid notification frequency');
  return { frequency };
}
export async function readNotificationSettings(directory) {
  return validate(await readJson(join(directory, 'notification-settings.json'), null));
}
export class NotificationSettings {
  constructor(directory) {
    this.store = new JsonStore(join(directory, 'notification-settings.json'), { version: 1, ...validate() });
    this.clients = new Set();
  }
  async load() { await this.store.load(); validate(this.store.value); return this; }
  current() { return validate(this.store.value); }
  async save(input) {
    check(input && typeof input === 'object' && !Array.isArray(input) && NOTIFICATION_FREQUENCIES.includes(input.frequency), 400, 'Invalid notification frequency');
    const settings = validate(input);
    await this.store.mutate(state => { Object.assign(state, settings); });
    for (const client of this.clients) this.send(client);
    return this.current();
  }
  send(response) {
    if (response.destroyed || response.writableEnded) return;
    if (response.writableLength > 64 * 1024) return response.destroy();
    response.write(`event: notification-settings\ndata: ${JSON.stringify(this.current())}\n\n`);
  }
  subscribe(response) {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
    response.flushHeaders(); this.clients.add(response); this.send(response);
    const heartbeat = setInterval(() => {
      if (response.writableLength > 64 * 1024) response.destroy();
      else response.write(': heartbeat\n\n');
    }, 15000);
    heartbeat.unref();
    response.once('close', () => { clearInterval(heartbeat); this.clients.delete(response); });
  }
  close() { for (const client of this.clients) client.destroy(); }
}
