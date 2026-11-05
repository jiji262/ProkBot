/** Half-duplex capture guard, driven by actual speaker drain receipts. */
export class VoicePlayback {
  constructor(now = Date.now) { this.now = now; this.active = new Map(); this.tailUntil = 0; }
  append(id, pcmBytes) {
    const previous = this.active.get(id) ?? this.now();
    this.active.set(id, Math.max(previous, this.now()) + pcmBytes / 48);
  }
  finish(id) {
    if (this.active.delete(id)) this.tailUntil = this.now() + 500;
  }
  cancel() { if (this.active.size) this.tailUntil = this.now() + 500; this.active.clear(); }
  isPlaying() {
    // Recover from a missing client receipt without leaving capture suspended.
    for (const [id, end] of this.active) if (this.now() > end + 2000) this.active.delete(id);
    return this.active.size > 0 || this.now() < this.tailUntil;
  }
}
