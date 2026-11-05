import { check } from './security.mjs';
import createVAD, { VADMode, VADEvent } from '@ozymandiasthegreat/vad';
import { VoiceOnset } from './voice-onset.mjs';

const WebRTCVoiceDetector = await createVAD();

export const SAMPLE_RATE = 24_000;
const FRAME_BYTES = SAMPLE_RATE * 2 * 0.02;

export function pcmWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function decodeAudio(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 256_000 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0, 400, 'Invalid PCM audio');
  const pcm = Buffer.from(value, 'base64');
  check(pcm.length % 2 === 0, 400, 'Invalid PCM sample boundary');
  return pcm;
}

/** WebRTC speech detection, 20 ms frames, onset confirmation and a short pre-roll. */
export class VoiceActivity {
  constructor({ onStart, onEnd, onDecision, silenceMs = 700, maxMs = 30_000, onsetMs = 120, buffered = false } = {}) {
    Object.assign(this, { onStart, onEnd, onDecision, silenceMs, maxMs, onsetMs, buffered });
    this.onset = new VoiceOnset();
    this.detector = new WebRTCVoiceDetector(VADMode.AGGRESSIVE, 48_000);
    this.analysisFrame = new Int16Array(960);
    this.noise = 90; this.offsetMs = 0; this.remainder = Buffer.alloc(0); this.reset();
  }
  reset() { this.active = false; this.frames = []; this.pre = []; this.onset.reset(); this.quiet = 0; this.duration = 0; }
  append(pcm) {
    const buffer = this.remainder.length ? Buffer.concat([this.remainder, pcm]) : pcm;
    let offset = 0;
    for (; offset + FRAME_BYTES <= buffer.length; offset += FRAME_BYTES)
      this.frame(Buffer.from(buffer.subarray(offset, offset + FRAME_BYTES)));
    this.remainder = Buffer.from(buffer.subarray(offset));
  }
  frame(data) {
    let sum = 0;
    // WebRTC accepts 48 kHz, not the clients' 24 kHz. Linear 2x interpolation
    // is only used for detection; ASR receives the original unmodified PCM.
    for (let i = 0; i < data.length; i += 2) {
      const sample = data.readInt16LE(i), next = i + 2 < data.length ? data.readInt16LE(i + 2) : sample;
      sum += sample ** 2;
      this.analysisFrame[i] = sample; this.analysisFrame[i + 1] = (sample + next) / 2;
    }
    const rms = Math.sqrt(sum / (data.length / 2));
    const voiced = this.detector.processFrame(this.analysisFrame) === VADEvent.VOICE &&
      rms > Math.max(350, Math.min(2200, this.noise * 3.5));
    this.offsetMs += 20;
    if (!this.active) {
      const decision = this.onset.push(voiced, this);
      this.pre.push(data);
      const preFrames = Math.max(50, Math.ceil((this.onsetMs + 100) / 20), Math.ceil(decision.retainMs / 20));
      if (this.pre.length > preFrames) this.pre.splice(0, this.pre.length - preFrames);
      // Pauses inside a candidate are not a new ambient-noise baseline.
      if (!voiced && !this.onset.pending) this.noise = this.noise * 0.98 + rms * 0.02;
      if (decision.rejected?.buffered) this.onDecision?.({ state: 'rejected', ...decision.rejected, atMs: this.offsetMs });
      if (!decision.confirmed) return;
      this.active = true; this.frames = this.pre; this.pre = [];
      this.duration = this.frames.length * 20;
      this.onDecision?.({ state: 'confirmed', ...decision.evidence, atMs: this.offsetMs });
      this.onStart?.({ audioStartMs: Math.max(0, this.offsetMs - this.duration) });
      return;
    }
    this.frames.push(data); this.duration += 20; this.quiet = voiced ? 0 : this.quiet + 20;
    if (this.quiet >= this.silenceMs || this.duration >= this.maxMs) this.commit();
  }
  commit() {
    if (!this.active) return;
    const pcm = Buffer.concat(this.frames), audioEndMs = this.offsetMs;
    this.reset(); this.onEnd?.({ pcm, audioEndMs });
  }
  clear() { this.reset(); this.remainder = Buffer.alloc(0); }
  skip(pcm) { this.clear(); this.offsetMs += pcm.length / (SAMPLE_RATE * 2) * 1000; }
  close() { this.clear(); this.detector.destroy(); }
}
