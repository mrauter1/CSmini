import {
  BroadcastRoomTransport,
  detectBroadcastTransportSupport,
} from "./broadcastTransport";
import { detectWebRtcSupport } from "./manualSignaling";
import {
  type CombatantStatus,
  decodeRoomMessage,
  encodeRoomMessage,
  isFreshRoomMessage,
  ROOM_PROTOCOL,
  ROOM_PROTOCOL_VERSION,
  type OutboundRoomPresence,
  type ParticipantIdentity,
  type ParticipantRecord,
  type RoomEliminationEvent,
  type RoomHitEvent,
  type RoomMessage,
  type RoomPresenceSnapshot,
  type TeamAssignment,
} from "./protocol";
import type { RoomTransport, RoomTransportPhase, RoomTransportStatus } from "./transport";
import { WebRtcRoomTransport } from "./webrtcTransport";

const HEARTBEAT_MS = 100;
const HEARTBEAT_PULSE_MS = 900;
const STALE_PEER_MS = 2_400;
const OPERATOR_CALLSIGNS = ["Atlas", "Bishop", "Cinder", "Lancer", "Nova", "Pike", "Rivet", "Sable"];
const OPERATOR_ACCENTS = ["#CFA66F", "#6F8FAA", "#819B58", "#B86E4E", "#7A8E96", "#A88E5E"];
const SESSION_KEY = "dustline.operator-seed";

export type MatchMode = "local" | "shared";
export type RoomConnectionKind = "broadcast" | "webrtc-host" | "webrtc-join";

export interface RoomIdentity extends ParticipantIdentity {}

export interface SharedRoomHandlers {
  onPresence: (presence: RoomPresenceSnapshot, event: "joined" | "updated") => void;
  onLeave: (peerId: string, reason: "leave" | "stale") => void;
  onHit: (event: RoomHitEvent) => void;
  onElimination: (event: RoomEliminationEvent) => void;
}

export interface RoomConnectionUiSnapshot {
  kind: RoomConnectionKind;
  phase: RoomTransportPhase;
  title: string;
  detail: string;
  offerCode?: string;
  answerCode?: string;
  remoteName?: string;
}

export interface RoomConnectionDebugSnapshot extends RoomConnectionUiSnapshot {
  peerCount: number;
  peerIds: string[];
}

export interface MatchRoomConnection {
  readonly kind: RoomConnectionKind;
  readonly roomId: string;
  readonly identity: RoomIdentity;
  readonly peersSnapshot: RoomPresenceSnapshot[];
  readonly uiSnapshot: RoomConnectionUiSnapshot;
  setHandlers(handlers: SharedRoomHandlers): void;
  publish(presence: OutboundRoomPresence, force?: boolean): void;
  sendHit(targetId: string, damage: number): boolean;
  sendElimination(
    attackerId: string,
    attackerName: string,
    targetId: string,
    targetName: string,
  ): void;
  tick(now?: number): void;
  dispose(): void;
  subscribe(listener: () => void): () => void;
  debugSnapshot(): RoomConnectionDebugSnapshot;
}

export interface HostMatchRoomConnection extends MatchRoomConnection {
  createOfferCode(): Promise<string>;
  applyAnswerCode(raw: string): Promise<void>;
}

export interface JoinMatchRoomConnection extends MatchRoomConnection {
  acceptOfferCode(raw: string): Promise<string>;
}

interface BaseConnectionOptions {
  roomId: string;
  mapId: string;
  identity: RoomIdentity;
  handlers: SharedRoomHandlers;
  transport: RoomTransport;
}

export function detectSharedRoomSupport(kind: RoomConnectionKind): {
  supported: boolean;
  reason: string;
} {
  if (kind === "broadcast") {
    return detectBroadcastTransportSupport();
  }

  return detectWebRtcSupport();
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

export function createBroadcastMatchRoomConnection(
  roomId: string,
  mapId: string,
  identity: RoomIdentity,
  handlers: SharedRoomHandlers,
): MatchRoomConnection {
  const transport = new BroadcastRoomTransport(roomId, identity.id, {
    onMessage: () => undefined,
  });

  return new BroadcastMatchRoomConnection({
    roomId,
    mapId,
    identity,
    handlers,
    transport,
  });
}

export function createHostMatchRoomConnection(
  roomId: string,
  mapId: string,
  identity: RoomIdentity,
  handlers: SharedRoomHandlers,
  sessionLabel: string,
): HostMatchRoomConnection {
  const transport = new WebRtcRoomTransport(
    {
      role: "host",
      roomId,
      mapId,
      localParticipant: identity,
      sessionLabel,
    },
    {
      onMessage: () => undefined,
    },
  );

  return new HostWebRtcMatchRoomConnection({
    roomId,
    mapId,
    identity,
    handlers,
    transport,
  });
}

export function createJoinMatchRoomConnection(
  roomId: string,
  mapId: string,
  identity: RoomIdentity,
  handlers: SharedRoomHandlers,
): JoinMatchRoomConnection {
  const transport = new WebRtcRoomTransport(
    {
      role: "guest",
      roomId,
      mapId,
      localParticipant: identity,
      sessionLabel: "",
    },
    {
      onMessage: () => undefined,
    },
  );

  return new JoinWebRtcMatchRoomConnection({
    roomId,
    mapId,
    identity,
    handlers,
    transport,
  });
}

abstract class BaseMatchRoomConnection implements MatchRoomConnection {
  readonly roomId: string;
  readonly identity: RoomIdentity;
  readonly peers = new Map<string, RoomPresenceSnapshot>();
  readonly participants = new Map<string, ParticipantRecord>();
  readonly lastSeqByPeer = new Map<string, number>();
  readonly lastSeenByPeer = new Map<string, number>();
  readonly listeners = new Set<() => void>();

  protected readonly mapId: string;
  protected handlers: SharedRoomHandlers;
  protected readonly transport: RoomTransport;
  protected lastPresence?: RoomPresenceSnapshot;
  protected lastPresenceSentAt = 0;
  protected lastHeartbeatAt = 0;
  protected nextSeq = 1;
  protected joined = false;
  protected uiState: RoomConnectionUiSnapshot;

  protected constructor(
    readonly kind: RoomConnectionKind,
    options: BaseConnectionOptions,
  ) {
    this.roomId = options.roomId;
    this.mapId = options.mapId;
    this.identity = options.identity;
    this.handlers = options.handlers;
    this.transport = options.transport;
    this.uiState = this.createUiState(this.transport.getStatus());

    this.bindTransport();
  }

  get peersSnapshot(): RoomPresenceSnapshot[] {
    return [...this.peers.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  get uiSnapshot(): RoomConnectionUiSnapshot {
    return this.uiState;
  }

  setHandlers(handlers: SharedRoomHandlers): void {
    this.handlers = handlers;
  }

  publish(presence: OutboundRoomPresence, force = false): void {
    const now = Date.now();
    this.lastPresence = {
      id: this.identity.id,
      name: this.identity.name,
      accentColor: this.identity.accentColor,
      health: presence.health,
      eliminations: presence.eliminations,
      deaths: presence.deaths,
      status: presence.status,
      position: presence.position,
      look: presence.look,
      updatedAt: now,
      team: presence.team ?? this.defaultTeam(),
    };

    if (!force && now - this.lastPresenceSentAt < HEARTBEAT_MS) {
      return;
    }

    this.flushPresence(now);
  }

  sendHit(targetId: string, damage: number): boolean {
    if (!this.peers.has(targetId)) {
      return false;
    }

    return this.sendMessage("combat-hit", {
      attackerId: this.identity.id,
      attackerName: this.identity.name,
      targetId,
      damage,
    });
  }

  sendElimination(
    attackerId: string,
    attackerName: string,
    targetId: string,
    targetName: string,
  ): void {
    this.sendMessage("combat-elimination", {
      attackerId,
      attackerName,
      targetId,
      targetName,
    });
  }

  tick(now = Date.now()): void {
    this.pruneStalePeers(now);

    if (this.lastPresence && now - this.lastPresenceSentAt >= HEARTBEAT_MS) {
      this.flushPresence(now);
    }

    if (now - this.lastHeartbeatAt >= HEARTBEAT_PULSE_MS) {
      this.sendMessage("heartbeat", {
        rosterCount: this.peers.size + 1,
        phase: this.peers.size > 0 ? "active" : "waiting",
      });
      this.lastHeartbeatAt = now;
    }
  }

  dispose(): void {
    this.sendMessage("disconnect", {
      reason: "leave",
    });
    this.transport.close("leave");
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  debugSnapshot(): RoomConnectionDebugSnapshot {
    return {
      ...this.uiState,
      peerCount: this.peers.size,
      peerIds: [...this.peers.keys()],
    };
  }

  protected createUiState(status: RoomTransportStatus): RoomConnectionUiSnapshot {
    return {
      kind: this.kind,
      phase: status.phase,
      title: this.defaultTitle(),
      detail: status.detail,
      remoteName: this.peersSnapshot[0]?.name,
    };
  }

  protected updateUiState(update: Partial<RoomConnectionUiSnapshot>): void {
    this.uiState = {
      ...this.uiState,
      ...update,
      kind: this.kind,
      title: update.title ?? this.uiState.title,
      remoteName: this.peersSnapshot[0]?.name ?? update.remoteName ?? this.uiState.remoteName,
    };
    this.emitStateChange();
  }

  protected flushPresence(now = Date.now()): void {
    if (!this.lastPresence) {
      return;
    }

    this.lastPresence = {
      ...this.lastPresence,
      updatedAt: now,
    };
    this.lastPresenceSentAt = now;
    this.sendMessage("presence-update", {
      presence: this.lastPresence,
    });
  }

  protected sendMessage<Type extends RoomMessage["type"]>(
    type: Type,
    payload: Extract<RoomMessage, { type: Type }>["payload"],
    toPeerId?: string,
  ): boolean {
    const message = {
      protocol: ROOM_PROTOCOL,
      version: ROOM_PROTOCOL_VERSION,
      type,
      roomId: this.roomId,
      fromPeerId: this.identity.id,
      toPeerId,
      seq: this.nextSeq++,
      sentAt: Date.now(),
      payload,
    } as Extract<RoomMessage, { type: Type }>;

    return this.transport.send(encodeRoomMessage(message));
  }

  protected rememberParticipant(participant: ParticipantRecord): void {
    this.participants.set(participant.id, participant);
    if (participant.id !== this.identity.id) {
      this.lastSeenByPeer.set(participant.id, Date.now());
    }
  }

  protected rememberPresence(presence: RoomPresenceSnapshot): void {
    const existing = this.peers.get(presence.id);
    this.peers.set(presence.id, presence);
    this.lastSeenByPeer.set(presence.id, presence.updatedAt);
    this.handlers.onPresence(presence, existing ? "updated" : "joined");
    this.updateUiState({
      remoteName: presence.name,
    });
  }

  protected removePeer(peerId: string, reason: "leave" | "stale"): void {
    const removedPresence = this.peers.delete(peerId);
    this.participants.delete(peerId);
    this.lastSeenByPeer.delete(peerId);
    this.lastSeqByPeer.delete(peerId);
    if (removedPresence) {
      this.handlers.onLeave(peerId, reason);
    }
    this.updateUiState({
      remoteName: this.peersSnapshot[0]?.name,
      detail:
        this.transport.getStatus().phase === "connected"
          ? this.peers.size > 0
            ? `Connected with ${this.peers.size} remote operator${this.peers.size === 1 ? "" : "s"}.`
            : "Connected. Awaiting another operator."
          : this.uiState.detail,
    });
  }

  protected pruneStalePeers(now: number): void {
    for (const [peerId, seenAt] of this.lastSeenByPeer) {
      if (now - seenAt <= STALE_PEER_MS) {
        continue;
      }

      this.removePeer(peerId, "stale");
    }
  }

  protected defaultTeam(): TeamAssignment {
    if (this.kind === "webrtc-join") {
      return "bravo";
    }

    return "alpha";
  }

  protected buildParticipantRecord(team = this.defaultTeam()): ParticipantRecord {
    return {
      ...this.identity,
      team,
      joinedAt: Date.now(),
    };
  }

  protected onTransportConnected(): void {
    if (this.kind === "webrtc-join" && !this.joined) {
      this.joined = true;
      this.sendMessage("join-request", {
        participant: this.identity,
        requestedRole: "guest",
        requestedTeam: "bravo",
        mapId: this.mapId,
        capabilities: ["presence-update", "combat-hit", "combat-elimination", "manual-signaling"],
      });
      return;
    }

    if (this.kind !== "webrtc-join") {
      this.rememberParticipant(this.buildParticipantRecord());
      this.sendMessage("participant-update", {
        participant: this.buildParticipantRecord(),
      });
    }
  }

  protected onTransportStatus(status: RoomTransportStatus): void {
    const detail =
      status.phase === "connected" && this.peers.size > 0
        ? `Connected with ${this.peers.size} remote operator${this.peers.size === 1 ? "" : "s"}.`
        : status.detail;

    this.updateUiState({
      phase: status.phase,
      detail,
    });

    if (status.phase === "connected") {
      this.onTransportConnected();
      return;
    }

    if (status.phase === "closed" || status.phase === "error") {
      for (const peerId of [...this.peers.keys()]) {
        this.removePeer(peerId, "leave");
      }
    }
  }

  protected onJoinRequest(message: Extract<RoomMessage, { type: "join-request" }>): void {
    if (this.kind !== "webrtc-host") {
      return;
    }

    if (message.payload.participant.id === this.identity.id) {
      this.sendMessage(
        "join-rejected",
        {
          reason: "duplicate-id",
          detail: "A participant with that operator id is already in this room.",
        },
        message.fromPeerId,
      );
      return;
    }

    const participant: ParticipantRecord = {
      ...message.payload.participant,
      team: message.payload.requestedTeam,
      joinedAt: Date.now(),
    };
    this.rememberParticipant(participant);
    this.sendMessage(
      "join-accepted",
      {
        participant,
        hostPeerId: this.identity.id,
        roomLabel: `${this.identity.name}'s room`,
        roster: [this.buildParticipantRecord("alpha"), participant],
      },
      message.fromPeerId,
    );
    this.sendMessage(
      "participant-update",
      {
        participant: this.buildParticipantRecord("alpha"),
      },
      message.fromPeerId,
    );
  }

  protected onJoinAccepted(message: Extract<RoomMessage, { type: "join-accepted" }>): void {
    if (this.kind !== "webrtc-join") {
      return;
    }

    for (const participant of message.payload.roster) {
      if (participant.id === this.identity.id) {
        continue;
      }
      this.rememberParticipant(participant);
    }

    this.updateUiState({
      detail: `Joined ${message.payload.roomLabel}. Waiting for shared snapshots.`,
    });
  }

  protected onJoinRejected(message: Extract<RoomMessage, { type: "join-rejected" }>): void {
    this.updateUiState({
      phase: "error",
      detail: message.payload.detail,
    });
  }

  protected bindTransport(): void {
    this.transport.setEvents({
      onMessage: (event) => {
        this.handleRawMessage(event.raw);
      },
      onStatus: (status) => {
        this.onTransportStatus(status);
      },
    });

    this.onTransportStatus(this.transport.getStatus());
  }

  protected emitStateChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private readonly handleRawMessage = (raw: string): void => {
    const message = decodeRoomMessage(raw);
    if (!message) {
      return;
    }

    if (message.roomId !== this.roomId || message.fromPeerId === this.identity.id) {
      return;
    }

    if (message.toPeerId && message.toPeerId !== this.identity.id) {
      return;
    }

    if (!isFreshRoomMessage(message)) {
      return;
    }

    const lastSeq = this.lastSeqByPeer.get(message.fromPeerId) ?? 0;
    if (message.seq <= lastSeq) {
      return;
    }
    this.lastSeqByPeer.set(message.fromPeerId, message.seq);
    this.lastSeenByPeer.set(message.fromPeerId, message.sentAt);

    switch (message.type) {
      case "join-request":
        this.onJoinRequest(message);
        return;
      case "join-accepted":
        this.onJoinAccepted(message);
        return;
      case "join-rejected":
        this.onJoinRejected(message);
        return;
      case "participant-update":
        this.rememberParticipant(message.payload.participant);
        return;
      case "presence-update":
        this.rememberPresence(message.payload.presence);
        return;
      case "combat-hit":
        if (message.payload.targetId === this.identity.id) {
          this.handlers.onHit({
            ...message.payload,
            sentAt: message.sentAt,
          });
        }
        return;
      case "combat-elimination":
        this.handlers.onElimination({
          ...message.payload,
          sentAt: message.sentAt,
        });
        return;
      case "disconnect":
        this.removePeer(message.fromPeerId, "leave");
        return;
      case "heartbeat":
      case "input-tick":
      case "host-snapshot":
      case "shot-claim":
      case "shot-result":
      case "objective-event":
        return;
      default:
        return;
    }
  };

  private defaultTitle(): string {
    switch (this.kind) {
      case "broadcast":
        return "Same-Browser Dev Room";
      case "webrtc-host":
        return "WebRTC Host Room";
      case "webrtc-join":
        return "WebRTC Join Room";
    }
  }
}

class BroadcastMatchRoomConnection extends BaseMatchRoomConnection {
  constructor(options: BaseConnectionOptions) {
    super("broadcast", options);
    this.updateUiState({
      detail: "Open the same map in another tab or use the WebRTC room flow for separate browsers.",
    });
  }
}

class HostWebRtcMatchRoomConnection
  extends BaseMatchRoomConnection
  implements HostMatchRoomConnection
{
  private readonly webRtcTransport: WebRtcRoomTransport;
  private offerCode = "";

  constructor(options: BaseConnectionOptions) {
    super("webrtc-host", options);
    this.webRtcTransport = options.transport as WebRtcRoomTransport;
  }

  async createOfferCode(): Promise<string> {
    this.offerCode = await this.webRtcTransport.createOfferCode();
    this.updateUiState({
      offerCode: this.offerCode,
      phase: this.transport.getStatus().phase,
      detail: this.transport.getStatus().detail,
    });
    return this.offerCode;
  }

  async applyAnswerCode(raw: string): Promise<void> {
    await this.webRtcTransport.applyAnswerCode(raw);
    this.updateUiState({
      detail: this.transport.getStatus().detail,
    });
  }
}

class JoinWebRtcMatchRoomConnection
  extends BaseMatchRoomConnection
  implements JoinMatchRoomConnection
{
  private readonly webRtcTransport: WebRtcRoomTransport;
  private answerCode = "";

  constructor(options: BaseConnectionOptions) {
    super("webrtc-join", options);
    this.webRtcTransport = options.transport as WebRtcRoomTransport;
  }

  async acceptOfferCode(raw: string): Promise<string> {
    this.answerCode = await this.webRtcTransport.acceptOfferCode(raw);
    this.updateUiState({
      answerCode: this.answerCode,
      phase: this.transport.getStatus().phase,
      detail: this.transport.getStatus().detail,
    });
    return this.answerCode;
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

export type { CombatantStatus, OutboundRoomPresence, RoomEliminationEvent, RoomHitEvent, RoomPresenceSnapshot };
