import { DurableObject } from "cloudflare:workers";

const MAX_ROOM_PEERS = 14;
const MAX_REQUEST_URL_LENGTH = 512;
const MAX_QUERY_LENGTH = 256;
const MAX_ROOM_PATH_LENGTH = 128;

// Payload caps stay above normal browser-generated signaling blobs while remaining cheap to reject.
// 24 KiB raw leaves room for the JSON envelope, 12 KiB covers a full offer/answer body, and 2 KiB
// covers long ICE candidate lines without letting clients turn the Worker into a large-payload relay.
const MAX_RAW_MESSAGE_BYTES = 24 * 1024;
const MAX_SDP_DESCRIPTION_BYTES = 12 * 1024;
const MAX_ICE_CANDIDATE_BYTES = 2 * 1024;
// The 10 s rate window is long enough to absorb a real room-setup burst, and 384 messages / 256 KiB
// per socket still gives a host room for 13 targeted offers plus trickled ICE while cutting off
// sustained spam quickly. 256 KiB also allows about twenty-one near-max SDP payloads in one window,
// which is comfortably above one host fan-out and far below "relay arbitrary blobs all day".
const MESSAGE_RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 384;
const MAX_BYTES_PER_WINDOW = 256 * 1024;
// Four invalid messages lets a buggy client receive a couple of actionable errors, but prevents
// infinite malformed-message loops from camping on a room.
const MAX_INVALID_MESSAGES = 4;

// Ready should happen immediately after a successful upgrade, so 5 s is enough grace before we treat
// the socket as hoarded. Gameplay moves onto DataChannels after setup, so keeping an idle signaling
// socket around for more than 10 minutes adds little value while increasing room-hoarding risk. A
// 30 s sweep is coarse enough not to thrash timers and fine enough to clear stale sockets promptly.
const SESSION_READY_TIMEOUT_MS = 5_000;
const SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
const SESSION_SWEEP_INTERVAL_MS = 30_000;
// Two offers / answers per pair allow the initial negotiation plus one retry or ICE restart. Sixty-four
// ICE candidates per pair leaves room for noisy browser candidate gathering across host/guest
// links without allowing endless trickle spam to monopolize the room.
const MAX_OFFERS_PER_PAIR = 2;
const MAX_ANSWERS_PER_PAIR = 2;
const MAX_ICE_CANDIDATES_PER_PAIR = 64;

// 1008 is the standard policy-violation close for contract breaches, 1009 is the standard signal
// for oversized frames, and 1011 keeps send failures and other internal faults distinct from abuse.
const CLOSE_CODES = Object.freeze({
  normal: 1000,
  policy: 1008,
  tooLarge: 1009,
  internal: 1011,
});

const RELAY_TYPES = new Set(["offer", "answer", "ice-candidate"]);
const SAFE_ROOM_ID = /^[a-zA-Z0-9:._-]{3,96}$/;
const SAFE_PEER_ID = /^[a-zA-Z0-9:._-]{3,96}$/;
const SAFE_MAP_ID = /^[a-z0-9-]{3,64}$/;
const SAFE_ACCENT_COLOR = /^#[0-9A-Fa-f]{6}$/;
const UTF8 = new TextEncoder();

const DEFAULT_ACCENT_COLOR = "#CFA66F";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

export class RoomObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();
    this.hostPeerId = "";
    this.sweepTimer = null;
  }

  async fetch(request) {
    if (!isWebSocketUpgrade(request)) {
      return json({ ok: false, error: "Expected WebSocket upgrade." }, 426);
    }

    this.pruneSessions(Date.now());

    const url = new URL(request.url);
    const peerId = normalizeToken(url.searchParams.get("peerId"), SAFE_PEER_ID);
    const role = url.searchParams.get("role");
    const mapId = normalizeToken(url.searchParams.get("mapId"), SAFE_MAP_ID);
    const name = normalizeDisplayText(url.searchParams.get("name"), 32);
    const accentColor =
      normalizeToken(url.searchParams.get("accentColor"), SAFE_ACCENT_COLOR) || DEFAULT_ACCENT_COLOR;

    if (!peerId || (role !== "host" && role !== "guest") || !mapId || !name) {
      return json({ ok: false, error: "Missing or invalid signaling identity." }, 400);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.acceptSession(server, {
      peerId,
      role,
      mapId,
      participant: {
        id: peerId,
        name,
        accentColor,
      },
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  acceptSession(socket, session) {
    socket.accept();
    this.startSweepTimer();

    if (this.sessions.size >= MAX_ROOM_PEERS) {
      this.rejectSocket(socket, "room-full", `This signaling room is limited to ${MAX_ROOM_PEERS} peers.`);
      return;
    }

    if (this.findByPeerId(session.peerId)) {
      this.rejectSocket(socket, "duplicate-id", "A peer with this id is already connected to the room.");
      return;
    }

    if (session.role === "host" && this.findHost()) {
      this.rejectSocket(socket, "host-busy", "This room already has a host.");
      return;
    }

    const now = Date.now();
    this.sessions.set(socket, {
      ...session,
      joinedAt: now,
      lastActivityAt: now,
      readyAcknowledgedAt: 0,
      rateWindowStartedAt: now,
      messagesInWindow: 0,
      bytesInWindow: 0,
      invalidMessages: 0,
      pairBudgets: new Map(),
    });

    if (session.role === "host") {
      this.hostPeerId = session.peerId;
    }

    send(socket, {
      type: "ready",
      peerId: session.peerId,
      role: session.role,
      hostPeerId: this.hostPeerId || undefined,
      maxPeers: MAX_ROOM_PEERS,
      peers: this.peerListFor(session.peerId),
    });

    this.announceArrival(socket, session);

    socket.addEventListener("message", (event) => {
      this.handleMessage(socket, event.data);
    });
    socket.addEventListener("close", () => {
      this.removeSession(socket, "closed");
    });
    socket.addEventListener("error", () => {
      this.removeSession(socket, "error");
    });
  }

  announceArrival(socket, session) {
    const host = this.findHost();

    if (session.role === "host") {
      for (const [guestSocket, guest] of this.sessions) {
        if (guestSocket === socket || guest.role !== "guest") {
          continue;
        }

        send(guestSocket, {
          type: "host-ready",
          peerId: session.peerId,
          participant: session.participant,
        });
        send(socket, {
          type: "peer-joined",
          peerId: guest.peerId,
          role: guest.role,
          participant: guest.participant,
        });
      }
      return;
    }

    if (!host) {
      send(socket, {
        type: "waiting-for-host",
        detail: "Connected to signaling. Waiting for the host.",
      });
      return;
    }

    send(socket, {
      type: "host-ready",
      peerId: host.session.peerId,
      participant: host.session.participant,
    });
    send(host.socket, {
      type: "peer-joined",
      peerId: session.peerId,
      role: session.role,
      participant: session.participant,
    });
  }

  handleMessage(socket, raw) {
    const session = this.sessions.get(socket);
    if (!session) {
      return;
    }

    const now = Date.now();
    this.pruneSessions(now);

    const trackedSession = this.sessions.get(socket);
    if (!trackedSession) {
      return;
    }

    if (typeof raw !== "string") {
      this.noteInvalidMessage(
        socket,
        trackedSession,
        "invalid-message",
        "Signaling messages must be UTF-8 JSON text frames.",
      );
      return;
    }

    const rawBytes = utf8Bytes(raw);
    trackedSession.lastActivityAt = now;

    if (!this.consumeRateBudget(socket, trackedSession, rawBytes, now)) {
      return;
    }

    if (rawBytes > MAX_RAW_MESSAGE_BYTES) {
      this.terminateSession(socket, trackedSession, {
        closeCode: CLOSE_CODES.tooLarge,
        closeReason: "message-too-large",
        roomError: {
          reason: "message-too-large",
          detail: `Signaling messages must stay below ${MAX_RAW_MESSAGE_BYTES} bytes.`,
        },
      });
      return;
    }

    const message = parseJson(raw);
    if (!message || typeof message.type !== "string") {
      this.noteInvalidMessage(
        socket,
        trackedSession,
        "invalid-message",
        "Signaling message must be valid JSON with a type.",
      );
      return;
    }

    trackedSession.readyAcknowledgedAt ||= now;

    if (message.type === "ping") {
      send(socket, {
        type: "pong",
        serverTime: now,
      });
      return;
    }

    if (!RELAY_TYPES.has(message.type)) {
      this.noteInvalidMessage(
        socket,
        trackedSession,
        "unsupported-message",
        "Only offer, answer, and ice-candidate signaling messages are accepted.",
      );
      return;
    }

    const targetPeerId = normalizeToken(message.toPeerId, SAFE_PEER_ID);
    if (!targetPeerId) {
      this.noteInvalidMessage(
        socket,
        trackedSession,
        "target-required",
        "Signaling messages must include a valid target peer id.",
      );
      return;
    }

    if (targetPeerId === trackedSession.peerId) {
      this.noteInvalidMessage(
        socket,
        trackedSession,
        "target-self",
        "Signaling messages must target another peer in the room.",
      );
      return;
    }

    const target = this.findByPeerId(targetPeerId);
    if (!target) {
      this.noteInvalidMessage(
        socket,
        trackedSession,
        "peer-not-found",
        "Target peer is not connected to this room.",
      );
      return;
    }

    switch (message.type) {
      case "offer":
        this.handleOffer(socket, trackedSession, target, message, now);
        return;
      case "answer":
        this.handleAnswer(socket, trackedSession, target, message, now);
        return;
      case "ice-candidate":
        this.handleIceCandidate(socket, trackedSession, target, message, now);
        return;
    }
  }

  handleOffer(socket, session, target, message, now) {
    if (session.role !== "host") {
      this.noteInvalidMessage(
        socket,
        session,
        "guest-offer-forbidden",
        "Only the room host may send offers.",
      );
      return;
    }

    if (target.session.role !== "guest") {
      this.noteInvalidMessage(
        socket,
        session,
        "invalid-offer-target",
        "Offers must target a guest peer.",
      );
      return;
    }

    const description = sanitizeDescription(message.description, "offer");
    if (!description) {
      this.noteInvalidMessage(
        socket,
        session,
        "invalid-offer",
        "Offer descriptions must include a bounded SDP payload.",
      );
      return;
    }

    if (!this.consumePairBudget(socket, session, target.session.peerId, "offer")) {
      return;
    }

    send(target.socket, {
      type: "offer",
      fromPeerId: session.peerId,
      toPeerId: target.session.peerId,
      participant: session.participant,
      description,
      sentAt: now,
    });
  }

  handleAnswer(socket, session, target, message, now) {
    if (session.role !== "guest") {
      this.noteInvalidMessage(
        socket,
        session,
        "host-answer-forbidden",
        "Only a guest may send an answer.",
      );
      return;
    }

    if (target.session.role !== "host" || target.session.peerId !== this.hostPeerId) {
      this.noteInvalidMessage(
        socket,
        session,
        "invalid-answer-target",
        "Answers must target the room host.",
      );
      return;
    }

    const description = sanitizeDescription(message.description, "answer");
    if (!description) {
      this.noteInvalidMessage(
        socket,
        session,
        "invalid-answer",
        "Answer descriptions must include a bounded SDP payload.",
      );
      return;
    }

    if (!this.consumePairBudget(socket, session, target.session.peerId, "answer")) {
      return;
    }

    send(target.socket, {
      type: "answer",
      fromPeerId: session.peerId,
      toPeerId: target.session.peerId,
      participant: session.participant,
      description,
      sentAt: now,
    });
  }

  handleIceCandidate(socket, session, target, message, now) {
    const targetMatchesTopology =
      (session.role === "host" && target.session.role === "guest") ||
      (session.role === "guest" &&
        target.session.role === "host" &&
        target.session.peerId === this.hostPeerId);

    if (!targetMatchesTopology) {
      this.noteInvalidMessage(
        socket,
        session,
        "invalid-candidate-target",
        "ICE candidates must target the host or one of its guests.",
      );
      return;
    }

    const candidate = sanitizeIceCandidate(message.candidate);
    if (!candidate) {
      this.noteInvalidMessage(
        socket,
        session,
        "invalid-candidate",
        "ICE candidates must stay within the allowed size budget.",
      );
      return;
    }

    if (!this.consumePairBudget(socket, session, target.session.peerId, "ice-candidate")) {
      return;
    }

    send(target.socket, {
      type: "ice-candidate",
      fromPeerId: session.peerId,
      toPeerId: target.session.peerId,
      candidate,
      sentAt: now,
    });
  }

  consumeRateBudget(socket, session, rawBytes, now) {
    if (now - session.rateWindowStartedAt >= MESSAGE_RATE_WINDOW_MS) {
      session.rateWindowStartedAt = now;
      session.messagesInWindow = 0;
      session.bytesInWindow = 0;
    }

    session.messagesInWindow += 1;
    session.bytesInWindow += rawBytes;

    if (
      session.messagesInWindow > MAX_MESSAGES_PER_WINDOW ||
      session.bytesInWindow > MAX_BYTES_PER_WINDOW
    ) {
      this.terminateSession(socket, session, {
        closeCode: CLOSE_CODES.policy,
        closeReason: "rate-limit",
        roomError: {
          reason: "rate-limit",
          detail: "Signaling traffic exceeded the per-socket room budget.",
        },
      });
      return false;
    }

    return true;
  }

  consumePairBudget(socket, session, targetPeerId, type) {
    const pairBudget =
      session.pairBudgets.get(targetPeerId) ??
      { offer: 0, answer: 0, "ice-candidate": 0 };
    pairBudget[type] += 1;
    session.pairBudgets.set(targetPeerId, pairBudget);

    const limit =
      type === "offer"
        ? MAX_OFFERS_PER_PAIR
        : type === "answer"
          ? MAX_ANSWERS_PER_PAIR
          : MAX_ICE_CANDIDATES_PER_PAIR;

    if (pairBudget[type] > limit) {
      this.terminateSession(socket, session, {
        closeCode: CLOSE_CODES.policy,
        closeReason: `${type}-limit`,
        roomError: {
          reason: `${type}-limit`,
          detail: `This room allows at most ${limit} ${type} messages per peer pair.`,
        },
      });
      return false;
    }

    return true;
  }

  noteInvalidMessage(socket, session, reason, detail) {
    session.invalidMessages += 1;
    send(socket, {
      type: "room-error",
      reason,
      detail,
    });

    if (session.invalidMessages >= MAX_INVALID_MESSAGES) {
      this.terminateSession(socket, session, {
        closeCode: CLOSE_CODES.policy,
        closeReason: "too-many-invalid-messages",
      });
    }
  }

  rejectSocket(socket, reason, detail) {
    send(socket, {
      type: "room-error",
      reason,
      detail,
    });

    try {
      socket.close(CLOSE_CODES.policy, reason);
    } catch {
      // Ignore secondary close failures while rejecting the socket.
    }
  }

  terminateSession(socket, session, options) {
    const {
      closeCode = CLOSE_CODES.policy,
      closeReason = "policy",
      roomError,
      broadcastReason = closeReason,
    } = options ?? {};

    if (!this.sessions.has(socket)) {
      return;
    }

    if (roomError) {
      send(socket, {
        type: "room-error",
        reason: roomError.reason,
        detail: roomError.detail,
      });
    }

    this.sessions.delete(socket);
    if (session.peerId === this.hostPeerId) {
      this.hostPeerId = "";
    }

    try {
      socket.close(closeCode, closeReason);
    } catch {
      // Ignore secondary close failures while terminating the socket.
    }

    this.broadcast(
      {
        type: "peer-left",
        peerId: session.peerId,
        role: session.role,
        reason: broadcastReason,
      },
      socket,
    );

    this.cleanupEmptyRoom();
  }

  removeSession(socket, reason) {
    const session = this.sessions.get(socket);
    if (!session) {
      return;
    }

    this.sessions.delete(socket);
    if (session.peerId === this.hostPeerId) {
      this.hostPeerId = "";
    }

    this.broadcast(
      {
        type: "peer-left",
        peerId: session.peerId,
        role: session.role,
        reason,
      },
      socket,
    );

    this.cleanupEmptyRoom();
  }

  pruneSessions(now) {
    for (const [socket, session] of [...this.sessions.entries()]) {
      if (!session.readyAcknowledgedAt && now - session.joinedAt > SESSION_READY_TIMEOUT_MS) {
        this.terminateSession(socket, session, {
          closeCode: CLOSE_CODES.policy,
          closeReason: "ready-timeout",
          roomError: {
            reason: "ready-timeout",
            detail: "The signaling session did not become ready in time.",
          },
        });
        continue;
      }

      if (now - session.lastActivityAt > SESSION_IDLE_TIMEOUT_MS) {
        this.terminateSession(socket, session, {
          closeCode: CLOSE_CODES.policy,
          closeReason: "idle-timeout",
          roomError: {
            reason: "idle-timeout",
            detail: "The signaling session was closed after staying idle for too long.",
          },
        });
      }
    }
  }

  cleanupEmptyRoom() {
    if (this.sessions.size > 0) {
      return;
    }

    this.hostPeerId = "";
    this.stopSweepTimer();
  }

  startSweepTimer() {
    if (this.sweepTimer) {
      return;
    }

    this.sweepTimer = setInterval(() => {
      this.pruneSessions(Date.now());
    }, SESSION_SWEEP_INTERVAL_MS);
  }

  stopSweepTimer() {
    if (!this.sweepTimer) {
      return;
    }

    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  broadcast(message, excludedSocket) {
    for (const socket of this.sessions.keys()) {
      if (socket !== excludedSocket) {
        send(socket, message);
      }
    }
  }

  findHost() {
    for (const [socket, session] of this.sessions) {
      if (session.role === "host") {
        return { socket, session };
      }
    }

    return undefined;
  }

  findByPeerId(peerId) {
    for (const [socket, session] of this.sessions) {
      if (session.peerId === peerId) {
        return { socket, session };
      }
    }

    return undefined;
  }

  peerListFor(localPeerId) {
    return [...this.sessions.values()]
      .filter((peer) => peer.peerId !== localPeerId)
      .map((peer) => ({
        peerId: peer.peerId,
        role: peer.role,
        participant: peer.participant,
      }));
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (request.url.length > MAX_REQUEST_URL_LENGTH || url.search.length > MAX_QUERY_LENGTH) {
      return json({ ok: false, error: "Signaling request URL is too large." }, 414);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      if (request.method !== "GET") {
        return methodNotAllowed("GET");
      }

      return json({
        ok: true,
        service: "csmini-signaling",
        maxPeersPerRoom: MAX_ROOM_PEERS,
      });
    }

    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }

    if (url.pathname.length > MAX_ROOM_PATH_LENGTH) {
      return json({ ok: false, error: "Room path is too large." }, 414);
    }

    const roomId = decodeRoomId(url.pathname);
    if (!roomId) {
      return json({ ok: false, error: "Use /room/:roomId for WebSocket signaling." }, 404);
    }

    if (!isWebSocketUpgrade(request)) {
      return json({ ok: false, error: "Expected WebSocket upgrade." }, 426);
    }

    const id = env.ROOMS.idFromName(roomId);
    return env.ROOMS.get(id).fetch(request);
  },
};

function isWebSocketUpgrade(request) {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function decodeRoomId(pathname) {
  const prefix = "/room/";
  if (!pathname.startsWith(prefix)) {
    return "";
  }

  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) {
    return "";
  }

  try {
    return normalizeToken(decodeURIComponent(encoded), SAFE_ROOM_ID);
  } catch {
    return "";
  }
}

function normalizeToken(value, pattern) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  return pattern.test(trimmed) ? trimmed : "";
}

function normalizeDisplayText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return sanitized ? sanitized.slice(0, maxLength) : "";
}

function sanitizeDescription(value, expectedType) {
  if (
    typeof value !== "object" ||
    value === null ||
    value.type !== expectedType ||
    typeof value.sdp !== "string" ||
    value.sdp.length === 0 ||
    utf8Bytes(value.sdp) > MAX_SDP_DESCRIPTION_BYTES
  ) {
    return null;
  }

  return {
    type: expectedType,
    sdp: value.sdp,
  };
}

function sanitizeIceCandidate(value) {
  if (typeof value !== "object" || value === null || typeof value.candidate !== "string") {
    return null;
  }

  if (!value.candidate || utf8Bytes(value.candidate) > MAX_ICE_CANDIDATE_BYTES) {
    return null;
  }

  const candidate = {
    candidate: value.candidate,
  };

  if (value.sdpMid !== undefined) {
    if (typeof value.sdpMid !== "string" || utf8Bytes(value.sdpMid) > 64) {
      return null;
    }
    candidate.sdpMid = value.sdpMid;
  }

  if (value.sdpMLineIndex !== undefined) {
    if (!Number.isInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0 || value.sdpMLineIndex > 32) {
      return null;
    }
    candidate.sdpMLineIndex = value.sdpMLineIndex;
  }

  if (value.usernameFragment !== undefined) {
    if (typeof value.usernameFragment !== "string" || utf8Bytes(value.usernameFragment) > 64) {
      return null;
    }
    candidate.usernameFragment = value.usernameFragment;
  }

  return candidate;
}

function utf8Bytes(value) {
  return UTF8.encode(value).byteLength;
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function send(socket, message) {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    try {
      socket.close(CLOSE_CODES.internal, "send-failed");
    } catch {
      // Ignore close failures after a send exception.
    }
  }
}

function methodNotAllowed(allow) {
  return new Response(
    JSON.stringify({
      ok: false,
      error: `Use ${allow} for this route.`,
    }),
    {
      status: 405,
      headers: {
        ...corsHeaders,
        allow,
        "content-type": "application/json",
      },
    },
  );
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: corsHeaders,
  });
}
