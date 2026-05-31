import type { ParticipantIdentity } from "./protocol";

const DEFAULT_SIGNALING_URL = "https://csmini-signaling.csmini.workers.dev";
const SIGNALING_URL_STORAGE_KEY = "dustline.signaling-url";
const DIRECT_FIRST_ICE_STORAGE_KEY = "dustline.direct-first-ice";
const SAFE_SIGNALING_ROOM_ID = /^[a-zA-Z0-9:._-]{3,96}$/;
const SAFE_SIGNALING_PEER_ID = /^[a-zA-Z0-9:._-]{3,96}$/;
const SAFE_SIGNALING_MAP_ID = /^[a-z0-9-]{3,64}$/;
const SAFE_SIGNALING_ACCENT_COLOR = /^#[0-9A-Fa-f]{6}$/;
const MAX_SIGNALING_NAME_LENGTH = 32;
const MAX_SIGNALING_CANDIDATE_FIELD_BYTES = 64;
const MAX_SIGNALING_CANDIDATE_LINE_INDEX = 32;
const UTF8 = new TextEncoder();

// Mirror the signaling Worker budgets client-side so oversized payloads never leave the browser.
export const MAX_SIGNALING_RAW_MESSAGE_BYTES = 24 * 1024;
export const MAX_SIGNALING_DESCRIPTION_BYTES = 12 * 1024;
export const MAX_SIGNALING_ICE_CANDIDATE_BYTES = 2 * 1024;
export const MAX_SIGNALING_INVALID_MESSAGES = 4;
export const MAX_TRANSPORT_BUFFERED_BYTES = 256 * 1024;
export const DIRECT_FIRST_RELAY_DELAY_MS = 1_500;

declare global {
  interface Window {
    __DUSTLINE_SIGNALING_URL__?: string;
    __DUSTLINE_DIRECT_FIRST_ICE__?: boolean;
  }
}

export function getSignalingServiceUrl(): string {
  const buildValue = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  const runtimeValue = typeof window !== "undefined" ? window.__DUSTLINE_SIGNALING_URL__ : "";
  const storedValue = readStoredSignalingUrl();

  return normalizeSignalingUrl(runtimeValue || storedValue || buildValue || DEFAULT_SIGNALING_URL);
}

export function toSignalingSocketUrl(baseUrl: string, roomId: string): string {
  const url = new URL(normalizeSignalingUrl(baseUrl));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}/room/${encodeURIComponent(roomId)}`;
  return url.toString();
}

export function shouldUseDirectFirstIce(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  if (window.__DUSTLINE_DIRECT_FIRST_ICE__ === true) {
    return true;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    const queryValue = params.get("directFirstIce");
    if (queryValue) {
      return isTruthyFlag(queryValue);
    }
  } catch {
    // Ignore URL parsing failures and use the stored/default value.
  }

  try {
    return isTruthyFlag(localStorage.getItem(DIRECT_FIRST_ICE_STORAGE_KEY) ?? "");
  } catch {
    return false;
  }
}

export function utf8ByteLength(value: string): number {
  return UTF8.encode(value).byteLength;
}

export function validateSignalingClientContext(context: {
  roomId: string;
  mapId: string;
  participant: ParticipantIdentity;
}): string | null {
  if (!isValidSignalingRoomId(context.roomId)) {
    return "Cloud room id failed client-side validation.";
  }

  if (!isValidSignalingMapId(context.mapId)) {
    return "Cloud room map id failed client-side validation.";
  }

  if (!isValidSignalingParticipant(context.participant)) {
    return "Cloud room participant identity failed client-side validation.";
  }

  return null;
}

export function isValidSignalingRoomId(value: string): boolean {
  return SAFE_SIGNALING_ROOM_ID.test(value.trim());
}

export function isValidSignalingPeerId(value: string): boolean {
  return SAFE_SIGNALING_PEER_ID.test(value.trim());
}

export function isValidSignalingMapId(value: string): boolean {
  return SAFE_SIGNALING_MAP_ID.test(value.trim());
}

export function isValidSignalingParticipant(value: ParticipantIdentity): boolean {
  if (!isValidSignalingPeerId(value.id)) {
    return false;
  }

  const normalizedName = normalizeDisplayText(value.name, MAX_SIGNALING_NAME_LENGTH);
  if (!normalizedName || normalizedName !== value.name.trim()) {
    return false;
  }

  return SAFE_SIGNALING_ACCENT_COLOR.test(value.accentColor.trim());
}

export function sanitizeSignalingDescription(
  value: unknown,
  expectedType: "offer" | "answer",
): RTCSessionDescriptionInit | null {
  if (
    !isRecord(value) ||
    value.type !== expectedType ||
    typeof value.sdp !== "string" ||
    value.sdp.length === 0 ||
    utf8ByteLength(value.sdp) > MAX_SIGNALING_DESCRIPTION_BYTES
  ) {
    return null;
  }

  return {
    type: expectedType,
    sdp: value.sdp,
  };
}

export function sanitizeSignalingIceCandidate(value: unknown): RTCIceCandidateInit | null {
  if (!isRecord(value) || typeof value.candidate !== "string") {
    return null;
  }

  if (!value.candidate || utf8ByteLength(value.candidate) > MAX_SIGNALING_ICE_CANDIDATE_BYTES) {
    return null;
  }

  const candidate: RTCIceCandidateInit = {
    candidate: value.candidate,
  };

  if (value.sdpMid !== undefined) {
    if (typeof value.sdpMid !== "string" || utf8ByteLength(value.sdpMid) > MAX_SIGNALING_CANDIDATE_FIELD_BYTES) {
      return null;
    }
    candidate.sdpMid = value.sdpMid;
  }

  if (value.sdpMLineIndex !== undefined) {
    const lineIndex = value.sdpMLineIndex;
    if (
      typeof lineIndex !== "number" ||
      !Number.isInteger(lineIndex) ||
      lineIndex < 0 ||
      lineIndex > MAX_SIGNALING_CANDIDATE_LINE_INDEX
    ) {
      return null;
    }
    candidate.sdpMLineIndex = lineIndex;
  }

  if (value.usernameFragment !== undefined) {
    if (
      typeof value.usernameFragment !== "string" ||
      utf8ByteLength(value.usernameFragment) > MAX_SIGNALING_CANDIDATE_FIELD_BYTES
    ) {
      return null;
    }
    candidate.usernameFragment = value.usernameFragment;
  }

  return candidate;
}

function readStoredSignalingUrl(): string {
  try {
    return localStorage.getItem(SIGNALING_URL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function normalizeSignalingUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function isTruthyFlag(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeDisplayText(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
