import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const supported = new Set(['text', 'widget', 'auto-review-approval', 'local-tool-permission']);

/** The original transcript and original cards are used on both ends. */
export function createTaskBridge(context, call, worker, { transcript, extensions }) {
  let role = 'primary', running, busy = false, closed = false;
  const tm = transcript;
  const controls = new Map();
  async function capture() {
    if (!running || !tm()?.getAgentTranscript) return;
    const job = running;
    const status = await call('task-state', { peerId: job.peerId, id: job.id });
    if (status.state === 'revoked') { running = null; return; }
    for (const entry of await tm().getAgentTranscript(job.toAgentId)) {
      if (entry.kind !== 'send-message' || !supported.has(entry.message?.type) || job.baseline.has(entry.id)) continue;
      const fingerprint = hash(entry); if (job.sent.get(entry.id) === fingerprint) continue;
      await call('event', { worker, peerId: job.peerId, id: job.id, entry }); job.sent.set(entry.id, fingerprint);
    }
  }
  async function tick() {
    if (closed || busy || !tm()?.applyLocalFederationEntry) return;
    busy = true;
    try {
      try { await capture(); } catch (error) { context.host.log(`[federation-task] ${error.message}`); }
      const updates = await call('updates');
      for (const update of updates) await tm().applyLocalFederationEntry(update.agentId, update.entry);
      if (updates.length) await call('updates-ack', { items: updates.map(({ key, revision, peerId }) => ({ key, revision, peerId })) });
      for (const control of await call('controls')) {
        let result = controls.get(control.id);
        if (!result) {
          result = { id: control.id, peerId: control.peerId, error: '' }; controls.set(control.id, result);
          try {
            const args = control.args;
            // Cancellation is also applied to a queued task before it can run.
            if (control.method === 'interruptAgentRun') await tm().interruptAgentRun(args.id);
            else if (control.method === 'resolveAutoReviewApproval') await extensions('auto-review').resolveApproval(args);
            else if (control.method === 'resolveLocalToolPermission') await extensions('local-tool-permission').resolveAsk(args);
            else if (control.method === 'respondToWidget') await tm().respondToWidget(args.entryId, args.value, args.agentId);
            else if (control.method === 'dismissWidget') await tm().dismissWidget(args);
          } catch (error) { result.error = String(error.message).slice(0, 200); }
        }
        await call('controls-ack', result);
        if (controls.size > 200) controls.delete(controls.keys().next().value);
      }
    } catch (error) { if (!closed) context.host.log(`[federation-task] ${error.message}`); }
    finally { busy = false; }
  }
  const timer = setInterval(() => void tick(), 1000); timer.unref();
  return {
    setRole(value) { role = value; },
    async begin(message) {
      if (role !== 'member') return;
      const entries = tm()?.getAgentTranscript ? await tm().getAgentTranscript(message.toAgentId) : [];
      running = { ...message, baseline: new Set(entries.map(x => x.id)), sent: new Map() };
    },
    async finish(state) {
      await capture();
      if (running && tm()?.applyLocalFederationEntry && state !== 'completed') {
        await call('event', { worker, peerId: running.peerId, id: running.id, entry: { id: 'task-result', kind: 'send-message', timestampMs: Date.now(), message: { type: 'text', content: state === 'failed' ? '成员任务失败 / Member task failed.' : '成员任务已中断 / Member task interrupted.' } } });
      }
      running = null;
    },
    tick, close() { closed = true; clearInterval(timer); },
  };
}
