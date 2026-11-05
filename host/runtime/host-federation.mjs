import { createTaskBridge } from './federation-task-bridge.mjs';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { peerAddress } from '../server/federation-identity.mjs';

/** Preserve the original SendToAgent and background wake; replace only remote transport. */
export async function startLocalFederation(context, { call, interval = 1500, extensions = id => context.deps[id] } = {}) {
  if (!call) {
    const configured = process.env.GROKBOT_FEDERATION_URL ?? process.env.GROKBOT_NOTIFICATION_URL;
    if (configured && process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE) {
      const base = new URL(configured), token = (await readFile(process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE, 'utf8')).trim();
      call = async (method, body = {}) => {
        const response = await fetch(new URL(`/internal/federation/${method}`, base), { method: 'POST', redirect: 'error',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error ?? `Federation service: ${response.status}`); return result;
      };
    }
  }
  const worker = randomUUID(), unsettled = new Map();
  const tasks = call ? createTaskBridge(context, call, worker, { transcript: () => extensions('transcript'), extensions }) : null;
  let peers = [], stopped = false, ready = false, suspended = false, busy = false, pendingFinish, activeId;
  const refresh = async () => { if (call) { const snapshot = await call('snapshot'); peers = snapshot.peers; tasks?.setRole(snapshot.role ?? 'primary'); } };
  async function tick() {
    if (!call || stopped || !ready || suspended || busy) return;
    busy = true;
    try {
      if (pendingFinish) { await tasks?.finish(pendingFinish.state); await call('finish', pendingFinish); pendingFinish = null; activeId = null; }
      await refresh();
      const execution = extensions('turn-execution');
      if (!await execution.isRunReady() || stopped || suspended) return;
      const message = await call('claim', { worker });
      if (!message || stopped || activeId === message.id) return;
      activeId = message.id;
      let result = 'interrupted', detail = '';
      if (await execution.isRunReady() && !suspended) {
        try {
          await tasks?.begin(message);
          await extensions('transcript').backgroundWakes.agentToAgent.runAgentInboundWake(message.toAgentId, [{
            from: message.from, text: message.text, timestampMs: message.receivedAt,
            localExternalDelivery: true, localCompletion: (state, error) => { result = state; detail = String(error?.message ?? '').slice(0, 500); },
          }]);
        } catch (error) { result = 'failed'; detail = String(error?.message ?? error).slice(0, 500); }
      }
      pendingFinish = { worker, id: message.id, peerId: message.peerId, state: result, detail };
      await tasks?.finish(result);
      await call('finish', pendingFinish); pendingFinish = null; activeId = null;
    } catch (error) { if (!stopped) context.host.log(`[federation] ${error.message}`); }
    finally { busy = false; }
  }
  const api = {
    isEnabled: () => peers.some(peer => peer.enabled),
    directory: agentId => peers.filter(peer => peer.enabled && peer.allowedBots.includes(agentId)).flatMap(peer => peer.remoteBots.map(bot => ({
      id: peerAddress(peer.id, bot.id), name: `${bot.name} @ ${peer.name}`, description: bot.description,
    }))),
    async sendToRemoteAgent(args) {
      if (!call) return { delivered: false, target: null, ack: 'No remote Hosts are paired.' };
      const key = JSON.stringify([args.fromAgentId, args.toAgentId, args.text]), messageId = unsettled.get(key) ?? randomUUID();
      try { const result = await call('send', { ...args, messageId }); unsettled.delete(key); return result; }
      catch (error) {
        unsettled.set(key, messageId); if (unsettled.size > 64) unsettled.delete(unsettled.keys().next().value);
        return { delivered: false, target: null, ack: `Message was not accepted: ${error.message}` };
      }
    },
    requestTemporalMemberTurn: async () => { throw new Error('Remote group turns are disabled'); },
    receiveRoomMemberTurnResult: async () => {}, cancelTemporalMemberTurns() {},
    tick, refresh, suspend() { suspended = true; }, resume() { suspended = false; void tick(); },
    close() { stopped = true; clearInterval(timer); tasks?.close(); },
  };
  const timer = setInterval(() => void tick(), interval); timer.unref();
  context.onStop(api.close);
  void context.host.whenBackgroundWorkReady.then(() => { ready = true; void tick(); });
  return api;
}
