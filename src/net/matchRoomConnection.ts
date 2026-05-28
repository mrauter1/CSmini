import {
  BroadcastRoomTransport,
  detectBroadcastTransportSupport,
} from "./broadcastTransport";
import { detectWebRtcSupport } from "./manualSignaling";
import {
  type CombatantStatus,
  decodeRoomMessage,
  encodeRoomMessage,
  type HostRoomSnapshot,
  type ParticipantIdentity,
  type ParticipantRecord,
  type RoomInputTick,
  type RoomLifecyclePhase,
  type RoomMessage,
  type RoomShotClaim,
  type RoomShotResult,
  ROOM_PROTOCOL,
  ROOM_PROTOCOL_VERSION,
  type TeamAssignment,
  isFreshRoomMessage,
} from "./protocol";
import type { RoomTransport, RoomTransportPhase, RoomTransportStatus } from "./transport";
import { WebRtcRoomTransport } from "./webrtcTransport";

const HEARTBEAT_PULSE_MS = 900;
const SNAPSHOT_PULSE_MS = 85;
const STALE_PEER_MS = 2_400;
const BROADCAST_HOST_KEY_PREFIX = "dustline.broadcast-host:";
const OPERATOR_CALLSIGNS = ["Atlas", "Bishop", "Cinder", "Lancer", "Nova", "Pike", "Rivet", "Sable"];
const OPERATOR_ACCENTS = ["#CFA66F", "#6F8FAA", "#819B58", "#B86E4E", "#7A8E96", "#A88E5E"];
const SESSION_KEY = "dustline.operator-seed";

export type MatchMode = "local" | "shared";
export type RoomConnectionKind = "broadcast" | "webrtc-host" | "webrtc-join";
export type MatchRoomRole = "host" | "guest";

export interface RoomIdentity extends ParticipantIdentity {}

export interface RoomInputEvent extends RoomInputTick {
  peerId: string;
  sentAt: number;
}

export interface RoomShotClaimEvent extends RoomShotClaim {
  peerId: string;
  sentAt: number;
}

export interface RoomShotResultEvent extends RoomShotResult {
  peerId: string;
  sentAt: number;
}

export interface SharedRoomHandlers {
  onParticipant: (participant: ParticipantRecord, event: "joined" | "updated") => void;
  onLeave: (peerId: string, reason: "leave" | "stale") => void;
  onInput: (event: RoomInputEvent) => void;
  onShotClaim: (event: RoomShotClaimEvent) => void;
  onShotResult: (event: RoomShotResultEvent) => void;
  onSnapshot: (snapshot: HostRoomSnapshot) => void;
  onRoomClosed: (reason: string) => void;
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
  role: MatchRoomRole;
  hostPeerId?: string;
  participantCount: number;
  peerCount: number;
  peerIds: string[];
  lastSnapshotId: number;
}

export interface MatchRoomConnection {
  readonly kind: RoomConnectionKind;
  readonly role: MatchRoomRole;
  readonly roomId: string;
  readonly identity: RoomIdentity;
  readonly hostPeerId?: string;
  readonly participantsSnapshot: ParticipantRecord[];
  readonly latestSnapshot?: HostRoomSnapshot;
  readonly uiSnapshot: RoomConnectionUiSnapshot;
  setHandlers(handlers: SharedRoomHandlers): void;
  publishHostSnapshot(snapshot: HostRoomSnapshot, force?: boolean): void;
  sendInputTick(input: RoomInputTick): boolean;
  sendShotClaim(claim: RoomShotClaim): boolean;
  sendShotResult(result: RoomShotResult, toPeerId?: string): boolean;
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
  role: MatchRoomRole;
  hostPeerId?: string;
  handlers: SharedRoomHandlers;
  transport: RoomTransport;
}

interface BroadcastHostClaim {
  peerId: string;
  updatedAt: number;
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
  const hostClaim = claimBroadcastHost(roomId, identity.id);
  const transport = new BroadcastRoomTransport(roomId, identity.id, {
    onMessage: () => undefined,
  });

  return new BroadcastMatchRoomConnection(
    {
      roomId,
      mapId,
      identity,
      role: hostClaim.peerId === identity.id ? "host" : "guest",
      hostPeerId: hostClaim.peerId,
      handlers,
      transport,
    },
    `${BROADCAST_HOST_KEY_PREFIX}${roomId}`,
  );
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
    role: "host",
    hostPeerId: identity.id,
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
    role: "guest",
    handlers,
    transport,
  });
}

abstract class BaseMatchRoomConnection implements MatchRoomConnection {
  readonly roomId: string;
  readonly role: MatchRoomRole;
  readonly identity: RoomIdentity;
  readonly participants = new Map<string, ParticipantRecord>();
  readonly lastSeqByPeer = new Map<string, number>();
  readonly lastSeenByPeer = new Map<string, number>();
  readonly listeners = new Set<() => void>();

  hostPeerId?: string;
  latestSnapshot?: HostRoomSnapshot;

  protected readonly mapId: string;
  protected handlers: SharedRoomHandlers;
  protected readonly transport: RoomTransport;
  protected lastHeartbeatAt = 0;
  protected lastSnapshotSentAt = 0;
  protected nextSeq = 1;
  protected joined = false;
  protected roomClosed = false;
  protected uiState: RoomConnectionUiSnapshot;

  protected constructor(
    readonly kind: RoomConnectionKind,
    options: BaseConnectionOptions,
  ) {
    this.roomId = options.roomId;
    this.mapId = options.mapId;
    this.role = options.role;
    this.identity = options.identity;
    this.hostPeerId = options.hostPeerId;
    this.handlers = options.handlers;
    this.transport = options.transport;
    this.uiState = this.createUiState(this.transport.getStatus());

    this.bindTransport();
  }

  get participantsSnapshot(): ParticipantRecord[] {
    return [...this.participants.values()].sort((left, right) => {
      if (left.joinedAt !== right.joinedAt) {
        return left.joinedAt - right.joinedAt;
      }
      return left.name.localeCompare(right.name);
    });
  }

  get uiSnapshot(): RoomConnectionUiSnapshot {
    return this.uiState;
  }

  setHandlers(handlers: SharedRoomHandlers): void {
    this.handlers = handlers;
  }

  publishHostSnapshot(snapshot: HostRoomSnapshot, force = false): void {
    if (this.role !== "host") {
      return;
    }

    this.latestSnapshot = snapshot;

    const now = Date.now();
    if (!force && now - this.lastSnapshotSentAt < SNAPSHOT_PULSE_MS) {
      return;
    }

    this.flushSnapshot(now);
  }

  sendInputTick(input: RoomInputTick): boolean {
    if (this.role !== "guest") {
      return false;
    }

    return this.sendMessage("input-tick", input, this.hostPeerId);
  }

  sendShotClaim(claim: RoomShotClaim): boolean {
    if (this.role !== "guest") {
      return false;
    }

    return this.sendMessage("shot-claim", claim, this.hostPeerId);
  }

  sendShotResult(result: RoomShotResult, toPeerId?: string): boolean {
    if (this.role !== "host") {
      return false;
    }

    return this.sendMessage("shot-result", result, toPeerId);
  }

  tick(now = Date.now()): void {
    this.pruneStalePeers(now);

    if (
      this.role === "host" &&
      this.latestSnapshot &&
      now - this.lastSnapshotSentAt >= SNAPSHOT_PULSE_MS
    ) {
      this.flushSnapshot(now);
    }

    if (now - this.lastHeartbeatAt >= HEARTBEAT_PULSE_MS) {
      const phase = this.latestSnapshot?.phase ?? this.defaultLifecyclePhase();
      this.sendMessage("heartbeat", {
        rosterCount: this.participants.size,
        phase,
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
      role: this.role,
      hostPeerId: this.hostPeerId,
      participantCount: this.participants.size,
      peerCount: this.remoteParticipants().length,
      peerIds: this.remoteParticipants().map((participant) => participant.id),
      lastSnapshotId: this.latestSnapshot?.snapshotId ?? 0,
    };
  }

  protected createUiState(status: RoomTransportStatus): RoomConnectionUiSnapshot {
    return {
      kind: this.kind,
      phase: status.phase,
      title: this.defaultTitle(),
      detail: status.detail,
      remoteName: this.remoteParticipants()[0]?.name,
    };
  }

  protected updateUiState(update: Partial<RoomConnectionUiSnapshot>): void {
    this.uiState = {
      ...this.uiState,
      ...update,
      kind: this.kind,
      title: update.title ?? this.uiState.title,
      remoteName:
        this.remoteParticipants()[0]?.name ?? update.remoteName ?? this.uiState.remoteName,
    };
    this.emitStateChange();
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
    const existing = this.participants.get(participant.id);
    this.participants.set(participant.id, participant);

    if (participant.id === this.identity.id) {
      return;
    }

    this.lastSeenByPeer.set(participant.id, Date.now());
    this.handlers.onParticipant(participant, existing ? "updated" : "joined");
    this.updateUiState({
      remoteName: participant.name,
    });
  }

  protected removePeer(peerId: string, reason: "leave" | "stale"): void {
    const removedParticipant = this.participants.get(peerId);
    this.participants.delete(peerId);
    this.lastSeenByPeer.delete(peerId);
    this.lastSeqByPeer.delete(peerId);

    if (removedParticipant) {
      this.handlers.onLeave(peerId, reason);
    }

    const hostRemoved = peerId === this.hostPeerId && peerId !== this.identity.id;
    if (hostRemoved && this.role === "guest") {
      this.notifyRoomClosed(
        reason === "stale" ? "Host room timed out." : "The host ended the room.",
      );
      return;
    }

    this.updateUiState({
      remoteName: this.remoteParticipants()[0]?.name,
      detail:
        this.transport.getStatus().phase === "connected"
          ? this.remoteParticipants().length > 0
            ? `Connected with ${this.remoteParticipants().length} remote operator${
                this.remoteParticipants().length === 1 ? "" : "s"
              }.`
            : this.role === "host"
              ? "Connected. Awaiting another operator."
              : "Connected. Waiting for host snapshots."
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
    return this.role === "host" ? "alpha" : "bravo";
  }

  protected buildParticipantRecord(team = this.defaultTeam()): ParticipantRecord {
    return {
      ...this.identity,
      team,
      joinedAt: Date.now(),
    };
  }

  protected onTransportConnected(): void {
    this.roomClosed = false;
    this.rememberParticipant(this.buildParticipantRecord());

    if (this.kind === "webrtc-join" && !this.joined) {
      this.joined = true;
      this.sendMessage("join-request", {
        participant: this.identity,
        requestedRole: "guest",
        requestedTeam: "bravo",
        mapId: this.mapId,
        capabilities: ["input-tick", "host-snapshot", "manual-signaling"],
      });
      return;
    }

    if (this.role === "host") {
      this.hostPeerId = this.identity.id;
    }

    this.sendMessage("participant-update", {
      participant: this.buildParticipantRecord(),
    });
  }

  protected onTransportStatus(status: RoomTransportStatus): void {
    const detail =
      status.phase === "connected" && this.remoteParticipants().length > 0
        ? `Connected with ${this.remoteParticipants().length} remote operator${
            this.remoteParticipants().length === 1 ? "" : "s"
          }.`
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
      if (this.role === "guest" && !this.roomClosed) {
        this.notifyRoomClosed(
          status.phase === "error" ? "The host connection failed." : "The room connection closed.",
        );
        return;
      }

      for (const peerId of [...this.lastSeenByPeer.keys()]) {
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

    if (this.remoteParticipants().length >= 1) {
      this.sendMessage(
        "join-rejected",
        {
          reason: "room-full",
          detail: "This browser-hosted room is currently limited to one remote operator.",
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
        roster: this.participantsSnapshot,
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

    this.hostPeerId = message.payload.hostPeerId;
    this.participants.clear();

    for (const participant of message.payload.roster) {
      this.rememberParticipant(participant);
    }

    this.rememberParticipant(message.payload.participant);
    this.updateUiState({
      detail: `Joined ${message.payload.roomLabel}. Waiting for host snapshots.`,
    });
  }

  protected onJoinRejected(message: Extract<RoomMessage, { type: "join-rejected" }>): void {
    this.updateUiState({
      phase: "error",
      detail: message.payload.detail,
    });
  }

  protected notifyRoomClosed(reason: string): void {
    if (this.roomClosed) {
      return;
    }

    this.roomClosed = true;
    this.updateUiState({
      phase: "closed",
      detail: reason,
    });
    this.handlers.onRoomClosed(reason);
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

  protected remoteParticipants(): ParticipantRecord[] {
    return this.participantsSnapshot.filter((participant) => participant.id !== this.identity.id);
  }

  protected defaultLifecyclePhase(): RoomLifecyclePhase {
    return this.remoteParticipants().length > 0 ? "active" : "waiting";
  }

  private flushSnapshot(now: number): void {
    if (!this.latestSnapshot) {
      return;
    }

    this.lastSnapshotSentAt = now;
    this.sendMessage("host-snapshot", this.latestSnapshot);
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
      case "input-tick":
        if (this.role === "host") {
          this.handlers.onInput({
            peerId: message.fromPeerId,
            sentAt: message.sentAt,
            ...message.payload,
          });
        }
        return;
      case "host-snapshot":
        if (this.role !== "guest") {
          return;
        }

        if (this.hostPeerId && message.fromPeerId !== this.hostPeerId) {
          return;
        }

        this.latestSnapshot = message.payload;
        this.handlers.onSnapshot(message.payload);
        return;
      case "shot-claim":
        if (this.role === "host") {
          this.handlers.onShotClaim({
            peerId: message.fromPeerId,
            sentAt: message.sentAt,
            ...message.payload,
          });
        }
        return;
      case "shot-result":
        if (this.role === "guest") {
          this.handlers.onShotResult({
            peerId: message.fromPeerId,
            sentAt: message.sentAt,
            ...message.payload,
          });
        }
        return;
      case "objective-event":
        return;
      case "heartbeat":
        return;
      case "disconnect":
        this.removePeer(message.fromPeerId, "leave");
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
  constructor(
    options: BaseConnectionOptions,
    private readonly hostClaimKey: string,
  ) {
    super("broadcast", options);
    this.updateUiState({
      detail:
        this.role === "host"
          ? "Dev-room host armed. Open the same map in another tab."
          : "Dev-room guest ready. Waiting for host snapshots.",
    });
  }

  override tick(now = Date.now()): void {
    if (this.role === "host") {
      writeBroadcastHostClaim(this.hostClaimKey, {
        peerId: this.identity.id,
        updatedAt: now,
      });
    } else if (!this.roomClosed) {
      const claim = readBroadcastHostClaim(this.hostClaimKey);
      if (!claim || claim.peerId !== this.hostPeerId || now - claim.updatedAt > STALE_PEER_MS) {
        this.notifyRoomClosed("The dev-room host is no longer available.");
      }
    }

    super.tick(now);
  }

  override dispose(): void {
    if (this.role === "host") {
      const claim = readBroadcastHostClaim(this.hostClaimKey);
      if (claim?.peerId === this.identity.id) {
        clearBroadcastHostClaim(this.hostClaimKey);
      }
    }

    super.dispose();
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

function claimBroadcastHost(roomId: string, peerId: string): BroadcastHostClaim {
  const key = `${BROADCAST_HOST_KEY_PREFIX}${roomId}`;
  const now = Date.now();
  const existing = readBroadcastHostClaim(key);

  if (!existing || now - existing.updatedAt > STALE_PEER_MS) {
    const claim = {
      peerId,
      updatedAt: now,
    };
    writeBroadcastHostClaim(key, claim);
    return claim;
  }

  return existing;
}

function readBroadcastHostClaim(key: string): BroadcastHostClaim | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as BroadcastHostClaim).peerId === "string" &&
      typeof (parsed as BroadcastHostClaim).updatedAt === "number"
    ) {
      return parsed as BroadcastHostClaim;
    }
  } catch {
    // Ignore storage corruption and fall back to a fresh claim.
  }

  return null;
}

function writeBroadcastHostClaim(key: string, claim: BroadcastHostClaim): void {
  try {
    localStorage.setItem(key, JSON.stringify(claim));
  } catch {
    // Storage can be unavailable in hardened/private contexts.
  }
}

function clearBroadcastHostClaim(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage cleanup failures.
  }
}

export type { CombatantStatus, HostRoomSnapshot, ParticipantRecord, RoomInputTick, TeamAssignment };
