import { mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** One Host owns this store. Publish durable state before exposing a handoff. */
export class HandoffStore {
  constructor(directory) {
    if (!directory) throw new Error('A persistent handoff directory is required');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = directory;
    this.filename = join(directory, 'pending-box-handoffs.json');
    let saved;
    try { saved = JSON.parse(readFileSync(this.filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (saved && (saved.version !== 1 || !Array.isArray(saved.entries))) throw new Error('Invalid handoff store');
    this.entries = new Map(saved?.entries ?? []);
    for (const [agentId, entry] of this.entries) {
      if (typeof agentId !== 'string' || typeof entry?.requestId !== 'string' || typeof entry?.instruction !== 'string') {
        throw new Error('Invalid persisted handoff');
      }
    }
  }
  save(entries) {
    const temporary = `${this.filename}.${process.pid}.tmp`;
    let fd;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, entries: [...entries] }), { mode: 0o600 });
      fd = openSync(temporary, 'r'); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, this.filename);
      fd = openSync(this.directory, 'r'); fsyncSync(fd); closeSync(fd); fd = undefined;
      this.entries = new Map(entries);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }
}

/** Reconcile durable service state with legacy SQLite card/badge state at Host startup. */
export async function restoreHandoffsFromSessions(handoff, sessionStore, openDatabase) {
  const agentIds = new Set(await sessionStore.listAgentRecordIds());
  for (const agentId of handoff.pending.keys()) {
    if (!agentIds.has(agentId) || !sessionStore.agentExists(agentId)) handoff.forget(agentId);
  }
  const restored = [], cleared = [];
  for (const agentId of agentIds) {
    if (!sessionStore.agentExists(agentId)) continue;
    const db = openDatabase(join(sessionStore.getAgentDir(agentId), 'store.db'));
    try {
      const awaiting = db.getAwaitingUserResponse();
      let pending = handoff.get(agentId);
      if (pending == null && awaiting?.tabId === 'box') {
        // Only the newest box request is eligible. An older unresolved card may
        // precede a later request that has already been handed back.
        const latest = db.getTranscriptEntries().findLast(entry => typeof entry.boxRequestId === 'string');
        if (latest && latest.boxResolution == null) {
          pending = { requestId: latest.boxRequestId, instruction: latest.boxInstruction ?? awaiting.reason };
          handoff.restore(agentId, pending);
          restored.push(agentId);
        } else {
          db.setAwaitingUserResponseForTab('box', null);
          cleared.push(agentId);
        }
      }
      if (pending != null) {
        // A failed end callback can already have cleared the badge. Restore it,
        // while leaving an existing badge owned by another feature unchanged.
        db.setAwaitingUserResponseForTab('box', {
          tabId: 'box', reason: pending.instruction,
          since: awaiting?.tabId === 'box' ? awaiting.since : Date.now(),
        });
      }
    } finally { db.close(); }
  }
  return { restored, cleared };
}
