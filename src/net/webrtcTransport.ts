import {
  decodeSignalEnvelope,
  encodeSignalEnvelope,
  waitForIceGatheringComplete,
  type GuestAnswerSignal,
  type HostOfferSignal,
} from "./manualSignaling";
import type { ParticipantIdentity } from "./protocol";
import type { RoomTransport, RoomTransportEvents, RoomTransportStatus } from "./transport";

const DATA_CHANNEL_LABEL = "dustline-room";

interface WebRtcTransportOptions {
  roomId: string;
  mapId: string;
  sessionLabel: string;
  localParticipant: ParticipantIdentity;
  role: "host" | "guest";
}

export class WebRtcRoomTransport implements RoomTransport {
  readonly kind = "webrtc" as const;
  readonly localPeerId: string;

  private readonly connection = new RTCPeerConnection({
    iceServers: [],
    bundlePolicy: "max-bundle",
  });
  private dataChannel?: RTCDataChannel;
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
      const channel = this.connection.createDataChannel(DATA_CHANNEL_LABEL, {
        ordered: true,
      });
      this.bindChannel(channel);
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

  send(raw: string): boolean {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      return false;
    }

    this.dataChannel.send(raw);
    return true;
  }

  close(reason = "closed"): void {
    this.dataChannel?.removeEventListener("open", this.handleChannelOpen);
    this.dataChannel?.removeEventListener("close", this.handleChannelClose);
    this.dataChannel?.removeEventListener("message", this.handleChannelMessage);
    this.dataChannel?.removeEventListener("error", this.handleChannelError);
    this.dataChannel?.close();
    this.connection.close();
    this.setStatus("closed", reason);
  }

  getStatus(): RoomTransportStatus {
    return this.status;
  }

  getRemoteParticipant(): ParticipantIdentity | undefined {
    return this.remoteParticipant;
  }

  private bindChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
    channel.addEventListener("open", this.handleChannelOpen);
    channel.addEventListener("close", this.handleChannelClose);
    channel.addEventListener("message", this.handleChannelMessage);
    channel.addEventListener("error", this.handleChannelError);
  }

  private assertRoomMatch(roomId: string, mapId: string): void {
    if (roomId !== this.options.roomId || mapId !== this.options.mapId) {
      throw new Error("The signaling blob points to a different room.");
    }
  }

  private setStatus(phase: RoomTransportStatus["phase"], detail: string): void {
    this.status = { phase, detail };
    this.events.onStatus?.(this.status);
  }

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
    this.setStatus("closed", "Peer connection closed.");
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
    switch (this.connection.connectionState) {
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
        this.setStatus("closed", "Peer connection closed.");
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

export type WebRtcHostSignal = HostOfferSignal;
export type WebRtcGuestSignal = GuestAnswerSignal;
