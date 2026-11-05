import { randomUUID } from 'node:crypto';
import { VoiceActivity, decodeAudio, pcmWav } from './voice-audio.mjs';
import { createVoiceHostSession } from './voice-host.mjs';
import { check, RateLimit } from './security.mjs';
import { VoicePlayback } from './voice-playback.mjs';

/** Adapts the original client's realtime events to Host voice turns and configurable speech services. */
export class VoiceSession {
  constructor({ ws, speech, synthesis, hostCall, agentId, callId = randomUUID(), clientAEC = false, bargeInMs = 400, bufferedBargeIn = false, onClose }) {
    Object.assign(this, { ws, speech, synthesis, callId, clientAEC, bargeInMs, bufferedBargeIn, onClose });
    this.host = createVoiceHostSession({ hostCall, agentId, callId });
    this.closed = false; this.jobs = new Set(); this.limiter = new RateLimit(); this.playback = new Map();
    this.speaker = new VoicePlayback();
    this.alive = true;
    this.vad = new VoiceActivity({ onStart: event => this.speechStarted(event), onEnd: event => this.speechEnded(event),
      onDecision: event => { if (this.bufferedBargeIn && event.buffered) console.info('[voice-onset]', JSON.stringify({ callId, ...event })); } });
    ws.on('message', (bytes, binary) => {
      try { check(!binary, 400, 'Expected realtime JSON'); this.message(JSON.parse(bytes.toString())); }
      catch (error) { this.error(error); }
    });
    ws.on('pong', () => { this.alive = true; });
    ws.on('error', () => this.close('disconnected'));
    ws.on('close', () => this.close('disconnected'));
    this.heartbeat = setInterval(() => {
      if (!this.alive) { ws.terminate(); return; }
      this.alive = false; ws.ping();
    }, 30_000); this.heartbeat.unref();
    this.expiry = setTimeout(() => { this.error({ status: 408, message: 'Voice session has ended' }); ws.close(1000); }, 30 * 60_000);
    this.expiry.unref();
    this.emit('session.created', { session: this.description() });
    this.emit('conversation.created', { conversation: { id: callId, object: 'realtime.conversation' } });
  }
  description() {
    return { id: this.callId, object: 'realtime.session', model: 'host-configured',
      audio: { input: { format: { type: 'audio/pcm', rate: 24000 } }, output: { format: { type: 'audio/pcm', rate: 24000 } } },
      turn_detection: { type: 'server_vad', silence_duration_ms: 700 } };
  }
  emit(type, fields = {}) {
    if (this.closed || this.ws.readyState !== 1) return;
    if (this.ws.bufferedAmount > 2 * 1024 * 1024) { this.ws.close(1013, 'Audio receiver is too slow'); return; }
    this.ws.send(JSON.stringify({ type, event_id: randomUUID(), ...fields }));
  }
  error(error) {
    this.emit('error', { error: { type: 'server_error', code: String(error.status ?? 500),
      message: error.status ? error.message : 'Voice service unavailable' } });
  }
  message(event) {
    check(event && typeof event.type === 'string', 400, 'Invalid realtime event');
    this.limiter.check('frames', 200, 1000);
    switch (event.type) {
      case 'session.update': {
        const format = event.session?.audio?.input?.format;
        check(!format || (format.type === 'audio/pcm' && format.rate === 24000), 400, 'Voice requires 24 kHz PCM');
        this.emit('session.updated', { session: this.description() }); break;
      }
      case 'input_audio_buffer.append': {
        const pcm = decodeAudio(event.audio);
        const playing = this.speaker.isPlaying();
        // Native AEC can leave a brief onset transient. Confirm barge-in for
        // the negotiated interval while retaining its onset and continuous input.
        this.vad.onsetMs = this.clientAEC && playing ? this.bargeInMs : 120;
        // This capability confirms every utterance, including delayed echo
        // after the speaker drain receipt. Capture is never suspended.
        this.vad.buffered = this.clientAEC && this.bufferedBargeIn;
        if (!this.clientAEC && playing) this.vad.skip(pcm);
        else this.vad.append(pcm);
        break;
      }
      case 'input_audio_buffer.commit': this.vad.commit(); break;
      case 'input_audio_buffer.clear': this.vad.clear(); this.emit('input_audio_buffer.cleared'); break;
      case 'response.cancel': this.cancel(); break;
      case 'response.playback.done': {
        const pending = this.playback.get(event.item_id);
        if (pending) { this.host.spoken(pending.id, pending.text); this.playback.delete(event.item_id); this.speaker.finish(event.item_id); }
        break;
      }
      // Original client may request another response after session setup/tool completion.
      // Only a completed microphone utterance creates a Host turn, preventing duplicate work.
      case 'response.create': case 'conversation.item.truncate': case 'conversation.item.create': break;
      case 'session.close': this.close('hung-up'); this.ws.close(1000); break;
      default: break;
    }
  }
  cancel() {
    this.playback.clear();
    this.speaker.cancel();
    for (const job of this.jobs) job.abort.abort();
    this.jobs.clear();
    if (this.responseId) {
      this.emit('response.cancelled', { response: { id: this.responseId, status: 'cancelled', output: [] } });
      this.responseId = null;
    }
  }
  speechStarted({ audioStartMs }) {
    this.inputId = randomUUID();
    this.emit('input_audio_buffer.speech_started', { item_id: this.inputId, audio_start_ms: audioStartMs });
    this.cancel();
  }
  speechEnded({ pcm, audioEndMs }) {
    const id = this.inputId ?? randomUUID(); this.inputId = null;
    const job = { abort: new AbortController() };
    this.commitInput(id, audioEndMs);
    this.jobs.add(job);
    void this.turn(id, pcm, job).catch(error => {
      if (!job.abort.signal.aborted && !this.closed) this.error(error);
    }).finally(() => this.jobs.delete(job));
  }
  commitInput(id, audioEndMs) {
    this.emit('input_audio_buffer.speech_stopped', { item_id: id, audio_end_ms: audioEndMs });
    this.emit('input_audio_buffer.committed', { item_id: id, previous_item_id: null });
  }
  async turn(id, pcm, job) {
    this.limiter.check('turns', 30);
    const signal = job.abort.signal;
    const result = await this.speech.transcribe({ audioBase64: pcmWav(pcm).toString('base64'), mimeType: 'audio/wav' }, signal);
    signal.throwIfAborted();
    if (!result.text.trim()) return;
    this.emit('conversation.item.input_audio_transcription.completed', { item_id: id, content_index: 0, transcript: result.text });
    const responseId = randomUUID(), itemId = randomUUID(); this.responseId = responseId;
    this.emit('response.created', { response: { id: responseId, object: 'realtime.response', status: 'in_progress', output: [] } });
    const reply = await this.host.turn({ id, text: result.text, signal });
    signal.throwIfAborted();
    if (reply.text) {
      this.emit('response.output_item.added', { response_id: responseId, output_index: 0,
        item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
      this.emit('response.audio_transcript.delta', { response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, delta: reply.text });
      this.playback.set(itemId, { id, text: reply.text });
      for await (const chunk of this.synthesis.stream(reply.text, { signal })) {
        signal.throwIfAborted();
        this.speaker.append(itemId, chunk.length);
        if (!this.clientAEC) this.vad.clear();
        this.emit('response.audio.delta', { response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, delta: chunk.toString('base64') });
      }
      this.emit('response.audio.done', { response_id: responseId, item_id: itemId, output_index: 0, content_index: 0 });
      this.emit('response.audio_transcript.done', { response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, transcript: reply.text });
    }
    this.emit('response.done', { response: { id: responseId, object: 'realtime.response', status: 'completed', output: [] } });
    if (this.responseId === responseId) this.responseId = null;
  }
  close(ending = 'hung-up') {
    if (this.closed) return;
    this.cancel(); this.closed = true; this.vad.close(); clearInterval(this.heartbeat); clearTimeout(this.expiry);
    this.onClose?.();
    this.ending = this.host.end({ ending }).catch(error => console.error(`[voice] record failed: ${error.status ?? error.name}`));
    return this.ending;
  }
}
