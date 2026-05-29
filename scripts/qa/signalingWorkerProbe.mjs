import { setTimeout as delay } from "node:timers/promises";

const SIGNALING_URL = process.env.SIGNALING_URL ?? "https://csmini-signaling.csmini.workers.dev";
const ROOM_ID = `probe:${Date.now().toString(36)}`;
const MAX_ROOM_PEERS = 14;
const GUEST_COUNT = MAX_ROOM_PEERS - 1;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function toSocketUrl(baseUrl, roomId, role, peerId, name) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `/room/${encodeURIComponent(roomId)}`;
  url.searchParams.set("peerId", peerId);
  url.searchParams.set("role", role);
  url.searchParams.set("mapId", "probe-map");
  url.searchParams.set("name", name);
  url.searchParams.set("accentColor", role === "host" ? "#CFA66F" : "#6F8FAA");
  return url.toString();
}

function openSocket(role, peerId, name) {
  const messages = [];
  const socket = new WebSocket(toSocketUrl(SIGNALING_URL, ROOM_ID, role, peerId, name));
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data));
  });

  return { socket, messages };
}

async function waitFor(record, predicate, timeoutMs = 8_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = record.messages.find(predicate);
    if (found) {
      return found;
    }
    await delay(100);
  }

  throw new Error("Timed out waiting for signaling message.");
}

async function waitOpen(record) {
  if (record.socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise((resolve, reject) => {
    record.socket.addEventListener("open", resolve, { once: true });
    record.socket.addEventListener("error", reject, { once: true });
  });
}

async function main() {
  const health = await fetch(`${SIGNALING_URL}/health`);
  assert(health.ok, `Health check failed with HTTP ${health.status}`);
  const healthBody = await health.json();
  assert(healthBody.ok === true, "Health response was not ok.");
  assert(healthBody.maxPeersPerRoom === 14, "Worker room capacity is not 14.");

  const host = openSocket("host", "probe-host", "ProbeHost");
  const guests = Array.from({ length: GUEST_COUNT }, (_, index) =>
    openSocket("guest", `probe-guest-${index + 1}`, `ProbeGuest${index + 1}`),
  );
  let overflow;

  try {
    await Promise.all([waitOpen(host), ...guests.map(waitOpen)]);
    await waitFor(host, (message) => message.type === "ready");
    await Promise.all(
      guests.flatMap((guest) => [
        waitFor(guest, (message) => message.type === "ready"),
        waitFor(guest, (message) => message.type === "host-ready"),
      ]),
    );
    await Promise.all(
      guests.map((guest, index) =>
        waitFor(
          host,
          (message) =>
            message.type === "peer-joined" && message.peerId === `probe-guest-${index + 1}`,
        ),
      ),
    );

    overflow = openSocket("guest", "probe-overflow", "ProbeOverflow");
    await waitOpen(overflow);
    await waitFor(
      overflow,
      (message) => message.type === "room-error" && message.reason === "room-full",
    );

    for (const [index, guest] of guests.entries()) {
      const guestPeerId = `probe-guest-${index + 1}`;
      host.socket.send(
        JSON.stringify({
          type: "offer",
          toPeerId: guestPeerId,
          description: { type: "offer", sdp: `probe-offer-${index + 1}` },
        }),
      );
      const offer = await waitFor(guest, (message) => message.type === "offer");
      assert(offer.fromPeerId === "probe-host", "Offer relay did not preserve host peer id.");
      assert(offer.toPeerId === guestPeerId, "Offer relay did not preserve guest peer id.");

      guest.socket.send(
        JSON.stringify({
          type: "answer",
          toPeerId: "probe-host",
          description: { type: "answer", sdp: `probe-answer-${index + 1}` },
        }),
      );
      const answer = await waitFor(
        host,
        (message) => message.type === "answer" && message.fromPeerId === guestPeerId,
      );
      assert(answer.fromPeerId === guestPeerId, "Answer relay did not preserve guest peer id.");
    }

    console.log(
      JSON.stringify(
        {
          signalingUrl: SIGNALING_URL,
          roomId: ROOM_ID,
          maxPeersPerRoom: healthBody.maxPeersPerRoom,
          acceptedGuests: guests.length,
          overflowRejected: true,
          hostMessages: host.messages.map((message) => message.type),
          guestMessages: guests.map((guest) => guest.messages.map((message) => message.type)),
          overflowMessages: overflow?.messages.map((message) => message.type) ?? [],
        },
        null,
        2,
      ),
    );
  } finally {
    host.socket.close();
    for (const guest of guests) {
      guest.socket.close();
    }
    overflow?.socket.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
