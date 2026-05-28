export type RoomTransportKind = "broadcast" | "webrtc";
export type RoomTransportPhase =
  | "idle"
  | "signaling"
  | "waiting"
  | "connecting"
  | "connected"
  | "closed"
  | "error";

export interface RoomTransportStatus {
  phase: RoomTransportPhase;
  detail: string;
}

export interface RoomTransportMessageEvent {
  raw: string;
  receivedAt: number;
}

export interface RoomTransportEvents {
  onMessage: (event: RoomTransportMessageEvent) => void;
  onStatus?: (status: RoomTransportStatus) => void;
}

export interface RoomTransport {
  readonly kind: RoomTransportKind;
  readonly localPeerId: string;
  setEvents(events: RoomTransportEvents): void;
  send(raw: string): boolean;
  close(reason?: string): void;
  getStatus(): RoomTransportStatus;
}
