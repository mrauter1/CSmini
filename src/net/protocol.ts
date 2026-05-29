import type { RoomTransportLane } from "./transport";

export const ROOM_PROTOCOL = "dustline-room";
export const ROOM_PROTOCOL_VERSION = 3 as const;
// Shared gameplay payloads stay comfortably below this in normal play, so 64 KiB prevents one
// peer from turning a data channel into an unbounded blob sink without clipping snapshots.
export const MAX_ROOM_MESSAGE_BYTES = 64 * 1024;
export const MAX_ROOM_INVALID_MESSAGES = 4;
const UTF8 = new TextEncoder();

export type CombatantStatus = "alive" | "down" | "respawning";
export type TeamAssignment = "alpha" | "bravo" | "observer";
export type JoinRequestRole = "host" | "guest" | "observer";
export type JoinRejectReason =
  | "duplicate-id"
  | "host-busy"
  | "invalid-offer"
  | "room-full"
  | "unsupported-version";
export type ShotResultDecision = "accepted" | "rejected" | "adjusted";
export type RoomLifecyclePhase = "waiting" | "active" | "ended";
export type RoundLifecyclePhase = "staging" | "live" | "reset";

export type NetworkVector2 = [number, number];
export type NetworkVector3 = [number, number, number];

export interface ParticipantIdentity {
  id: string;
  name: string;
  accentColor: string;
}

export interface ParticipantRecord extends ParticipantIdentity {
  team: TeamAssignment;
  joinedAt: number;
}

export interface RoomPresenceSnapshot extends ParticipantRecord {
  health: number;
  eliminations: number;
  deaths: number;
  status: CombatantStatus;
  position: NetworkVector3;
  look: NetworkVector3;
  respawnAt: number;
  lastProcessedInputSequence: number;
  updatedAt: number;
}

export interface ObjectiveStateSnapshot {
  objectiveId: string;
  phase: string;
  value?: number;
  detail?: string;
}

export interface WeaponStateSnapshot {
  ammoInClip: number;
  reserveAmmo: number;
  reloadSequence: number;
  reloadEndsAt: number;
  spreadIndex: number;
}

interface EnvelopeBase<Type extends string, Payload> {
  protocol: typeof ROOM_PROTOCOL;
  version: typeof ROOM_PROTOCOL_VERSION;
  type: Type;
  roomId: string;
  fromPeerId: string;
  toPeerId?: string;
  seq: number;
  sentAt: number;
  payload: Payload;
}

export type JoinRequestMessage = EnvelopeBase<
  "join-request",
  {
    participant: ParticipantIdentity;
    requestedRole: JoinRequestRole;
    requestedTeam: TeamAssignment;
    mapId: string;
    capabilities: string[];
  }
>;

export type JoinAcceptedMessage = EnvelopeBase<
  "join-accepted",
  {
    participant: ParticipantRecord;
    hostPeerId: string;
    roomLabel: string;
    roster: ParticipantRecord[];
  }
>;

export type JoinRejectedMessage = EnvelopeBase<
  "join-rejected",
  {
    reason: JoinRejectReason;
    detail: string;
  }
>;

export type ParticipantUpdateMessage = EnvelopeBase<
  "participant-update",
  {
    participant: ParticipantRecord;
  }
>;

export type InputTickMessage = EnvelopeBase<
  "input-tick",
  {
    tick: number;
    sequence: number;
    look: NetworkVector3;
    movement: NetworkVector2;
    actions: string[];
  }
>;

export type HostSnapshotMessage = EnvelopeBase<
  "host-snapshot",
  {
    snapshotId: number;
    hostPeerId: string;
    phase: RoomLifecyclePhase;
    roundPhase: RoundLifecyclePhase;
    objective: ObjectiveStateSnapshot;
    roster: RoomPresenceSnapshot[];
  }
>;

export type ShotClaimMessage = EnvelopeBase<
  "shot-claim",
  {
    claimId: number;
    shooterId: string;
    tick: number;
    origin: NetworkVector3;
    direction: NetworkVector3;
    ammoInClip: number;
    reserveAmmo: number;
    reloadSequence: number;
    spreadIndex: number;
    inputSequence: number;
    weaponId: string;
  }
>;

export type ShotResultMessage = EnvelopeBase<
  "shot-result",
  {
    claimId: number;
    shooterId: string;
    targetId?: string;
    decision: ShotResultDecision;
    damage: number;
    reason: string;
    shooterWeapon: WeaponStateSnapshot;
    targetHealth?: number;
    targetStatus?: CombatantStatus;
  }
>;

export type ObjectiveEventMessage = EnvelopeBase<
  "objective-event",
  {
    eventId: string;
    objectiveId: string;
    phase: string;
    value?: number;
    detail?: string;
  }
>;

export type HeartbeatMessage = EnvelopeBase<
  "heartbeat",
  {
    rosterCount: number;
    phase: RoomLifecyclePhase;
  }
>;

export type DisconnectMessage = EnvelopeBase<
  "disconnect",
  {
    reason: string;
  }
>;

export type RoomMessage =
  | JoinRequestMessage
  | JoinAcceptedMessage
  | JoinRejectedMessage
  | ParticipantUpdateMessage
  | InputTickMessage
  | HostSnapshotMessage
  | ShotClaimMessage
  | ShotResultMessage
  | ObjectiveEventMessage
  | HeartbeatMessage
  | DisconnectMessage;

export type RoomMessageType = RoomMessage["type"];
export type RoomLatestStateMessageType = Extract<
  RoomMessageType,
  "heartbeat" | "host-snapshot" | "input-tick"
>;
export type RoomReliableMessageType = Exclude<RoomMessageType, RoomLatestStateMessageType>;
export type RoomMessageSequenceScope = "reliable" | RoomLatestStateMessageType;
export type RoomInputTick = InputTickMessage["payload"];
export type HostRoomSnapshot = HostSnapshotMessage["payload"];
export type RoomShotClaim = ShotClaimMessage["payload"];
export type RoomShotResult = ShotResultMessage["payload"];

export function getRoomMessageLane(type: RoomMessageType): RoomTransportLane {
  switch (type) {
    case "heartbeat":
    case "host-snapshot":
    case "input-tick":
      return "latest-state";
    default:
      return "reliable";
  }
}

export function getRoomMessageSequenceScope(type: RoomMessageType): RoomMessageSequenceScope {
  switch (type) {
    case "heartbeat":
    case "host-snapshot":
    case "input-tick":
      return type;
    default:
      return "reliable";
  }
}

export function encodeRoomMessage(message: RoomMessage): string {
  return JSON.stringify(message);
}

export function measureRoomMessageBytes(raw: string): number {
  return UTF8.encode(raw).byteLength;
}

export function decodeRoomMessage(raw: string): RoomMessage | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return parseRoomMessage(value);
  } catch {
    return null;
  }
}

export function parseRoomMessage(value: unknown): RoomMessage | null {
  if (!isEnvelopeBase(value)) {
    return null;
  }

  switch (value.type) {
    case "join-request":
      return isJoinRequestPayload(value.payload) ? value : null;
    case "join-accepted":
      return isJoinAcceptedPayload(value.payload) ? value : null;
    case "join-rejected":
      return isJoinRejectedPayload(value.payload) ? value : null;
    case "participant-update":
      return isParticipantUpdatePayload(value.payload) ? value : null;
    case "input-tick":
      return isInputTickPayload(value.payload) ? value : null;
    case "host-snapshot":
      return isHostSnapshotPayload(value.payload) ? value : null;
    case "shot-claim":
      return isShotClaimPayload(value.payload) ? value : null;
    case "shot-result":
      return isShotResultPayload(value.payload) ? value : null;
    case "objective-event":
      return isObjectiveEventPayload(value.payload) ? value : null;
    case "heartbeat":
      return isHeartbeatPayload(value.payload) ? value : null;
    case "disconnect":
      return isDisconnectPayload(value.payload) ? value : null;
    default:
      return null;
  }
}

function isEnvelopeBase(value: unknown): value is RoomMessage {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.protocol === ROOM_PROTOCOL &&
    value.version === ROOM_PROTOCOL_VERSION &&
    typeof value.type === "string" &&
    typeof value.roomId === "string" &&
    typeof value.fromPeerId === "string" &&
    (typeof value.toPeerId === "undefined" || typeof value.toPeerId === "string") &&
    isSafeNumber(value.seq) &&
    isSafeNumber(value.sentAt) &&
    isRecord(value.payload)
  );
}

function isJoinRequestPayload(
  payload: Record<string, unknown>,
): payload is JoinRequestMessage["payload"] {
  return (
    isParticipantIdentity(payload.participant) &&
    isJoinRequestRole(payload.requestedRole) &&
    isTeamAssignment(payload.requestedTeam) &&
    typeof payload.mapId === "string" &&
    Array.isArray(payload.capabilities) &&
    payload.capabilities.every((entry) => typeof entry === "string")
  );
}

function isJoinAcceptedPayload(
  payload: Record<string, unknown>,
): payload is JoinAcceptedMessage["payload"] {
  return (
    isParticipantRecord(payload.participant) &&
    typeof payload.hostPeerId === "string" &&
    typeof payload.roomLabel === "string" &&
    Array.isArray(payload.roster) &&
    payload.roster.every(isParticipantRecord)
  );
}

function isJoinRejectedPayload(
  payload: Record<string, unknown>,
): payload is JoinRejectedMessage["payload"] {
  return typeof payload.detail === "string" && isJoinRejectReason(payload.reason);
}

function isParticipantUpdatePayload(
  payload: Record<string, unknown>,
): payload is ParticipantUpdateMessage["payload"] {
  return isParticipantRecord(payload.participant);
}

function isInputTickPayload(
  payload: Record<string, unknown>,
): payload is InputTickMessage["payload"] {
  return (
    isSafeNumber(payload.tick) &&
    isSafeNumber(payload.sequence) &&
    isVector3(payload.look) &&
    isVector2(payload.movement) &&
    Array.isArray(payload.actions) &&
    payload.actions.every((entry) => typeof entry === "string")
  );
}

function isHostSnapshotPayload(
  payload: Record<string, unknown>,
): payload is HostSnapshotMessage["payload"] {
  return (
    isSafeNumber(payload.snapshotId) &&
    typeof payload.hostPeerId === "string" &&
    isRoomLifecyclePhase(payload.phase) &&
    isRoundLifecyclePhase(payload.roundPhase) &&
    isObjectiveStateSnapshot(payload.objective) &&
    Array.isArray(payload.roster) &&
    payload.roster.every(isRoomPresenceSnapshot)
  );
}

function isShotClaimPayload(
  payload: Record<string, unknown>,
): payload is ShotClaimMessage["payload"] {
  return (
    isSafeNumber(payload.claimId) &&
    typeof payload.shooterId === "string" &&
    isSafeNumber(payload.tick) &&
    isVector3(payload.origin) &&
    isVector3(payload.direction) &&
    isSafeNumber(payload.ammoInClip) &&
    isSafeNumber(payload.reserveAmmo) &&
    isSafeNumber(payload.reloadSequence) &&
    isSafeNumber(payload.spreadIndex) &&
    isSafeNumber(payload.inputSequence) &&
    typeof payload.weaponId === "string"
  );
}

function isShotResultPayload(
  payload: Record<string, unknown>,
): payload is ShotResultMessage["payload"] {
  return (
    isSafeNumber(payload.claimId) &&
    typeof payload.shooterId === "string" &&
    (typeof payload.targetId === "undefined" || typeof payload.targetId === "string") &&
    isShotResultDecision(payload.decision) &&
    isSafeNumber(payload.damage) &&
    typeof payload.reason === "string" &&
    isWeaponStateSnapshot(payload.shooterWeapon) &&
    (typeof payload.targetHealth === "undefined" || isSafeNumber(payload.targetHealth)) &&
    (typeof payload.targetStatus === "undefined" || isCombatantStatus(payload.targetStatus))
  );
}

function isObjectiveEventPayload(
  payload: Record<string, unknown>,
): payload is ObjectiveEventMessage["payload"] {
  return (
    typeof payload.eventId === "string" &&
    isObjectiveStateSnapshot(payload)
  );
}

function isHeartbeatPayload(
  payload: Record<string, unknown>,
): payload is HeartbeatMessage["payload"] {
  return isSafeNumber(payload.rosterCount) && isRoomLifecyclePhase(payload.phase);
}

function isDisconnectPayload(
  payload: Record<string, unknown>,
): payload is DisconnectMessage["payload"] {
  return typeof payload.reason === "string";
}

function isParticipantIdentity(value: unknown): value is ParticipantIdentity {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.accentColor === "string"
  );
}

function isParticipantRecord(value: unknown): value is ParticipantRecord {
  return (
    isParticipantIdentity(value) &&
    isRecord(value) &&
    isTeamAssignment(value.team) &&
    isSafeNumber(value.joinedAt)
  );
}

function isRoomPresenceSnapshot(value: unknown): value is RoomPresenceSnapshot {
  return (
    isParticipantRecord(value) &&
    isRecord(value) &&
    isSafeNumber(value.health) &&
    isSafeNumber(value.eliminations) &&
    isSafeNumber(value.deaths) &&
    isCombatantStatus(value.status) &&
    isVector3(value.position) &&
    isVector3(value.look) &&
    isSafeNumber(value.respawnAt) &&
    isSafeNumber(value.lastProcessedInputSequence) &&
    isSafeNumber(value.updatedAt)
  );
}

function isObjectiveStateSnapshot(value: unknown): value is ObjectiveStateSnapshot {
  return (
    isRecord(value) &&
    typeof value.objectiveId === "string" &&
    typeof value.phase === "string" &&
    (typeof value.value === "undefined" || isSafeNumber(value.value)) &&
    (typeof value.detail === "undefined" || typeof value.detail === "string")
  );
}

function isWeaponStateSnapshot(value: unknown): value is WeaponStateSnapshot {
  return (
    isRecord(value) &&
    isSafeNumber(value.ammoInClip) &&
    isSafeNumber(value.reserveAmmo) &&
    isSafeNumber(value.reloadSequence) &&
    isSafeNumber(value.reloadEndsAt) &&
    isSafeNumber(value.spreadIndex)
  );
}

function isVector2(value: unknown): value is NetworkVector2 {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isSafeNumber(value[0]) &&
    isSafeNumber(value[1])
  );
}

function isVector3(value: unknown): value is NetworkVector3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    isSafeNumber(value[0]) &&
    isSafeNumber(value[1]) &&
    isSafeNumber(value[2])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCombatantStatus(value: unknown): value is CombatantStatus {
  return value === "alive" || value === "down" || value === "respawning";
}

function isTeamAssignment(value: unknown): value is TeamAssignment {
  return value === "alpha" || value === "bravo" || value === "observer";
}

function isJoinRequestRole(value: unknown): value is JoinRequestRole {
  return value === "host" || value === "guest" || value === "observer";
}

function isJoinRejectReason(value: unknown): value is JoinRejectReason {
  return (
    value === "duplicate-id" ||
    value === "host-busy" ||
    value === "invalid-offer" ||
    value === "room-full" ||
    value === "unsupported-version"
  );
}

function isShotResultDecision(value: unknown): value is ShotResultDecision {
  return value === "accepted" || value === "rejected" || value === "adjusted";
}

function isRoomLifecyclePhase(value: unknown): value is RoomLifecyclePhase {
  return value === "waiting" || value === "active" || value === "ended";
}

function isRoundLifecyclePhase(value: unknown): value is RoundLifecyclePhase {
  return value === "staging" || value === "live" || value === "reset";
}
