export type RoomTransportKind = "broadcast" | "webrtc";
export type RoomTransportLane = "reliable" | "latest-state";
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
  lane: RoomTransportLane;
  raw: string;
  receivedAt: number;
  fromPeerId?: string;
}

export interface RoomTransportEvents {
  onMessage: (event: RoomTransportMessageEvent) => void;
  onStatus?: (status: RoomTransportStatus) => void;
}

export interface RoomTransportSendOptions {
  latestStateOnlyIfBuffered?: boolean;
}

export interface RoomTransportPeerStats {
  peerId: string;
  phase: string;
  sampledAt: number;
  bytesSent: number;
  bytesReceived: number;
  localCandidateType: string;
  remoteCandidateType: string;
  localProtocol: string;
  remoteProtocol: string;
  usingRelay: boolean;
}

export interface RoomTransportDebugSnapshot {
  peers: RoomTransportPeerStats[];
  directFirstIce: boolean;
  relayCandidateDelayMs: number;
}

export interface RoomTransport {
  readonly kind: RoomTransportKind;
  readonly localPeerId: string;
  setEvents(events: RoomTransportEvents): void;
  send(
    raw: string,
    toPeerId?: string,
    lane?: RoomTransportLane,
    options?: RoomTransportSendOptions,
  ): boolean;
  disconnectPeer?(peerId: string, reason?: string): void;
  close(reason?: string): void;
  getStatus(): RoomTransportStatus;
  getDebugSnapshot?(): RoomTransportDebugSnapshot;
}
