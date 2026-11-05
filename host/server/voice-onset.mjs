// Durations count captured audio, not network packet arrival times.
export const BUFFERED_BARGE_IN = Object.freeze({
  voicedMs: 560, spanMs: 640, gapMs: 600, windowMs: 2000, preRollMs: 1000,
});

/** Confirm sustained speech while preserving syllables separated by brief pauses. */
export class VoiceOnset {
  constructor() { this.reset(); }
  reset() { this.pending = null; }
  push(voiced, { buffered = false, onsetMs = 120 } = {}) {
    if (!this.pending) {
      if (!voiced) return { confirmed: false, retainMs: 0 };
      this.pending = { buffered, voicedMs: 0, spanMs: 0, gapMs: 0 };
    }
    const pending = this.pending;
    // Playback may end inside a candidate. Do not relax an echo candidate to
    // the ordinary onset just because its playback receipt arrived.
    pending.buffered ||= buffered;
    pending.spanMs += 20;
    pending.voicedMs += voiced ? 20 : 0;
    pending.gapMs = voiced ? 0 : pending.gapMs + 20;
    const policy = BUFFERED_BARGE_IN;
    const rejected = pending.buffered
      ? pending.gapMs >= policy.gapMs || pending.spanMs > policy.windowMs
      : !voiced;
    if (rejected) {
      this.reset();
      if (voiced) this.pending = { buffered, voicedMs: 20, spanMs: 20, gapMs: 0 };
      return { confirmed: false, retainMs: this.pending?.spanMs ?? 0, rejected: { ...pending } };
    }
    const confirmed = voiced && (pending.buffered
      ? pending.voicedMs >= policy.voicedMs && pending.spanMs >= policy.spanMs
      : pending.voicedMs >= onsetMs);
    return { confirmed, retainMs: pending.spanMs + policy.preRollMs,
      ...(confirmed ? { evidence: { ...pending } } : {}) };
  }
}
