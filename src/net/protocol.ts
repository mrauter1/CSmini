import type { TeamId } from "../types";
import type { RoomTransportLane } from "./transport";

export const ROOM_PROTOCOL = "dustline-room";
export const ROOM_PROTOCOL_VERSION = 3 as const;
// Shared gameplay payloads stay comfortably below this in normal play, so 64 KiB prevents one
// peer from turning a data channel into an unbounded blob sink without clipping snapshots.
export const MAX_ROOM_MESSAGE_BYTES = 64 * 1024;
export const MAX_ROOM_INVALID_MESSAGES = 4;
const UTF8 = new TextEncoder();

export type CombatantStatus = "alive" | "down" | "respawning";
export type TeamAssignment = TeamId | "observer";
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
  state?: Record<string, unknown>;
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
    look?: NetworkVector3;
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
export type HostSnapshotEncodingMode = "full" | "delta";

export interface RoomDecodeContext {
  participants?: ReadonlyMap<string, ParticipantRecord>;
  latestSnapshot?: HostRoomSnapshot;
}

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

export function encodeRoomMessage(
  message: RoomMessage,
  options: { hostSnapshotMode?: HostSnapshotEncodingMode } = {},
): string {
  return JSON.stringify(compactRoomMessage(message, options) ?? message);
}

export function measureRoomMessageBytes(raw: string): number {
  return UTF8.encode(raw).byteLength;
}

export function decodeRoomMessage(raw: string, context?: RoomDecodeContext): RoomMessage | null {
  try {
    const value = JSON.parse(raw) as unknown;
    const compact = parseCompactRoomMessage(value, context);
    if (compact) {
      return compact;
    }
    return parseRoomMessage(value);
  } catch {
    return null;
  }
}

function compactRoomMessage(
  message: RoomMessage,
  options: { hostSnapshotMode?: HostSnapshotEncodingMode },
): unknown[] | null {
  switch (message.type) {
    case "input-tick":
      return compactEnvelope(message, "i", compactInputTick(message.payload));
    case "host-snapshot": {
      const mode = options.hostSnapshotMode ?? "full";
      return compactEnvelope(
        message,
        mode === "delta" ? "sd" : "s",
        mode === "delta"
          ? compactHostSnapshotDelta(message.payload)
          : compactHostSnapshotFull(message.payload),
      );
    }
    case "heartbeat":
      return compactEnvelope(message, "h", [
        message.payload.rosterCount,
        encodeRoomPhase(message.payload.phase),
      ]);
    default:
      return null;
  }
}

function compactEnvelope(message: RoomMessage, typeCode: string, payload: unknown): unknown[] {
  return [
    "d",
    ROOM_PROTOCOL_VERSION,
    typeCode,
    message.roomId,
    message.fromPeerId,
    message.toPeerId ?? null,
    message.seq,
    message.sentAt,
    payload,
  ];
}

function parseCompactRoomMessage(value: unknown, context?: RoomDecodeContext): RoomMessage | null {
  if (
    !Array.isArray(value) ||
    value.length !== 9 ||
    value[0] !== "d" ||
    value[1] !== ROOM_PROTOCOL_VERSION ||
    typeof value[2] !== "string" ||
    typeof value[3] !== "string" ||
    typeof value[4] !== "string" ||
    !(value[5] === null || typeof value[5] === "string") ||
    !isSafeNumber(value[6]) ||
    !isSafeNumber(value[7])
  ) {
    return null;
  }

  const base = {
    protocol: ROOM_PROTOCOL,
    version: ROOM_PROTOCOL_VERSION,
    roomId: value[3],
    fromPeerId: value[4],
    toPeerId: value[5] === null ? undefined : value[5],
    seq: value[6],
    sentAt: value[7],
  } as const;

  switch (value[2]) {
    case "i": {
      const payload = expandInputTick(value[8]);
      return payload ? { ...base, type: "input-tick", payload } : null;
    }
    case "s": {
      const payload = expandHostSnapshotFull(value[8]);
      return payload ? { ...base, type: "host-snapshot", payload } : null;
    }
    case "sd": {
      const payload = expandHostSnapshotDelta(value[8], context);
      return payload ? { ...base, type: "host-snapshot", payload } : null;
    }
    case "h": {
      const payload = expandHeartbeat(value[8]);
      return payload ? { ...base, type: "heartbeat", payload } : null;
    }
    default:
      return null;
  }
}

function compactInputTick(payload: InputTickMessage["payload"]): unknown[] {
  return [
    payload.tick,
    payload.sequence,
    payload.look,
    payload.movement,
    encodeActions(payload.actions),
  ];
}

function expandInputTick(value: unknown): InputTickMessage["payload"] | null {
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    !isSafeNumber(value[0]) ||
    !isSafeNumber(value[1]) ||
    !isVector3(value[2]) ||
    !isVector2(value[3]) ||
    !isSafeNumber(value[4])
  ) {
    return null;
  }

  return {
    tick: value[0],
    sequence: value[1],
    look: value[2],
    movement: value[3],
    actions: decodeActions(value[4]),
  };
}

function compactHostSnapshotFull(payload: HostSnapshotMessage["payload"]): unknown[] {
  return [
    payload.snapshotId,
    payload.hostPeerId,
    encodeRoomPhase(payload.phase),
    encodeRoundPhase(payload.roundPhase),
    compactObjective(payload.objective),
    payload.roster.map(compactPresenceFull),
  ];
}

function compactHostSnapshotDelta(payload: HostSnapshotMessage["payload"]): unknown[] {
  return [
    payload.snapshotId,
    payload.hostPeerId,
    encodeRoomPhase(payload.phase),
    encodeRoundPhase(payload.roundPhase),
    compactObjective(payload.objective),
    payload.roster.map(compactPresenceDynamic),
  ];
}

function expandHostSnapshotFull(value: unknown): HostSnapshotMessage["payload"] | null {
  const header = expandSnapshotHeader(value);
  if (!header) {
    return null;
  }

  const roster = header.roster.map(expandPresenceFull);
  if (roster.some((entry) => !entry)) {
    return null;
  }

  return {
    ...header.snapshot,
    roster: roster as RoomPresenceSnapshot[],
  };
}

function expandHostSnapshotDelta(
  value: unknown,
  context?: RoomDecodeContext,
): HostSnapshotMessage["payload"] | null {
  const header = expandSnapshotHeader(value);
  if (!header) {
    return null;
  }

  const roster = header.roster.map((entry) => expandPresenceDynamic(entry, context));
  if (roster.some((entry) => !entry)) {
    return null;
  }

  return {
    ...header.snapshot,
    roster: roster as RoomPresenceSnapshot[],
  };
}

function expandSnapshotHeader(value: unknown):
  | {
      snapshot: Omit<HostSnapshotMessage["payload"], "roster">;
      roster: unknown[];
    }
  | null {
  if (
    !Array.isArray(value) ||
    value.length !== 6 ||
    !isSafeNumber(value[0]) ||
    typeof value[1] !== "string" ||
    !isSafeNumber(value[2]) ||
    !isSafeNumber(value[3]) ||
    !Array.isArray(value[5])
  ) {
    return null;
  }

  const phase = decodeRoomPhase(value[2]);
  const roundPhase = decodeRoundPhase(value[3]);
  const objective = expandObjective(value[4]);
  if (!phase || !roundPhase || !objective) {
    return null;
  }

  return {
    snapshot: {
      snapshotId: value[0],
      hostPeerId: value[1],
      phase,
      roundPhase,
      objective,
    },
    roster: value[5],
  };
}

function compactObjective(objective: ObjectiveStateSnapshot): unknown[] {
  return [
    objective.objectiveId,
    objective.phase,
    objective.value ?? null,
    objective.detail ?? null,
    objective.state ?? null,
  ];
}

function expandObjective(value: unknown): ObjectiveStateSnapshot | null {
  if (
    !Array.isArray(value) ||
    (value.length !== 4 && value.length !== 5) ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string" ||
    !(value[2] === null || isSafeNumber(value[2])) ||
    !(value[3] === null || typeof value[3] === "string") ||
    !(value.length < 5 || value[4] === null || isRecord(value[4]))
  ) {
    return null;
  }

  return {
    objectiveId: value[0],
    phase: value[1],
    ...(value[2] === null ? {} : { value: value[2] }),
    ...(value[3] === null ? {} : { detail: value[3] }),
    ...(value.length < 5 || value[4] === null ? {} : { state: value[4] }),
  };
}

function compactPresenceFull(presence: RoomPresenceSnapshot): unknown[] {
  return [
    presence.id,
    presence.name,
    presence.accentColor,
    encodeTeam(presence.team),
    presence.joinedAt,
    presence.health,
    presence.eliminations,
    presence.deaths,
    encodeStatus(presence.status),
    presence.position,
    presence.look,
    presence.respawnAt,
    presence.lastProcessedInputSequence,
    presence.updatedAt,
  ];
}

function compactPresenceDynamic(presence: RoomPresenceSnapshot): unknown[] {
  return [
    presence.id,
    presence.health,
    presence.eliminations,
    presence.deaths,
    encodeStatus(presence.status),
    presence.position,
    presence.look,
    presence.respawnAt,
    presence.lastProcessedInputSequence,
    presence.updatedAt,
  ];
}

function expandPresenceFull(value: unknown): RoomPresenceSnapshot | null {
  if (
    !Array.isArray(value) ||
    value.length !== 14 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string" ||
    typeof value[2] !== "string" ||
    !isSafeNumber(value[3]) ||
    !isSafeNumber(value[4]) ||
    !isSafeNumber(value[5]) ||
    !isSafeNumber(value[6]) ||
    !isSafeNumber(value[7]) ||
    !isSafeNumber(value[8]) ||
    !isVector3(value[9]) ||
    !isVector3(value[10]) ||
    !isSafeNumber(value[11]) ||
    !isSafeNumber(value[12]) ||
    !isSafeNumber(value[13])
  ) {
    return null;
  }

  const team = decodeTeam(value[3]);
  const status = decodeStatus(value[8]);
  if (!team || !status) {
    return null;
  }

  return {
    id: value[0],
    name: value[1],
    accentColor: value[2],
    team,
    joinedAt: value[4],
    health: value[5],
    eliminations: value[6],
    deaths: value[7],
    status,
    position: value[9],
    look: value[10],
    respawnAt: value[11],
    lastProcessedInputSequence: value[12],
    updatedAt: value[13],
  };
}

function expandPresenceDynamic(
  value: unknown,
  context?: RoomDecodeContext,
): RoomPresenceSnapshot | null {
  if (
    !Array.isArray(value) ||
    value.length !== 10 ||
    typeof value[0] !== "string" ||
    !isSafeNumber(value[1]) ||
    !isSafeNumber(value[2]) ||
    !isSafeNumber(value[3]) ||
    !isSafeNumber(value[4]) ||
    !isVector3(value[5]) ||
    !isVector3(value[6]) ||
    !isSafeNumber(value[7]) ||
    !isSafeNumber(value[8]) ||
    !isSafeNumber(value[9])
  ) {
    return null;
  }

  const participant = lookupParticipant(value[0], context);
  const status = decodeStatus(value[4]);
  if (!participant || !status) {
    return null;
  }

  return {
    ...participant,
    health: value[1],
    eliminations: value[2],
    deaths: value[3],
    status,
    position: value[5],
    look: value[6],
    respawnAt: value[7],
    lastProcessedInputSequence: value[8],
    updatedAt: value[9],
  };
}

function lookupParticipant(
  participantId: string,
  context?: RoomDecodeContext,
): ParticipantRecord | null {
  const participant = context?.participants?.get(participantId);
  if (participant) {
    return participant;
  }

  const previous = context?.latestSnapshot?.roster.find((entry) => entry.id === participantId);
  return previous
    ? {
        id: previous.id,
        name: previous.name,
        accentColor: previous.accentColor,
        team: previous.team,
        joinedAt: previous.joinedAt,
      }
    : null;
}

function expandHeartbeat(value: unknown): HeartbeatMessage["payload"] | null {
  if (!Array.isArray(value) || value.length !== 2 || !isSafeNumber(value[0]) || !isSafeNumber(value[1])) {
    return null;
  }

  const phase = decodeRoomPhase(value[1]);
  return phase
    ? {
        rosterCount: value[0],
        phase,
      }
    : null;
}

function encodeActions(actions: string[]): number {
  let flags = 0;
  if (actions.includes("crouch")) {
    flags |= 1;
  }
  if (actions.includes("jump")) {
    flags |= 2;
  }
  if (actions.includes("reload")) {
    flags |= 4;
  }
  return flags;
}

function decodeActions(flags: number): string[] {
  const actions: string[] = [];
  if ((flags & 1) !== 0) {
    actions.push("crouch");
  }
  if ((flags & 2) !== 0) {
    actions.push("jump");
  }
  if ((flags & 4) !== 0) {
    actions.push("reload");
  }
  return actions;
}

const TEAMS: TeamAssignment[] = ["amber", "cobalt", "observer"];
const STATUSES: CombatantStatus[] = ["alive", "down", "respawning"];
const ROOM_PHASES: RoomLifecyclePhase[] = ["waiting", "active", "ended"];
const ROUND_PHASES: RoundLifecyclePhase[] = ["staging", "live", "reset"];

function encodeTeam(value: TeamAssignment): number {
  return TEAMS.indexOf(value);
}

function decodeTeam(value: number): TeamAssignment | null {
  return TEAMS[value] ?? null;
}

function encodeStatus(value: CombatantStatus): number {
  return STATUSES.indexOf(value);
}

function decodeStatus(value: number): CombatantStatus | null {
  return STATUSES[value] ?? null;
}

function encodeRoomPhase(value: RoomLifecyclePhase): number {
  return ROOM_PHASES.indexOf(value);
}

function decodeRoomPhase(value: number): RoomLifecyclePhase | null {
  return ROOM_PHASES[value] ?? null;
}

function encodeRoundPhase(value: RoundLifecyclePhase): number {
  return ROUND_PHASES.indexOf(value);
}

function decodeRoundPhase(value: number): RoundLifecyclePhase | null {
  return ROUND_PHASES[value] ?? null;
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
    (typeof payload.look === "undefined" || isVector3(payload.look)) &&
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
    (typeof value.detail === "undefined" || typeof value.detail === "string") &&
    (typeof value.state === "undefined" || isRecord(value.state))
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
  return value === "amber" || value === "cobalt" || value === "observer";
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
