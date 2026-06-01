import {
  BroadcastRoomTransport,
  detectBroadcastTransportSupport,
} from "./broadcastTransport";
import { opposingTeam } from "../game/teams";
import { detectWebRtcSupport } from "./manualSignaling";
import { detectSignaledWebRtcSupport, SignaledWebRtcRoomTransport } from "./signaledWebRtcTransport";
import {
  type CombatantStatus,
  decodeRoomMessage,
  encodeRoomMessage,
  getRoomMessageLane,
  getRoomMessageSequenceScope,
  type HostSnapshotEncodingMode,
  type HostRoomSnapshot,
  MAX_ROOM_INVALID_MESSAGES,
  MAX_ROOM_MESSAGE_BYTES,
  measureRoomMessageBytes,
  type ParticipantIdentity,
  type ParticipantRecord,
  type RoomInputTick,
  type RoomLifecyclePhase,
  type RoomMessage,
  type RoomMessageSequenceScope,
  type RoomShotClaim,
  type RoomShotResult,
  ROOM_PROTOCOL,
  ROOM_PROTOCOL_VERSION,
  type TeamAssignment,
} from "./protocol";
import type {
  RoomTransport,
  RoomTransportDebugSnapshot,
  RoomTransportMessageEvent,
  RoomTransportPhase,
  RoomTransportSendOptions,
  RoomTransportStatus,
} from "./transport";
import { WebRtcRoomTransport } from "./webrtcTransport";

const HEARTBEAT_PULSE_MS = 900;
const SNAPSHOT_PULSE_MS = 85;
const SNAPSHOT_KEEPALIVE_MS = 1_000;
const FULL_SNAPSHOT_PULSE_MS = 8_000;
const STALE_PEER_MS = 60_000;
const RELAY_IDLE_WARNING_MS = 180_000;
const RELAY_IDLE_DISCONNECT_MS = 240_000;
const RELAY_IDLE_POLL_MS = 1_000;
const RELAY_IDLE_REASON = "relay-idle-timeout";
export const MAX_ROOM_PARTICIPANTS = 14;
export const MAX_ROOM_GUESTS = MAX_ROOM_PARTICIPANTS - 1;
const BROADCAST_HOST_KEY_PREFIX = "dustline.broadcast-host:";
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const OPERATOR_CALLSIGNS = ["Atlas", "Bishop", "Cinder", "Lancer", "Nova", "Pike", "Rivet", "Sable"];
const OPERATOR_ACCENTS = ["#CFA66F", "#6F8FAA", "#819B58", "#B86E4E", "#7A8E96", "#A88E5E"];
const SESSION_KEY = "dustline.operator-seed";

export type MatchMode = "local" | "shared";
export type RoomConnectionKind =
  | "signal-host"
  | "signal-join"
  | "broadcast"
  | "webrtc-host"
  | "webrtc-join";
export type MatchRoomRole = "host" | "guest";
export type CloudRoomVisibility = "private" | "public";

export interface RoomIdentity extends ParticipantIdentity {}

export interface RoomInputEvent extends RoomInputTick {
  peerId: string;
  sentAt: number;
  receivedAt: number;
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
  roomCode?: string;
  signalingUrl?: string;
  remoteName?: string;
}

export interface RoomConnectionDebugSnapshot extends RoomConnectionUiSnapshot {
  role: MatchRoomRole;
  hostPeerId?: string;
  participantCount: number;
  peerCount: number;
  peerIds: string[];
  lastSnapshotId: number;
  lastSnapshotBytes: number;
  lastSnapshotEncoding: HostSnapshotEncodingMode | "none";
  transport: RoomTransportDebugSnapshot | null;
  latestStateQa: {
    inbound: LatestStateQaDebugSnapshot;
    outbound: LatestStateQaDebugSnapshot;
  };
  relayIdle: RelayIdleDebugSnapshot;
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
  debugSendRawRoomMessage?: (raw: string, toPeerId?: string) => boolean;
  debugConfigureLatestStateQa?: (
    direction: LatestStateQaDirection,
    config?: LatestStateQaConfig | null,
  ) => boolean;
  debugConfigureRelayIdleQa?: (config?: RelayIdleQaConfig | null) => boolean;
  debugSendSignalingPayload?: (payload: Record<string, unknown>) => boolean;
  debugInjectSignalingMessage?: (raw: string) => boolean;
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
  localTeam: TeamAssignment;
  requestedTeam: TeamAssignment;
  hostPeerId?: string;
  handlers: SharedRoomHandlers;
  transport: RoomTransport;
}

export type LatestStateQaDirection = "inbound" | "outbound";

export interface LatestStateQaConfig {
  hold?: boolean;
  dropNextCount?: number;
  duplicateNextCount?: number;
  delayMs?: number;
  delayScheduleMs?: number[];
}

export interface LatestStateQaDebugSnapshot {
  hold: boolean;
  pending: boolean;
  dropNextCount: number;
  duplicateNextCount: number;
  delayMs: number;
  delayScheduleRemaining: number;
}

export interface RelayIdleQaConfig {
  forceRelay?: boolean;
  warningMs?: number;
  disconnectMs?: number;
  disabled?: boolean;
}

export interface RelayIdleDebugPeerSnapshot {
  peerId: string;
  subjectPeerId: string;
  usingRelay: boolean;
  lastGameplayActivityAt: number;
  idleMs: number;
  warned: boolean;
}

export interface RelayIdleDebugSnapshot {
  warningMs: number;
  disconnectMs: number;
  forcedRelay: boolean;
  disabled: boolean;
  activeRelayPeerCount: number;
  peers: RelayIdleDebugPeerSnapshot[];
}

interface BroadcastHostClaim {
  peerId: string;
  updatedAt: number;
}

type LatestStateSequenceState = Partial<
  Record<Exclude<RoomMessageSequenceScope, "reliable">, number>
>;

interface PendingLatestStateOutboundMessage {
  raw: string;
  toPeerId?: string;
  transportOptions?: RoomTransportSendOptions;
}

interface LatestStateQaController {
  hold: boolean;
  dropNextCount: number;
  duplicateNextCount: number;
  delayMs: number;
  delayScheduleMs: number[];
  timers: Set<number>;
  pendingOutbound?: PendingLatestStateOutboundMessage;
}

function createLatestStateQaController(): LatestStateQaController {
  return {
    hold: false,
    dropNextCount: 0,
    duplicateNextCount: 0,
    delayMs: 0,
    delayScheduleMs: [],
    timers: new Set<number>(),
  };
}

function clampLatestStateQaCount(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value ?? 0));
}

function clampLatestStateQaDelay(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value ?? 0));
}

function sanitizeLatestStateQaDelaySchedule(values: number[] | undefined): number[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => clampLatestStateQaDelay(value))
    .filter((value) => value > 0)
    .slice(0, 64);
}

function sanitizeRelayIdleMs(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(100, Math.floor(value ?? fallback));
}

export function detectSharedRoomSupport(kind: RoomConnectionKind): {
  supported: boolean;
  reason: string;
} {
  if (kind === "broadcast") {
    return detectBroadcastTransportSupport();
  }

  if (kind === "signal-host" || kind === "signal-join") {
    return detectSignaledWebRtcSupport();
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

export function buildSignaledRoomId(mapId: string, roomCode: string): string {
  return `dustline-room:${mapId}:${normalizeRoomCode(roomCode)}`;
}

export function createRoomCode(length = 6): string {
  const values = new Uint32Array(length);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(values);
  } else {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    }
  }

  return [...values]
    .map((value) => ROOM_CODE_ALPHABET[value % ROOM_CODE_ALPHABET.length])
    .join("");
}

export function normalizeRoomCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

export function createBroadcastMatchRoomConnection(
  roomId: string,
  mapId: string,
  identity: RoomIdentity,
  handlers: SharedRoomHandlers,
  localTeam: TeamAssignment,
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
      localTeam,
      requestedTeam: localTeam,
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
  localTeam: TeamAssignment,
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
    localTeam,
    requestedTeam: localTeam,
    hostPeerId: identity.id,
    handlers,
    transport,
  });
}

export function createSignaledHostMatchRoomConnection(
  roomId: string,
  mapId: string,
  identity: RoomIdentity,
  handlers: SharedRoomHandlers,
  sessionLabel: string,
  signalingUrl: string,
  roomCode: string,
  localTeam: TeamAssignment,
  visibility: CloudRoomVisibility = "private",
  mapName = mapId,
): MatchRoomConnection {
  const transport = new SignaledWebRtcRoomTransport(
    {
      role: "host",
      roomId,
      mapId,
      roomCode,
      mapName,
      visibility,
      localParticipant: identity,
      sessionLabel,
      signalingUrl,
    },
    {
      onMessage: () => undefined,
    },
  );

  return new SignaledWebRtcMatchRoomConnection(
    "signal-host",
    {
      roomId,
      mapId,
      identity,
      role: "host",
      localTeam,
      requestedTeam: localTeam,
      hostPeerId: identity.id,
      handlers,
      transport,
    },
    roomCode,
    signalingUrl,
  );
}

export function createSignaledJoinMatchRoomConnection(
  roomId: string,
  mapId: string,
  identity: RoomIdentity,
  handlers: SharedRoomHandlers,
  signalingUrl: string,
  roomCode: string,
  requestedTeam: TeamAssignment,
): MatchRoomConnection {
  const transport = new SignaledWebRtcRoomTransport(
    {
      role: "guest",
      roomId,
      mapId,
      localParticipant: identity,
      sessionLabel: "",
      signalingUrl,
    },
    {
      onMessage: () => undefined,
    },
  );

  return new SignaledWebRtcMatchRoomConnection(
    "signal-join",
    {
      roomId,
      mapId,
      identity,
      role: "guest",
      localTeam: requestedTeam,
      requestedTeam,
      handlers,
      transport,
    },
    roomCode,
    signalingUrl,
  );
}

export function createJoinMatchRoomConnection(
  roomId: string,
  mapId: string,
  identity: RoomIdentity,
  handlers: SharedRoomHandlers,
  requestedTeam: TeamAssignment,
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
    localTeam: requestedTeam,
    requestedTeam,
    handlers,
    transport,
  });
}

abstract class BaseMatchRoomConnection implements MatchRoomConnection {
  readonly roomId: string;
  readonly role: MatchRoomRole;
  readonly identity: RoomIdentity;
  readonly participants = new Map<string, ParticipantRecord>();
  readonly lastReliableSeqByPeer = new Map<string, number>();
  readonly lastLatestSeqByPeer = new Map<string, LatestStateSequenceState>();
  readonly lastSeenByPeer = new Map<string, number>();
  readonly invalidRoomMessagesByPeer = new Map<string, number>();
  readonly relayGameplayActivityByPeer = new Map<string, number>();
  readonly relayInputSignatureByPeer = new Map<string, string>();
  readonly relayIdleWarnedSubjects = new Set<string>();
  readonly listeners = new Set<() => void>();

  hostPeerId?: string;
  latestSnapshot?: HostRoomSnapshot;

  protected readonly mapId: string;
  protected readonly localTeam: TeamAssignment;
  protected readonly requestedTeam: TeamAssignment;
  protected handlers: SharedRoomHandlers;
  protected readonly transport: RoomTransport;
  protected lastHeartbeatAt = 0;
  protected lastSnapshotSentAt = 0;
  protected lastLatestStateSentAt = 0;
  protected nextSeq = 1;
  protected joined = false;
  protected roomClosed = false;
  protected uiState: RoomConnectionUiSnapshot;
  private relayIdleTimer = 0;
  private relayIdleWarningMs = RELAY_IDLE_WARNING_MS;
  private relayIdleDisconnectMs = RELAY_IDLE_DISCONNECT_MS;
  private relayIdleForceRelay = false;
  private relayIdleDisabled = false;
  private pendingSnapshotSignature = "";
  private lastSentSnapshotSignature = "";
  private lastFullSnapshotSentAt = 0;
  private lastSnapshotBytes = 0;
  private lastSnapshotEncoding: HostSnapshotEncodingMode | "none" = "none";
  private readonly latestStateQa = {
    inbound: createLatestStateQaController(),
    outbound: createLatestStateQaController(),
  };

  protected constructor(
    readonly kind: RoomConnectionKind,
    options: BaseConnectionOptions,
  ) {
    this.roomId = options.roomId;
    this.mapId = options.mapId;
    this.role = options.role;
    this.identity = options.identity;
    this.localTeam = options.localTeam;
    this.requestedTeam = options.requestedTeam;
    this.hostPeerId = options.hostPeerId;
    this.handlers = options.handlers;
    this.transport = options.transport;
    this.uiState = this.createUiState(this.transport.getStatus());

    this.noteRelayGameplayActivity(this.identity.id);
    this.startRelayIdleMonitor();
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
    this.pendingSnapshotSignature = hostSnapshotTrafficSignature(snapshot);

    const now = Date.now();
    if (force) {
      this.flushSnapshot(now, "full");
      return;
    }

    const changed = this.pendingSnapshotSignature !== this.lastSentSnapshotSignature;
    if (!changed && now - this.lastSnapshotSentAt < SNAPSHOT_KEEPALIVE_MS) {
      return;
    }

    if (!force && now - this.lastSnapshotSentAt < SNAPSHOT_PULSE_MS) {
      if (changed) {
        this.refreshBufferedSnapshot(now, this.snapshotEncodingMode(now));
      }
      return;
    }

    this.flushSnapshot(now, this.snapshotEncodingMode(now));
  }

  sendInputTick(input: RoomInputTick): boolean {
    if (this.role !== "guest") {
      return false;
    }

    const sent = this.sendMessage("input-tick", input, this.hostPeerId);
    if (sent && this.inputTickHasGameplayActivity(this.identity.id, input)) {
      this.noteRelayGameplayActivity(this.identity.id);
    }
    return sent;
  }

  sendShotClaim(claim: RoomShotClaim): boolean {
    if (this.role !== "guest") {
      return false;
    }

    const sent = this.sendMessage("shot-claim", claim, this.hostPeerId);
    if (sent) {
      this.noteRelayGameplayActivity(this.identity.id);
    }
    return sent;
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
      now - this.lastSnapshotSentAt >= SNAPSHOT_PULSE_MS &&
      (this.pendingSnapshotSignature !== this.lastSentSnapshotSignature ||
        now - this.lastSnapshotSentAt >= SNAPSHOT_KEEPALIVE_MS)
    ) {
      this.flushSnapshot(now, this.snapshotEncodingMode(now));
    }

    if (
      now - this.lastHeartbeatAt >= HEARTBEAT_PULSE_MS &&
      now - this.lastLatestStateSentAt >= HEARTBEAT_PULSE_MS
    ) {
      const phase = this.latestSnapshot?.phase ?? this.defaultLifecyclePhase();
      this.sendMessage("heartbeat", {
        rosterCount: this.participants.size,
        phase,
      });
      this.lastHeartbeatAt = now;
    }
  }

  dispose(): void {
    this.stopRelayIdleMonitor();
    this.clearLatestStateQaTimers("inbound");
    this.clearLatestStateQaTimers("outbound");
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
      lastSnapshotBytes: this.lastSnapshotBytes,
      lastSnapshotEncoding: this.lastSnapshotEncoding,
      transport: this.transport.getDebugSnapshot?.() ?? null,
      latestStateQa: {
        inbound: this.snapshotLatestStateQa("inbound"),
        outbound: this.snapshotLatestStateQa("outbound"),
      },
      relayIdle: this.snapshotRelayIdle(),
    };
  }

  debugSendRawRoomMessage(raw: string, toPeerId?: string): boolean {
    const message = decodeRoomMessage(raw);
    return this.transport.send(
      raw,
      toPeerId,
      message ? getRoomMessageLane(message.type) : "reliable",
    );
  }

  debugConfigureLatestStateQa(
    direction: LatestStateQaDirection,
    config?: LatestStateQaConfig | null,
  ): boolean {
    const controller = this.latestStateQa[direction];
    const wasHolding = controller.hold;

    controller.hold = direction === "outbound" ? Boolean(config?.hold) : false;
    controller.dropNextCount = clampLatestStateQaCount(config?.dropNextCount);
    controller.duplicateNextCount = clampLatestStateQaCount(config?.duplicateNextCount);
    controller.delayMs = clampLatestStateQaDelay(config?.delayMs);
    controller.delayScheduleMs = sanitizeLatestStateQaDelaySchedule(config?.delayScheduleMs);

    if (direction === "outbound" && wasHolding && !controller.hold && controller.pendingOutbound) {
      const pending = controller.pendingOutbound;
      controller.pendingOutbound = undefined;
      this.dispatchLatestStateOutbound(pending.raw, pending.toPeerId, pending.transportOptions);
    }

    this.emitStateChange();
    return true;
  }

  debugConfigureRelayIdleQa(config?: RelayIdleQaConfig | null): boolean {
    this.relayIdleWarningMs = sanitizeRelayIdleMs(config?.warningMs, RELAY_IDLE_WARNING_MS);
    this.relayIdleDisconnectMs = Math.max(
      this.relayIdleWarningMs + 100,
      sanitizeRelayIdleMs(config?.disconnectMs, RELAY_IDLE_DISCONNECT_MS),
    );
    this.relayIdleForceRelay = Boolean(config?.forceRelay);
    this.relayIdleDisabled = Boolean(config?.disabled);
    this.relayGameplayActivityByPeer.clear();
    this.relayIdleWarnedSubjects.clear();
    this.noteRelayGameplayActivity(this.identity.id);
    for (const participant of this.remoteParticipants()) {
      this.noteRelayGameplayActivity(participant.id);
    }
    this.refreshRelayIdleUi();
    this.checkRelayIdle(Date.now());
    return true;
  }

  private startRelayIdleMonitor(): void {
    if (this.relayIdleTimer || typeof window === "undefined") {
      return;
    }

    this.relayIdleTimer = window.setInterval(() => {
      this.checkRelayIdle(Date.now());
    }, RELAY_IDLE_POLL_MS);
  }

  private stopRelayIdleMonitor(): void {
    if (!this.relayIdleTimer || typeof window === "undefined") {
      return;
    }

    window.clearInterval(this.relayIdleTimer);
    this.relayIdleTimer = 0;
  }

  private noteRelayGameplayActivity(peerId: string, now = Date.now()): void {
    this.relayGameplayActivityByPeer.set(peerId, now);
    if (this.relayIdleWarnedSubjects.delete(peerId)) {
      this.refreshRelayIdleUi();
    }
  }

  private inputTickHasGameplayActivity(peerId: string, input: RoomInputTick): boolean {
    const movementActive = Math.hypot(input.movement[0], input.movement[1]) > 0.01;
    const actionsActive = input.actions.length > 0;
    const lookSignature = input.look.map((value) => value.toFixed(2)).join(",");
    const previousSignature = this.relayInputSignatureByPeer.get(peerId);
    this.relayInputSignatureByPeer.set(peerId, lookSignature);

    return (
      movementActive ||
      actionsActive ||
      (previousSignature !== undefined && previousSignature !== lookSignature)
    );
  }

  private relayIdleSubjectForPeer(peerId: string): string {
    return this.role === "guest" ? this.identity.id : peerId;
  }

  private activeRelayPeerIds(): string[] {
    const statsPeers = this.transport.getDebugSnapshot?.().peers ?? [];
    const peerIds = new Set<string>();

    for (const stats of statsPeers) {
      if (stats.usingRelay) {
        peerIds.add(stats.peerId);
      }
    }

    if (this.relayIdleForceRelay) {
      for (const participant of this.remoteParticipants()) {
        peerIds.add(participant.id);
      }
      for (const stats of statsPeers) {
        peerIds.add(stats.peerId);
      }
    }

    return [...peerIds].filter((peerId) => peerId !== this.identity.id);
  }

  private checkRelayIdle(now: number): void {
    if (this.roomClosed || this.relayIdleDisabled) {
      return;
    }

    const relayPeerIds = this.activeRelayPeerIds();
    if (relayPeerIds.length === 0) {
      this.resetRelayIdleClock(now);
      return;
    }

    for (const peerId of relayPeerIds) {
      const subjectPeerId = this.relayIdleSubjectForPeer(peerId);
      const lastActivityAt = this.relayGameplayActivityByPeer.get(subjectPeerId) ?? now;
      if (!this.relayGameplayActivityByPeer.has(subjectPeerId)) {
        this.relayGameplayActivityByPeer.set(subjectPeerId, lastActivityAt);
      }

      const idleMs = now - lastActivityAt;
      if (idleMs >= this.relayIdleDisconnectMs) {
        this.disconnectRelayIdlePeer(peerId);
        continue;
      }

      if (idleMs >= this.relayIdleWarningMs) {
        this.relayIdleWarnedSubjects.add(subjectPeerId);
      } else if (this.relayIdleWarnedSubjects.delete(subjectPeerId)) {
        this.refreshRelayIdleUi();
      }
    }

    this.refreshRelayIdleUi();
  }

  private disconnectRelayIdlePeer(peerId: string): void {
    const subjectPeerId = this.relayIdleSubjectForPeer(peerId);
    this.relayIdleWarnedSubjects.delete(subjectPeerId);

    const seconds = Math.round(this.relayIdleDisconnectMs / 1_000);
    if (this.role === "guest") {
      this.sendMessage("disconnect", { reason: RELAY_IDLE_REASON }, peerId);
      this.notifyRoomClosed(`Disconnected from relay room after ${seconds}s without gameplay input.`);
      this.transport.close(RELAY_IDLE_REASON);
      return;
    }

    const participantName = this.participants.get(peerId)?.name ?? "A relay operator";
    const detail = `${participantName} was disconnected after ${seconds}s without gameplay input.`;
    this.sendMessage("disconnect", { reason: RELAY_IDLE_REASON }, peerId);
    this.transport.disconnectPeer?.(peerId, RELAY_IDLE_REASON);
    this.removePeer(peerId, "leave", detail);
    this.updateUiState({ detail });
  }

  private resetRelayIdleClock(now: number): void {
    const hadWarning = this.relayIdleWarnedSubjects.size > 0;
    this.relayIdleWarnedSubjects.clear();
    this.relayGameplayActivityByPeer.clear();
    this.relayInputSignatureByPeer.clear();
    this.relayGameplayActivityByPeer.set(this.identity.id, now);
    for (const participant of this.remoteParticipants()) {
      this.relayGameplayActivityByPeer.set(participant.id, now);
    }
    if (hadWarning) {
      this.refreshRelayIdleUi();
    }
  }

  private refreshRelayIdleUi(): void {
    if (this.roomClosed || this.transport.getStatus().phase !== "connected") {
      return;
    }

    const warnedPeerId = this.firstWarnedRelayPeerId();
    if (!warnedPeerId) {
      const detail = this.connectedDetail();
      if (this.uiState.detail !== detail) {
        this.updateUiState({ detail });
      }
      return;
    }

    const subjectPeerId = this.relayIdleSubjectForPeer(warnedPeerId);
    const lastActivityAt = this.relayGameplayActivityByPeer.get(subjectPeerId) ?? Date.now();
    const remainingSeconds = Math.max(
      1,
      Math.ceil((this.relayIdleDisconnectMs - (Date.now() - lastActivityAt)) / 1_000),
    );
    const subjectLabel =
      this.role === "guest"
        ? "You"
        : this.participants.get(warnedPeerId)?.name ?? "Relay operator";
    const verb = this.role === "guest" ? "will be disconnected" : "will be disconnected";

    const detail = `Relay idle warning: ${subjectLabel} ${verb} in ${remainingSeconds}s unless gameplay input resumes.`;
    if (this.uiState.detail !== detail) {
      this.updateUiState({ detail });
    }
  }

  private firstWarnedRelayPeerId(): string | null {
    for (const peerId of this.activeRelayPeerIds()) {
      const subjectPeerId = this.relayIdleSubjectForPeer(peerId);
      if (this.relayIdleWarnedSubjects.has(subjectPeerId)) {
        return peerId;
      }
    }

    return null;
  }

  private snapshotRelayIdle(): RelayIdleDebugSnapshot {
    const now = Date.now();
    const activeRelayPeerIds = new Set(this.activeRelayPeerIds());
    const peers = this.remoteParticipants().map((participant) => {
      const subjectPeerId = this.relayIdleSubjectForPeer(participant.id);
      const lastGameplayActivityAt = this.relayGameplayActivityByPeer.get(subjectPeerId) ?? 0;
      return {
        peerId: participant.id,
        subjectPeerId,
        usingRelay: activeRelayPeerIds.has(participant.id),
        lastGameplayActivityAt,
        idleMs: lastGameplayActivityAt > 0 ? Math.max(0, now - lastGameplayActivityAt) : 0,
        warned: this.relayIdleWarnedSubjects.has(subjectPeerId),
      };
    });

    return {
      warningMs: this.relayIdleWarningMs,
      disconnectMs: this.relayIdleDisconnectMs,
      forcedRelay: this.relayIdleForceRelay,
      disabled: this.relayIdleDisabled,
      activeRelayPeerCount: activeRelayPeerIds.size,
      peers,
    };
  }

  private snapshotLatestStateQa(direction: LatestStateQaDirection): LatestStateQaDebugSnapshot {
    const controller = this.latestStateQa[direction];
    return {
      hold: controller.hold,
      pending: Boolean(controller.pendingOutbound),
      dropNextCount: controller.dropNextCount,
      duplicateNextCount: controller.duplicateNextCount,
      delayMs: controller.delayMs,
      delayScheduleRemaining: controller.delayScheduleMs.length,
    };
  }

  private hasLatestStateQaRules(direction: LatestStateQaDirection): boolean {
    const controller = this.latestStateQa[direction];
    return (
      controller.hold ||
      controller.dropNextCount > 0 ||
      controller.duplicateNextCount > 0 ||
      controller.delayMs > 0 ||
      controller.delayScheduleMs.length > 0 ||
      Boolean(controller.pendingOutbound)
    );
  }

  private clearLatestStateQaTimers(direction: LatestStateQaDirection): void {
    const controller = this.latestStateQa[direction];
    for (const timerId of controller.timers) {
      clearTimeout(timerId);
    }
    controller.timers.clear();
    controller.pendingOutbound = undefined;
  }

  private nextLatestStateQaDelay(direction: LatestStateQaDirection): number {
    const controller = this.latestStateQa[direction];
    if (controller.delayScheduleMs.length > 0) {
      return controller.delayScheduleMs.shift() ?? 0;
    }

    return controller.delayMs;
  }

  private scheduleLatestStateQa(
    direction: LatestStateQaDirection,
    delayMs: number,
    callback: () => void,
  ): void {
    const controller = this.latestStateQa[direction];
    const timerId = window.setTimeout(() => {
      controller.timers.delete(timerId);
      callback();
    }, delayMs);
    controller.timers.add(timerId);
  }

  private dispatchLatestStateOutbound(
    raw: string,
    toPeerId?: string,
    transportOptions?: RoomTransportSendOptions,
  ): boolean {
    const controller = this.latestStateQa.outbound;
    if (!this.hasLatestStateQaRules("outbound")) {
      return this.transport.send(raw, toPeerId, "latest-state", transportOptions);
    }

    const hasPending = Boolean(controller.pendingOutbound);

    if (controller.hold) {
      if (transportOptions?.latestStateOnlyIfBuffered && !hasPending) {
        return false;
      }

      controller.pendingOutbound = {
        raw,
        toPeerId,
        transportOptions,
      };
      this.emitStateChange();
      return true;
    }

    if (controller.dropNextCount > 0) {
      controller.dropNextCount -= 1;
      this.emitStateChange();
      return true;
    }

    const duplicate = controller.duplicateNextCount > 0;
    if (duplicate) {
      controller.duplicateNextCount -= 1;
    }
    const delayMs = this.nextLatestStateQaDelay("outbound");

    if (delayMs > 0) {
      this.scheduleLatestStateQa("outbound", delayMs, () => {
        this.transport.send(raw, toPeerId, "latest-state", transportOptions);
      });
      if (duplicate) {
        this.scheduleLatestStateQa("outbound", delayMs + 8, () => {
          this.transport.send(raw, toPeerId, "latest-state", transportOptions);
        });
      }
      this.emitStateChange();
      return true;
    }

    const sent = this.transport.send(raw, toPeerId, "latest-state", transportOptions);
    if (sent && duplicate) {
      this.scheduleLatestStateQa("outbound", 8, () => {
        this.transport.send(raw, toPeerId, "latest-state", transportOptions);
      });
    }
    this.emitStateChange();
    return sent;
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

  protected connectedDetail(): string {
    if (this.remoteParticipants().length > 0) {
      return `Connected with ${this.remoteParticipants().length} remote operator${
        this.remoteParticipants().length === 1 ? "" : "s"
      }.`;
    }

    return this.role === "host"
      ? "Connected. Awaiting another operator."
      : "Connected. Waiting for host snapshots.";
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
    transportOptions?: RoomTransportSendOptions,
    encodeOptions?: { hostSnapshotMode?: HostSnapshotEncodingMode },
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

    const raw = encodeRoomMessage(message, encodeOptions);
    if (measureRoomMessageBytes(raw) > MAX_ROOM_MESSAGE_BYTES) {
      return false;
    }

    const lane = getRoomMessageLane(type);
    const sent =
      lane === "latest-state"
        ? this.dispatchLatestStateOutbound(raw, toPeerId, transportOptions)
        : this.transport.send(raw, toPeerId, lane, transportOptions);
    if (sent && lane === "latest-state") {
      this.lastLatestStateSentAt = message.sentAt;
    }

    return sent;
  }

  protected rememberParticipant(participant: ParticipantRecord): void {
    const existing = this.participants.get(participant.id);
    this.participants.set(participant.id, participant);

    if (participant.id === this.identity.id) {
      return;
    }

    this.lastSeenByPeer.set(participant.id, Date.now());
    this.noteRelayGameplayActivity(participant.id);
    this.handlers.onParticipant(participant, existing ? "updated" : "joined");
    this.updateUiState({
      remoteName: participant.name,
    });
  }

  protected removePeer(
    peerId: string,
    reason: "leave" | "stale",
    closedDetail?: string,
  ): void {
    const removedParticipant = this.participants.get(peerId);
    this.participants.delete(peerId);
    this.lastSeenByPeer.delete(peerId);
    this.lastReliableSeqByPeer.delete(peerId);
    this.lastLatestSeqByPeer.delete(peerId);
    this.invalidRoomMessagesByPeer.delete(peerId);
    this.relayGameplayActivityByPeer.delete(peerId);
    this.relayInputSignatureByPeer.delete(peerId);
    this.relayIdleWarnedSubjects.delete(peerId);

    if (removedParticipant) {
      this.handlers.onLeave(peerId, reason);
    }

    const hostRemoved = peerId === this.hostPeerId && peerId !== this.identity.id;
    if (hostRemoved && this.role === "guest") {
      this.notifyRoomClosed(
        closedDetail ?? (reason === "stale" ? "Host room timed out." : "The host ended the room."),
      );
      return;
    }

    this.updateUiState({
      remoteName: this.remoteParticipants()[0]?.name,
      detail:
        this.transport.getStatus().phase === "connected"
          ? this.connectedDetail()
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
    return this.localTeam;
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

    if (this.role === "guest" && !this.joined) {
      this.joined = true;
      this.sendMessage("join-request", {
        participant: this.identity,
        requestedRole: "guest",
        requestedTeam: this.requestedTeam,
        mapId: this.mapId,
        capabilities: [
          "input-tick",
          "host-snapshot",
          this.kind === "signal-join" ? "cloudflare-signaling" : "manual-signaling",
        ],
      });
      return;
    }

    if (this.role === "host") {
      this.hostPeerId = this.identity.id;
    }
  }

  protected onTransportStatus(status: RoomTransportStatus): void {
    const detail =
      status.phase === "connected"
        ? this.connectedDetail()
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
    if (this.role !== "host") {
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

    if (this.remoteParticipants().length >= MAX_ROOM_GUESTS) {
      this.sendMessage(
        "join-rejected",
        {
          reason: "room-full",
          detail: `This browser-hosted room is limited to ${MAX_ROOM_PARTICIPANTS} total operators.`,
        },
        message.fromPeerId,
      );
      return;
    }

    const participant: ParticipantRecord = {
      ...message.payload.participant,
      team: this.resolveRequestedTeam(message.payload.requestedTeam),
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
    this.sendMessage("participant-update", {
      participant,
    });
    this.sendMessage(
      "participant-update",
      {
        participant: this.buildParticipantRecord(this.localTeam),
      },
      message.fromPeerId,
    );
  }

  protected resolveRequestedTeam(requestedTeam: TeamAssignment): TeamAssignment {
    if (requestedTeam === "observer") {
      return "observer";
    }

    if (this.localTeam === "observer") {
      return requestedTeam;
    }

    if (requestedTeam === this.localTeam) {
      return opposingTeam(this.localTeam);
    }

    return requestedTeam;
  }

  protected onJoinAccepted(message: Extract<RoomMessage, { type: "join-accepted" }>): void {
    if (this.role !== "guest") {
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
        this.handleRawMessage(event);
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

  private noteInvalidRoomMessage(peerId: string | undefined, detail: string): void {
    if (!peerId || peerId === this.identity.id) {
      return;
    }

    const nextCount = (this.invalidRoomMessagesByPeer.get(peerId) ?? 0) + 1;
    this.invalidRoomMessagesByPeer.set(peerId, nextCount);
    if (nextCount < MAX_ROOM_INVALID_MESSAGES) {
      return;
    }

    this.invalidRoomMessagesByPeer.delete(peerId);
    this.transport.disconnectPeer?.(peerId, "invalid-room-message");
    this.removePeer(peerId, "leave", detail);

    if (this.role === "guest" && peerId === this.hostPeerId) {
      return;
    }

    this.updateUiState({
      detail,
      remoteName: this.remoteParticipants()[0]?.name,
    });
  }

  private recordLatestStateSeq(
    peerId: string,
    scope: Exclude<RoomMessageSequenceScope, "reliable">,
    seq: number,
  ): void {
    const state = this.lastLatestSeqByPeer.get(peerId) ?? {};
    state[scope] = seq;
    this.lastLatestSeqByPeer.set(peerId, state);
  }

  private evaluateInboundSequence(
    message: RoomMessage,
  ): "accept" | "drop-late-latest-state" | "invalid-reliable-order" {
    const scope = getRoomMessageSequenceScope(message.type);
    if (scope === "reliable") {
      const lastSeq = this.lastReliableSeqByPeer.get(message.fromPeerId) ?? 0;
      if (message.seq <= lastSeq) {
        return "invalid-reliable-order";
      }

      this.lastReliableSeqByPeer.set(message.fromPeerId, message.seq);
      return "accept";
    }

    const lastSeq = this.lastLatestSeqByPeer.get(message.fromPeerId)?.[scope] ?? 0;
    if (message.seq <= lastSeq) {
      return "drop-late-latest-state";
    }

    this.recordLatestStateSeq(message.fromPeerId, scope, message.seq);
    return "accept";
  }

  private validateInboundOwnership(message: RoomMessage): string | null {
    switch (message.type) {
      case "join-request":
        return this.role === "host"
          ? null
          : "Guests must not receive join requests from another peer.";
      case "join-accepted":
        return this.role === "guest"
          ? null
          : "Hosts must not receive join-accepted room messages.";
      case "join-rejected":
        return this.role === "guest"
          ? null
          : "Hosts must not receive join-rejected room messages.";
      case "participant-update":
        if (this.role !== "guest") {
          return "Hosts must not receive participant updates from another peer.";
        }

        if (!this.hostPeerId) {
          return "Guests must not receive participant updates before the host accepts them.";
        }

        return message.fromPeerId === this.hostPeerId
          ? null
          : "Only the active host may publish participant updates to a guest.";
      case "input-tick":
        return this.role === "host"
          ? null
          : "Guests must not receive input ticks from another peer.";
      case "host-snapshot":
        if (this.role !== "guest") {
          return "Hosts must not receive host snapshots from another peer.";
        }

        if (this.hostPeerId && message.fromPeerId !== this.hostPeerId) {
          return "Only the active host may send room snapshots to a guest.";
        }

        return null;
      case "shot-claim":
        return this.role === "host"
          ? null
          : "Guests must not receive shot claims from another peer.";
      case "shot-result":
        if (this.role !== "guest") {
          return "Hosts must not receive shot results from another peer.";
        }

        if (this.hostPeerId && message.fromPeerId !== this.hostPeerId) {
          return "Only the active host may send shot results to a guest.";
        }

        return null;
      case "objective-event":
        if (this.role !== "guest") {
          return "Hosts must not receive objective events from another peer.";
        }

        if (this.hostPeerId && message.fromPeerId !== this.hostPeerId) {
          return "Only the active host may send objective events to a guest.";
        }

        return null;
      case "heartbeat":
      case "disconnect":
        return null;
      default:
        return null;
    }
  }

  private flushSnapshot(now: number, encoding: HostSnapshotEncodingMode): void {
    if (!this.latestSnapshot) {
      return;
    }

    const raw = encodeRoomMessage(
      {
        protocol: ROOM_PROTOCOL,
        version: ROOM_PROTOCOL_VERSION,
        type: "host-snapshot",
        roomId: this.roomId,
        fromPeerId: this.identity.id,
        seq: this.nextSeq,
        sentAt: now,
        payload: this.latestSnapshot,
      },
      { hostSnapshotMode: encoding },
    );
    this.lastSnapshotBytes = measureRoomMessageBytes(raw);

    if (
      this.sendMessage(
        "host-snapshot",
        this.latestSnapshot,
        undefined,
        undefined,
        { hostSnapshotMode: encoding },
      )
    ) {
      this.lastSnapshotSentAt = now;
      this.lastSentSnapshotSignature =
        this.pendingSnapshotSignature || hostSnapshotTrafficSignature(this.latestSnapshot);
      this.lastSnapshotEncoding = encoding;
      if (encoding === "full") {
        this.lastFullSnapshotSentAt = now;
      }
    }
  }

  private refreshBufferedSnapshot(now: number, encoding: HostSnapshotEncodingMode): void {
    if (!this.latestSnapshot) {
      return;
    }

    const raw = encodeRoomMessage(
      {
        protocol: ROOM_PROTOCOL,
        version: ROOM_PROTOCOL_VERSION,
        type: "host-snapshot",
        roomId: this.roomId,
        fromPeerId: this.identity.id,
        seq: this.nextSeq,
        sentAt: now,
        payload: this.latestSnapshot,
      },
      { hostSnapshotMode: encoding },
    );

    if (
      this.sendMessage(
        "host-snapshot",
        this.latestSnapshot,
        undefined,
        { latestStateOnlyIfBuffered: true },
        { hostSnapshotMode: encoding },
      )
    ) {
      this.lastSnapshotBytes = measureRoomMessageBytes(raw);
      this.lastSentSnapshotSignature =
        this.pendingSnapshotSignature || hostSnapshotTrafficSignature(this.latestSnapshot);
      this.lastSnapshotEncoding = encoding;
      if (encoding === "full") {
        this.lastFullSnapshotSentAt = now;
      }
    }
  }

  private snapshotEncodingMode(now: number): HostSnapshotEncodingMode {
    return now - this.lastFullSnapshotSentAt >= FULL_SNAPSHOT_PULSE_MS ? "full" : "delta";
  }

  private readonly handleRawMessage = (event: RoomTransportMessageEvent): void => {
    if (event.lane !== "latest-state") {
      this.processRawMessage(event);
      return;
    }

    if (!this.hasLatestStateQaRules("inbound")) {
      this.processRawMessage(event);
      return;
    }

    const controller = this.latestStateQa.inbound;
    if (controller.dropNextCount > 0) {
      controller.dropNextCount -= 1;
      this.emitStateChange();
      return;
    }

    const duplicate = controller.duplicateNextCount > 0;
    if (duplicate) {
      controller.duplicateNextCount -= 1;
    }
    const delayMs = this.nextLatestStateQaDelay("inbound");
    const dispatch = () => {
      this.processRawMessage({
        ...event,
        receivedAt: Date.now(),
      });
    };

    if (delayMs > 0) {
      this.scheduleLatestStateQa("inbound", delayMs, dispatch);
      if (duplicate) {
        this.scheduleLatestStateQa("inbound", delayMs + 8, dispatch);
      }
      this.emitStateChange();
      return;
    }

    dispatch();
    if (duplicate) {
      this.scheduleLatestStateQa("inbound", 8, dispatch);
    }
    this.emitStateChange();
  };

  private processRawMessage(event: RoomTransportMessageEvent): void {
    if (measureRoomMessageBytes(event.raw) > MAX_ROOM_MESSAGE_BYTES) {
      this.noteInvalidRoomMessage(event.fromPeerId, "A peer sent an oversized room payload.");
      return;
    }

    const message = decodeRoomMessage(event.raw, {
      participants: this.participants,
      latestSnapshot: this.latestSnapshot,
    });
    if (!message) {
      this.noteInvalidRoomMessage(event.fromPeerId, "A peer sent repeated malformed room messages.");
      return;
    }

    if (message.roomId !== this.roomId || message.fromPeerId === this.identity.id) {
      this.noteInvalidRoomMessage(message.fromPeerId, "A peer sent a room message for the wrong room.");
      return;
    }

    if (message.toPeerId && message.toPeerId !== this.identity.id) {
      this.noteInvalidRoomMessage(message.fromPeerId, "A peer sent a room message to the wrong target.");
      return;
    }

    if (event.lane !== getRoomMessageLane(message.type)) {
      this.noteInvalidRoomMessage(
        message.fromPeerId,
        "A peer sent room traffic on the wrong delivery lane.",
      );
      return;
    }

    const ownershipError = this.validateInboundOwnership(message);
    if (ownershipError) {
      this.noteInvalidRoomMessage(message.fromPeerId, ownershipError);
      return;
    }

    const sequenceResult = this.evaluateInboundSequence(message);
    if (sequenceResult === "invalid-reliable-order") {
      this.noteInvalidRoomMessage(message.fromPeerId, "A peer replayed room traffic out of order.");
      return;
    }
    this.lastSeenByPeer.set(message.fromPeerId, event.receivedAt);
    if (sequenceResult === "drop-late-latest-state") {
      return;
    }

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
        if (this.inputTickHasGameplayActivity(message.fromPeerId, message.payload)) {
          this.noteRelayGameplayActivity(message.fromPeerId, event.receivedAt);
        }
        this.handlers.onInput({
          peerId: message.fromPeerId,
          sentAt: message.sentAt,
          receivedAt: event.receivedAt,
          ...message.payload,
        });
        return;
      case "host-snapshot":
        this.latestSnapshot = message.payload;
        this.handlers.onSnapshot(message.payload);
        return;
      case "shot-claim":
        this.noteRelayGameplayActivity(message.fromPeerId, event.receivedAt);
        this.handlers.onShotClaim({
          peerId: message.fromPeerId,
          sentAt: message.sentAt,
          ...message.payload,
        });
        return;
      case "shot-result":
        this.handlers.onShotResult({
          peerId: message.fromPeerId,
          sentAt: message.sentAt,
          ...message.payload,
        });
        return;
      case "objective-event":
        this.noteRelayGameplayActivity(message.fromPeerId, event.receivedAt);
        return;
      case "heartbeat":
        return;
      case "disconnect":
        this.removePeer(
          message.fromPeerId,
          "leave",
          message.payload.reason === RELAY_IDLE_REASON
            ? "Disconnected after relay inactivity."
            : undefined,
        );
        return;
      default:
        return;
    }
  }

  private defaultTitle(): string {
    switch (this.kind) {
      case "broadcast":
        return "Same-Browser Dev Room";
      case "signal-host":
        return "Cloud Room Host";
      case "signal-join":
        return "Cloud Room Join";
      case "webrtc-host":
        return "Manual WebRTC Host";
      case "webrtc-join":
        return "Manual WebRTC Join";
    }
  }
}

function hostSnapshotTrafficSignature(snapshot: HostRoomSnapshot): string {
  return [
    snapshot.phase,
    snapshot.roundPhase,
    snapshot.objective.phase,
    snapshot.objective.value ?? "",
    ...snapshot.roster.map((entry) =>
      [
        entry.id,
        entry.health,
        entry.eliminations,
        entry.deaths,
        entry.status,
        entry.position.join(","),
        entry.look.join(","),
        entry.respawnAt,
        entry.lastProcessedInputSequence,
      ].join(":"),
    ),
  ].join("|");
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

class SignaledWebRtcMatchRoomConnection extends BaseMatchRoomConnection {
  private readonly signaledTransport: SignaledWebRtcRoomTransport;

  constructor(
    kind: Extract<RoomConnectionKind, "signal-host" | "signal-join">,
    options: BaseConnectionOptions,
    roomCode: string,
    signalingUrl: string,
  ) {
    super(kind, options);
    this.signaledTransport = options.transport as SignaledWebRtcRoomTransport;
    this.updateUiState({
      roomCode,
      signalingUrl,
    });
  }

  debugSendSignalingPayload(payload: Record<string, unknown>): boolean {
    return this.signaledTransport.debugSendSignalingPayload(payload);
  }

  debugInjectSignalingMessage(raw: string): boolean {
    this.signaledTransport.debugInjectSignalingMessage(raw);
    return true;
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
