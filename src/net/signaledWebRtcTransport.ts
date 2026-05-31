import {
  MAX_ROOM_MESSAGE_BYTES,
  ROOM_PROTOCOL,
  ROOM_PROTOCOL_VERSION,
  measureRoomMessageBytes,
  type ParticipantIdentity,
} from "./protocol";
import {
  MAX_SIGNALING_INVALID_MESSAGES,
  MAX_SIGNALING_RAW_MESSAGE_BYTES,
  MAX_TRANSPORT_BUFFERED_BYTES,
  DIRECT_FIRST_RELAY_DELAY_MS,
  isValidSignalingParticipant,
  isValidSignalingPeerId,
  sanitizeSignalingDescription,
  sanitizeSignalingIceCandidate,
  shouldUseDirectFirstIce,
  toSignalingSocketUrl,
  utf8ByteLength,
  validateSignalingClientContext,
} from "./signalingConfig";
import { samplePeerConnectionStats } from "./webrtcStats";
import {
  DEFAULT_ICE_SERVERS,
  loadIceServers,
} from "./iceServers";
import {
  getRoomDataChannelLane,
  LATEST_STATE_DATA_CHANNEL_LABEL,
  RELIABLE_DATA_CHANNEL_LABEL,
} from "./webrtcTransport";
import type {
  RoomTransport,
  RoomTransportDebugSnapshot,
  RoomTransportEvents,
  RoomTransportLane,
  RoomTransportPeerStats,
  RoomTransportSendOptions,
  RoomTransportStatus,
} from "./transport";

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

interface PeerChannelListeners {
  open: () => void;
  close: () => void;
  message: (event: MessageEvent<unknown>) => void;
  error: () => void;
  bufferedamountlow?: () => void;
}

interface PeerConnectionState {
  peerId: string;
  participant?: ParticipantIdentity;
  connection: RTCPeerConnection;
  pendingRemoteCandidates: RTCIceCandidateInit[];
  pendingLatestStateRaw?: string;
  pendingRelayCandidates: RTCIceCandidateInit[];
  relayCandidateTimer?: number;
  stats?: RoomTransportPeerStats;
  phase: PeerPhase;
  reliableChannel?: RTCDataChannel;
  reliableChannelListeners?: PeerChannelListeners;
  latestStateChannel?: RTCDataChannel;
  latestStateChannelListeners?: PeerChannelListeners;
}

type OutboundSignalingMessage =
  | {
      type: "ping";
    }
  | {
      type: "offer";
      toPeerId: string;
      description: RTCSessionDescriptionInit;
    }
  | {
      type: "answer";
      toPeerId: string;
      description: RTCSessionDescriptionInit;
    }
  | {
      type: "ice-candidate";
      toPeerId: string;
      candidate: RTCIceCandidateInit;
    };

const MAX_PENDING_REMOTE_ICE_CANDIDATES = 64;
const GUEST_OFFER_WAIT_MS = 5_000;
const GUEST_OFFER_RETRY_DELAY_MS = 350;
const GUEST_OFFER_RETRY_LIMIT = 3;

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
  private iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS;
  private readonly iceServersPromise: Promise<RTCIceServer[]>;
  private readonly directFirstIce = shouldUseDirectFirstIce();
  private telemetryTimer = 0;
  private guestOfferWatchdogTimer = 0;
  private guestReconnectTimer = 0;
  private guestOfferRetries = 0;
  private guestHostPeerId = "";
  private closed = false;
  private signalingInvalidMessages = 0;

  constructor(
    private readonly options: SignaledWebRtcTransportOptions,
    events: RoomTransportEvents,
  ) {
    this.events = events;
    this.localPeerId = options.localParticipant.id;
    this.iceServersPromise = loadIceServers(options.signalingUrl);
    this.status = {
      phase: "signaling",
      detail:
        options.role === "host"
          ? "Opening the Cloudflare signaling room."
          : "Joining the Cloudflare signaling room.",
    };

    void this.initialize();
    this.events.onStatus?.(this.status);
  }

  setEvents(events: RoomTransportEvents): void {
    this.events = events;
    this.events.onStatus?.(this.status);
  }

  send(
    raw: string,
    toPeerId?: string,
    lane: RoomTransportLane = "reliable",
    options?: RoomTransportSendOptions,
  ): boolean {
    if (toPeerId) {
      return this.sendToPeer(toPeerId, raw, lane, options);
    }

    if (this.options.role === "guest") {
      const hostPeer = this.firstOpenPeer();
      return hostPeer ? this.sendToPeer(hostPeer.peerId, raw, lane, options) : false;
    }

    let sent = false;
    for (const peer of this.peers.values()) {
      sent = this.sendToPeer(peer.peerId, raw, lane, options) || sent;
    }
    return sent;
  }

  close(reason = "closed"): void {
    this.shutdown("closed", reason, reason);
  }

  disconnectPeer(peerId: string, reason = "closed"): void {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return;
    }

    this.closePeer(peer, reason, false);
    this.updateAggregateStatus();
  }

  getStatus(): RoomTransportStatus {
    return this.status;
  }

  getDebugSnapshot(): RoomTransportDebugSnapshot {
    return {
      peers: [...this.peers.values()]
        .map((peer) => peer.stats)
        .filter((stats): stats is RoomTransportPeerStats => Boolean(stats)),
      directFirstIce: this.directFirstIce,
      relayCandidateDelayMs: this.directFirstIce ? DIRECT_FIRST_RELAY_DELAY_MS : 0,
    };
  }

  getRemoteParticipant(): ParticipantIdentity | undefined {
    return this.firstPeer()?.participant;
  }

  debugSendSignalingPayload(payload: Record<string, unknown>): boolean {
    if (!isRecord(payload)) {
      return false;
    }

    return this.sendSignal(payload as OutboundSignalingMessage);
  }

  debugInjectSignalingMessage(raw: string): void {
    this.handleSocketMessage(new MessageEvent("message", { data: raw }));
  }

  private async initialize(): Promise<void> {
    this.setStatus("signaling", "Loading WebRTC relay configuration.");
    this.iceServers = await this.iceServersPromise;
    if (!this.closed) {
      this.startTelemetry();
      this.openSocket();
    }
  }

  private openSocket(): void {
    const validationError = validateSignalingClientContext({
      roomId: this.options.roomId,
      mapId: this.options.mapId,
      participant: this.options.localParticipant,
    });
    if (validationError) {
      this.setStatus("error", validationError);
      return;
    }

    let url: URL;
    try {
      url = new URL(toSignalingSocketUrl(this.options.signalingUrl, this.options.roomId));
    } catch {
      this.setStatus("error", "Cloud signaling URL is invalid.");
      return;
    }

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

  private shutdown(
    phase: RoomTransportStatus["phase"],
    detail: string,
    reason: string,
  ): void {
    if (this.closed) {
      this.setStatus(phase, detail);
      return;
    }

    this.closed = true;
    this.cancelGuestOfferWatchdog();
    this.cancelGuestReconnect();
    this.stopTelemetry();
    for (const peer of [...this.peers.values()]) {
      this.closePeer(peer, reason, false);
    }
    this.peers.clear();

    const socket = this.socket;
    if (socket) {
      socket.removeEventListener("open", this.handleSocketOpen);
      socket.removeEventListener("message", this.handleSocketMessage);
      socket.removeEventListener("close", this.handleSocketClose);
      socket.removeEventListener("error", this.handleSocketError);
      try {
        socket.close(phase === "closed" ? 1000 : 1008, reason.slice(0, 123));
      } catch {
        // Ignore close failures while tearing the client transport down.
      }
    }

    this.socket = undefined;
    this.setStatus(phase, detail);
  }

  private failTransport(detail: string, reason = "invalid-signaling"): void {
    this.shutdown("error", detail, reason);
  }

  private startTelemetry(): void {
    if (this.telemetryTimer) {
      return;
    }

    this.telemetryTimer = window.setInterval(() => {
      this.sampleTelemetry();
    }, 2_000);
    this.sampleTelemetry();
  }

  private stopTelemetry(): void {
    if (!this.telemetryTimer) {
      return;
    }

    window.clearInterval(this.telemetryTimer);
    this.telemetryTimer = 0;
  }

  private sampleTelemetry(): void {
    for (const peer of this.peers.values()) {
      void samplePeerConnectionStats(peer.connection, peer.peerId, peer.phase).then((stats) => {
        if (stats && this.peers.get(peer.peerId) === peer) {
          peer.stats = stats;
        }
      });
    }
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
        iceServers: this.iceServers,
        bundlePolicy: "max-bundle",
      }),
      pendingRemoteCandidates: [],
      pendingRelayCandidates: [],
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
        "reliable",
        peer.connection.createDataChannel(RELIABLE_DATA_CHANNEL_LABEL, {
          ordered: true,
        }),
      );
      this.bindChannel(
        peer,
        "latest-state",
        peer.connection.createDataChannel(LATEST_STATE_DATA_CHANNEL_LABEL, {
          ordered: false,
          maxRetransmits: 0,
        }),
      );
    } else {
      peer.connection.addEventListener("datachannel", (event) => {
        const lane = getRoomDataChannelLane(event.channel.label);
        if (!lane) {
          event.channel.close();
          return;
        }

        this.bindChannel(peer, lane, event.channel);
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
    if (!this.sendSignal({ type: "offer", toPeerId: peerId, description })) {
      peer.phase = "error";
      this.updateAggregateStatus("Client-side signaling guard rejected the offer.");
      return;
    }
    peer.phase = "connecting";
    this.updateAggregateStatus(`Offer sent to ${participant.name}. Waiting for answer.`);
  }

  private async acceptOffer(message: Extract<SignalingMessage, { type: "offer" }>): Promise<void> {
    if (this.options.role !== "guest") {
      this.noteInvalidSignalingMessage("Hosts must not receive offers.");
      return;
    }

    this.cancelGuestOfferWatchdog();
    this.guestOfferRetries = 0;

    const existingHost = this.firstPeer();
    if (existingHost && existingHost.peerId !== message.fromPeerId) {
      this.noteInvalidSignalingMessage("Only one host may negotiate with a guest room client.");
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
    if (!this.sendSignal({ type: "answer", toPeerId: message.fromPeerId, description })) {
      peer.phase = "error";
      this.updateAggregateStatus("Client-side signaling guard rejected the answer.");
      return;
    }
    peer.phase = "connecting";
    this.updateAggregateStatus("Answer sent. Establishing the data channel.");
  }

  private async acceptAnswer(message: Extract<SignalingMessage, { type: "answer" }>): Promise<void> {
    if (this.options.role !== "host") {
      this.noteInvalidSignalingMessage("Guests must not receive answers.");
      return;
    }

    const peer = this.peers.get(message.fromPeerId);
    if (!peer) {
      this.noteInvalidSignalingMessage("Received an answer for an unknown guest.");
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
      this.noteInvalidSignalingMessage("Received an ICE candidate for an unknown peer.");
      return;
    }

    if (!peer.connection.remoteDescription) {
      if (peer.pendingRemoteCandidates.length >= MAX_PENDING_REMOTE_ICE_CANDIDATES) {
        this.noteInvalidSignalingMessage("Received too many pending ICE candidates for one peer.");
        return;
      }
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

  private bindChannel(
    peer: PeerConnectionState,
    lane: RoomTransportLane,
    channel: RTCDataChannel,
  ): void {
    this.unbindChannel(peer, lane);
    if (lane === "latest-state") {
      channel.bufferedAmountLowThreshold = 0;
    }

    const listeners: PeerChannelListeners = {
      open: () => {
        this.handleChannelOpen(peer, lane);
      },
      close: () => {
        this.handleChannelClose(peer, lane);
      },
      message: (event) => {
        this.handleChannelMessage(peer, lane, event);
      },
      error: () => {
        this.handleChannelError(peer, lane);
      },
      bufferedamountlow:
        lane === "latest-state"
          ? () => {
              this.flushLatestStateChannel(peer);
            }
          : undefined,
    };

    if (lane === "reliable") {
      peer.reliableChannel = channel;
      peer.reliableChannelListeners = listeners;
    } else {
      peer.latestStateChannel = channel;
      peer.latestStateChannelListeners = listeners;
    }

    channel.addEventListener("open", listeners.open);
    channel.addEventListener("close", listeners.close);
    channel.addEventListener("message", listeners.message);
    channel.addEventListener("error", listeners.error);
    if (listeners.bufferedamountlow) {
      channel.addEventListener("bufferedamountlow", listeners.bufferedamountlow);
    }
  }

  private unbindChannel(peer: PeerConnectionState, lane: RoomTransportLane): void {
    const channel = lane === "reliable" ? peer.reliableChannel : peer.latestStateChannel;
    const listeners =
      lane === "reliable" ? peer.reliableChannelListeners : peer.latestStateChannelListeners;
    if (!channel || !listeners) {
      if (lane === "reliable") {
        peer.reliableChannelListeners = undefined;
        peer.reliableChannel = undefined;
      } else {
        peer.latestStateChannelListeners = undefined;
        peer.latestStateChannel = undefined;
      }
      return;
    }

    channel.removeEventListener("open", listeners.open);
    channel.removeEventListener("close", listeners.close);
    channel.removeEventListener("message", listeners.message);
    channel.removeEventListener("error", listeners.error);
    if (listeners.bufferedamountlow) {
      channel.removeEventListener("bufferedamountlow", listeners.bufferedamountlow);
    }

    if (lane === "reliable") {
      peer.reliableChannelListeners = undefined;
      peer.reliableChannel = undefined;
    } else {
      peer.latestStateChannelListeners = undefined;
      peer.latestStateChannel = undefined;
    }
  }

  private sendToPeer(
    peerId: string,
    raw: string,
    lane: RoomTransportLane,
    options?: RoomTransportSendOptions,
  ): boolean {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return false;
    }

    const rawBytes = measureRoomMessageBytes(raw);
    if (rawBytes > MAX_ROOM_MESSAGE_BYTES) {
      return false;
    }

    if (lane === "latest-state") {
      const channel = peer.latestStateChannel;
      if (!channel || channel.readyState !== "open") {
        return false;
      }

      const hasBufferedLatestState =
        channel.bufferedAmount > 0 || peer.pendingLatestStateRaw !== undefined;
      if (options?.latestStateOnlyIfBuffered && !hasBufferedLatestState) {
        return false;
      }

      peer.pendingLatestStateRaw = raw;
      this.flushLatestStateChannel(peer);
      return true;
    }

    const channel = peer.reliableChannel;
    if (!channel || channel.readyState !== "open") {
      return false;
    }

    if (channel.bufferedAmount + rawBytes > MAX_TRANSPORT_BUFFERED_BYTES) {
      return false;
    }

    try {
      channel.send(raw);
      return true;
    } catch {
      peer.phase = "error";
      this.updateAggregateStatus("Reliable DataChannel send failed.");
      return false;
    }
  }

  private flushLatestStateChannel(peer: PeerConnectionState): void {
    const channel = peer.latestStateChannel;
    const raw = peer.pendingLatestStateRaw;
    if (!channel || channel.readyState !== "open" || !raw) {
      return;
    }

    const rawBytes = measureRoomMessageBytes(raw);
    if (channel.bufferedAmount > 0 || channel.bufferedAmount + rawBytes > MAX_TRANSPORT_BUFFERED_BYTES) {
      return;
    }

    peer.pendingLatestStateRaw = undefined;
    try {
      channel.send(raw);
    } catch {
      peer.pendingLatestStateRaw = raw;
      peer.phase = "error";
      this.updateAggregateStatus("Latest-state DataChannel send failed.");
    }
  }

  private firstPeer(): PeerConnectionState | undefined {
    return this.peers.values().next().value as PeerConnectionState | undefined;
  }

  private firstOpenPeer(): PeerConnectionState | undefined {
    return [...this.peers.values()].find((peer) => this.isPeerConnected(peer));
  }

  private closePeer(peer: PeerConnectionState, reason: string, emitDisconnect: boolean): void {
    const wasTracked = this.peers.has(peer.peerId);
    const reliableChannel = peer.reliableChannel;
    const latestStateChannel = peer.latestStateChannel;
    if (peer.relayCandidateTimer) {
      window.clearTimeout(peer.relayCandidateTimer);
      peer.relayCandidateTimer = undefined;
    }
    this.unbindChannel(peer, "reliable");
    this.unbindChannel(peer, "latest-state");
    peer.phase = "closed";
    reliableChannel?.close();
    latestStateChannel?.close();
    peer.connection.close();
    this.peers.delete(peer.peerId);

    if (emitDisconnect && wasTracked) {
      this.emitSyntheticDisconnect(peer.peerId, reason);
    }
  }

  private emitSyntheticDisconnect(peerId: string, reason: string): void {
    const now = Date.now();
    this.events.onMessage({
      lane: "reliable",
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
      fromPeerId: peerId,
    });
  }

  private isPeerConnected(peer: PeerConnectionState): boolean {
    return (
      peer.reliableChannel?.readyState === "open" &&
      peer.latestStateChannel?.readyState === "open"
    );
  }

  private updateAggregateStatus(preferredDetail?: string): void {
    if (this.closed) {
      return;
    }

    const peers = [...this.peers.values()];
    const connected = peers.filter((peer) => this.isPeerConnected(peer)).length;
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

    const peer = this.firstOpenPeer() ?? this.firstPeer();
    if (connected > 0) {
      const remoteName = peer?.participant?.name;
      this.setStatus(
        "connected",
        remoteName ? `Connected to ${remoteName}.` : "Peer connection established.",
      );
      return;
    }

    if (negotiating > 0) {
      this.setStatus(
        "connecting",
        preferredDetail ?? "Establishing the host room lanes.",
      );
      return;
    }

    if (failed > 0) {
      this.setStatus("error", "WebRTC connection failed.");
      return;
    }

    this.setStatus("closed", "Host connection closed.");
  }

  private sendSignal(message: OutboundSignalingMessage): boolean {
    const payload = this.serializeSignalingMessage(message);
    if (!payload) {
      return false;
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.setStatus("error", "Signaling socket is not connected.");
      return false;
    }

    if (this.socket.bufferedAmount + utf8ByteLength(payload) > MAX_TRANSPORT_BUFFERED_BYTES) {
      this.failTransport("Cloud signaling send buffering exceeded the client budget.", "buffer-limit");
      return false;
    }

    try {
      this.socket.send(payload);
      return true;
    } catch {
      this.failTransport("Cloud signaling send failed.", "send-failed");
      return false;
    }
  }

  private serializeSignalingMessage(message: OutboundSignalingMessage): string | null {
    let sanitized: OutboundSignalingMessage | null = null;

    switch (message.type) {
      case "ping":
        sanitized = message;
        break;
      case "offer": {
        if (!isValidSignalingPeerId(message.toPeerId)) {
          this.failTransport("Cloud signaling rejected an offer with an invalid target peer id.");
          return null;
        }
        const description = sanitizeSignalingDescription(message.description, "offer");
        if (!description) {
          this.failTransport("Cloud signaling rejected an oversized or invalid offer payload.");
          return null;
        }
        sanitized = {
          type: "offer",
          toPeerId: message.toPeerId,
          description,
        };
        break;
      }
      case "answer": {
        if (!isValidSignalingPeerId(message.toPeerId)) {
          this.failTransport("Cloud signaling rejected an answer with an invalid target peer id.");
          return null;
        }
        const description = sanitizeSignalingDescription(message.description, "answer");
        if (!description) {
          this.failTransport("Cloud signaling rejected an oversized or invalid answer payload.");
          return null;
        }
        sanitized = {
          type: "answer",
          toPeerId: message.toPeerId,
          description,
        };
        break;
      }
      case "ice-candidate": {
        if (!isValidSignalingPeerId(message.toPeerId)) {
          this.failTransport("Cloud signaling rejected an ICE candidate with an invalid target peer id.");
          return null;
        }
        const candidate = sanitizeSignalingIceCandidate(message.candidate);
        if (!candidate) {
          this.failTransport("Cloud signaling rejected an oversized or invalid ICE candidate.");
          return null;
        }
        sanitized = {
          type: "ice-candidate",
          toPeerId: message.toPeerId,
          candidate,
        };
        break;
      }
      default:
        this.failTransport("Cloud signaling rejected an unsupported client message type.");
        return null;
    }

    const raw = JSON.stringify(sanitized);
    if (utf8ByteLength(raw) > MAX_SIGNALING_RAW_MESSAGE_BYTES) {
      this.failTransport("Cloud signaling payload exceeded the client-side size budget.", "message-too-large");
      return null;
    }

    return raw;
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
      this.noteInvalidSignalingMessage("Received a non-text signaling frame.");
      return;
    }

    const message = parseSignalingMessage(event.data);
    if (!message) {
      this.noteInvalidSignalingMessage("Received an invalid signaling message.");
      return;
    }

    const contractError = this.validateInboundSignalingMessage(message);
    if (contractError) {
      this.noteInvalidSignalingMessage(contractError);
      return;
    }

    void this.handleSignalingMessage(message).catch((error) => {
      this.failTransport(
        error instanceof Error ? error.message : "Signaling negotiation failed.",
        "negotiation-failed",
      );
    });
  };

  private validateInboundSignalingMessage(message: SignalingMessage): string | null {
    switch (message.type) {
      case "ready":
        return message.peerId === this.localPeerId
          ? null
          : "Received a ready message for the wrong peer.";
      case "waiting-for-host":
        return this.options.role === "guest" ? null : "Hosts must not receive waiting-for-host.";
      case "host-ready":
        if (this.options.role !== "guest") {
          return "Hosts must not receive host-ready.";
        }
        return message.peerId === this.localPeerId
          ? "host-ready echoed the guest peer id instead of the host."
          : null;
      case "peer-joined":
        return this.options.role === "host" ? null : "Guests must not receive peer-joined.";
      case "offer":
        return message.toPeerId === this.localPeerId
          ? null
          : "Offer targeted the wrong local peer.";
      case "answer":
        return message.toPeerId === this.localPeerId
          ? null
          : "Answer targeted the wrong local peer.";
      case "ice-candidate":
        return message.toPeerId === this.localPeerId
          ? null
          : "ICE candidate targeted the wrong local peer.";
      case "peer-left":
        return message.peerId === this.localPeerId
          ? "peer-left should not target the local peer id."
          : null;
      case "room-error":
      case "pong":
        return null;
    }
  }

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
          this.startGuestOfferWatchdog(message.peerId);
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

  private noteInvalidSignalingMessage(detail: string): void {
    this.signalingInvalidMessages += 1;
    if (this.signalingInvalidMessages >= MAX_SIGNALING_INVALID_MESSAGES) {
      this.failTransport(detail, "too-many-invalid-messages");
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

  private startGuestOfferWatchdog(hostPeerId: string): void {
    if (this.options.role !== "guest" || this.closed) {
      return;
    }

    if (this.guestHostPeerId !== hostPeerId) {
      this.guestHostPeerId = hostPeerId;
      this.guestOfferRetries = 0;
    }

    this.cancelGuestOfferWatchdog();
    this.guestOfferWatchdogTimer = window.setTimeout(() => {
      this.guestOfferWatchdogTimer = 0;
      this.retryGuestOfferWait(hostPeerId);
    }, GUEST_OFFER_WAIT_MS);
  }

  private retryGuestOfferWait(hostPeerId: string): void {
    if (this.options.role !== "guest" || this.closed) {
      return;
    }

    const peer = this.peers.get(hostPeerId);
    if (!peer || peer.phase !== "new") {
      return;
    }

    if (this.guestOfferRetries >= GUEST_OFFER_RETRY_LIMIT) {
      this.setStatus(
        "waiting",
        "Host found, but no offer arrived. Ask the host to keep the room open or create a fresh Cloud Room.",
      );
      return;
    }

    this.guestOfferRetries += 1;
    this.closePeer(peer, "offer-timeout", false);
    this.setStatus(
      "signaling",
      `Still waiting for host offer. Retrying signaling ${this.guestOfferRetries}/${GUEST_OFFER_RETRY_LIMIT}.`,
    );
    this.reopenGuestSignalingSocket();
  }

  private reopenGuestSignalingSocket(): void {
    if (this.options.role !== "guest" || this.closed) {
      return;
    }

    const socket = this.socket;
    if (socket) {
      socket.removeEventListener("open", this.handleSocketOpen);
      socket.removeEventListener("message", this.handleSocketMessage);
      socket.removeEventListener("close", this.handleSocketClose);
      socket.removeEventListener("error", this.handleSocketError);
      try {
        socket.close(1000, "retry-offer");
      } catch {
        // Ignore close failures while retrying the signaling handshake.
      }
    }
    this.socket = undefined;

    this.cancelGuestReconnect();
    this.guestReconnectTimer = window.setTimeout(() => {
      this.guestReconnectTimer = 0;
      if (!this.closed) {
        this.openSocket();
      }
    }, GUEST_OFFER_RETRY_DELAY_MS);
  }

  private cancelGuestOfferWatchdog(): void {
    if (!this.guestOfferWatchdogTimer) {
      return;
    }

    window.clearTimeout(this.guestOfferWatchdogTimer);
    this.guestOfferWatchdogTimer = 0;
  }

  private cancelGuestReconnect(): void {
    if (!this.guestReconnectTimer) {
      return;
    }

    window.clearTimeout(this.guestReconnectTimer);
    this.guestReconnectTimer = 0;
  }

  private readonly handleSocketError = (): void => {
    if (this.status.phase !== "connected") {
      this.setStatus("error", "Signaling server connection failed.");
    }
  };

  private handleIceCandidate(peer: PeerConnectionState, event: RTCPeerConnectionIceEvent): void {
    if (!event.candidate) {
      return;
    }

    const candidate = event.candidate.toJSON();
    if (this.shouldHoldRelayCandidate(peer, event.candidate)) {
      peer.pendingRelayCandidates.push(candidate);
      this.scheduleRelayCandidateFlush(peer);
      return;
    }

    if (
      !this.sendSignal({
        type: "ice-candidate",
        toPeerId: peer.peerId,
        candidate,
      })
    ) {
      peer.phase = "error";
      this.updateAggregateStatus("Client-side signaling guard rejected the ICE candidate.");
    }
  }

  private shouldHoldRelayCandidate(peer: PeerConnectionState, candidate: RTCIceCandidate): boolean {
    return (
      this.directFirstIce &&
      !this.isPeerConnected(peer) &&
      (candidate.type === "relay" || /\btyp relay\b/.test(candidate.candidate))
    );
  }

  private scheduleRelayCandidateFlush(peer: PeerConnectionState): void {
    if (peer.relayCandidateTimer) {
      return;
    }

    peer.relayCandidateTimer = window.setTimeout(() => {
      peer.relayCandidateTimer = undefined;
      this.flushRelayCandidates(peer);
    }, DIRECT_FIRST_RELAY_DELAY_MS);
  }

  private flushRelayCandidates(peer: PeerConnectionState): void {
    if (this.closed || this.isPeerConnected(peer)) {
      peer.pendingRelayCandidates.length = 0;
      return;
    }

    while (peer.pendingRelayCandidates.length > 0) {
      const candidate = peer.pendingRelayCandidates.shift();
      if (!candidate) {
        continue;
      }

      if (
        !this.sendSignal({
          type: "ice-candidate",
          toPeerId: peer.peerId,
          candidate,
        })
      ) {
        peer.phase = "error";
        this.updateAggregateStatus("Client-side signaling guard rejected the delayed relay candidate.");
        return;
      }
    }
  }

  private handleChannelOpen(peer: PeerConnectionState, lane: RoomTransportLane): void {
    if (lane === "latest-state") {
      this.flushLatestStateChannel(peer);
    }
    if (this.isPeerConnected(peer)) {
      peer.pendingRelayCandidates.length = 0;
      if (peer.relayCandidateTimer) {
        window.clearTimeout(peer.relayCandidateTimer);
        peer.relayCandidateTimer = undefined;
      }
    }
    peer.phase = this.isPeerConnected(peer) ? "connected" : "connecting";
    this.updateAggregateStatus();
  }

  private handleChannelClose(peer: PeerConnectionState, _lane: RoomTransportLane): void {
    if (this.closed || peer.phase === "closed") {
      return;
    }

    this.closePeer(peer, "closed", true);
    this.updateAggregateStatus();
  }

  private handleChannelMessage(
    peer: PeerConnectionState,
    lane: RoomTransportLane,
    event: MessageEvent<unknown>,
  ): void {
    if (typeof event.data !== "string") {
      return;
    }

    this.events.onMessage({
      lane,
      raw: event.data,
      receivedAt: Date.now(),
      fromPeerId: peer.peerId,
    });
  }

  private handleChannelError(peer: PeerConnectionState, lane: RoomTransportLane): void {
    peer.phase = "error";
    this.updateAggregateStatus(
      lane === "reliable" ? "Reliable DataChannel error." : "Latest-state DataChannel error.",
    );
  }

  private handleConnectionState(peer: PeerConnectionState): void {
    switch (peer.connection.connectionState) {
      case "connected":
        peer.phase = this.isPeerConnected(peer) ? "connected" : "connecting";
        this.updateAggregateStatus();
        return;
      case "connecting":
        peer.phase = "connecting";
        this.updateAggregateStatus("Negotiation complete. Establishing the room data channels.");
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
  if (utf8ByteLength(raw) > MAX_SIGNALING_RAW_MESSAGE_BYTES) {
    return null;
  }

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
      return (
        typeof value.peerId === "string" &&
        isValidSignalingPeerId(value.peerId) &&
        (value.role === "host" || value.role === "guest")
      );
    case "waiting-for-host":
      return typeof value.detail === "string";
    case "host-ready":
    case "peer-joined":
      return (
        typeof value.peerId === "string" &&
        isValidSignalingPeerId(value.peerId) &&
        isParticipant(value.participant)
      );
    case "offer":
      return (
        typeof value.fromPeerId === "string" &&
        isValidSignalingPeerId(value.fromPeerId) &&
        typeof value.toPeerId === "string" &&
        isValidSignalingPeerId(value.toPeerId) &&
        isParticipant(value.participant) &&
        sanitizeSignalingDescription(value.description, "offer") !== null
      );
    case "answer":
      return (
        typeof value.fromPeerId === "string" &&
        isValidSignalingPeerId(value.fromPeerId) &&
        typeof value.toPeerId === "string" &&
        isValidSignalingPeerId(value.toPeerId) &&
        isParticipant(value.participant) &&
        sanitizeSignalingDescription(value.description, "answer") !== null
      );
    case "ice-candidate":
      return (
        typeof value.fromPeerId === "string" &&
        isValidSignalingPeerId(value.fromPeerId) &&
        typeof value.toPeerId === "string" &&
        isValidSignalingPeerId(value.toPeerId) &&
        sanitizeSignalingIceCandidate(value.candidate) !== null
      );
    case "peer-left":
      return (
        typeof value.peerId === "string" &&
        isValidSignalingPeerId(value.peerId) &&
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
    typeof value.accentColor === "string" &&
    isValidSignalingParticipant({
      id: value.id,
      name: value.name,
      accentColor: value.accentColor,
    })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
