const DEFAULT_SIGNALING_URL = "https://csmini-signaling.csmini.workers.dev";
const SIGNALING_URL_STORAGE_KEY = "dustline.signaling-url";

declare global {
  interface Window {
    __DUSTLINE_SIGNALING_URL__?: string;
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
