import type {
  RoomTransport,
  RoomTransportEvents,
  RoomTransportLane,
  RoomTransportStatus,
} from "./transport";

export function detectBroadcastTransportSupport(): { supported: boolean; reason: string } {
  if (typeof BroadcastChannel === "undefined") {
    return {
      supported: false,
      reason: "BroadcastChannel is unavailable in this browser.",
    };
  }

  return {
    supported: true,
    reason: "BroadcastChannel available.",
  };
}

export class BroadcastRoomTransport implements RoomTransport {
  readonly kind = "broadcast" as const;
  private status: RoomTransportStatus = {
    phase: "connected",
    detail: "Same-browser dev room ready.",
  };
  private readonly channel: BroadcastChannel;
  private events: RoomTransportEvents;

  constructor(
    private readonly roomId: string,
    readonly localPeerId: string,
    events: RoomTransportEvents,
  ) {
    this.events = events;
    this.channel = new BroadcastChannel(roomId);
    this.channel.addEventListener("message", this.handleMessage);
    this.events.onStatus?.(this.status);
  }

  setEvents(events: RoomTransportEvents): void {
    this.events = events;
    this.events.onStatus?.(this.status);
  }

  send(raw: string, _toPeerId?: string, lane: RoomTransportLane = "reliable"): boolean {
    if (this.status.phase === "closed") {
      return false;
    }

    this.channel.postMessage({ lane, raw });
    return true;
  }

  close(reason = "closed"): void {
    if (this.status.phase === "closed") {
      return;
    }

    this.channel.removeEventListener("message", this.handleMessage);
    this.channel.close();
    this.status = {
      phase: "closed",
      detail: reason,
    };
    this.events.onStatus?.(this.status);
  }

  getStatus(): RoomTransportStatus {
    return this.status;
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    if (typeof event.data === "string") {
      this.events.onMessage({
        lane: "reliable",
        raw: event.data,
        receivedAt: Date.now(),
      });
      return;
    }

    if (
      typeof event.data !== "object" ||
      event.data === null ||
      !("raw" in event.data) ||
      !("lane" in event.data) ||
      typeof event.data.raw !== "string" ||
      (event.data.lane !== "reliable" && event.data.lane !== "latest-state")
    ) {
      return;
    }

    this.events.onMessage({
      lane: event.data.lane,
      raw: event.data.raw,
      receivedAt: Date.now(),
    });
  };
}
