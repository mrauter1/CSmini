import type { ParticipantIdentity } from "./protocol";

const SIGNAL_VERSION = 1 as const;
const ICE_GATHERING_STABLE_MS = 1_500;
const ICE_GATHERING_MIN_MS = 1_000;
const ICE_GATHERING_RELAY_GRACE_MS = 6_000;

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
  timeoutMs = 20_000,
): Promise<void> {
  if (connection.iceGatheringState === "complete") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    let latestCandidateAt = startedAt;
    let stableCheckTimer = 0;
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (hasLocalIceCandidate(connection)) {
        finish();
        return;
      }

      cleanup();
      reject(new Error("Timed out while collecting ICE candidates."));
    }, timeoutMs);

    const cleanup = (): void => {
      window.clearTimeout(timeout);
      if (stableCheckTimer) {
        window.clearTimeout(stableCheckTimer);
      }
      connection.removeEventListener("icegatheringstatechange", handleStateChange);
      connection.removeEventListener("icecandidate", handleIceCandidate);
    };

    const finish = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve();
    };

    const handleStateChange = (): void => {
      if (connection.iceGatheringState !== "complete") {
        return;
      }

      finish();
    };

    const handleIceCandidate = (event: RTCPeerConnectionIceEvent): void => {
      if (!event.candidate) {
        finish();
        return;
      }

      latestCandidateAt = Date.now();
      scheduleStableCheck();
    };

    const scheduleStableCheck = (): void => {
      if (stableCheckTimer) {
        window.clearTimeout(stableCheckTimer);
      }

      stableCheckTimer = window.setTimeout(checkStableCandidates, ICE_GATHERING_STABLE_MS);
    };

    const checkStableCandidates = (): void => {
      stableCheckTimer = 0;
      if (settled) {
        return;
      }

      if (connection.iceGatheringState === "complete") {
        finish();
        return;
      }

      if (!hasLocalIceCandidate(connection)) {
        return;
      }

      const now = Date.now();
      const elapsed = now - startedAt;
      const stableFor = now - latestCandidateAt;
      if (elapsed < ICE_GATHERING_MIN_MS || stableFor < ICE_GATHERING_STABLE_MS) {
        scheduleStableCheck();
        return;
      }

      if (hasRelayIceCandidate(connection) || elapsed >= ICE_GATHERING_RELAY_GRACE_MS) {
        finish();
      }
    };

    connection.addEventListener("icegatheringstatechange", handleStateChange);
    connection.addEventListener("icecandidate", handleIceCandidate);
    handleStateChange();
    if (hasLocalIceCandidate(connection)) {
      scheduleStableCheck();
    }
  });
}

function hasLocalIceCandidate(connection: RTCPeerConnection): boolean {
  return /(?:^|\r?\n)a=candidate:/m.test(connection.localDescription?.sdp ?? "");
}

function hasRelayIceCandidate(connection: RTCPeerConnection): boolean {
  return / typ relay(?: |\r?\n)/.test(connection.localDescription?.sdp ?? "");
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
