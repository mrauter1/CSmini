import {
  decodeSignalEnvelope,
  encodeSignalEnvelope,
  waitForIceGatheringComplete,
  type GuestAnswerSignal,
  type HostOfferSignal,
} from "./manualSignaling";
import type { ParticipantIdentity } from "./protocol";
import { MAX_ROOM_MESSAGE_BYTES, measureRoomMessageBytes } from "./protocol";
import { MAX_TRANSPORT_BUFFERED_BYTES } from "./signalingConfig";
import type {
  RoomTransport,
  RoomTransportEvents,
  RoomTransportLane,
  RoomTransportSendOptions,
  RoomTransportStatus,
} from "./transport";

export const RELIABLE_DATA_CHANNEL_LABEL = "dustline-room-reliable";
export const LATEST_STATE_DATA_CHANNEL_LABEL = "dustline-room-state";
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
];

interface WebRtcTransportOptions {
  roomId: string;
  mapId: string;
  sessionLabel: string;
  localParticipant: ParticipantIdentity;
  role: "host" | "guest";
}

interface ChannelListeners {
  open: () => void;
  close: () => void;
  message: (event: MessageEvent<unknown>) => void;
  error: () => void;
  bufferedamountlow?: () => void;
}

export function getRoomDataChannelLane(label: string): RoomTransportLane | null {
  switch (label) {
    case RELIABLE_DATA_CHANNEL_LABEL:
      return "reliable";
    case LATEST_STATE_DATA_CHANNEL_LABEL:
      return "latest-state";
    default:
      return null;
  }
}

export class WebRtcRoomTransport implements RoomTransport {
  readonly kind = "webrtc" as const;
  readonly localPeerId: string;

  private readonly connection = new RTCPeerConnection({
    iceServers: DEFAULT_ICE_SERVERS,
    bundlePolicy: "max-bundle",
  });
  private readonly channels: Partial<Record<RoomTransportLane, RTCDataChannel>> = {};
  private readonly channelListeners: Partial<Record<RoomTransportLane, ChannelListeners>> = {};
  private pendingLatestStateRaw?: string;
  private remoteParticipant?: ParticipantIdentity;
  private status: RoomTransportStatus;
  private events: RoomTransportEvents;

  constructor(
    private readonly options: WebRtcTransportOptions,
    events: RoomTransportEvents,
  ) {
    this.events = events;
    this.localPeerId = options.localParticipant.id;
    this.status = {
      phase: options.role === "host" ? "idle" : "signaling",
      detail:
        options.role === "host"
          ? "Ready to generate an offer."
          : "Paste a host offer to generate an answer.",
    };

    if (options.role === "host") {
      this.bindChannel(
        "reliable",
        this.connection.createDataChannel(RELIABLE_DATA_CHANNEL_LABEL, {
          ordered: true,
        }),
      );
      this.bindChannel(
        "latest-state",
        this.connection.createDataChannel(LATEST_STATE_DATA_CHANNEL_LABEL, {
          ordered: false,
          maxRetransmits: 0,
        }),
      );
    } else {
      this.connection.addEventListener("datachannel", this.handleDataChannel);
    }

    this.connection.addEventListener("connectionstatechange", this.handleConnectionState);
    this.connection.addEventListener("icecandidateerror", this.handleIceCandidateError);
    this.events.onStatus?.(this.status);
  }

  setEvents(events: RoomTransportEvents): void {
    this.events = events;
    this.events.onStatus?.(this.status);
  }

  async createOfferCode(): Promise<string> {
    if (this.options.role !== "host") {
      throw new Error("Only the host transport can generate an offer.");
    }

    this.setStatus("signaling", "Generating offer and collecting ICE candidates.");
    const offer = await this.connection.createOffer();
    await this.connection.setLocalDescription(offer);
    await waitForIceGatheringComplete(this.connection);

    const description = this.connection.localDescription;
    if (!description) {
      throw new Error("Host offer was not created.");
    }

    this.setStatus("waiting", "Offer ready. Waiting for a guest answer.");
    return encodeSignalEnvelope({
      version: 1,
      role: "host-offer",
      roomId: this.options.roomId,
      mapId: this.options.mapId,
      participant: this.options.localParticipant,
      sessionLabel: this.options.sessionLabel,
      description: description.toJSON(),
    });
  }

  async applyAnswerCode(raw: string): Promise<void> {
    if (this.options.role !== "host") {
      throw new Error("Only the host transport can apply an answer.");
    }

    const parsed = decodeSignalEnvelope(raw);
    if (!parsed || parsed.role !== "guest-answer") {
      throw new Error("The pasted answer could not be decoded.");
    }

    this.assertRoomMatch(parsed.roomId, parsed.mapId);
    this.remoteParticipant = parsed.participant;
    this.setStatus("connecting", `Answer applied from ${parsed.participant.name}.`);
    await this.connection.setRemoteDescription(parsed.description);
  }

  async acceptOfferCode(raw: string): Promise<string> {
    if (this.options.role !== "guest") {
      throw new Error("Only the guest transport can consume an offer.");
    }

    const parsed = decodeSignalEnvelope(raw);
    if (!parsed || parsed.role !== "host-offer") {
      throw new Error("The pasted offer could not be decoded.");
    }

    this.assertRoomMatch(parsed.roomId, parsed.mapId);
    this.remoteParticipant = parsed.participant;
    this.setStatus("signaling", `Generating answer for ${parsed.participant.name}.`);
    await this.connection.setRemoteDescription(parsed.description);
    const answer = await this.connection.createAnswer();
    await this.connection.setLocalDescription(answer);
    await waitForIceGatheringComplete(this.connection);

    const description = this.connection.localDescription;
    if (!description) {
      throw new Error("Guest answer was not created.");
    }

    this.setStatus("waiting", "Answer ready. Waiting for the host to finish connecting.");
    return encodeSignalEnvelope({
      version: 1,
      role: "guest-answer",
      roomId: this.options.roomId,
      mapId: this.options.mapId,
      participant: this.options.localParticipant,
      hostPeerId: parsed.participant.id,
      description: description.toJSON(),
    });
  }

  send(
    raw: string,
    _toPeerId?: string,
    lane: RoomTransportLane = "reliable",
    options?: RoomTransportSendOptions,
  ): boolean {
    const rawBytes = measureRoomMessageBytes(raw);
    if (rawBytes > MAX_ROOM_MESSAGE_BYTES) {
      return false;
    }

    if (lane === "latest-state") {
      return this.queueLatestState(raw, options);
    }

    const channel = this.channels.reliable;
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
      this.setStatus("error", "Reliable DataChannel send failed.");
      return false;
    }
  }

  disconnectPeer(_peerId: string, reason = "closed"): void {
    this.close(reason);
  }

  close(reason = "closed"): void {
    this.unbindChannel("reliable");
    this.unbindChannel("latest-state");
    this.connection.close();
    this.setStatus("closed", reason);
  }

  getStatus(): RoomTransportStatus {
    return this.status;
  }

  getRemoteParticipant(): ParticipantIdentity | undefined {
    return this.remoteParticipant;
  }

  private queueLatestState(raw: string, options?: RoomTransportSendOptions): boolean {
    const channel = this.channels["latest-state"];
    if (!channel || channel.readyState !== "open") {
      return false;
    }

    const hasBufferedLatestState = channel.bufferedAmount > 0 || this.pendingLatestStateRaw !== undefined;
    if (options?.latestStateOnlyIfBuffered && !hasBufferedLatestState) {
      return false;
    }

    this.pendingLatestStateRaw = raw;
    this.flushLatestStateChannel();
    return true;
  }

  private flushLatestStateChannel(): void {
    const channel = this.channels["latest-state"];
    const raw = this.pendingLatestStateRaw;
    if (!channel || channel.readyState !== "open" || !raw) {
      return;
    }

    const rawBytes = measureRoomMessageBytes(raw);
    if (channel.bufferedAmount > 0 || channel.bufferedAmount + rawBytes > MAX_TRANSPORT_BUFFERED_BYTES) {
      return;
    }

    this.pendingLatestStateRaw = undefined;
    try {
      channel.send(raw);
    } catch {
      this.pendingLatestStateRaw = raw;
      this.setStatus("error", "Latest-state DataChannel send failed.");
    }
  }

  private bindChannel(lane: RoomTransportLane, channel: RTCDataChannel): void {
    this.unbindChannel(lane);
    if (lane === "latest-state") {
      channel.bufferedAmountLowThreshold = 0;
    }

    const listeners: ChannelListeners = {
      open: () => {
        this.handleChannelOpen(lane);
      },
      close: () => {
        this.handleChannelClose(lane);
      },
      message: (event) => {
        this.handleChannelMessage(lane, event);
      },
      error: () => {
        this.handleChannelError(lane);
      },
      bufferedamountlow:
        lane === "latest-state"
          ? () => {
              this.flushLatestStateChannel();
            }
          : undefined,
    };

    this.channels[lane] = channel;
    this.channelListeners[lane] = listeners;
    channel.addEventListener("open", listeners.open);
    channel.addEventListener("close", listeners.close);
    channel.addEventListener("message", listeners.message);
    channel.addEventListener("error", listeners.error);
    if (listeners.bufferedamountlow) {
      channel.addEventListener("bufferedamountlow", listeners.bufferedamountlow);
    }
  }

  private unbindChannel(lane: RoomTransportLane): void {
    const channel = this.channels[lane];
    const listeners = this.channelListeners[lane];
    if (!channel || !listeners) {
      delete this.channels[lane];
      delete this.channelListeners[lane];
      return;
    }

    channel.removeEventListener("open", listeners.open);
    channel.removeEventListener("close", listeners.close);
    channel.removeEventListener("message", listeners.message);
    channel.removeEventListener("error", listeners.error);
    if (listeners.bufferedamountlow) {
      channel.removeEventListener("bufferedamountlow", listeners.bufferedamountlow);
    }
    delete this.channels[lane];
    delete this.channelListeners[lane];
  }

  private assertRoomMatch(roomId: string, mapId: string): void {
    if (roomId !== this.options.roomId || mapId !== this.options.mapId) {
      throw new Error("The signaling blob points to a different room.");
    }
  }

  private setStatus(phase: RoomTransportStatus["phase"], detail: string): void {
    if (this.status.phase === phase && this.status.detail === detail) {
      return;
    }

    this.status = { phase, detail };
    this.events.onStatus?.(this.status);
  }

  private updateChannelStatus(preferredDetail?: string): void {
    const reliableOpen = this.channels.reliable?.readyState === "open";
    const latestStateOpen = this.channels["latest-state"]?.readyState === "open";
    if (reliableOpen && latestStateOpen) {
      const remoteName = this.remoteParticipant?.name;
      this.setStatus(
        "connected",
        remoteName ? `Connected to ${remoteName}.` : "Peer connection established.",
      );
      return;
    }

    if (this.connection.connectionState === "failed") {
      this.setStatus("error", "WebRTC connection failed.");
      return;
    }

    if (this.connection.connectionState === "disconnected") {
      this.setStatus("closed", "Peer disconnected.");
      return;
    }

    if (this.connection.connectionState === "closed") {
      this.setStatus("closed", "Peer connection closed.");
      return;
    }

    if (
      this.connection.connectionState === "connected" ||
      this.connection.connectionState === "connecting" ||
      reliableOpen ||
      latestStateOpen
    ) {
      const missingLanes: string[] = [];
      if (!reliableOpen) {
        missingLanes.push("reliable");
      }
      if (!latestStateOpen) {
        missingLanes.push("latest-state");
      }
      this.setStatus(
        "connecting",
        preferredDetail ??
          `Establishing ${missingLanes.join(" and ")} room lane${
            missingLanes.length === 1 ? "" : "s"
          }.`,
      );
    }
  }

  private readonly handleDataChannel = (event: RTCDataChannelEvent): void => {
    const lane = getRoomDataChannelLane(event.channel.label);
    if (!lane) {
      event.channel.close();
      return;
    }

    this.bindChannel(lane, event.channel);
    this.updateChannelStatus();
  };

  private handleChannelOpen(lane: RoomTransportLane): void {
    if (lane === "latest-state") {
      this.flushLatestStateChannel();
    }
    this.updateChannelStatus();
  }

  private handleChannelClose(_lane: RoomTransportLane): void {
    this.updateChannelStatus();
  }

  private handleChannelMessage(lane: RoomTransportLane, event: MessageEvent<unknown>): void {
    if (typeof event.data !== "string") {
      return;
    }

    this.events.onMessage({
      lane,
      raw: event.data,
      receivedAt: Date.now(),
      fromPeerId: this.remoteParticipant?.id,
    });
  }

  private handleChannelError(lane: RoomTransportLane): void {
    this.setStatus(
      "error",
      lane === "reliable" ? "Reliable DataChannel error." : "Latest-state DataChannel error.",
    );
  }

  private readonly handleConnectionState = (): void => {
    switch (this.connection.connectionState) {
      case "connected":
        this.updateChannelStatus();
        return;
      case "connecting":
        this.updateChannelStatus("Negotiation complete. Establishing the room data channels.");
        return;
      case "failed":
        this.setStatus("error", "WebRTC connection failed.");
        return;
      case "disconnected":
        this.setStatus("closed", "Peer disconnected.");
        return;
      case "closed":
        this.setStatus("closed", "Peer connection closed.");
        return;
      default:
        return;
    }
  };

  private readonly handleIceCandidateError = (): void => {
    // Candidate errors can be emitted for one STUN path while other candidates still succeed.
    // The connection state is the authoritative failure signal.
  };
}

export type WebRtcHostSignal = HostOfferSignal;
export type WebRtcGuestSignal = GuestAnswerSignal;
