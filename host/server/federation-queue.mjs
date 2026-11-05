import { randomUUID } from 'node:crypto';
import { check, hash } from './security.mjs';
import { peerAddress } from './federation-identity.mjs';

const finished = new Set(['completed', 'failed', 'interrupted', 'revoked', 'expired']);
const UUID = /^[a-f0-9-]{36}$/;
const digest = value => hash(JSON.stringify([value.id, value.fromAgentId, value.toAgentId, value.text, value.createdAt]));
export const messageView = ({ text, ...message }) => message;
export function cleanupMessages(state, now) {
  state.messages = state.messages.filter(message => !finished.has(message.state) || (message.finishedAt ?? message.createdAt) > now - 30 * 86400000);
  check(state.messages.length < 10000, 429, 'Message history limit reached');
  for (const message of state.messages) if (!finished.has(message.state) && (message.direction === 'outbound' || message.state === 'queued') && now - message.createdAt > 7 * 86400000) {
    message.state = 'expired'; message.finishedAt = now; delete message.text;
  }
}
export function enqueueOutgoing(state, peer, { fromAgentId, toAgentId, text, messageId = randomUUID() }, now) {
  check(peer.enabled && peer.allowedBots.includes(fromAgentId), 403, 'This Bot cannot contact that Host');
  const target = peer.remoteBots.find(bot => bot.id === toAgentId); check(target, 403, 'Remote Bot is not shared');
  check(typeof text === 'string' && text.trim().length > 0 && text.length <= 8000 && UUID.test(messageId), 400, 'Invalid Bot message');
  const old = state.messages.find(message => message.direction === 'outbound' && message.peerId === peer.id && message.id === messageId);
  if (old) { check(old.fromAgentId === fromAgentId && old.toAgentId === toAgentId && old.textDigest === hash(text), 409, 'Message ID was reused'); return old; }
  cleanupMessages(state, now);
  check(state.messages.filter(message => !finished.has(message.state)).length < 1000, 429, 'Message queue full');
  const message = { id: messageId, direction: 'outbound', peerId: peer.id, fromAgentId, toAgentId, text, textDigest: hash(text),
    targetName: target.name, createdAt: now, state: 'queued' };
  message.digest = digest(message); state.messages.push(message); return message;
}
export function receiveMessages(state, peer, input, now) {
  check(Array.isArray(input) && input.length <= 20, 400, 'Invalid message batch');
  const accepted = [];
  for (const item of input) {
    check(item && UUID.test(item.id) && typeof item.text === 'string' && item.text.length > 0 && item.text.length <= 8000
      && Number.isSafeInteger(item.createdAt) && item.createdAt <= now + 300000 && item.createdAt >= now - 7 * 86400000, 400, 'Invalid Bot message');
    check(peer.allowedBots.includes(item.toAgentId) && peer.remoteBots.some(bot => bot.id === item.fromAgentId), 403, 'Bot access denied');
    const fingerprint = digest(item), old = state.messages.find(message => message.direction === 'inbound' && message.peerId === peer.id && message.id === item.id);
    if (old) { check(old.digest === fingerprint, 409, 'Message ID was reused'); accepted.push(messageView(old)); continue; }
    cleanupMessages(state, now);
    check(state.messages.filter(message => !finished.has(message.state)).length < 1000, 429, 'Message queue full');
    const sender = peer.remoteBots.find(bot => bot.id === item.fromAgentId);
    const message = { id: item.id, direction: 'inbound', peerId: peer.id, fromAgentId: item.fromAgentId, toAgentId: item.toAgentId,
      from: { id: peerAddress(peer.id, item.fromAgentId), name: `${sender.name} @ ${peer.name}` },
      text: item.text, digest: fingerprint, createdAt: item.createdAt, receivedAt: now, state: 'queued' };
    state.messages.push(message); accepted.push(messageView(message));
  }
  return accepted;
}
export function acknowledgeMessages(state, peer, acknowledgements, now) {
  check(Array.isArray(acknowledgements) && acknowledgements.length <= 100, 400, 'Invalid acknowledgements');
  for (const ack of acknowledgements) {
    const message = state.messages.find(item => item.direction === 'outbound' && item.peerId === peer.id && item.id === ack.id);
    if (!message) continue;
    check(ack.digest === message.digest && ['queued', 'running', 'completed', 'failed', 'interrupted', 'revoked', 'expired'].includes(ack.state), 409, 'Invalid delivery acknowledgement');
    if (finished.has(message.state)) continue;
    if (message.state === 'running' && ack.state === 'queued') continue;
    message.state = ack.state === 'queued' ? 'accepted' : ack.state; message.updatedAt = now;
    if (finished.has(message.state)) { message.finishedAt = now; delete message.text; }
  }
}
export function outgoingBatch(state, peer) {
  return state.messages.filter(message => message.direction === 'outbound' && message.peerId === peer.id
    && message.state === 'queued' && peer.allowedBots.includes(message.fromAgentId) && peer.remoteBots.some(bot => bot.id === message.toAgentId))
    .slice(0, 20).map(({ id, fromAgentId, toAgentId, text, createdAt }) => ({ id, fromAgentId, toAgentId, text, createdAt }));
}
export function incomingAcks(state, peer, requested = []) {
  const records = state.messages.filter(message => message.direction === 'inbound' && message.peerId === peer.id);
  const requestedSet = new Set(requested);
  // Explicit status requests prevent a long backlog from starving old completion acknowledgements.
  return [...records.filter(message => requestedSet.has(message.id)), ...records.slice(-50)]
    .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index).slice(0, 100)
    .map(({ id, state, digest }) => ({ id, state, digest }));
}
export function pendingStatus(state, peer) {
  return state.messages.filter(message => message.direction === 'outbound' && message.peerId === peer.id && ['accepted', 'running'].includes(message.state)).slice(0, 50).map(message => message.id);
}
