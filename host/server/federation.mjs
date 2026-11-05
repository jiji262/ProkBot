import { taskExchange, receiveTaskExchange, enqueueTaskControl } from './federation-tasks.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { JsonStore } from './storage.mjs';
import { check, equal, secret, hash, HttpError } from './security.mjs';
import { createIdentity, federationUrl, peerAddress, parsePeerAddress, signedEnvelope, validateIdentity, verifyEnvelope } from './federation-identity.mjs';
import { enqueueOutgoing, receiveMessages, acknowledgeMessages, outgoingBatch, incomingAcks, pendingStatus, messageView, cleanupMessages } from './federation-queue.mjs';

const botIds = value => { check(Array.isArray(value) && value.length <= 100 && value.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)), 400, 'Select valid Bots'); return [...new Set(value)]; };
const bots = value => {
  check(Array.isArray(value) && value.length <= 100, 400, 'Invalid Bot directory');
  return value.map(item => { botIds([item.id]); check(typeof item.name === 'string' && item.name.length <= 120 && typeof item.description === 'string' && item.description.length <= 1000, 400, 'Invalid Bot directory');
    return { id: item.id, name: item.name.replace(/[\r\n\x00-\x1f]/g, ' '), description: item.description }; });
};
const name = value => { check(typeof value === 'string' && value.trim().length > 0 && value.length <= 100, 400, 'Invalid Host name'); return value.trim().replace(/[\r\n\x00-\x1f]/g, ' '); };
const publicPeer = ({ publicKey, ...peer }) => peer;

export class Federation {
  constructor(directory, { hostCall, profile, network, now = Date.now, fetchImpl = fetch } = {}) {
    this.store = new JsonStore(join(directory, 'federation.json'), { version: 1, identity: null,
      role: 'primary', primaryId: null, taskUpdates: [], taskControls: [], url: '', privateNetwork: false, peers: [], invitations: [], messages: [], worker: null });
    Object.assign(this, { hostCall, profile, network, now, fetchImpl }); this.inFlight = new Map(); this.stopped = false; this.lifetime = new AbortController();
  }
  async load() {
    await this.store.load();
    if (!this.store.value.identity) await this.store.mutate(state => { state.identity = createIdentity(); });
    validateIdentity(this.store.value.identity);
    return this;
  }
  role() { return this.store.value.role ?? 'primary'; }
  identity() { const { id, publicKey } = this.store.value.identity; return { id, publicKey, name: this.profile?.current().hostName ?? 'Grok Bot Host', url: this.store.value.url }; }
  publicConfig() { return { role: this.role(), primaryId: this.store.value.primaryId ?? null, identity: this.identity(), url: this.store.value.url, privateNetwork: this.store.value.privateNetwork,
    peers: this.store.value.peers.map(publicPeer), messages: this.store.value.messages.slice(-200).reverse().map(messageView) }; }
  async save(input) {
    check(!input.role || ['primary', 'member'].includes(input.role), 400, 'Invalid Host role');
    if (input.role && input.role !== this.role()) {
      check(input.role === 'primary' && !this.store.value.peers.some(p => p.enabled), 409, 'Disconnect the current group before changing role');
      await this.store.mutate(state => { state.role = 'primary'; state.primaryId = null; });
      this.onRoleChange?.();
    }
    const privateNetwork = input.privateNetwork === true, url = federationUrl(input.url, privateNetwork, true);
    await this.store.mutate(state => { state.url = url; state.privateNetwork = privateNetwork; }); return this.publicConfig();
  }
  async exported(ids) {
    const roster = await this.hostCall('listAgents', {});
    return roster.filter(bot => ids.includes(bot.id) && !bot.isGroup).map(bot => ({ id: bot.id, name: String(bot.name).slice(0, 120), description: String(bot.description ?? '').slice(0, 1000) }));
  }
  async createInvitation(input) {
    check(this.role() === 'primary', 403, 'Only the primary Host can invite members');
    const allowedBots = botIds(input.allowedBots), visible = await this.exported(allowedBots);
    check(visible.length === allowedBots.length && visible.length > 0, 400, 'Select existing Bots');
    check(this.store.value.url, 400, 'Set this Host URL first');
    const token = secret(), id = randomUUID(), expiresAt = this.now() + 600000;
    await this.store.mutate(state => {
      state.invitations = state.invitations.filter(item => item.expiresAt > this.now()); check(state.invitations.length < 20, 429, 'Too many invitations');
      state.invitations.push({ id, tokenHash: hash(token), allowedBots, expiresAt, privateNetwork: state.privateNetwork });
    });
    return { version: 1, role: 'primary', purpose: 'member', ...this.identity(), invitationId: id, token, expiresAt, privateNetwork: this.store.value.privateNetwork, bots: visible };
  }
  async acceptInvitation({ invitation, allowedBots: selected, privateNetwork = false }) {
    check(!this.store.value.peers.some(p => p.enabled && p.id !== invitation?.id), 409, 'Disconnect the existing group before joining a primary Host');
    check(invitation?.role === 'primary' && invitation?.purpose === 'member', 400, 'A primary Host invitation is required');
    const remote = validateIdentity(invitation); name(invitation.name);
    check(invitation.version === 1 && typeof invitation.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(invitation.token)
      && /^[a-f0-9-]{36}$/.test(invitation.invitationId) && invitation.expiresAt > this.now(), 400, 'Invalid or expired invitation');
    check(remote.id !== this.identity().id, 400, 'Cannot pair a Host with itself');
    const url = federationUrl(invitation.url, privateNetwork), allowedBots = botIds(selected), visible = await this.exported(allowedBots);
    check(visible.length === allowedBots.length && visible.length > 0, 400, 'Select existing Bots');
    const envelope = signedEnvelope(this.store.value.identity, 'pair', {
      invitationId: invitation.invitationId, token: invitation.token, identity: this.identity(), bots: visible,
    }, { now: this.now() });
    const result = await this.post(url, '/federation/v1/pair', envelope);
    const body = verifyEnvelope(remote.publicKey, result, 'pair-result', { now: this.now(), nonce: envelope.payload.nonce });
    check(body.identity?.id === remote.id, 401, 'Pair response identity mismatch');
    const remoteBots = bots(body.bots);
    await this.store.mutate(state => {
      state.role = 'member'; state.primaryId = remote.id;
      const old = state.peers.find(peer => peer.id === remote.id);
      const peer = { id: remote.id, publicKey: remote.publicKey, name: name(body.identity.name), url, privateNetwork,
        allowedBots, remoteBots, enabled: true, pairedAt: this.now(), lastSyncAt: null, error: '' };
      if (old) Object.assign(old, peer); else { check(state.peers.length < 50, 409, 'Peer limit reached'); state.peers.push(peer); }
    });
    this.onRoleChange?.();
    return this.publicConfig();
  }
  async receivePair(envelope) {
    check(this.role() === 'primary', 403, 'This Host is a member');
    const identity = validateIdentity(envelope?.payload?.body?.identity);
    const body = verifyEnvelope(identity.publicKey, envelope, 'pair', { now: this.now() });
    const remoteBots = bots(body.bots), remoteName = name(body.identity.name);
    const invitation = this.store.value.invitations.find(item => item.id === body.invitationId);
    check(invitation && invitation.expiresAt > this.now() && typeof body.token === 'string' && equal(invitation.tokenHash, hash(body.token)), 401, 'Invitation expired or revoked');
    check(!invitation.acceptedBy || invitation.acceptedBy === identity.id, 409, 'Invitation already used');
    check(identity.id !== this.identity().id, 400, 'Cannot pair a Host with itself');
    const url = federationUrl(body.identity.url, invitation.privateNetwork, true), visible = await this.exported(invitation.allowedBots);
    await this.store.mutate(state => {
      const invite = state.invitations.find(item => item.id === body.invitationId);
      check(invite && invite.expiresAt > this.now() && (!invite.acceptedBy || invite.acceptedBy === identity.id), 401, 'Invitation already used');
      // A lost response can retry only for the same identity. It cannot alter the agreed permissions.
      const old = state.peers.find(peer => peer.id === identity.id);
      if (!invite.acceptedBy) {
        const peer = { id: identity.id, publicKey: identity.publicKey, name: remoteName, url, privateNetwork: invite.privateNetwork,
          allowedBots: [...invite.allowedBots], remoteBots, enabled: true, pairedAt: this.now(), lastSyncAt: null, error: '' };
        if (old) Object.assign(old, peer); else { check(state.peers.length < 50, 409, 'Peer limit reached'); state.peers.push(peer); }
        invite.acceptedBy = identity.id;
      } else check(old?.enabled, 403, 'Peer revoked');
    });
    return signedEnvelope(this.store.value.identity, 'pair-result', { identity: this.identity(), bots: visible }, { now: this.now(), nonce: envelope.payload.nonce });
  }
  async updatePeer(id, input) {
    const allowedBots = botIds(input.allowedBots), visible = await this.exported(allowedBots);
    check(visible.length === allowedBots.length, 400, 'Select existing Bots');
    const result = await this.store.mutate(state => {
      const peer = state.peers.find(peer => peer.id === id); check(peer, 404, 'Host not paired');
      Object.assign(peer, { allowedBots, enabled: input.enabled !== false, url: federationUrl(input.url, input.privateNetwork === true, true), privateNetwork: input.privateNetwork === true });
      peer.revokePending = !peer.enabled;
      for (const message of state.messages) if (message.peerId === id && ['queued', 'accepted', 'running'].includes(message.state)
        && (!peer.enabled || !allowedBots.includes(message.direction === 'outbound' ? message.fromAgentId : message.toAgentId))) {
        message.cancelRequested = message.direction === 'inbound' && message.state === 'running';
        message.state = 'revoked'; message.finishedAt = this.now(); delete message.text;
      }
      return publicPeer(peer);
    });
    void this.syncPeer(id); return result;
  }
  async receiveRevocation(envelope) {
    const peer = this.store.value.peers.find(p => p.id === envelope?.payload?.sender); check(peer, 403, 'Host not paired');
    verifyEnvelope(peer.publicKey, envelope, 'revoke', { now: this.now() });
    await this.store.mutate(state => {
      const current = state.peers.find(p => p.id === peer.id); current.enabled = false; current.revokePending = false;
      for (const message of state.messages) if (message.peerId === peer.id && ['queued', 'accepted', 'running'].includes(message.state)) {
        message.cancelRequested = message.direction === 'inbound' && message.state === 'running';
        message.state = 'revoked'; message.finishedAt = this.now(); delete message.text;
      }
    });
    return signedEnvelope(this.store.value.identity, 'revoke-result', { revoked: true }, { now: this.now(), nonce: envelope.payload.nonce });
  }
  directory(agentId) {
    return this.store.value.peers.filter(peer => peer.enabled && peer.allowedBots.includes(agentId)).flatMap(peer => peer.remoteBots.map(bot => ({
      id: peerAddress(peer.id, bot.id), name: `${bot.name} @ ${peer.name}`, description: bot.description,
    })));
  }
  async send(args) {
    check(!args.images?.length, 400, 'Remote Bot messages currently accept text');
    const { peerId, agentId } = parsePeerAddress(args.toAgentId);
    const message = await this.store.mutate(state => {
      const peer = state.peers.find(peer => peer.id === peerId); check(peer, 404, 'Host not paired');
      return enqueueOutgoing(state, peer, { ...args, toAgentId: agentId }, this.now());
    });
    void this.syncPeer(peerId).catch(() => {});
    return { delivered: true, target: { id: args.toAgentId, name: message.targetName },
      ack: `Queued for ${message.targetName}. Delivery is asynchronous; a reply arrives in this conversation. Message ID: ${message.id}`, messageId: message.id };
  }
  async post(url, path, envelope) {
    if (url.startsWith('tailcat:')) { check(this.network, 503, 'Tailcat is unavailable'); url = await this.network.resolve(url); }
    const response = await this.fetchImpl(new URL(path, url), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope), signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15000)]) });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status, `Remote Host HTTP ${response.status}`); }
    const chunks = []; let size = 0;
    for await (const bytes of response.body) { size += bytes.length; check(size <= 512 * 1024, 413, 'Remote response too large'); chunks.push(Buffer.from(bytes)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async applyExchange(peerId, body) {
    if (body.revoked === true) {
      await this.store.mutate(state => {
        const peer = state.peers.find(p => p.id === peerId); peer.enabled = false; peer.revokePending = false;
        for (const message of state.messages) if (message.peerId === peerId && ['queued', 'accepted', 'running'].includes(message.state)) {
          message.cancelRequested = message.direction === 'inbound' && message.state === 'running';
          message.state = 'revoked'; message.finishedAt = this.now(); delete message.text;
        }
      }); return;
    }
    const remoteBots = bots(body.bots); check(Array.isArray(body.statusIds) && body.statusIds.length <= 50, 400, 'Invalid status request');
    await this.store.mutate(state => {
      const peer = state.peers.find(peer => peer.id === peerId); check(peer?.enabled, 403, 'Host revoked');
      cleanupMessages(state, this.now()); peer.remoteBots = remoteBots;
      receiveMessages(state, peer, body.messages, this.now()); acknowledgeMessages(state, peer, body.acks, this.now());
      receiveTaskExchange(state, peer, body, this.now());
      peer.lastSyncAt = this.now(); peer.error = '';
    });
  }
  async exchangeBody(peerId, requested = []) {
    const peer = this.store.value.peers.find(peer => peer.id === peerId); check(peer?.enabled, 403, 'Host revoked');
    return { ...taskExchange(this.store.value, peer), bots: await this.exported(peer.allowedBots), messages: outgoingBatch(this.store.value, peer),
      acks: incomingAcks(this.store.value, peer, requested), statusIds: pendingStatus(this.store.value, peer) };
  }
  async receiveSync(envelope) {
    const peer = this.store.value.peers.find(peer => peer.id === envelope?.payload?.sender); check(peer, 403, 'Host not paired');
    const body = verifyEnvelope(peer.publicKey, envelope, 'sync', { now: this.now() });
    if (!peer.enabled) return signedEnvelope(this.store.value.identity, 'sync-result', { revoked: true }, { now: this.now(), nonce: envelope.payload.nonce });
    await this.applyExchange(peer.id, body);
    return signedEnvelope(this.store.value.identity, 'sync-result', await this.exchangeBody(peer.id, body.statusIds), { now: this.now(), nonce: envelope.payload.nonce });
  }
  syncPeer(id) {
    if (this.inFlight.has(id)) return this.inFlight.get(id);
    if (this.stopped) return Promise.resolve();
    const pending = this.syncOne(id).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, pending); return pending;
  }
  async syncOne(id) {
    const peer = this.store.value.peers.find(peer => peer.id === id); if (!peer?.url || !peer.enabled && !peer.revokePending) return;
    try {
      if (peer.revokePending) {
        const envelope = signedEnvelope(this.store.value.identity, 'revoke', {}, { now: this.now() });
        const response = await this.post(peer.url, '/federation/v1/revoke', envelope);
        verifyEnvelope(peer.publicKey, response, 'revoke-result', { now: this.now(), nonce: envelope.payload.nonce });
        await this.store.mutate(state => { const current = state.peers.find(p => p.id === id); current.revokePending = false; current.error = ''; });
        return;
      }
      if (this.store.value.messages.some(message => ['queued', 'accepted', 'running'].includes(message.state) && this.now() - message.createdAt > 7 * 86400000))
        await this.store.mutate(state => cleanupMessages(state, this.now()));
      const envelope = signedEnvelope(this.store.value.identity, 'sync', await this.exchangeBody(id), { now: this.now() });
      const response = await this.post(peer.url, '/federation/v1/sync', envelope);
      const body = verifyEnvelope(peer.publicKey, response, 'sync-result', { now: this.now(), nonce: envelope.payload.nonce });
      await this.applyExchange(id, body);
    } catch (error) {
      if (!this.stopped) await this.store.mutate(state => { const current = state.peers.find(item => item.id === id); if (current) current.error = String(error.message).slice(0, 200); });
    }
  }
  async claim(worker) {
    check(typeof worker === 'string' && /^[a-f0-9-]{36}$/.test(worker), 400, 'Invalid worker');
    if (this.store.value.worker === worker && !this.store.value.messages.some(message => message.direction === 'inbound' && ['queued', 'running'].includes(message.state))) return null;
    return this.store.mutate(state => {
      cleanupMessages(state, this.now());
      if (state.worker !== worker) {
        for (const message of state.messages) if (message.direction === 'inbound' && message.state === 'running') {
          message.state = 'interrupted'; message.finishedAt = this.now(); delete message.text;
        }
        state.worker = worker;
      }
      const message = state.messages.find(item => item.direction === 'inbound' && ['queued', 'running'].includes(item.state));
      if (!message) return null;
      const peer = state.peers.find(item => item.id === message.peerId);
      if (!peer?.enabled || !peer.allowedBots.includes(message.toAgentId)) { message.state = 'revoked'; message.finishedAt = this.now(); delete message.text; return null; }
      Object.assign(message, { state: 'running', worker, startedAt: message.startedAt ?? this.now() });
      return { ...message };
    });
  }
  async control(method, args) {
    const handled = await this.store.mutate(state => enqueueTaskControl(state, method, args, this.now()));
    for (const peer of this.store.value.peers) void this.syncPeer(peer.id);
    return handled;
  }
  async finish({ worker, id, peerId, state: result, detail = '' }) {
    check(['completed', 'failed', 'interrupted'].includes(result), 400, 'Invalid message result');
    await this.store.mutate(state => {
      const message = state.messages.find(item => item.direction === 'inbound' && item.id === id && item.peerId === peerId);
      check(message?.worker === worker, 409, 'Message owner changed');
      if (message.state !== 'running') return;
      message.state = result; message.finishedAt = this.now(); message.detail = String(detail).slice(0, 500); delete message.text;
    });
    void this.syncPeer(peerId).catch(() => {}); return { ok: true };
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { for (const peer of this.store.value.peers) void this.syncPeer(peer.id); }, 5000); this.timer.unref();
  }
  async close() { this.stopped = true; clearInterval(this.timer); this.lifetime.abort(); await Promise.allSettled(this.inFlight.values()); await this.store.tail; }
}
