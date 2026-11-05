import { join } from 'node:path';
import { JsonStore } from './storage.mjs';
import { check } from './security.mjs';

export const defaultHarnessSettings = Object.freeze({ dreaming: false, browserUse: true, userForm: true,
  browserLoginImport: true, passkeys: true, macComputer: true, teachTask: true });
export function validateHarnessSettings(input) {
  const next = {};
  for (const [key, fallback] of Object.entries(defaultHarnessSettings)) {
    check(input[key] === undefined || typeof input[key] === 'boolean', 400, `Invalid ${key}`);
    next[key] = input[key] ?? fallback;
  }
  return next;
}
export class HarnessSettings {
  constructor(directory) { this.store = new JsonStore(join(directory, 'harness-settings.json'),
    { version: 1, settings: { ...defaultHarnessSettings } }); }
  async load() { await this.store.load(); return this; }
  current() { return validateHarnessSettings(this.store.value.settings); }
  async save(input) {
    const settings = validateHarnessSettings(input);
    await this.store.mutate(state => { state.settings = settings; });
    return this.current();
  }
}
