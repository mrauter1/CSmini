export const ROOM_PROTOCOL = "dustline-room";
export const ROOM_PROTOCOL_VERSION = 1 as const;
export const ROOM_MESSAGE_STALE_MS = 12_000;
export const ROOM_MESSAGE_FUTURE_SKEW_MS = 2_500;

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

export interface RoomPresenceSnapshot extends ParticipantIdentity {
  health: number;
  eliminations: number;
  deaths: number;
  status: CombatantStatus;
  position: NetworkVector3;
  look: NetworkVector3;
  updatedAt: number;
  team: TeamAssignment;
}

export interface OutboundRoomPresence {
  health: number;
  eliminations: number;
  deaths: number;
  status: CombatantStatus;
  position: NetworkVector3;
  look: NetworkVector3;
  team?: TeamAssignment;
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

export type PresenceUpdateMessage = EnvelopeBase<
  "presence-update",
  {
    presence: RoomPresenceSnapshot;
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
    roster: Array<{
      peerId: string;
      team: TeamAssignment;
      health: number;
      status: CombatantStatus;
      position: NetworkVector3;
      look: NetworkVector3;
    }>;
  }
>;

export type ShotClaimMessage = EnvelopeBase<
  "shot-claim",
  {
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
    shooterId: string;
    targetId?: string;
    decision: ShotResultDecision;
    damage: number;
    reason: string;
    authoritativeHealth?: number;
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

export type CombatHitMessage = EnvelopeBase<
  "combat-hit",
  {
    attackerId: string;
    attackerName: string;
    targetId: string;
    damage: number;
  }
>;

export type CombatEliminationMessage = EnvelopeBase<
  "combat-elimination",
  {
    attackerId: string;
    attackerName: string;
    targetId: string;
    targetName: string;
  }
>;

export type HeartbeatMessage = EnvelopeBase<
  "heartbeat",
  {
    rosterCount: number;
    phase: "idle" | "waiting" | "active";
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
  | PresenceUpdateMessage
  | InputTickMessage
  | HostSnapshotMessage
  | ShotClaimMessage
  | ShotResultMessage
  | ObjectiveEventMessage
  | CombatHitMessage
  | CombatEliminationMessage
  | HeartbeatMessage
  | DisconnectMessage;

export type RoomMessageType = RoomMessage["type"];

export function encodeRoomMessage(message: RoomMessage): string {
  return JSON.stringify(message);
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
    case "presence-update":
      return isPresenceUpdatePayload(value.payload) ? value : null;
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
    case "combat-hit":
      return isCombatHitPayload(value.payload) ? value : null;
    case "combat-elimination":
      return isCombatEliminationPayload(value.payload) ? value : null;
    case "heartbeat":
      return isHeartbeatPayload(value.payload) ? value : null;
    case "disconnect":
      return isDisconnectPayload(value.payload) ? value : null;
    default:
      return null;
  }
}

export function isFreshRoomMessage(message: RoomMessage, now = Date.now()): boolean {
  if (message.sentAt > now + ROOM_MESSAGE_FUTURE_SKEW_MS) {
    return false;
  }

  return now - message.sentAt <= ROOM_MESSAGE_STALE_MS;
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

function isPresenceUpdatePayload(
  payload: Record<string, unknown>,
): payload is PresenceUpdateMessage["payload"] {
  return isRoomPresenceSnapshot(payload.presence);
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
    Array.isArray(payload.roster) &&
    payload.roster.every(isHostSnapshotEntry)
  );
}

function isShotClaimPayload(
  payload: Record<string, unknown>,
): payload is ShotClaimMessage["payload"] {
  return (
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
    typeof payload.shooterId === "string" &&
    (typeof payload.targetId === "undefined" || typeof payload.targetId === "string") &&
    isShotResultDecision(payload.decision) &&
    isSafeNumber(payload.damage) &&
    typeof payload.reason === "string" &&
    (typeof payload.authoritativeHealth === "undefined" ||
      isSafeNumber(payload.authoritativeHealth))
  );
}

function isObjectiveEventPayload(
  payload: Record<string, unknown>,
): payload is ObjectiveEventMessage["payload"] {
  return (
    typeof payload.eventId === "string" &&
    typeof payload.objectiveId === "string" &&
    typeof payload.phase === "string" &&
    (typeof payload.value === "undefined" || isSafeNumber(payload.value)) &&
    (typeof payload.detail === "undefined" || typeof payload.detail === "string")
  );
}

function isCombatHitPayload(
  payload: Record<string, unknown>,
): payload is CombatHitMessage["payload"] {
  return (
    typeof payload.attackerId === "string" &&
    typeof payload.attackerName === "string" &&
    typeof payload.targetId === "string" &&
    isSafeNumber(payload.damage)
  );
}

function isCombatEliminationPayload(
  payload: Record<string, unknown>,
): payload is CombatEliminationMessage["payload"] {
  return (
    typeof payload.attackerId === "string" &&
    typeof payload.attackerName === "string" &&
    typeof payload.targetId === "string" &&
    typeof payload.targetName === "string"
  );
}

function isHeartbeatPayload(
  payload: Record<string, unknown>,
): payload is HeartbeatMessage["payload"] {
  return (
    isSafeNumber(payload.rosterCount) &&
    (payload.phase === "idle" || payload.phase === "waiting" || payload.phase === "active")
  );
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
    isParticipantIdentity(value) &&
    isRecord(value) &&
    isSafeNumber(value.health) &&
    isSafeNumber(value.eliminations) &&
    isSafeNumber(value.deaths) &&
    isCombatantStatus(value.status) &&
    isVector3(value.position) &&
    isVector3(value.look) &&
    isSafeNumber(value.updatedAt) &&
    isTeamAssignment(value.team)
  );
}

function isHostSnapshotEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.peerId === "string" &&
    isTeamAssignment(value.team) &&
    isSafeNumber(value.health) &&
    isCombatantStatus(value.status) &&
    isVector3(value.position) &&
    isVector3(value.look)
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
