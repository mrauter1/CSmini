import { DATA_CHANNEL_LABEL, DEFAULT_ICE_SERVERS } from "./webrtcTransport";
import { toSignalingSocketUrl } from "./signalingConfig";
import type { ParticipantIdentity } from "./protocol";
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

  private connection?: RTCPeerConnection;
  private dataChannel?: RTCDataChannel;
  private remotePeerId = "";
  private remoteParticipant?: ParticipantIdentity;
  private socket?: WebSocket;
  private status: RoomTransportStatus;
  private events: RoomTransportEvents;
  private closed = false;
  private readonly pendingRemoteCandidates: RTCIceCandidateInit[] = [];

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

  send(raw: string): boolean {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      return false;
    }

    this.dataChannel.send(raw);
    return true;
  }

  close(reason = "closed"): void {
    this.closed = true;
    this.unbindChannel();
    this.dataChannel?.close();
    this.connection?.close();
    this.socket?.close(1000, reason);
    this.setStatus("closed", reason);
  }

  getStatus(): RoomTransportStatus {
    return this.status;
  }

  getRemoteParticipant(): ParticipantIdentity | undefined {
    return this.remoteParticipant;
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

  private ensurePeerConnection(): RTCPeerConnection {
    if (this.connection) {
      return this.connection;
    }

    this.connection = new RTCPeerConnection({
      iceServers: DEFAULT_ICE_SERVERS,
      bundlePolicy: "max-bundle",
    });
    this.connection.addEventListener("icecandidate", this.handleIceCandidate);
    this.connection.addEventListener("connectionstatechange", this.handleConnectionState);
    this.connection.addEventListener("icecandidateerror", this.handleIceCandidateError);

    if (this.options.role === "host") {
      this.bindChannel(
        this.connection.createDataChannel(DATA_CHANNEL_LABEL, {
          ordered: true,
        }),
      );
    } else {
      this.connection.addEventListener("datachannel", this.handleDataChannel);
    }

    return this.connection;
  }

  private async createAndSendOffer(peerId: string, participant: ParticipantIdentity): Promise<void> {
    if (this.options.role !== "host" || this.remotePeerId) {
      return;
    }

    this.remotePeerId = peerId;
    this.remoteParticipant = participant;
    this.setStatus("signaling", `Creating WebRTC offer for ${participant.name}.`);

    const connection = this.ensurePeerConnection();
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    const description = connection.localDescription?.toJSON() ?? offer;
    this.sendSignal({
      type: "offer",
      toPeerId: peerId,
      description,
    });
    this.setStatus("waiting", `Offer sent to ${participant.name}. Waiting for answer.`);
  }

  private async acceptOffer(message: Extract<SignalingMessage, { type: "offer" }>): Promise<void> {
    if (this.options.role !== "guest") {
      return;
    }

    this.remotePeerId = message.fromPeerId;
    this.remoteParticipant = message.participant;
    this.setStatus("signaling", `Answering ${message.participant.name}'s room offer.`);

    const connection = this.ensurePeerConnection();
    await connection.setRemoteDescription(message.description);
    await this.flushPendingRemoteCandidates();
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    const description = connection.localDescription?.toJSON() ?? answer;
    this.sendSignal({
      type: "answer",
      toPeerId: message.fromPeerId,
      description,
    });
    this.setStatus("connecting", "Answer sent. Establishing the data channel.");
  }

  private async acceptAnswer(message: Extract<SignalingMessage, { type: "answer" }>): Promise<void> {
    if (this.options.role !== "host" || message.fromPeerId !== this.remotePeerId) {
      return;
    }

    const connection = this.ensurePeerConnection();
    this.setStatus("connecting", `Answer received from ${message.participant.name}.`);
    await connection.setRemoteDescription(message.description);
    await this.flushPendingRemoteCandidates();
  }

  private async acceptIceCandidate(
    message: Extract<SignalingMessage, { type: "ice-candidate" }>,
  ): Promise<void> {
    if (!message.candidate || message.fromPeerId !== this.remotePeerId) {
      return;
    }

    const connection = this.ensurePeerConnection();
    if (!connection.remoteDescription) {
      this.pendingRemoteCandidates.push(message.candidate);
      return;
    }

    await connection.addIceCandidate(message.candidate);
  }

  private async flushPendingRemoteCandidates(): Promise<void> {
    const connection = this.connection;
    if (!connection?.remoteDescription) {
      return;
    }

    while (this.pendingRemoteCandidates.length > 0) {
      const candidate = this.pendingRemoteCandidates.shift();
      if (candidate) {
        await connection.addIceCandidate(candidate);
      }
    }
  }

  private bindChannel(channel: RTCDataChannel): void {
    this.unbindChannel();
    this.dataChannel = channel;
    channel.addEventListener("open", this.handleChannelOpen);
    channel.addEventListener("close", this.handleChannelClose);
    channel.addEventListener("message", this.handleChannelMessage);
    channel.addEventListener("error", this.handleChannelError);
  }

  private unbindChannel(): void {
    this.dataChannel?.removeEventListener("open", this.handleChannelOpen);
    this.dataChannel?.removeEventListener("close", this.handleChannelClose);
    this.dataChannel?.removeEventListener("message", this.handleChannelMessage);
    this.dataChannel?.removeEventListener("error", this.handleChannelError);
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
    this.status = { phase, detail };
    this.events.onStatus?.(this.status);
  }

  private readonly handleSocketOpen = (): void => {
    this.setStatus(
      this.options.role === "host" ? "waiting" : "signaling",
      this.options.role === "host"
        ? "Cloud room is online. Waiting for a guest."
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
          this.remotePeerId = message.peerId;
          this.remoteParticipant = message.participant;
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
      case "peer-left":
        if (message.peerId === this.remotePeerId) {
          this.setStatus("closed", "Remote peer left the signaling room.");
        }
        return;
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

    if (this.dataChannel?.readyState === "open" || this.connection?.connectionState === "connected") {
      this.setStatus("connected", "Peer connection established.");
      return;
    }

    this.setStatus("closed", "Signaling server disconnected.");
  };

  private readonly handleSocketError = (): void => {
    if (this.status.phase !== "connected") {
      this.setStatus("error", "Signaling server connection failed.");
    }
  };

  private readonly handleIceCandidate = (event: RTCPeerConnectionIceEvent): void => {
    if (!event.candidate || !this.remotePeerId) {
      return;
    }

    this.sendSignal({
      type: "ice-candidate",
      toPeerId: this.remotePeerId,
      candidate: event.candidate.toJSON(),
    });
  };

  private readonly handleDataChannel = (event: RTCDataChannelEvent): void => {
    this.bindChannel(event.channel);
  };

  private readonly handleChannelOpen = (): void => {
    const remoteName = this.remoteParticipant?.name;
    this.setStatus(
      "connected",
      remoteName ? `Connected to ${remoteName}.` : "Peer connection established.",
    );
  };

  private readonly handleChannelClose = (): void => {
    if (!this.closed) {
      this.setStatus("closed", "Peer connection closed.");
    }
  };

  private readonly handleChannelMessage = (event: MessageEvent<unknown>): void => {
    if (typeof event.data !== "string") {
      return;
    }

    this.events.onMessage({
      raw: event.data,
      receivedAt: Date.now(),
    });
  };

  private readonly handleChannelError = (): void => {
    this.setStatus("error", "DataChannel error.");
  };

  private readonly handleConnectionState = (): void => {
    switch (this.connection?.connectionState) {
      case "connected":
        this.handleChannelOpen();
        return;
      case "connecting":
        this.setStatus("connecting", "Negotiation complete. Establishing the data channel.");
        return;
      case "failed":
        this.setStatus("error", "WebRTC connection failed.");
        return;
      case "disconnected":
        this.setStatus("closed", "Peer disconnected.");
        return;
      case "closed":
        if (!this.closed) {
          this.setStatus("closed", "Peer connection closed.");
        }
        return;
      default:
        return;
    }
  };

  private readonly handleIceCandidateError = (): void => {
    if (this.status.phase === "connected") {
      return;
    }

    this.setStatus("error", "ICE candidate gathering failed.");
  };
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
