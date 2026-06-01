import { setTimeout as delay } from "node:timers/promises";

const SIGNALING_URL = process.env.SIGNALING_URL ?? "https://csmini-signaling.csmini.workers.dev";
const MAX_ROOM_PEERS = 14;
const GUEST_COUNT = MAX_ROOM_PEERS - 1;
const MAX_RAW_MESSAGE_BYTES = 24 * 1024;
const MAX_MESSAGES_PER_WINDOW = 384;
const MAX_ICE_CANDIDATES_PER_PAIR = 64;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_LARGE = 1009;

const PROBE_CANDIDATE = {
  candidate: "candidate:0 1 UDP 2122252543 192.0.2.1 54400 typ host",
  sdpMid: "0",
  sdpMLineIndex: 0,
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createRoomId(label) {
  return `probe:${label}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

function toSocketUrl(baseUrl, roomId, role, peerId, name, options = {}) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `/room/${encodeURIComponent(roomId)}`;
  url.searchParams.set("peerId", peerId);
  url.searchParams.set("role", role);
  url.searchParams.set("mapId", "sandline-foundry");
  url.searchParams.set("name", name);
  url.searchParams.set("accentColor", role === "host" ? "#CFA66F" : "#6F8FAA");
  if (options.visibility) {
    url.searchParams.set("visibility", options.visibility);
  }
  if (options.roomCode) {
    url.searchParams.set("roomCode", options.roomCode);
  }
  if (options.publicSlot) {
    url.searchParams.set("publicSlot", String(options.publicSlot));
  }
  if (options.mapName) {
    url.searchParams.set("mapName", options.mapName);
  }
  return url.toString();
}

function openSocket(roomId, role, peerId, name, options = {}) {
  const messages = [];
  const closes = [];
  const url = toSocketUrl(SIGNALING_URL, roomId, role, peerId, name, options);
  const socket = new WebSocket(url);

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      messages.push({ type: "non-text-frame" });
      return;
    }

    messages.push(JSON.parse(event.data));
  });

  socket.addEventListener("close", (event) => {
    closes.push({
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });
  });

  return { socket, messages, closes, url };
}

async function fetchPublicRooms() {
  const response = await fetch(`${SIGNALING_URL}/public-rooms?mapId=sandline-foundry`, {
    cache: "no-store",
  });
  assert(response.ok, `Public rooms failed with HTTP ${response.status}`);
  const body = await response.json();
  assert(body.ok === true && Array.isArray(body.rooms), "Public rooms response was invalid.");
  return body.rooms;
}

async function waitForPublicRoom(predicate, timeoutMs = 8_000, description = "public room") {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const rooms = await fetchPublicRooms();
    const found = predicate(rooms);
    if (found) {
      return found;
    }
    await delay(50);
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitFor(record, predicate, timeoutMs = 8_000, description = "signaling event") {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = predicate(record);
    if (found) {
      return found;
    }
    await delay(50);
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitOpen(record) {
  if (record.socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise((resolve, reject) => {
    record.socket.addEventListener("open", resolve, { once: true });
    record.socket.addEventListener(
      "error",
      () => reject(new Error(`WebSocket failed to open: ${record.url}`)),
      { once: true },
    );
  });
}

async function waitForMessage(record, predicate, timeoutMs = 8_000, description = "message") {
  return waitFor(
    record,
    (state) => state.messages.find(predicate),
    timeoutMs,
    description,
  );
}

async function waitForClose(record, predicate = () => true, timeoutMs = 8_000, description = "close") {
  return waitFor(
    record,
    (state) => state.closes.find(predicate),
    timeoutMs,
    description,
  );
}

function sendJson(record, payload) {
  record.socket.send(JSON.stringify(payload));
}

function safeClose(record) {
  if (!record) {
    return;
  }

  try {
    if (record.socket.readyState === WebSocket.OPEN || record.socket.readyState === WebSocket.CONNECTING) {
      record.socket.close();
    }
  } catch {
    // Ignore test cleanup failures.
  }
}

async function openHostGuestRoom(label) {
  const roomId = createRoomId(label);
  const host = openSocket(roomId, "host", `${label}-host`, `Host-${label}`);
  const guest = openSocket(roomId, "guest", `${label}-guest`, `Guest-${label}`);
  await Promise.all([waitOpen(host), waitOpen(guest)]);
  await waitForMessage(host, (message) => message.type === "ready", 8_000, "host ready");
  await waitForMessage(guest, (message) => message.type === "ready", 8_000, "guest ready");
  await waitForMessage(guest, (message) => message.type === "host-ready", 8_000, "guest host-ready");
  await waitForMessage(
    host,
    (message) => message.type === "peer-joined" && message.peerId === `${label}-guest`,
    8_000,
    "host peer-joined",
  );
  return { roomId, host, guest };
}

async function probeRoutes() {
  const health = await fetch(`${SIGNALING_URL}/health`);
  assert(health.ok, `Health check failed with HTTP ${health.status}`);
  const healthBody = await health.json();
  assert(healthBody.ok === true, "Health response was not ok.");
  assert(healthBody.maxPeersPerRoom === MAX_ROOM_PEERS, "Worker room capacity is not 14.");

  const badMethod = await fetch(`${SIGNALING_URL}/health`, { method: "POST" });
  assert(badMethod.status === 405, "POST /health should be rejected.");

  const badRoute = await fetch(`${SIGNALING_URL}/not-a-room`);
  assert(badRoute.status === 404, "Unexpected route should be rejected before Durable Object dispatch.");

  const tooLargeQuery = await fetch(
    `${SIGNALING_URL}/room/${encodeURIComponent(createRoomId("oversize-query"))}?${"x".repeat(300)}`,
  );
  assert(tooLargeQuery.status === 414, "Oversized signaling query should be rejected before Durable Object dispatch.");

  return {
    maxPeersPerRoom: healthBody.maxPeersPerRoom,
    postHealthStatus: badMethod.status,
    badRouteStatus: badRoute.status,
    oversizeQueryStatus: tooLargeQuery.status,
  };
}

async function probeTurnCredentials() {
  const response = await fetch(`${SIGNALING_URL}/turn-credentials`, { cache: "no-store" });
  assert(response.ok, `TURN credential endpoint failed with HTTP ${response.status}`);
  assert(response.headers.get("cache-control") === "no-store", "TURN credentials should not be cached.");

  const body = await response.json();
  assert(Array.isArray(body), "TURN credential endpoint should return an ICE server array.");
  assert(body.length > 0, "TURN credential endpoint should return at least one ICE server.");
  assert(
    body.every((server) => server && (typeof server.urls === "string" || Array.isArray(server.urls))),
    "Every ICE server must include urls.",
  );

  const flattenedUrls = body.flatMap((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]));
  assert(flattenedUrls.every((url) => /^(stun|stuns|turn|turns):/.test(url)), "ICE URLs must use ICE schemes.");

  return {
    count: body.length,
    hasTurn: flattenedUrls.some((url) => /^turns?:/.test(url)),
    source: response.headers.get("x-ice-servers-source") ?? "unknown",
    expiresIn: response.headers.get("x-turn-credential-expires-in") ?? null,
  };
}

async function probePublicRoomsRegistry() {
  const roomId = createRoomId("public");
  const roomCode = "PXB875";
  const host = openSocket(roomId, "host", "public-host", "PublicHost", {
    visibility: "public",
    roomCode,
    publicSlot: 1,
    mapName: "Sandline Foundry",
  });
  let guest;

  try {
    await waitOpen(host);
    await waitForMessage(host, (message) => message.type === "ready", 8_000, "public host ready");

    const listedRoom = await waitForPublicRoom(
      (rooms) => rooms.find((room) => room.roomCode === roomCode && room.publicSlot === 1),
      8_000,
      "public room listing",
    );
    host.socket.send(JSON.stringify({ type: "ping" }));
    await waitForMessage(host, (message) => message.type === "pong", 8_000, "public host pong");
    const refreshedRoom = await waitForPublicRoom(
      (rooms) =>
        rooms.find(
          (room) =>
            room.roomCode === roomCode &&
            room.publicSlot === 1 &&
            room.expiresAt > listedRoom.expiresAt,
        ),
      8_000,
      "public room ping refresh",
    );

    guest = openSocket(roomId, "guest", "public-guest", "PublicGuest");
    await waitOpen(guest);
    await waitForMessage(guest, (message) => message.type === "host-ready", 8_000, "public guest host-ready");

    const joinedRoom = await waitForPublicRoom(
      (rooms) =>
        rooms.find((room) => room.roomCode === roomCode && room.participantCount === 2),
      8_000,
      "public room participant count",
    );

    safeClose(guest);
    safeClose(host);

    await waitForPublicRoom(
      (rooms) => !rooms.some((room) => room.roomCode === roomCode),
      8_000,
      "public room removal",
    );

    return {
      roomCode: listedRoom.roomCode,
      publicSlot: listedRoom.publicSlot,
      hostName: listedRoom.hostName,
      expiresAtBeforePing: listedRoom.expiresAt,
      expiresAtAfterPing: refreshedRoom.expiresAt,
      participantCountAfterJoin: joinedRoom.participantCount,
    };
  } finally {
    safeClose(guest);
    safeClose(host);
  }
}

async function probeCapacityAndRelay() {
  const roomId = createRoomId("capacity");
  const host = openSocket(roomId, "host", "capacity-host", "CapacityHost");
  const guests = Array.from({ length: GUEST_COUNT }, (_, index) =>
    openSocket(roomId, "guest", `capacity-guest-${index + 1}`, `CapacityGuest${index + 1}`),
  );
  let overflow;

  try {
    await Promise.all([waitOpen(host), ...guests.map(waitOpen)]);
    await waitForMessage(host, (message) => message.type === "ready", 8_000, "capacity host ready");
    await Promise.all(
      guests.flatMap((guest) => [
        waitForMessage(guest, (message) => message.type === "ready", 8_000, "guest ready"),
        waitForMessage(guest, (message) => message.type === "host-ready", 8_000, "guest host-ready"),
      ]),
    );
    await Promise.all(
      guests.map((guest, index) =>
        waitForMessage(
          host,
          (message) =>
            message.type === "peer-joined" && message.peerId === `capacity-guest-${index + 1}`,
          8_000,
          `peer-joined ${index + 1}`,
        ),
      ),
    );

    overflow = openSocket(roomId, "guest", "capacity-overflow", "CapacityOverflow");
    await waitOpen(overflow);
    const overflowError = await waitForMessage(
      overflow,
      (message) => message.type === "room-error" && message.reason === "room-full",
      8_000,
      "room-full error",
    );
    const overflowClose = await waitForClose(
      overflow,
      (close) => close.code === CLOSE_POLICY && close.reason === "room-full",
      8_000,
      "room-full close",
    );

    sendJson(host, {
      type: "offer",
      toPeerId: "capacity-guest-1",
      description: { type: "offer", sdp: "probe-offer" },
    });
    const offer = await waitForMessage(
      guests[0],
      (message) => message.type === "offer" && message.fromPeerId === "capacity-host",
      8_000,
      "offer relay",
    );

    sendJson(guests[0], {
      type: "answer",
      toPeerId: "capacity-host",
      description: { type: "answer", sdp: "probe-answer" },
    });
    const answer = await waitForMessage(
      host,
      (message) => message.type === "answer" && message.fromPeerId === "capacity-guest-1",
      8_000,
      "answer relay",
    );

    sendJson(host, {
      type: "ice-candidate",
      toPeerId: "capacity-guest-1",
      candidate: PROBE_CANDIDATE,
    });
    const hostCandidate = await waitForMessage(
      guests[0],
      (message) =>
        message.type === "ice-candidate" && message.fromPeerId === "capacity-host",
      8_000,
      "host candidate relay",
    );

    sendJson(guests[0], {
      type: "ice-candidate",
      toPeerId: "capacity-host",
      candidate: PROBE_CANDIDATE,
    });
    const guestCandidate = await waitForMessage(
      host,
      (message) =>
        message.type === "ice-candidate" && message.fromPeerId === "capacity-guest-1",
      8_000,
      "guest candidate relay",
    );

    sendJson(host, {
      type: "ice-candidate",
      toPeerId: "capacity-guest-1",
      candidate: {
        candidate: "",
        sdpMid: null,
        sdpMLineIndex: null,
        usernameFragment: null,
      },
    });
    const nullableCandidate = await waitForMessage(
      guests[0],
      (message) =>
        message.type === "ice-candidate" &&
        message.fromPeerId === "capacity-host" &&
        message.candidate?.candidate === "",
      8_000,
      "nullable end-of-candidates relay",
    );

    return {
      acceptedGuests: guests.length,
      overflowRejected: overflowError.reason === "room-full" && overflowClose.code === CLOSE_POLICY,
      relay: {
        offer: {
          fromPeerId: offer.fromPeerId,
          toPeerId: offer.toPeerId,
        },
        answer: {
          fromPeerId: answer.fromPeerId,
          toPeerId: answer.toPeerId,
        },
        hostCandidateFrom: hostCandidate.fromPeerId,
        guestCandidateFrom: guestCandidate.fromPeerId,
        nullableCandidateFieldsDropped:
          !("sdpMid" in nullableCandidate.candidate) &&
          !("sdpMLineIndex" in nullableCandidate.candidate) &&
          !("usernameFragment" in nullableCandidate.candidate),
      },
    };
  } finally {
    safeClose(host);
    guests.forEach(safeClose);
    safeClose(overflow);
  }
}

async function probeUnsupportedMessage() {
  const { host, guest } = await openHostGuestRoom("unsupported");

  try {
    sendJson(host, { type: "broadcast-all" });
    const error = await waitForMessage(
      host,
      (message) => message.type === "room-error" && message.reason === "unsupported-message",
      8_000,
      "unsupported-message rejection",
    );
    return { reason: error.reason };
  } finally {
    safeClose(host);
    safeClose(guest);
  }
}

async function probeTargetValidation() {
  const { host, guest } = await openHostGuestRoom("target");

  try {
    sendJson(guest, {
      type: "ice-candidate",
      candidate: PROBE_CANDIDATE,
    });
    const missingTarget = await waitForMessage(
      guest,
      (message) => message.type === "room-error" && message.reason === "target-required",
      8_000,
      "missing target rejection",
    );

    sendJson(guest, {
      type: "ice-candidate",
      toPeerId: "missing-peer",
      candidate: PROBE_CANDIDATE,
    });
    const badTarget = await waitForMessage(
      guest,
      (message) => message.type === "room-error" && message.reason === "peer-not-found",
      8_000,
      "peer-not-found rejection",
    );

    return {
      missingTarget: missingTarget.reason,
      badTarget: badTarget.reason,
    };
  } finally {
    safeClose(host);
    safeClose(guest);
  }
}

async function probeRoleViolations() {
  const { host, guest } = await openHostGuestRoom("roles");

  try {
    sendJson(guest, {
      type: "offer",
      toPeerId: "roles-host",
      description: { type: "offer", sdp: "guest-offer" },
    });
    const guestOffer = await waitForMessage(
      guest,
      (message) => message.type === "room-error" && message.reason === "guest-offer-forbidden",
      8_000,
      "guest offer rejection",
    );

    sendJson(host, {
      type: "answer",
      toPeerId: "roles-guest",
      description: { type: "answer", sdp: "host-answer" },
    });
    const hostAnswer = await waitForMessage(
      host,
      (message) => message.type === "room-error" && message.reason === "host-answer-forbidden",
      8_000,
      "host answer rejection",
    );

    return {
      guestOffer: guestOffer.reason,
      hostAnswer: hostAnswer.reason,
    };
  } finally {
    safeClose(host);
    safeClose(guest);
  }
}

async function probeOversizedMessage() {
  const roomId = createRoomId("oversized");
  const host = openSocket(roomId, "host", "oversized-host", "OversizedHost");

  try {
    await waitOpen(host);
    await waitForMessage(host, (message) => message.type === "ready", 8_000, "oversized ready");

    const oversized = JSON.stringify({
      type: "ping",
      padding: "A".repeat(MAX_RAW_MESSAGE_BYTES),
    });
    host.socket.send(oversized);

    const close = await waitForClose(
      host,
      (event) => event.code === CLOSE_TOO_LARGE && event.reason === "message-too-large",
      8_000,
      "oversized close",
    );

    return {
      closeCode: close.code,
      closeReason: close.reason,
    };
  } finally {
    safeClose(host);
  }
}

async function probeRateLimit() {
  const roomId = createRoomId("rate");
  const host = openSocket(roomId, "host", "rate-host", "RateHost");

  try {
    await waitOpen(host);
    await waitForMessage(host, (message) => message.type === "ready", 8_000, "rate ready");

    for (let index = 0; index < MAX_MESSAGES_PER_WINDOW + 32; index += 1) {
      sendJson(host, { type: "ping", seq: index });
    }

    const close = await waitForClose(
      host,
      (event) => event.code === CLOSE_POLICY && event.reason === "rate-limit",
      8_000,
      "rate limit close",
    );

    return {
      closeCode: close.code,
      closeReason: close.reason,
    };
  } finally {
    safeClose(host);
  }
}

async function probeIceCandidateBudget() {
  const { host, guest } = await openHostGuestRoom("candidate-budget");

  try {
    for (let index = 0; index < MAX_ICE_CANDIDATES_PER_PAIR + 1; index += 1) {
      sendJson(guest, {
        type: "ice-candidate",
        toPeerId: "candidate-budget-host",
        candidate: {
          ...PROBE_CANDIDATE,
          candidate: `${PROBE_CANDIDATE.candidate} ${index}`,
        },
      });
    }

    const error = await waitForMessage(
      guest,
      (message) => message.type === "room-error" && message.reason === "ice-candidate-limit",
      8_000,
      "ice-candidate-limit error",
    );
    const close = await waitForClose(
      guest,
      (event) => event.code === CLOSE_POLICY && event.reason === "ice-candidate-limit",
      8_000,
      "ice-candidate-limit close",
    );

    return {
      reason: error.reason,
      closeCode: close.code,
      closeReason: close.reason,
    };
  } finally {
    safeClose(host);
    safeClose(guest);
  }
}

async function main() {
  const routes = await probeRoutes();
  const turnCredentials = await probeTurnCredentials();
  const publicRooms = await probePublicRoomsRegistry();
  const capacity = await probeCapacityAndRelay();
  const unsupportedMessage = await probeUnsupportedMessage();
  const targetValidation = await probeTargetValidation();
  const roleViolations = await probeRoleViolations();
  const oversizedMessage = await probeOversizedMessage();
  const rateLimit = await probeRateLimit();
  const iceCandidateBudget = await probeIceCandidateBudget();

  console.log(
    JSON.stringify(
      {
        signalingUrl: SIGNALING_URL,
        routes,
        turnCredentials,
        publicRooms,
        capacity,
        unsupportedMessage,
        targetValidation,
        roleViolations,
        oversizedMessage,
        rateLimit,
        iceCandidateBudget,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
