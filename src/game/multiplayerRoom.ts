import type { SerializedRoundState } from "./rounds";
import type { SerializedBombRuntimeState } from "./bombState";
import type { SerializedHostageRuntimeState } from "./hostageState";
import type { TeamId, TeamPreference } from "../types";

const HEARTBEAT_MS = 100;
const STALE_PEER_MS = 2400;
const OPERATOR_CALLSIGNS = ["Atlas", "Bishop", "Cinder", "Lancer", "Nova", "Pike", "Rivet", "Sable"];
const OPERATOR_ACCENTS = ["#CFA66F", "#6F8FAA", "#819B58", "#B86E4E", "#7A8E96", "#A88E5E"];
const SESSION_KEY = "dustline.operator-seed";

export type MatchMode = "local" | "shared";
export type CombatantStatus = "alive" | "down";

export interface RoomIdentity {
  id: string;
  name: string;
  accentColor: string;
}

export interface RoomPresenceSnapshot {
  id: string;
  name: string;
  accentColor: string;
  teamId: TeamId;
  teamPreference: TeamPreference;
  health: number;
  eliminations: number;
  deaths: number;
  status: CombatantStatus;
  roundState: SerializedRoundState;
  bombState: SerializedBombRuntimeState | null;
  hostageState: SerializedHostageRuntimeState | null;
  position: [number, number, number];
  look: [number, number, number];
  updatedAt: number;
}

export interface OutboundRoomPresence {
  teamId: TeamId;
  teamPreference: TeamPreference;
  health: number;
  eliminations: number;
  deaths: number;
  status: CombatantStatus;
  roundState: SerializedRoundState;
  bombState: SerializedBombRuntimeState | null;
  hostageState: SerializedHostageRuntimeState | null;
  position: [number, number, number];
  look: [number, number, number];
}

export interface RoomHitEvent {
  attackerId: string;
  attackerName: string;
  targetId: string;
  damage: number;
  sentAt: number;
}

export interface RoomEliminationEvent {
  attackerId: string;
  attackerName: string;
  targetId: string;
  targetName: string;
  sentAt: number;
}

type BroadcastEnvelope =
  | {
      kind: "hello";
      senderId: string;
    }
  | {
      kind: "presence";
      senderId: string;
      payload: RoomPresenceSnapshot;
    }
  | {
      kind: "hit";
      senderId: string;
      payload: RoomHitEvent;
    }
  | {
      kind: "elimination";
      senderId: string;
      payload: RoomEliminationEvent;
    }
  | {
      kind: "leave";
      senderId: string;
    };

export interface SharedRoomHandlers {
  onPresence: (presence: RoomPresenceSnapshot, event: "joined" | "updated") => void;
  onLeave: (peerId: string, reason: "leave" | "stale") => void;
  onHit: (event: RoomHitEvent) => void;
  onElimination: (event: RoomEliminationEvent) => void;
}

export function detectSharedRoomSupport(): { supported: boolean; reason: string } {
  if (typeof BroadcastChannel === "undefined") {
    return {
      supported: false,
      reason: "BroadcastChannel is unavailable in this browser, so shared-room sync cannot start.",
    };
  }

  return {
    supported: true,
    reason: "Shared-room sync available.",
  };
}

export function createRoomIdentity(): RoomIdentity {
  const seed = readOrCreateOperatorSeed();
  const hash = hashString(seed);
  const callsign = OPERATOR_CALLSIGNS[hash % OPERATOR_CALLSIGNS.length];
  const accentColor = OPERATOR_ACCENTS[hash % OPERATOR_ACCENTS.length];
  const suffix = (Math.floor(hash / OPERATOR_CALLSIGNS.length) % 80) + 10;

  return {
    id: `operator-${seed}`,
    name: `${callsign}-${suffix}`,
    accentColor,
  };
}

export function buildRoomId(mapId: string): string {
  return `dustline-room:${mapId}`;
}

export class SharedRoomSession {
  private readonly channel: BroadcastChannel;
  private readonly peers = new Map<string, RoomPresenceSnapshot>();
  private lastPresence?: RoomPresenceSnapshot;
  private lastSentAt = 0;

  constructor(
    private readonly roomId: string,
    private readonly identity: RoomIdentity,
    private readonly handlers: SharedRoomHandlers,
  ) {
    this.channel = new BroadcastChannel(roomId);
    this.channel.addEventListener("message", this.handleMessage);
    this.send({ kind: "hello", senderId: this.identity.id });
  }

  get peersSnapshot(): RoomPresenceSnapshot[] {
    return [...this.peers.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  publish(presence: OutboundRoomPresence, force = false): void {
    const now = Date.now();
    this.lastPresence = {
      id: this.identity.id,
      name: this.identity.name,
      accentColor: this.identity.accentColor,
      updatedAt: now,
      ...presence,
    };

    if (!force && now - this.lastSentAt < HEARTBEAT_MS) {
      return;
    }

    this.flushPresence(now);
  }

  sendHit(targetId: string, damage: number): boolean {
    if (!this.peers.has(targetId)) {
      return false;
    }

    this.send({
      kind: "hit",
      senderId: this.identity.id,
      payload: {
        attackerId: this.identity.id,
        attackerName: this.identity.name,
        targetId,
        damage,
        sentAt: Date.now(),
      },
    });

    return true;
  }

  sendElimination(
    attackerId: string,
    attackerName: string,
    targetId: string,
    targetName: string,
  ): void {
    this.send({
      kind: "elimination",
      senderId: this.identity.id,
      payload: {
        attackerId,
        attackerName,
        targetId,
        targetName,
        sentAt: Date.now(),
      },
    });
  }

  pruneStalePeers(now = Date.now()): void {
    for (const [peerId, peer] of this.peers) {
      if (now - peer.updatedAt <= STALE_PEER_MS) {
        continue;
      }

      this.peers.delete(peerId);
      this.handlers.onLeave(peerId, "stale");
    }
  }

  dispose(): void {
    this.send({ kind: "leave", senderId: this.identity.id });
    this.channel.removeEventListener("message", this.handleMessage);
    this.channel.close();
  }

  private flushPresence(now = Date.now()): void {
    if (!this.lastPresence) {
      return;
    }

    this.lastPresence = {
      ...this.lastPresence,
      updatedAt: now,
    };
    this.lastSentAt = now;
    this.send({
      kind: "presence",
      senderId: this.identity.id,
      payload: this.lastPresence,
    });
  }

  private readonly handleMessage = (event: MessageEvent<BroadcastEnvelope>): void => {
    const data = event.data;

    if (!data || data.senderId === this.identity.id) {
      return;
    }

    switch (data.kind) {
      case "hello":
        this.flushPresence();
        return;
      case "presence": {
        const existing = this.peers.get(data.payload.id);
        this.peers.set(data.payload.id, data.payload);
        this.handlers.onPresence(data.payload, existing ? "updated" : "joined");
        return;
      }
      case "hit":
        if (data.payload.targetId === this.identity.id) {
          this.handlers.onHit(data.payload);
        }
        return;
      case "elimination":
        this.handlers.onElimination(data.payload);
        return;
      case "leave":
        if (this.peers.delete(data.senderId)) {
          this.handlers.onLeave(data.senderId, "leave");
        }
        return;
      default:
        return;
    }
  };

  private send(message: BroadcastEnvelope): void {
    this.channel.postMessage(message);
  }
}

function readOrCreateOperatorSeed(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) {
      return existing;
    }

    const created = createSeed();
    sessionStorage.setItem(SESSION_KEY, created);
    return created;
  } catch {
    return createSeed();
  }
}

function createSeed(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().slice(0, 8);
  }

  return Math.random().toString(36).slice(2, 10);
}

function hashString(value: string): number {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}
