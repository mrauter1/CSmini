import type { ParticipantIdentity } from "./protocol";

const SIGNAL_VERSION = 1 as const;

interface SignalEnvelopeBase<Role extends string> {
  version: typeof SIGNAL_VERSION;
  role: Role;
  roomId: string;
  mapId: string;
  participant: ParticipantIdentity;
  description: RTCSessionDescriptionInit;
}

export interface HostOfferSignal extends SignalEnvelopeBase<"host-offer"> {
  sessionLabel: string;
}

export interface GuestAnswerSignal extends SignalEnvelopeBase<"guest-answer"> {
  hostPeerId: string;
}

export type ManualSignalEnvelope = HostOfferSignal | GuestAnswerSignal;

export function detectWebRtcSupport(): { supported: boolean; reason: string } {
  if (typeof RTCPeerConnection === "undefined") {
    return {
      supported: false,
      reason: "RTCPeerConnection is unavailable in this browser.",
    };
  }

  if (typeof RTCDataChannel === "undefined") {
    return {
      supported: false,
      reason: "RTCDataChannel is unavailable in this browser.",
    };
  }

  return {
    supported: true,
    reason: "WebRTC DataChannel available.",
  };
}

export function encodeSignalEnvelope(envelope: ManualSignalEnvelope): string {
  return btoa(JSON.stringify(envelope));
}

export function decodeSignalEnvelope(raw: string): ManualSignalEnvelope | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const decoded = atob(trimmed);
    const value = JSON.parse(decoded) as unknown;
    return parseSignalEnvelope(value);
  } catch {
    return null;
  }
}

export async function waitForIceGatheringComplete(
  connection: RTCPeerConnection,
  timeoutMs = 8_000,
): Promise<void> {
  if (connection.iceGatheringState === "complete") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while collecting ICE candidates."));
    }, timeoutMs);

    const cleanup = (): void => {
      window.clearTimeout(timeout);
      connection.removeEventListener("icegatheringstatechange", handleStateChange);
    };

    const handleStateChange = (): void => {
      if (connection.iceGatheringState !== "complete") {
        return;
      }

      cleanup();
      resolve();
    };

    connection.addEventListener("icegatheringstatechange", handleStateChange);
  });
}

function parseSignalEnvelope(value: unknown): ManualSignalEnvelope | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.version !== SIGNAL_VERSION ||
    typeof value.role !== "string" ||
    typeof value.roomId !== "string" ||
    typeof value.mapId !== "string" ||
    !isParticipantIdentity(value.participant) ||
    !isSessionDescription(value.description)
  ) {
    return null;
  }

  if (value.role === "host-offer" && typeof value.sessionLabel === "string") {
    return value as unknown as HostOfferSignal;
  }

  if (value.role === "guest-answer" && typeof value.hostPeerId === "string") {
    return value as unknown as GuestAnswerSignal;
  }

  return null;
}

function isParticipantIdentity(value: unknown): value is ParticipantIdentity {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.accentColor === "string"
  );
}

function isSessionDescription(value: unknown): value is RTCSessionDescriptionInit {
  return (
    isRecord(value) &&
    (value.type === "offer" || value.type === "answer" || value.type === "pranswer" || value.type === "rollback") &&
    typeof value.sdp === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
