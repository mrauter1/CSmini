type VoiceType = OscillatorType;

export class RetroAudio {
  private context?: AudioContext;

  prime(): void {
    this.ensureContext();
    void this.context?.resume();
  }

  fire(): void {
    const context = this.ensureContext();
    const now = context.currentTime;

    this.voice("square", 192, 92, 0.08, 0.045, now);
    this.voice("triangle", 128, 72, 0.12, 0.03, now + 0.01);
  }

  hitConfirm(): void {
    const context = this.ensureContext();
    const now = context.currentTime;

    this.voice("sine", 920, 1180, 0.06, 0.035, now);
    this.voice("sine", 1380, 1600, 0.04, 0.022, now + 0.045);
  }

  playerHit(): void {
    const context = this.ensureContext();
    const now = context.currentTime;

    this.voice("sawtooth", 210, 118, 0.12, 0.035, now);
  }

  death(): void {
    const context = this.ensureContext();
    const now = context.currentTime;

    this.voice("triangle", 250, 62, 0.34, 0.05, now);
    this.voice("sine", 132, 54, 0.42, 0.025, now + 0.03);
  }

  respawn(): void {
    const context = this.ensureContext();
    const now = context.currentTime;

    this.voice("triangle", 210, 340, 0.14, 0.03, now);
    this.voice("square", 320, 560, 0.16, 0.025, now + 0.09);
  }

  dispose(): void {
    const context = this.context;
    this.context = undefined;

    if (!context) {
      return;
    }

    void context.close().catch(() => undefined);
  }

  private ensureContext(): AudioContext {
    this.context ??= new AudioContext();
    return this.context;
  }

  private voice(
    type: VoiceType,
    startFrequency: number,
    endFrequency: number,
    duration: number,
    peakGain: number,
    startAt: number,
  ): void {
    const context = this.ensureContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(startFrequency, startAt);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(35, endFrequency),
      startAt + duration,
    );

    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(peakGain, startAt + duration * 0.18);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

    oscillator.connect(gain);
    gain.connect(context.destination);

    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.02);
  }
}
