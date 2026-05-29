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
  fromPeerId?: string;
}

export interface RoomTransportEvents {
  onMessage: (event: RoomTransportMessageEvent) => void;
  onStatus?: (status: RoomTransportStatus) => void;
}

export interface RoomTransport {
  readonly kind: RoomTransportKind;
  readonly localPeerId: string;
  setEvents(events: RoomTransportEvents): void;
  send(raw: string, toPeerId?: string): boolean;
  disconnectPeer?(peerId: string, reason?: string): void;
  close(reason?: string): void;
  getStatus(): RoomTransportStatus;
}
