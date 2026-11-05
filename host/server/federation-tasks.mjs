import { createHash } from 'node:crypto';
import { check } from './security.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active = new Set(['queued', 'accepted', 'running']);
const cardMethods = {
  'auto-review-approval': ['resolveAutoReviewApproval'],
  'local-tool-permission': ['resolveLocalToolPermission'],
  widget: ['respondToWidget', 'dismissWidget'],
};
export const taskControlMethods = new Set(['interruptAgentRun', ...Object.values(cardMethods).flat()]);
const task = (state, peerId, id, direction) => state.messages.find(m => m.peerId === peerId && m.id === id && m.direction === direction);
function initialize(state) { state.taskUpdates ??= []; state.taskControls ??= []; }
export function taskEntryId(peerId, jobId, entryId) { return `remote-${digest([peerId, jobId, entryId]).slice(0, 40)}`; }
export function mappedEntry(update) {
  const entry = structuredClone(update.entry), mapping = {};
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'id' || key === 'reply_to' || key.endsWith('Id')) && typeof child === 'string') {
        const local = taskEntryId(update.peerId, update.jobId, child); mapping[local] = child; value[key] = local;
      } else walk(child);
    }
  }
  walk(entry); return { entry, mapping };
}
function validEntry(entry) {
  check(entry?.kind === 'send-message' && typeof entry.id === 'string' && entry.id.length < 256 &&
    ['text', ...Object.keys(cardMethods)].includes(entry.message?.type) && JSON.stringify(entry).length <= 64000, 400, 'Invalid task update');
}
export function publishTaskEntry(state, { worker, peerId, id, entry }, now) {
  initialize(state); const message = task(state, peerId, id, 'inbound');
  check(message?.worker === worker && ['running', 'completed', 'interrupted', 'failed'].includes(message.state), 409, 'Task owner changed');
  validEntry(entry);
  const key = digest([peerId, id, entry.id]), fingerprint = digest(entry);
  let update = state.taskUpdates.find(x => x.direction === 'outbound' && x.key === key);
  if (update?.fingerprint === fingerprint) return;
  if (!update) { check(state.taskUpdates.length < 10000, 429, 'Task update queue full'); update = { key, peerId, jobId: id, direction: 'outbound', revision: 0 }; state.taskUpdates.push(update); }
  Object.assign(update, { revision: update.revision + 1, entry, fingerprint, updatedAt: now, acknowledged: false });
}
export function taskExchange(state, peer) {
  initialize(state);
  return {
    updates: state.taskUpdates.filter(x => x.peerId === peer.id && x.direction === 'outbound' && !x.acknowledged).slice(0, 5).map(({ key, jobId, revision, entry }) => ({ key, jobId, revision, entry })),
    updateAcks: state.taskUpdates.filter(x => x.peerId === peer.id && x.direction === 'inbound').sort((a, b) => (b.receivedAt ?? b.updatedAt) - (a.receivedAt ?? a.updatedAt)).slice(0, 200).map(({ key, revision }) => ({ key, revision })),
    controls: state.taskControls.filter(x => x.peerId === peer.id && x.direction === 'outbound' && !x.acknowledged).slice(0, 20),
    controlAcks: state.taskControls.filter(x => x.peerId === peer.id && x.direction === 'inbound' && x.settled).sort((a, b) => (b.receivedAt ?? b.createdAt) - (a.receivedAt ?? a.createdAt)).slice(0, 200).map(({ id, error }) => ({ id, error })),
  };
}
export function receiveTaskExchange(state, peer, body, now) {
  initialize(state);
  for (const key of ['updates', 'updateAcks', 'controls', 'controlAcks']) check(body[key] === undefined || Array.isArray(body[key]) && body[key].length <= 200, 400, 'Invalid task exchange');
  check(!(body.updates?.length) || (state.role ?? 'primary') === 'primary', 403, 'Only the primary receives task updates');
  check(!(body.controls?.length) || state.role === 'member' && state.primaryId === peer.id, 403, 'Only the primary controls member tasks');
  for (const value of body.updates ?? []) {
    const message = task(state, peer.id, value.jobId, 'outbound');
    check(message && peer.allowedBots.includes(message.fromAgentId), 403, 'Task scope denied'); validEntry(value.entry);
    check(value.key === digest([state.identity.id, value.jobId, value.entry.id]) && Number.isSafeInteger(value.revision) && value.revision > 0, 400, 'Invalid task revision');
    let update = state.taskUpdates.find(x => x.key === value.key && x.peerId === peer.id && x.direction === 'inbound');
    if (update && update.revision >= value.revision) { update.receivedAt = now; continue; }
    if (!update) { check(state.taskUpdates.length < 10000, 429, 'Task update queue full'); update = {}; state.taskUpdates.push(update); }
    Object.assign(update, value, { peerId: peer.id, direction: 'inbound', agentId: message.fromAgentId, delivered: false, updatedAt: now, receivedAt: now });
  }
  for (const ack of body.updateAcks ?? []) {
    const update = state.taskUpdates.find(x => x.peerId === peer.id && x.direction === 'outbound' && x.key === ack.key && x.revision === ack.revision);
    if (update) update.acknowledged = true;
  }
  for (const control of body.controls ?? []) {
    const message = task(state, peer.id, control.jobId, 'inbound');
    check(message && peer.allowedBots.includes(message.toAgentId) && taskControlMethods.has(control.method), 403, 'Task control denied');
    check(control.id === digest([control.jobId, control.method, control.args]), 400, 'Invalid task control ID');
    const prior = state.taskControls.find(x => x.direction === 'inbound' && x.id === control.id && x.peerId === peer.id);
    if (prior) { prior.receivedAt = now; continue; }
    if (!active.has(message.state)) {
      state.taskControls.push({ id: control.id, jobId: control.jobId, peerId: peer.id, direction: 'inbound', settled: true, error: 'Task is no longer running', createdAt: now }); continue;
    }
    if (control.method === 'interruptAgentRun' && message.state === 'queued') {
      message.state = 'interrupted'; message.finishedAt = now; delete message.text;
      state.taskControls.push({ id: control.id, jobId: control.jobId, peerId: peer.id, direction: 'inbound', settled: true, error: '', createdAt: now }); continue;
    }
    // Approval controls must refer to a card this task actually emitted.
    if (control.method !== 'interruptAgentRun') {
      const card = state.taskUpdates.find(x => x.peerId === peer.id && x.jobId === control.jobId && x.direction === 'outbound' && x.entry.id === control.args.entryId);
      check(card && cardMethods[card.entry.message.type]?.includes(control.method), 403, 'Task approval scope denied');
      if (control.method === 'resolveAutoReviewApproval') check(control.args.requestId === card.entry.message.approval?.requestId, 403, 'Approval request mismatch');
      if (control.method === 'resolveLocalToolPermission') check(control.args.requestId === card.entry.message.ask?.requestId, 403, 'Permission request mismatch');
    }
    const args = { ...control.args, ...(control.method === 'interruptAgentRun' ? { id: message.toAgentId } : { agentId: message.toAgentId }) };
    state.taskControls.push({ id: control.id, jobId: control.jobId, peerId: peer.id, method: control.method, args, direction: 'inbound', settled: false, createdAt: now });
  }
  for (const ack of body.controlAcks ?? []) {
    const control = state.taskControls.find(x => x.peerId === peer.id && x.direction === 'outbound' && x.id === ack.id);
    if (control) { control.acknowledged = true; control.error = typeof ack.error === 'string' ? ack.error.slice(0, 200) : ''; }
  }
  state.taskUpdates = state.taskUpdates.filter(x => x.updatedAt > now - 30 * 86400000);
  state.taskControls = state.taskControls.filter(x => x.createdAt > now - 30 * 86400000);
}
export function enqueueTaskControl(state, method, args, now) {
  initialize(state); const agentId = args.agentId ?? args.id;
  if (method === 'interruptAgentRun') {
    for (const job of state.messages.filter(x => x.direction === 'outbound' && x.fromAgentId === agentId && active.has(x.state))) add(job, { id: job.toAgentId });
    return false; // Also interrupt the primary's local run.
  }
  const update = state.taskUpdates.find(x => x.direction === 'inbound' && x.agentId === agentId && mappedEntry(x).entry.id === args.entryId);
  if (!update) return false;
  const job = task(state, update.peerId, update.jobId, 'outbound');
  check(job && state.peers.some(p => p.id === job.peerId && p.enabled && p.allowedBots.includes(agentId)), 403, 'Member access revoked');
  check(cardMethods[update.entry.message.type]?.includes(method), 403, 'Invalid approval action');
  const { mapping } = mappedEntry(update);
  const remoteArgs = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === 'string' ? mapping[value] ?? value : value]));
  remoteArgs.agentId = job.toAgentId; add(job, remoteArgs); return true;
  function add(job, values) {
    const id = digest([job.id, method, values]);
    if (!state.taskControls.some(x => x.id === id && x.peerId === job.peerId && x.direction === 'outbound'))
      state.taskControls.push({ id, jobId: job.id, peerId: job.peerId, method, args: values, direction: 'outbound', acknowledged: false, createdAt: now });
  }
}
export async function taskInternal(federation, method, input) {
  const { store, now } = federation;
  if (method === 'event') return store.mutate(state => { publishTaskEntry(state, input, now()); return { ok: true }; });
  if (method === 'task-state') return { state: task(store.value, input.peerId, input.id, 'inbound')?.state };
  if (method === 'updates') return (store.value.taskUpdates ?? []).filter(x => x.direction === 'inbound' && !x.delivered && store.value.peers.some(p => p.id === x.peerId && p.enabled)).slice(0, 20).map(x => ({ key: x.key, revision: x.revision, peerId: x.peerId, agentId: x.agentId, entry: mappedEntry(x).entry }));
  if (method === 'updates-ack') return store.mutate(state => { for (const item of input.items ?? []) { const x = state.taskUpdates.find(x => x.direction === 'inbound' && x.peerId === item.peerId && x.key === item.key && x.revision === item.revision); if (x) x.delivered = true; } return { ok: true }; });
  if (method === 'controls') return [...store.value.messages.filter(x => x.direction === 'inbound' && x.cancelRequested).map(x => ({ id: `revoke-${x.id}`, peerId: x.peerId, method: 'interruptAgentRun', args: { id: x.toAgentId } })), ...(store.value.taskControls ?? []).filter(x => x.direction === 'inbound' && !x.settled && store.value.peers.some(p => p.id === x.peerId && p.enabled) && active.has(task(store.value, x.peerId, x.jobId, 'inbound')?.state))].slice(0, 20);
  if (method === 'controls-ack') return store.mutate(state => { const revoked = state.messages.find(x => x.peerId === input.peerId && `revoke-${x.id}` === input.id); if (revoked) revoked.cancelRequested = false; const x = state.taskControls.find(x => x.direction === 'inbound' && x.peerId === input.peerId && x.id === input.id); if (x) { x.settled = true; x.error = String(input.error ?? '').slice(0, 200); } return { ok: true }; });
  check(false, 404, 'Unknown task operation');
}
