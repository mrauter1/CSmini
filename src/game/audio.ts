type VoiceType = OscillatorType;

type AudioDebugContextState = AudioContextState | "uninitialized" | "unknown";
type AudioBlockedReason = "context-suspended" | "context-unavailable" | null;

export interface AudioDebugEvent {
  type: "local-fire" | "world-fire" | "hit-confirm" | "player-hit" | "death" | "respawn";
  at: number;
  distance: number | null;
  gain: number | null;
  outputGain: number | null;
  pan: number | null;
  playable: boolean;
  contextState: AudioDebugContextState;
  blockedReason: AudioBlockedReason;
}

export interface AudioDebugState {
  contextState: AudioDebugContextState;
  pendingWorldFireCount: number;
  lastResumeAttemptAt: number | null;
  lastPlayableWorldFireAt: number | null;
  lastBlockedWorldFireAt: number | null;
}

interface PendingWorldFire {
  distance: number;
  pan: number;
  requestedAt: number;
}

const WORLD_FIRE_OUTPUT_BOOST = 1.35;
const PENDING_WORLD_FIRE_MAX_AGE = 1.8;
const MAX_PENDING_WORLD_FIRES = 4;

export class RetroAudio {
  private context?: AudioContext;
  private readonly debugEvents: AudioDebugEvent[] = [];
  private readonly pendingWorldFires: PendingWorldFire[] = [];
  private lastResumeAttemptAt: number | null = null;
  private lastPlayableWorldFireAt: number | null = null;
  private lastBlockedWorldFireAt: number | null = null;

  prime(): void {
    const context = this.ensureContext();
    this.lastResumeAttemptAt = this.debugNow();

    if (context.state === "running") {
      this.flushPendingWorldFires(context);
      return;
    }

    void context
      .resume()
      .then(() => {
        if (context.state === "running") {
          this.flushPendingWorldFires(context);
        }
      })
      .catch(() => undefined);
  }

  fire(): void {
    const context = this.ensureContext();
    const now = context.currentTime;

    this.voice("square", 192, 92, 0.08, 0.045, now);
    this.voice("triangle", 128, 72, 0.12, 0.03, now + 0.01);
    this.record("local-fire", now, null, 1, 1, null, context.state === "running", context.state);
  }

  worldFire(distance: number, pan = 0): void {
    const gainScale = this.distanceGain(distance);
    const outputGain = this.outputGain(gainScale);
    const context = this.ensureContext();
    const state = context.state;

    if (state !== "running") {
      this.queueWorldFire(distance, pan);
      const debugTime = this.debugNow();
      this.lastBlockedWorldFireAt = debugTime;
      this.record(
        "world-fire",
        debugTime,
        distance,
        gainScale,
        outputGain,
        pan,
        false,
        state,
        "context-suspended",
      );
      return;
    }

    this.playWorldFireNow(context, distance, pan);
  }

  hitConfirm(): void {
    const context = this.ensureContext();
    const now = context.currentTime;

    this.voice("sine", 920, 1180, 0.06, 0.035, now);
    this.voice("sine", 1380, 1600, 0.04, 0.022, now + 0.045);
    this.record("hit-confirm", now, null, 1, 1, null, context.state === "running", context.state);
  }

  playerHit(): void {
    const context = this.ensureContext();
    const now = context.currentTime;

    this.voice("sawtooth", 210, 118, 0.12, 0.035, now);
    this.record("player-hit", now, null, 1, 1, null, context.state === "running", context.state);
  }

  death(): void {
    const context = this.ensureContext();
    const now = context.currentTime;

    this.voice("triangle", 250, 62, 0.34, 0.05, now);
    this.voice("sine", 132, 54, 0.42, 0.025, now + 0.03);
    this.record("death", now, null, 1, 1, null, context.state === "running", context.state);
  }

  respawn(): void {
    const context = this.ensureContext();
    const now = context.currentTime;

    this.voice("triangle", 210, 340, 0.14, 0.03, now);
    this.voice("square", 320, 560, 0.16, 0.025, now + 0.09);
    this.record("respawn", now, null, 1, 1, null, context.state === "running", context.state);
  }

  debugSnapshot(): AudioDebugEvent[] {
    return this.debugEvents.map((event) => ({ ...event }));
  }

  debugState(): AudioDebugState {
    return {
      contextState: this.contextState(),
      pendingWorldFireCount: this.pendingWorldFires.length,
      lastResumeAttemptAt: this.lastResumeAttemptAt,
      lastPlayableWorldFireAt: this.lastPlayableWorldFireAt,
      lastBlockedWorldFireAt: this.lastBlockedWorldFireAt,
    };
  }

  dispose(): void {
    const context = this.context;
    this.context = undefined;

    if (!context) {
      return;
    }

    this.pendingWorldFires.length = 0;
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

  private playWorldFireNow(context: AudioContext, distance: number, pan: number): void {
    const gainScale = this.distanceGain(distance);
    const outputGain = this.outputGain(gainScale);
    const now = context.currentTime;
    const output = this.worldOutput(context, pan, outputGain);

    this.voice("square", 174, 78, 0.11, 0.072, now, output);
    this.voice("triangle", 116, 58, 0.16, 0.044, now + 0.012, output);
    this.lastPlayableWorldFireAt = this.debugNow();
    this.record("world-fire", now, distance, gainScale, outputGain, pan, true, context.state);
  }

  private flushPendingWorldFires(context: AudioContext): void {
    const now = this.debugNow();
    const pending = this.pendingWorldFires.splice(0);

    for (const event of pending) {
      if (now - event.requestedAt > PENDING_WORLD_FIRE_MAX_AGE) {
        continue;
      }

      this.playWorldFireNow(context, event.distance, event.pan);
    }
  }

  private queueWorldFire(distance: number, pan: number): void {
    this.pendingWorldFires.push({
      distance,
      pan,
      requestedAt: this.debugNow(),
    });

    if (this.pendingWorldFires.length > MAX_PENDING_WORLD_FIRES) {
      this.pendingWorldFires.splice(0, this.pendingWorldFires.length - MAX_PENDING_WORLD_FIRES);
    }
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

  private outputGain(distanceGain: number): number {
    return Math.max(0.12, Math.min(1, distanceGain * WORLD_FIRE_OUTPUT_BOOST));
  }

  private record(
    type: AudioDebugEvent["type"],
    at: number,
    distance: number | null,
    gain: number | null,
    outputGain: number | null,
    pan: number | null,
    playable: boolean,
    contextState: AudioDebugContextState,
    blockedReason: AudioBlockedReason = null,
  ): void {
    this.debugEvents.push({
      type,
      at: Number(at.toFixed(3)),
      distance: distance === null ? null : Number(distance.toFixed(2)),
      gain: gain === null ? null : Number(gain.toFixed(3)),
      outputGain: outputGain === null ? null : Number(outputGain.toFixed(3)),
      pan: pan === null ? null : Number(pan.toFixed(3)),
      playable,
      contextState,
      blockedReason,
    });

    if (this.debugEvents.length > 32) {
      this.debugEvents.splice(0, this.debugEvents.length - 32);
    }
  }

  private contextState(): AudioDebugContextState {
    return this.context?.state ?? "uninitialized";
  }

  private debugNow(): number {
    return this.context?.state === "running" ? this.context.currentTime : performance.now() / 1000;
  }
}
