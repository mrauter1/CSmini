import { ROOM_PROTOCOL, ROOM_PROTOCOL_VERSION, type ParticipantIdentity } from "./protocol";
import { toSignalingSocketUrl } from "./signalingConfig";
import { DATA_CHANNEL_LABEL, DEFAULT_ICE_SERVERS } from "./webrtcTransport";
import type { RoomTransport, RoomTransportEvents, RoomTransportStatus } from "./transport";

interface SignaledWebRtcTransportOptions {
  signalingUrl: string;
  roomId: string;
  mapId: string;
  sessionLabel: string;
  localParticipant: ParticipantIdentity;
  role: "host" | "guest";
}

type SignalingMessage =
  | {
      type: "ready";
      peerId: string;
      role: "host" | "guest";
      hostPeerId?: string;
      maxPeers: number;
    }
  | {
      type: "waiting-for-host";
      detail: string;
    }
  | {
      type: "host-ready" | "peer-joined";
      peerId: string;
      participant: ParticipantIdentity;
      role?: "host" | "guest";
    }
  | {
      type: "offer";
      fromPeerId: string;
      toPeerId: string;
      participant: ParticipantIdentity;
      description: RTCSessionDescriptionInit;
    }
  | {
      type: "answer";
      fromPeerId: string;
      toPeerId: string;
      participant: ParticipantIdentity;
      description: RTCSessionDescriptionInit;
    }
  | {
      type: "ice-candidate";
      fromPeerId: string;
      toPeerId: string;
      candidate: RTCIceCandidateInit;
    }
  | {
      type: "peer-left";
      peerId: string;
      role: "host" | "guest";
      reason: string;
    }
  | {
      type: "room-error";
      reason: string;
      detail: string;
    }
  | {
      type: "pong";
      serverTime: number;
    };

type PeerPhase = "new" | "signaling" | "connecting" | "connected" | "closed" | "error";

interface PeerConnectionState {
  peerId: string;
  participant?: ParticipantIdentity;
  connection: RTCPeerConnection;
  dataChannel?: RTCDataChannel;
  pendingRemoteCandidates: RTCIceCandidateInit[];
  phase: PeerPhase;
}

export function detectSignaledWebRtcSupport(): { supported: boolean; reason: string } {
  if (typeof WebSocket === "undefined") {
    return {
      supported: false,
      reason: "WebSocket is unavailable in this browser.",
    };
  }

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
    reason: "WebSocket signaling and WebRTC DataChannel available.",
  };
}

export class SignaledWebRtcRoomTransport implements RoomTransport {
  readonly kind = "webrtc" as const;
  readonly localPeerId: string;

  private readonly peers = new Map<string, PeerConnectionState>();
  private socket?: WebSocket;
  private status: RoomTransportStatus;
  private events: RoomTransportEvents;
  private closed = false;

  constructor(
    private readonly options: SignaledWebRtcTransportOptions,
    events: RoomTransportEvents,
  ) {
    this.events = events;
    this.localPeerId = options.localParticipant.id;
    this.status = {
      phase: "signaling",
      detail:
        options.role === "host"
          ? "Opening the Cloudflare signaling room."
          : "Joining the Cloudflare signaling room.",
    };

    this.openSocket();
    this.events.onStatus?.(this.status);
  }

  setEvents(events: RoomTransportEvents): void {
    this.events = events;
    this.events.onStatus?.(this.status);
  }

  send(raw: string, toPeerId?: string): boolean {
    if (toPeerId) {
      return this.sendToPeer(toPeerId, raw);
    }

    if (this.options.role === "guest") {
      const hostPeer = this.firstOpenPeer();
      return hostPeer ? this.sendToPeer(hostPeer.peerId, raw) : false;
    }

    let sent = false;
    for (const peer of this.peers.values()) {
      sent = this.sendToPeer(peer.peerId, raw) || sent;
    }
    return sent;
  }

  close(reason = "closed"): void {
    this.closed = true;
    for (const peer of [...this.peers.values()]) {
      this.closePeer(peer, reason, false);
    }
    this.peers.clear();
    this.socket?.close(1000, reason);
    this.setStatus("closed", reason);
  }

  getStatus(): RoomTransportStatus {
    return this.status;
  }

  getRemoteParticipant(): ParticipantIdentity | undefined {
    return this.firstPeer()?.participant;
  }

  private openSocket(): void {
    const url = new URL(toSignalingSocketUrl(this.options.signalingUrl, this.options.roomId));
    url.searchParams.set("peerId", this.options.localParticipant.id);
    url.searchParams.set("role", this.options.role);
    url.searchParams.set("mapId", this.options.mapId);
    url.searchParams.set("name", this.options.localParticipant.name);
    url.searchParams.set("accentColor", this.options.localParticipant.accentColor);

    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", this.handleSocketOpen);
    this.socket.addEventListener("message", this.handleSocketMessage);
    this.socket.addEventListener("close", this.handleSocketClose);
    this.socket.addEventListener("error", this.handleSocketError);
  }

  private ensurePeer(peerId: string, participant?: ParticipantIdentity): PeerConnectionState {
    const existing = this.peers.get(peerId);
    if (existing) {
      if (participant) {
        existing.participant = participant;
      }
      return existing;
    }

    const peer: PeerConnectionState = {
      peerId,
      participant,
      connection: new RTCPeerConnection({
        iceServers: DEFAULT_ICE_SERVERS,
        bundlePolicy: "max-bundle",
      }),
      pendingRemoteCandidates: [],
      phase: "new",
    };

    peer.connection.addEventListener("icecandidate", (event) => {
      this.handleIceCandidate(peer, event);
    });
    peer.connection.addEventListener("connectionstatechange", () => {
      this.handleConnectionState(peer);
    });
    peer.connection.addEventListener("icecandidateerror", () => {
      this.handleIceCandidateError(peer);
    });

    if (this.options.role === "host") {
      this.bindChannel(
        peer,
        peer.connection.createDataChannel(DATA_CHANNEL_LABEL, {
          ordered: true,
        }),
      );
    } else {
      peer.connection.addEventListener("datachannel", (event) => {
        this.bindChannel(peer, event.channel);
      });
    }

    this.peers.set(peerId, peer);
    return peer;
  }

  private async createAndSendOffer(peerId: string, participant: ParticipantIdentity): Promise<void> {
    if (this.options.role !== "host") {
      return;
    }

    const peer = this.ensurePeer(peerId, participant);
    if (peer.phase !== "new" && peer.phase !== "closed" && peer.phase !== "error") {
      return;
    }

    peer.phase = "signaling";
    this.updateAggregateStatus(`Creating WebRTC offer for ${participant.name}.`);

    const offer = await peer.connection.createOffer();
    await peer.connection.setLocalDescription(offer);
    const description = peer.connection.localDescription?.toJSON() ?? offer;
    this.sendSignal({
      type: "offer",
      toPeerId: peerId,
      description,
    });
    peer.phase = "connecting";
    this.updateAggregateStatus(`Offer sent to ${participant.name}. Waiting for answer.`);
  }

  private async acceptOffer(message: Extract<SignalingMessage, { type: "offer" }>): Promise<void> {
    if (this.options.role !== "guest") {
      return;
    }

    const existingHost = this.firstPeer();
    if (existingHost && existingHost.peerId !== message.fromPeerId) {
      return;
    }

    const peer = this.ensurePeer(message.fromPeerId, message.participant);
    peer.phase = "signaling";
    this.updateAggregateStatus(`Answering ${message.participant.name}'s room offer.`);

    await peer.connection.setRemoteDescription(message.description);
    await this.flushPendingRemoteCandidates(peer);
    const answer = await peer.connection.createAnswer();
    await peer.connection.setLocalDescription(answer);
    const description = peer.connection.localDescription?.toJSON() ?? answer;
    this.sendSignal({
      type: "answer",
      toPeerId: message.fromPeerId,
      description,
    });
    peer.phase = "connecting";
    this.updateAggregateStatus("Answer sent. Establishing the data channel.");
  }

  private async acceptAnswer(message: Extract<SignalingMessage, { type: "answer" }>): Promise<void> {
    if (this.options.role !== "host") {
      return;
    }

    const peer = this.peers.get(message.fromPeerId);
    if (!peer) {
      return;
    }

    peer.participant = message.participant;
    peer.phase = "connecting";
    this.updateAggregateStatus(`Answer received from ${message.participant.name}.`);
    await peer.connection.setRemoteDescription(message.description);
    await this.flushPendingRemoteCandidates(peer);
  }

  private async acceptIceCandidate(
    message: Extract<SignalingMessage, { type: "ice-candidate" }>,
  ): Promise<void> {
    const peer = this.peers.get(message.fromPeerId);
    if (!peer) {
      return;
    }

    if (!peer.connection.remoteDescription) {
      peer.pendingRemoteCandidates.push(message.candidate);
      return;
    }

    await peer.connection.addIceCandidate(message.candidate);
  }

  private async flushPendingRemoteCandidates(peer: PeerConnectionState): Promise<void> {
    if (!peer.connection.remoteDescription) {
      return;
    }

    while (peer.pendingRemoteCandidates.length > 0) {
      const candidate = peer.pendingRemoteCandidates.shift();
      if (candidate) {
        await peer.connection.addIceCandidate(candidate);
      }
    }
  }

  private bindChannel(peer: PeerConnectionState, channel: RTCDataChannel): void {
    this.unbindChannel(peer);
    peer.dataChannel = channel;
    channel.addEventListener("open", () => {
      this.handleChannelOpen(peer);
    });
    channel.addEventListener("close", () => {
      this.handleChannelClose(peer);
    });
    channel.addEventListener("message", this.handleChannelMessage);
    channel.addEventListener("error", () => {
      this.handleChannelError(peer);
    });
  }

  private unbindChannel(peer: PeerConnectionState): void {
    peer.dataChannel?.removeEventListener("message", this.handleChannelMessage);
  }

  private sendToPeer(peerId: string, raw: string): boolean {
    const peer = this.peers.get(peerId);
    if (!peer?.dataChannel || peer.dataChannel.readyState !== "open") {
      return false;
    }

    peer.dataChannel.send(raw);
    return true;
  }

  private firstPeer(): PeerConnectionState | undefined {
    return this.peers.values().next().value as PeerConnectionState | undefined;
  }

  private firstOpenPeer(): PeerConnectionState | undefined {
    return [...this.peers.values()].find((peer) => peer.dataChannel?.readyState === "open");
  }

  private closePeer(peer: PeerConnectionState, reason: string, emitDisconnect: boolean): void {
    const wasTracked = this.peers.has(peer.peerId);
    this.unbindChannel(peer);
    peer.phase = "closed";
    peer.dataChannel?.close();
    peer.connection.close();
    this.peers.delete(peer.peerId);

    if (emitDisconnect && wasTracked) {
      this.emitSyntheticDisconnect(peer.peerId, reason);
    }
  }

  private emitSyntheticDisconnect(peerId: string, reason: string): void {
    const now = Date.now();
    this.events.onMessage({
      raw: JSON.stringify({
        protocol: ROOM_PROTOCOL,
        version: ROOM_PROTOCOL_VERSION,
        type: "disconnect",
        roomId: this.options.roomId,
        fromPeerId: peerId,
        toPeerId: this.localPeerId,
        seq: now,
        sentAt: now,
        payload: {
          reason,
        },
      }),
      receivedAt: now,
    });
  }

  private updateAggregateStatus(preferredDetail?: string): void {
    if (this.closed) {
      return;
    }

    const peers = [...this.peers.values()];
    const connected = peers.filter((peer) => peer.dataChannel?.readyState === "open").length;
    const failed = peers.filter((peer) => peer.phase === "error").length;
    const negotiating = Math.max(0, peers.length - connected - failed);

    if (this.options.role === "host") {
      if (connected > 0) {
        const joining = negotiating > 0 ? ` ${negotiating} joining.` : "";
        const failures = failed > 0 ? ` ${failed} failed.` : "";
        this.setStatus(
          "connected",
          `Connected with ${connected} remote operator${connected === 1 ? "" : "s"}.${joining}${failures}`,
        );
        return;
      }

      if (negotiating > 0) {
        this.setStatus(
          "connecting",
          preferredDetail ??
            `Negotiating with ${negotiating} remote operator${negotiating === 1 ? "" : "s"}.`,
        );
        return;
      }

      if (failed > 0) {
        this.setStatus("error", `${failed} peer connection${failed === 1 ? "" : "s"} failed.`);
        return;
      }

      this.setStatus("waiting", "Cloud room is online. Waiting for guests.");
      return;
    }

    const peer = this.firstPeer();
    if (connected > 0) {
      const remoteName = peer?.participant?.name;
      this.setStatus(
        "connected",
        remoteName ? `Connected to ${remoteName}.` : "Peer connection established.",
      );
      return;
    }

    if (negotiating > 0) {
      this.setStatus("connecting", preferredDetail ?? "Establishing the host data channel.");
      return;
    }

    if (failed > 0) {
      this.setStatus("error", "WebRTC connection failed.");
      return;
    }

    this.setStatus("closed", "Host connection closed.");
  }

  private sendSignal(message: Record<string, unknown>): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.setStatus("error", "Signaling socket is not connected.");
      return false;
    }

    this.socket.send(JSON.stringify(message));
    return true;
  }

  private setStatus(phase: RoomTransportStatus["phase"], detail: string): void {
    if (this.status.phase === phase && this.status.detail === detail) {
      return;
    }

    this.status = { phase, detail };
    this.events.onStatus?.(this.status);
  }

  private readonly handleSocketOpen = (): void => {
    this.setStatus(
      this.options.role === "host" ? "waiting" : "signaling",
      this.options.role === "host"
        ? "Cloud room is online. Waiting for guests."
        : "Connected to signaling. Waiting for the host offer.",
    );
    this.sendSignal({ type: "ping" });
  };

  private readonly handleSocketMessage = (event: MessageEvent<unknown>): void => {
    if (typeof event.data !== "string") {
      return;
    }

    const message = parseSignalingMessage(event.data);
    if (!message) {
      this.setStatus("error", "Received an invalid signaling message.");
      return;
    }

    void this.handleSignalingMessage(message).catch((error) => {
      this.setStatus(
        "error",
        error instanceof Error ? error.message : "Signaling negotiation failed.",
      );
    });
  };

  private async handleSignalingMessage(message: SignalingMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        if (this.options.role === "host") {
          this.setStatus("waiting", "Cloud room is online. Waiting for guests.");
        }
        return;
      case "waiting-for-host":
        this.setStatus("waiting", message.detail);
        return;
      case "host-ready":
        if (this.options.role === "guest") {
          this.ensurePeer(message.peerId, message.participant);
          this.setStatus("waiting", `Host ${message.participant.name} found. Waiting for offer.`);
        }
        return;
      case "peer-joined":
        await this.createAndSendOffer(message.peerId, message.participant);
        return;
      case "offer":
        await this.acceptOffer(message);
        return;
      case "answer":
        await this.acceptAnswer(message);
        return;
      case "ice-candidate":
        await this.acceptIceCandidate(message);
        return;
      case "peer-left": {
        const peer = this.peers.get(message.peerId);
        if (peer) {
          this.closePeer(peer, message.reason, true);
          this.updateAggregateStatus();
        }
        return;
      }
      case "room-error":
        this.setStatus("error", message.detail);
        return;
      case "pong":
        return;
    }
  }

  private readonly handleSocketClose = (): void => {
    if (this.closed) {
      return;
    }

    if (this.firstOpenPeer()) {
      this.updateAggregateStatus();
      return;
    }

    this.setStatus("closed", "Signaling server disconnected.");
  };

  private readonly handleSocketError = (): void => {
    if (this.status.phase !== "connected") {
      this.setStatus("error", "Signaling server connection failed.");
    }
  };

  private handleIceCandidate(peer: PeerConnectionState, event: RTCPeerConnectionIceEvent): void {
    if (!event.candidate) {
      return;
    }

    this.sendSignal({
      type: "ice-candidate",
      toPeerId: peer.peerId,
      candidate: event.candidate.toJSON(),
    });
  }

  private handleChannelOpen(peer: PeerConnectionState): void {
    peer.phase = "connected";
    this.updateAggregateStatus();
  }

  private handleChannelClose(peer: PeerConnectionState): void {
    if (this.closed || peer.phase === "closed") {
      return;
    }

    this.closePeer(peer, "closed", true);
    this.updateAggregateStatus();
  }

  private readonly handleChannelMessage = (event: MessageEvent<unknown>): void => {
    if (typeof event.data !== "string") {
      return;
    }

    this.events.onMessage({
      raw: event.data,
      receivedAt: Date.now(),
    });
  };

  private handleChannelError(peer: PeerConnectionState): void {
    peer.phase = "error";
    this.updateAggregateStatus("DataChannel error.");
  }

  private handleConnectionState(peer: PeerConnectionState): void {
    switch (peer.connection.connectionState) {
      case "connected":
        peer.phase = "connected";
        this.updateAggregateStatus();
        return;
      case "connecting":
        peer.phase = "connecting";
        this.updateAggregateStatus("Negotiation complete. Establishing the data channel.");
        return;
      case "failed":
        peer.phase = "error";
        this.closePeer(peer, "failed", true);
        if (this.options.role === "guest") {
          this.setStatus("error", "WebRTC connection failed.");
          return;
        }
        this.updateAggregateStatus("WebRTC connection failed.");
        return;
      case "disconnected":
        peer.phase = "connecting";
        this.updateAggregateStatus("Peer disconnected. Waiting for reconnection.");
        return;
      case "closed":
        if (!this.closed && this.peers.has(peer.peerId)) {
          this.closePeer(peer, "closed", true);
          this.updateAggregateStatus();
        }
        return;
      default:
        return;
    }
  }

  private handleIceCandidateError(_peer: PeerConnectionState): void {
    // Candidate errors can be emitted for one STUN path while other candidates still succeed.
    // The connection state is the authoritative failure signal.
  }
}

function parseSignalingMessage(raw: string): SignalingMessage | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return isSignalingMessage(value) ? value : null;
  } catch {
    return null;
  }
}

function isSignalingMessage(value: unknown): value is SignalingMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "ready":
      return typeof value.peerId === "string" && (value.role === "host" || value.role === "guest");
    case "waiting-for-host":
      return typeof value.detail === "string";
    case "host-ready":
    case "peer-joined":
      return typeof value.peerId === "string" && isParticipant(value.participant);
    case "offer":
    case "answer":
      return (
        typeof value.fromPeerId === "string" &&
        typeof value.toPeerId === "string" &&
        isParticipant(value.participant) &&
        isSessionDescription(value.description)
      );
    case "ice-candidate":
      return (
        typeof value.fromPeerId === "string" &&
        typeof value.toPeerId === "string" &&
        isRecord(value.candidate)
      );
    case "peer-left":
      return (
        typeof value.peerId === "string" &&
        (value.role === "host" || value.role === "guest") &&
        typeof value.reason === "string"
      );
    case "room-error":
      return typeof value.reason === "string" && typeof value.detail === "string";
    case "pong":
      return typeof value.serverTime === "number";
    default:
      return false;
  }
}

function isParticipant(value: unknown): value is ParticipantIdentity {
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
    (value.type === "offer" || value.type === "answer" || value.type === "pranswer") &&
    typeof value.sdp === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
