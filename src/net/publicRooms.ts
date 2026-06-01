import { isValidSignalingMapId } from "./signalingConfig";
import { publicRoomSlotForCode } from "./publicRoomSlots";

export interface PublicRoomSummary {
  roomId: string;
  roomCode: string;
  mapId: string;
  mapName: string;
  hostPeerId: string;
  hostName: string;
  hostAccentColor: string;
  publicSlot: number;
  participantCount: number;
  maxPeers: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface PublicRoomsResponse {
  ok: boolean;
  ttlMs?: number;
  rooms?: unknown;
  error?: string;
}

export async function fetchPublicRooms(
  signalingUrl: string,
  mapId?: string,
): Promise<PublicRoomSummary[]> {
  const url = new URL(signalingUrl);
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}/public-rooms`;
  url.search = "";
  if (mapId && isValidSignalingMapId(mapId)) {
    url.searchParams.set("mapId", mapId);
  }

  const response = await fetch(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Public rooms failed with HTTP ${response.status}.`);
  }

  const body = (await response.json()) as PublicRoomsResponse;
  if (!body.ok || !Array.isArray(body.rooms)) {
    throw new Error(body.error ?? "Public rooms response was invalid.");
  }

  return body.rooms.map(toPublicRoomSummary).filter((room): room is PublicRoomSummary => Boolean(room));
}

function toPublicRoomSummary(value: unknown): PublicRoomSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const roomCode = stringField(value.roomCode);
  const mapId = stringField(value.mapId);
  const mapName = stringField(value.mapName);
  const hostName = stringField(value.hostName);
  const publicSlot = integerField(value.publicSlot);
  const participantCount = integerField(value.participantCount);
  const maxPeers = integerField(value.maxPeers);

  if (!roomCode || !mapId || !mapName || !hostName || participantCount < 1 || maxPeers < 1) {
    return null;
  }

  return {
    roomId: stringField(value.roomId),
    roomCode,
    mapId,
    mapName,
    hostPeerId: stringField(value.hostPeerId),
    hostName,
    hostAccentColor: stringField(value.hostAccentColor) || "#CFA66F",
    publicSlot: publicSlot || (publicRoomSlotForCode(roomCode)?.slot ?? 0),
    participantCount,
    maxPeers,
    createdAt: integerField(value.createdAt),
    updatedAt: integerField(value.updatedAt),
    expiresAt: integerField(value.expiresAt),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integerField(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}
