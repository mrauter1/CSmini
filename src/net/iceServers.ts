import { getSignalingServiceUrl } from "./signalingConfig";

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
];

const MAX_ICE_SERVER_COUNT = 12;
const MAX_ICE_URLS_PER_SERVER = 8;
const MAX_ICE_URL_LENGTH = 256;
const MAX_ICE_CREDENTIAL_LENGTH = 256;
const ICE_SERVER_FETCH_TIMEOUT_MS = 4_000;
const ICE_URL_PATTERN = /^(stun|stuns|turn|turns):[^"'<>\\\s]+$/i;

export function toTurnCredentialsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}/turn-credentials`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function loadIceServers(signalingUrl = getSignalingServiceUrl()): Promise<RTCIceServer[]> {
  let timeoutHandle = 0;
  const controller = new AbortController();

  try {
    timeoutHandle = window.setTimeout(() => {
      controller.abort();
    }, ICE_SERVER_FETCH_TIMEOUT_MS);

    const response = await fetch(toTurnCredentialsUrl(signalingUrl), {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      return DEFAULT_ICE_SERVERS;
    }

    return sanitizeIceServers(await response.json());
  } catch {
    return DEFAULT_ICE_SERVERS;
  } finally {
    if (timeoutHandle) {
      window.clearTimeout(timeoutHandle);
    }
  }
}

export function sanitizeIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value)) {
    return DEFAULT_ICE_SERVERS;
  }

  const servers: RTCIceServer[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    const urls = sanitizeIceUrls(item.urls);
    if (!urls) {
      continue;
    }

    const server: RTCIceServer = { urls };
    if (typeof item.username === "string" && item.username.length <= MAX_ICE_CREDENTIAL_LENGTH) {
      server.username = item.username;
    }
    if (typeof item.credential === "string" && item.credential.length <= MAX_ICE_CREDENTIAL_LENGTH) {
      server.credential = item.credential;
    }

    servers.push(server);
    if (servers.length >= MAX_ICE_SERVER_COUNT) {
      break;
    }
  }

  return servers.length > 0 ? servers : DEFAULT_ICE_SERVERS;
}

function sanitizeIceUrls(value: unknown): string | string[] | null {
  if (typeof value === "string") {
    return isSafeIceUrl(value) ? value : null;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const urls = value.filter(isSafeIceUrl).slice(0, MAX_ICE_URLS_PER_SERVER);
  return urls.length > 0 ? urls : null;
}

function isSafeIceUrl(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ICE_URL_LENGTH && ICE_URL_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
