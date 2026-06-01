import { DurableObject } from "cloudflare:workers";

const MAX_ROOM_PEERS = 14;
const MAX_PUBLIC_ROOMS = 128;
const MAX_REQUEST_URL_LENGTH = 512;
const MAX_QUERY_LENGTH = 256;
const MAX_ROOM_PATH_LENGTH = 128;
const MAX_PUBLIC_ROOM_BODY_BYTES = 4 * 1024;
const MAX_TURN_CREDENTIAL_RESPONSE_BYTES = 16 * 1024;
const MAX_TURN_CREATE_CREDENTIAL_RESPONSE_BYTES = 8 * 1024;
const TURN_CREDENTIAL_EXPIRY_SECONDS = 2 * 60 * 60;
const MAX_ICE_SERVER_COUNT = 12;
const MAX_ICE_URLS_PER_SERVER = 8;
const MAX_ICE_URL_LENGTH = 256;
const MAX_ICE_CREDENTIAL_LENGTH = 256;

// Payload caps stay above normal browser-generated signaling blobs while remaining cheap to reject.
// 24 KiB raw leaves room for the JSON envelope, 12 KiB covers a full offer/answer body, and 2 KiB
// covers long ICE candidate lines without letting clients turn the Worker into a large-payload relay.
const MAX_RAW_MESSAGE_BYTES = 24 * 1024;
const MAX_SDP_DESCRIPTION_BYTES = 12 * 1024;
const MAX_ICE_CANDIDATE_BYTES = 2 * 1024;
const MAX_ICE_CANDIDATE_FIELD_BYTES = 256;
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
const PUBLIC_ROOM_TTL_MS = 240_000;
const PUBLIC_ROOM_REGISTRY_NAME = "global";
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
const DEFAULT_ICE_SERVERS = Object.freeze([
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
]);
const SAFE_ROOM_ID = /^[a-zA-Z0-9:._-]{3,96}$/;
const SAFE_ROOM_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6,12}$/;
const SAFE_PEER_ID = /^[a-zA-Z0-9:._-]{3,96}$/;
const SAFE_MAP_ID = /^[a-z0-9-]{3,64}$/;
const SAFE_ACCENT_COLOR = /^#[0-9A-Fa-f]{6}$/;
const SAFE_METERED_APP_NAME = /^[a-zA-Z0-9-]{3,63}$/;
const SAFE_METERED_API_KEY = /^[a-zA-Z0-9_-]{16,128}$/;
const SAFE_METERED_SECRET_KEY = /^[a-zA-Z0-9_-]{16,256}$/;
const SAFE_ICE_URL = /^(stun|stuns|turn|turns):[^"'<>\\\s]+$/i;
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
    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map();
    this.hostPeerId = "";
    this.roomId = "";
    this.sweepTimer = null;
  }

  async fetch(request) {
    if (!isWebSocketUpgrade(request)) {
      return json({ ok: false, error: "Expected WebSocket upgrade." }, 426);
    }

    this.pruneSessions(Date.now());

    const url = new URL(request.url);
    const roomId = decodeRoomId(url.pathname);
    const peerId = normalizeToken(url.searchParams.get("peerId"), SAFE_PEER_ID);
    const role = url.searchParams.get("role");
    const mapId = normalizeToken(url.searchParams.get("mapId"), SAFE_MAP_ID);
    const name = normalizeDisplayText(url.searchParams.get("name"), 32);
    const accentColor =
      normalizeToken(url.searchParams.get("accentColor"), SAFE_ACCENT_COLOR) || DEFAULT_ACCENT_COLOR;
    const visibility = url.searchParams.get("visibility") === "public" ? "public" : "private";
    const roomCode = normalizeToken(url.searchParams.get("roomCode"), SAFE_ROOM_CODE);
    const publicSlot = readInteger(url.searchParams.get("publicSlot"), 0, MAX_PUBLIC_ROOMS);
    const mapName = normalizeDisplayText(url.searchParams.get("mapName"), 64);

    if (!roomId || !peerId || (role !== "host" && role !== "guest") || !mapId || !name) {
      return json({ ok: false, error: "Missing or invalid signaling identity." }, 400);
    }

    if (visibility === "public" && role === "host" && (!roomCode || !mapName)) {
      return json({ ok: false, error: "Public rooms require a room code and map name." }, 400);
    }

    this.roomId ||= roomId;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.acceptSession(server, {
      peerId,
      role,
      mapId,
      roomCode,
      publicSlot,
      mapName,
      visibility,
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
    this.queuePublicRoomSync();

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
      if (trackedSession.role === "host" && trackedSession.visibility === "public") {
        this.queuePublicRoomSync();
      }
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
    this.queuePublicRoomSync();
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
    this.queuePublicRoomSync();
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

  queuePublicRoomSync() {
    this.ctx.waitUntil(this.syncPublicRoom(Date.now()).catch(() => undefined));
  }

  async syncPublicRoom(now) {
    if (!this.env.PUBLIC_ROOMS || !this.roomId) {
      return;
    }

    const registry = this.env.PUBLIC_ROOMS.get(
      this.env.PUBLIC_ROOMS.idFromName(PUBLIC_ROOM_REGISTRY_NAME),
    );
    const host = this.findHost();
    if (!host || host.session.visibility !== "public") {
      await registry.fetch("https://registry/delete", {
        method: "POST",
        body: JSON.stringify({ roomId: this.roomId }),
      });
      return;
    }

    await registry.fetch("https://registry/upsert", {
      method: "POST",
      body: JSON.stringify({
        roomId: this.roomId,
        roomCode: host.session.roomCode,
        publicSlot: host.session.publicSlot,
        mapId: host.session.mapId,
        mapName: host.session.mapName,
        hostPeerId: host.session.peerId,
        hostName: host.session.participant.name,
        hostAccentColor: host.session.participant.accentColor,
        participantCount: this.sessions.size,
        maxPeers: MAX_ROOM_PEERS,
        updatedAt: now,
      }),
    });
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

export class PublicRoomsObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.rooms = new Map();
    this.loaded = false;
  }

  async fetch(request) {
    await this.ensureLoaded();

    const url = new URL(request.url);
    const now = Date.now();
    await this.prune(now);

    if (request.method === "GET") {
      const mapId = normalizeToken(url.searchParams.get("mapId"), SAFE_MAP_ID);
      const rooms = [...this.rooms.values()]
        .filter((room) => !mapId || room.mapId === mapId)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      return json(
        {
          ok: true,
          ttlMs: PUBLIC_ROOM_TTL_MS,
          rooms,
        },
        200,
        { "cache-control": "no-store" },
      );
    }

    if (request.method !== "POST") {
      return methodNotAllowed("GET, POST");
    }

    if (url.pathname === "/upsert") {
      return this.handleUpsert(request, now);
    }

    if (url.pathname === "/delete") {
      return this.handleDelete(request);
    }

    return json({ ok: false, error: "Unknown registry operation." }, 404);
  }

  async handleUpsert(request, now) {
    const body = await readBoundedJson(request, MAX_PUBLIC_ROOM_BODY_BYTES);
    const room = sanitizePublicRoom(body);
    if (!room) {
      return json({ ok: false, error: "Invalid public room payload." }, 400);
    }

    const existing = this.rooms.get(room.roomId);
    this.rooms.set(room.roomId, {
      ...room,
      createdAt: existing?.createdAt ?? now,
      updatedAt: Math.max(now, room.updatedAt),
      expiresAt: now + PUBLIC_ROOM_TTL_MS,
    });

    await this.trimAndPersist();
    return json({ ok: true });
  }

  async handleDelete(request) {
    const body = await readBoundedJson(request, MAX_PUBLIC_ROOM_BODY_BYTES);
    const roomId = normalizeToken(body?.roomId, SAFE_ROOM_ID);
    if (!roomId) {
      return json({ ok: false, error: "Invalid public room id." }, 400);
    }

    this.rooms.delete(roomId);
    await this.persist();
    return json({ ok: true });
  }

  async ensureLoaded() {
    if (this.loaded) {
      return;
    }

    const stored = await this.ctx.storage.get("rooms");
    if (Array.isArray(stored)) {
      this.rooms = new Map(
        stored
          .map((room) => sanitizePublicRoom(room, true))
          .filter(Boolean)
          .map((room) => [room.roomId, room]),
      );
    }
    this.loaded = true;
  }

  async prune(now) {
    let changed = false;
    for (const [roomId, room] of this.rooms) {
      if (room.expiresAt <= now) {
        this.rooms.delete(roomId);
        changed = true;
      }
    }

    if (changed) {
      await this.persist();
    }
  }

  async trimAndPersist() {
    if (this.rooms.size > MAX_PUBLIC_ROOMS) {
      this.rooms = new Map(
        [...this.rooms.values()]
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, MAX_PUBLIC_ROOMS)
          .map((room) => [room.roomId, room]),
      );
    }

    await this.persist();
  }

  async persist() {
    await this.ctx.storage.put("rooms", [...this.rooms.values()]);
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
        publicRoomTtlMs: PUBLIC_ROOM_TTL_MS,
      });
    }

    if (url.pathname === "/public-rooms") {
      if (request.method !== "GET") {
        return methodNotAllowed("GET");
      }

      const registry = env.PUBLIC_ROOMS.get(env.PUBLIC_ROOMS.idFromName(PUBLIC_ROOM_REGISTRY_NAME));
      return registry.fetch(request);
    }

    if (url.pathname === "/turn-credentials") {
      if (request.method !== "GET") {
        return methodNotAllowed("GET");
      }

      return handleTurnCredentialsRequest(env);
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

async function handleTurnCredentialsRequest(env) {
  const appName = normalizeToken(env.METERED_APP_NAME, SAFE_METERED_APP_NAME);
  const secretKey = normalizeToken(env.METERED_SECRET_KEY, SAFE_METERED_SECRET_KEY);
  const fallbackApiKey = normalizeToken(env.METERED_TURN_API_KEY, SAFE_METERED_API_KEY);
  const useExpiringCredentials = env.METERED_USE_EXPIRING_CREDENTIALS === "1";
  if (!appName || (!secretKey && !fallbackApiKey)) {
    return json(DEFAULT_ICE_SERVERS, 200, {
      "cache-control": "no-store",
      "x-ice-servers-source": "default-stun",
    });
  }

  if (secretKey && useExpiringCredentials) {
    const credential = await createExpiringMeteredCredential(appName, secretKey);
    if (credential) {
      const iceServers = await fetchMeteredIceServers(appName, credential.apiKey);
      if (iceServers) {
        return json(iceServers, 200, {
          "cache-control": "no-store",
          "x-ice-servers-source": "metered-expiring",
          "x-turn-credential-expires-in": String(credential.expiryInSeconds),
        });
      }
    }
  }

  if (fallbackApiKey) {
    const iceServers = await fetchMeteredIceServers(appName, fallbackApiKey);
    if (iceServers) {
      return json(iceServers, 200, {
        "cache-control": "no-store",
        "x-ice-servers-source": "metered-static-fallback",
      });
    }
  }

  return json({ ok: false, error: "Could not fetch TURN credential ICE servers." }, 502, {
    "cache-control": "no-store",
  });
}

async function createExpiringMeteredCredential(appName, secretKey) {
  const upstreamUrl = new URL(`https://${appName}.metered.live/api/v1/turn/credential`);
  upstreamUrl.searchParams.set("secretKey", secretKey);

  let upstream;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expiryInSeconds: TURN_CREDENTIAL_EXPIRY_SECONDS,
        label: createMeteredCredentialLabel(),
      }),
    });
  } catch {
    return null;
  }

  if (!upstream.ok) {
    return null;
  }

  const raw = await upstream.text();
  if (UTF8.encode(raw).byteLength > MAX_TURN_CREATE_CREDENTIAL_RESPONSE_BYTES) {
    return null;
  }

  const credential = parseJson(raw);
  if (typeof credential !== "object" || credential === null) {
    return null;
  }

  const apiKey = normalizeToken(credential.apiKey, SAFE_METERED_API_KEY);
  if (!apiKey) {
    return null;
  }

  const expiryInSeconds = Number.isInteger(credential.expiryInSeconds)
    ? credential.expiryInSeconds
    : TURN_CREDENTIAL_EXPIRY_SECONDS;

  return {
    apiKey,
    expiryInSeconds,
  };
}

async function fetchMeteredIceServers(appName, apiKey) {
  const upstreamUrl = new URL(`https://${appName}.metered.live/api/v1/turn/credentials`);
  upstreamUrl.searchParams.set("apiKey", apiKey);

  let upstream;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      headers: { accept: "application/json" },
    });
  } catch {
    return null;
  }

  if (!upstream.ok) {
    return null;
  }

  const raw = await upstream.text();
  if (UTF8.encode(raw).byteLength > MAX_TURN_CREDENTIAL_RESPONSE_BYTES) {
    return null;
  }

  const iceServers = sanitizeIceServers(parseJson(raw));
  if (!iceServers) {
    return null;
  }

  return iceServers;
}

function createMeteredCredentialLabel() {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `csmini-${Date.now().toString(36)}-${suffix}`;
}

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

async function readBoundedJson(request, maxBytes) {
  const raw = await request.text();
  if (utf8Bytes(raw) > maxBytes) {
    return null;
  }

  return parseJson(raw);
}

function sanitizePublicRoom(value, stored = false) {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const roomId = normalizeToken(value.roomId, SAFE_ROOM_ID);
  const roomCode = normalizeToken(value.roomCode, SAFE_ROOM_CODE);
  const publicSlot = clampInteger(value.publicSlot, 0, MAX_PUBLIC_ROOMS);
  const mapId = normalizeToken(value.mapId, SAFE_MAP_ID);
  const mapName = normalizeDisplayText(value.mapName, 64);
  const hostPeerId = normalizeToken(value.hostPeerId, SAFE_PEER_ID);
  const hostName = normalizeDisplayText(value.hostName, 32);
  const hostAccentColor =
    normalizeToken(value.hostAccentColor, SAFE_ACCENT_COLOR) || DEFAULT_ACCENT_COLOR;
  const participantCount = clampInteger(value.participantCount, 1, MAX_ROOM_PEERS);
  const maxPeers = clampInteger(value.maxPeers, 1, MAX_ROOM_PEERS);
  const updatedAt = clampTimestamp(value.updatedAt);
  const createdAt = stored ? clampTimestamp(value.createdAt) : 0;
  const expiresAt = stored ? clampTimestamp(value.expiresAt) : 0;

  if (!roomId || !roomCode || !mapId || !mapName || !hostPeerId || !hostName || !updatedAt) {
    return null;
  }

  return {
    roomId,
    roomCode,
    publicSlot,
    mapId,
    mapName,
    hostPeerId,
    hostName,
    hostAccentColor,
    participantCount: Math.min(participantCount, maxPeers),
    maxPeers,
    createdAt,
    updatedAt,
    expiresAt,
  };
}

function clampInteger(value, min, max) {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : min;
}

function readInteger(value, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : min;
}

function clampTimestamp(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
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

  if (utf8Bytes(value.candidate) > MAX_ICE_CANDIDATE_BYTES) {
    return null;
  }

  const candidate = {
    candidate: value.candidate,
  };

  if (value.sdpMid != null) {
    if (typeof value.sdpMid !== "string" || utf8Bytes(value.sdpMid) > MAX_ICE_CANDIDATE_FIELD_BYTES) {
      return null;
    }
    candidate.sdpMid = value.sdpMid;
  }

  if (value.sdpMLineIndex != null) {
    if (!Number.isInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0 || value.sdpMLineIndex > 32) {
      return null;
    }
    candidate.sdpMLineIndex = value.sdpMLineIndex;
  }

  if (value.usernameFragment != null) {
    if (
      typeof value.usernameFragment !== "string" ||
      utf8Bytes(value.usernameFragment) > MAX_ICE_CANDIDATE_FIELD_BYTES
    ) {
      return null;
    }
    candidate.usernameFragment = value.usernameFragment;
  }

  return candidate;
}

function sanitizeIceServers(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  const servers = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const urls = sanitizeIceUrls(entry.urls);
    if (!urls) {
      continue;
    }

    const server = { urls };
    if (typeof entry.username === "string" && entry.username.length <= MAX_ICE_CREDENTIAL_LENGTH) {
      server.username = entry.username;
    }
    if (typeof entry.credential === "string" && entry.credential.length <= MAX_ICE_CREDENTIAL_LENGTH) {
      server.credential = entry.credential;
    }

    servers.push(server);
    if (servers.length >= MAX_ICE_SERVER_COUNT) {
      break;
    }
  }

  return servers.length > 0 ? servers : null;
}

function sanitizeIceUrls(value) {
  if (typeof value === "string") {
    return isSafeIceUrl(value) ? value : null;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const urls = value.filter(isSafeIceUrl).slice(0, MAX_ICE_URLS_PER_SERVER);
  return urls.length > 0 ? urls : null;
}

function isSafeIceUrl(value) {
  return typeof value === "string" && value.length <= MAX_ICE_URL_LENGTH && SAFE_ICE_URL.test(value);
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

function json(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders,
      ...headers,
    },
  });
}
