import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { check, hash, secret } from './security.mjs';
import { VoiceSession } from './voice-session.mjs';

export class Voice {
  constructor({ config, speech, synthesis, hostCall, auth, connections }) {
    Object.assign(this, { config, speech, synthesis, hostCall, auth, connections });
    this.tickets = new Map(); this.sessions = new Map();
    this.websockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false,
      handleProtocols: protocols => [...protocols].find(value => value.startsWith('xai-client-secret.')) ?? false });
  }
  issue(deviceId, agentId, origin, audioProcessing) {
    this.config.resolveSynthesisConfig();
    check(this.speech.publicConfig().enabled, 503, 'Speech recognition is not configured');
    for (const [key, item] of this.tickets) if (item.expiresAt <= Date.now() || item.deviceId === deviceId) this.tickets.delete(key);
    check(this.tickets.size < 64, 429, 'Too many pending voice sessions');
    const clientSecret = secret(), expiresAt = Date.now() + 60_000;
    const bufferedBargeIn = audioProcessing === 'native-aec3-buffered-v1';
    const clientAEC = bufferedBargeIn || ['native-aec-v1', 'native-aec3-v1'].includes(audioProcessing);
    const bargeInMs = audioProcessing === 'native-aec3-v1' ? 240 : 400;
    this.tickets.set(hash(clientSecret), { deviceId, agentId, origin, expiresAt, clientAEC, bargeInMs, bufferedBargeIn, callId: randomUUID() });
    const websocketUrl = new URL('/local/voice/realtime', origin); websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    return { clientSecret, websocketUrl: websocketUrl.href, model: 'host-configured', expiresAtUnixSeconds: Math.floor(expiresAt / 1000) };
  }
  upgrade(request, socket, head) {
    const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(item => item.trim());
    const credentials = protocols.filter(item => /^xai-client-secret\.[A-Za-z0-9_-]{43}$/.test(item));
    check(credentials.length === 1, 401, 'Voice credential is required');
    const key = hash(credentials[0].slice('xai-client-secret.'.length)), ticket = this.tickets.get(key);
    const device = ticket && this.auth.device(ticket.deviceId);
    check(ticket && ticket.expiresAt > Date.now() && device, 401, 'Voice credential expired');
    const localDesktop = device.platform === 'desktop' && ['null', 'file://'].includes(request.headers.origin);
    check(!request.headers.origin || request.headers.origin === ticket.origin || localDesktop, 403, 'Voice origin does not match');
    check(this.sessions.size < 4 && !this.sessions.has(ticket.deviceId), 409, 'A voice call is already active');
    this.config.resolveSynthesisConfig();
    this.tickets.delete(key);
    this.websockets.handleUpgrade(request, socket, head, ws => {
      this.connections.track(ticket.deviceId, socket);
      const session = new VoiceSession({ ...ticket, ws, speech: this.speech, synthesis: this.synthesis, hostCall: this.hostCall,
        onClose: () => this.sessions.delete(ticket.deviceId) });
      this.sessions.set(ticket.deviceId, session);
    });
  }
  async close() {
    this.tickets.clear();
    const pending = [...this.sessions.values()].map(session => { const promise = session.close('disconnected'); session.ws.terminate(); return promise; });
    await Promise.race([Promise.allSettled(pending), new Promise(resolve => { const timer = setTimeout(resolve, 3000); timer.unref(); })]);
    this.websockets.close();
  }
}
