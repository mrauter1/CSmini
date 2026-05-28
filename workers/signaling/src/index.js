import { DurableObject } from "cloudflare:workers";

const MAX_ROOM_PEERS = 14;
const CLOSE_POLICY = 1008;
const RELAY_TYPES = new Set(["offer", "answer", "ice-candidate"]);
const SAFE_ROOM_ID = /^[a-zA-Z0-9:._-]{3,96}$/;
const SAFE_PEER_ID = /^[a-zA-Z0-9:._-]{3,96}$/;

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
  }

  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return json({ ok: false, error: "Expected WebSocket upgrade." }, 426);
    }

    const url = new URL(request.url);
    const peerId = normalizeToken(url.searchParams.get("peerId"), SAFE_PEER_ID);
    const role = url.searchParams.get("role");
    const mapId = normalizeText(url.searchParams.get("mapId"), 64);
    const name = normalizeText(url.searchParams.get("name"), 32);
    const accentColor = normalizeText(url.searchParams.get("accentColor"), 16);

    if (!peerId || (role !== "host" && role !== "guest") || !mapId || !name) {
      return json({ ok: false, error: "Missing or invalid signaling identity." }, 400);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const accepted = this.acceptSession(server, {
      peerId,
      role,
      mapId,
      participant: {
        id: peerId,
        name,
        accentColor: accentColor || "#CFA66F",
      },
    });

    if (!accepted) {
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  acceptSession(socket, session) {
    socket.accept();

    if (this.sessions.size >= MAX_ROOM_PEERS) {
      send(socket, {
        type: "room-error",
        reason: "room-full",
        detail: `This signaling room is limited to ${MAX_ROOM_PEERS} peers.`,
      });
      socket.close(CLOSE_POLICY, "room-full");
      return false;
    }

    if (this.findByPeerId(session.peerId)) {
      send(socket, {
        type: "room-error",
        reason: "duplicate-id",
        detail: "A peer with this id is already connected to the room.",
      });
      socket.close(CLOSE_POLICY, "duplicate-id");
      return false;
    }

    const existingHost = this.findHost();
    if (session.role === "host" && existingHost) {
      send(socket, {
        type: "room-error",
        reason: "host-busy",
        detail: "This room already has a host.",
      });
      socket.close(CLOSE_POLICY, "host-busy");
      return false;
    }

    this.sessions.set(socket, {
      ...session,
      joinedAt: Date.now(),
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

    return true;
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

    const message = parseJson(raw);
    if (!message || typeof message.type !== "string") {
      send(socket, {
        type: "room-error",
        reason: "invalid-message",
        detail: "Signaling message must be valid JSON with a type.",
      });
      return;
    }

    if (message.type === "ping") {
      send(socket, {
        type: "pong",
        serverTime: Date.now(),
      });
      return;
    }

    if (!RELAY_TYPES.has(message.type)) {
      send(socket, {
        type: "room-error",
        reason: "unsupported-message",
        detail: `Unsupported signaling message: ${message.type}`,
      });
      return;
    }

    const targetPeerId = normalizeToken(message.toPeerId, SAFE_PEER_ID);
    const target = targetPeerId ? this.findByPeerId(targetPeerId) : undefined;
    if (!target) {
      send(socket, {
        type: "room-error",
        reason: "peer-not-found",
        detail: "Target peer is not connected to this room.",
      });
      return;
    }

    send(target.socket, {
      type: message.type,
      fromPeerId: session.peerId,
      toPeerId: target.session.peerId,
      participant: session.participant,
      description: message.description,
      candidate: message.candidate,
      sentAt: Date.now(),
    });
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
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "csmini-signaling",
        maxPeersPerRoom: MAX_ROOM_PEERS,
      });
    }

    const roomId = decodeRoomId(url.pathname);
    if (!roomId) {
      return json({ ok: false, error: "Use /room/:roomId for WebSocket signaling." }, 404);
    }

    const id = env.ROOMS.idFromName(roomId);
    return env.ROOMS.get(id).fetch(request);
  },
};

function decodeRoomId(pathname) {
  const prefix = "/room/";
  if (!pathname.startsWith(prefix)) {
    return "";
  }

  const roomId = decodeURIComponent(pathname.slice(prefix.length));
  return normalizeToken(roomId, SAFE_ROOM_ID);
}

function normalizeToken(value, pattern) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  return pattern.test(trimmed) ? trimmed : "";
}

function normalizeText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function parseJson(raw) {
  if (typeof raw !== "string") {
    return null;
  }

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
    socket.close(1011, "send-failed");
  }
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: corsHeaders,
  });
}
