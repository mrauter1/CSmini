type VoiceType = OscillatorType;

export interface AudioDebugEvent {
  type: "local-fire" | "world-fire" | "hit-confirm" | "player-hit" | "death" | "respawn";
  at: number;
  distance: number | null;
  gain: number | null;
  pan: number | null;
}

export class RetroAudio {
  private context?: AudioContext;
  private readonly debugEvents: AudioDebugEvent[] = [];

  prime(): void {
    this.ensureContext();
    void this.context?.resume();
  }

  fire(): void {
    const context = this.ensureContext();
    const now = context.currentTime;

    this.voice("square", 192, 92, 0.08, 0.045, now);
    this.voice("triangle", 128, 72, 0.12, 0.03, now + 0.01);
    this.record("local-fire", now, null, 1, null);
  }

  worldFire(distance: number, pan = 0): void {
    const gainScale = this.distanceGain(distance);
    const debugTime = this.context?.currentTime ?? performance.now() / 1000;
    this.record("world-fire", debugTime, distance, gainScale, pan);

    try {
      const context = this.ensureContext();
      const now = context.currentTime;
      const output = this.worldOutput(context, pan, gainScale);

      this.voice("square", 172, 82, 0.09, 0.042, now, output);
      this.voice("triangle", 112, 62, 0.13, 0.026, now + 0.012, output);
    } catch {
      // Keep deterministic debug evidence even if the browser refuses audio output.
    }
  }

  hitConfirm(): void {
    const context = this.ensureContext();
    const now = context.currentTime;

    this.voice("sine", 920, 1180, 0.06, 0.035, now);
    this.voice("sine", 1380, 1600, 0.04, 0.022, now + 0.045);
    this.record("hit-confirm", now, null, 1, null);
  }

  playerHit(): void {
    const context = this.ensureContext();
    const now = context.currentTime;

    this.voice("sawtooth", 210, 118, 0.12, 0.035, now);
    this.record("player-hit", now, null, 1, null);
  }

  death(): void {
    const context = this.ensureContext();
    const now = context.currentTime;

    this.voice("triangle", 250, 62, 0.34, 0.05, now);
    this.voice("sine", 132, 54, 0.42, 0.025, now + 0.03);
    this.record("death", now, null, 1, null);
  }

  respawn(): void {
    const context = this.ensureContext();
    const now = context.currentTime;

    this.voice("triangle", 210, 340, 0.14, 0.03, now);
    this.voice("square", 320, 560, 0.16, 0.025, now + 0.09);
    this.record("respawn", now, null, 1, null);
  }

  debugSnapshot(): AudioDebugEvent[] {
    return this.debugEvents.map((event) => ({ ...event }));
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
    destination?: AudioNode,
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
    gain.connect(destination ?? context.destination);

    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.02);
  }

  private worldOutput(context: AudioContext, pan: number, gainScale: number): AudioNode {
    const gain = context.createGain();
    gain.gain.setValueAtTime(gainScale, context.currentTime);

    if (typeof context.createStereoPanner !== "function") {
      gain.connect(context.destination);
      return gain;
    }

    const panner = context.createStereoPanner();
    panner.pan.setValueAtTime(Math.max(-0.85, Math.min(0.85, pan)), context.currentTime);
    gain.connect(panner);
    panner.connect(context.destination);
    return gain;
  }

  private distanceGain(distance: number): number {
    const normalizedDistance = Math.max(0, Number.isFinite(distance) ? distance : 0);
    const gain = 1 / (1 + Math.max(0, normalizedDistance - 2) * 0.09);
    return Math.max(0.08, Math.min(0.92, gain));
  }

  private record(
    type: AudioDebugEvent["type"],
    at: number,
    distance: number | null,
    gain: number | null,
    pan: number | null,
  ): void {
    this.debugEvents.push({
      type,
      at: Number(at.toFixed(3)),
      distance: distance === null ? null : Number(distance.toFixed(2)),
      gain: gain === null ? null : Number(gain.toFixed(3)),
      pan: pan === null ? null : Number(pan.toFixed(3)),
    });

    if (this.debugEvents.length > 32) {
      this.debugEvents.splice(0, this.debugEvents.length - 32);
    }
  }
}
