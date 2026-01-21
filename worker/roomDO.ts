/**
 * Room Durable Object: manages WebSocket fan-out for speaker -> audience
 */
const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 48 hours
// const ROOM_TTL_MS = 3 * 60 * 1000; // 1 minute

interface Env {
  /**
   * Optional comma-separated allowlist for WebSocket Origin checks.
   * Use "*" to allow all (default).
   */
  ALLOWED_ORIGINS?: string;
}

interface RoomState {
  speakerKey: string | null;
  seq: number;
}

export class RoomDO {
  private state: DurableObjectState;
  private roomState: RoomState = { speakerKey: null, seq: 0 };
  private speakerSocket: WebSocket | null = null;
  private audienceSockets: Set<WebSocket> = new Set();
  private lastLangInfo: string | null = null;
  private allowedOrigins: string[];
  private static readonly MAX_MESSAGE_BYTES = 512 * 1024;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!this.allowedOrigins.length) this.allowedOrigins = ["*"];

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<RoomState>("roomState");
      if (stored) this.roomState = stored;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal init
    if (url.pathname === "/init" && request.method === "POST") {
      const { speakerKey } = await request.json() as { speakerKey: string };
      this.roomState.speakerKey = speakerKey;
      this.roomState.seq = 0;
      await this.state.storage.put("roomState", this.roomState);
      await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return new Response("ok");
    }

    // Internal validate
    if (url.pathname === "/validate" && request.method === "POST") {
      const { speakerKey } = await request.json() as { speakerKey: string };
      const valid = this.roomState.speakerKey === speakerKey;
      return new Response(JSON.stringify({ valid }));
    }

    // Internal status check for room existence and expiry
    if (url.pathname === "/status" && request.method === "GET") {
      const alarm = await this.state.storage.getAlarm();
      return new Response(JSON.stringify({
        exists: this.roomState.speakerKey !== null,
        expiresAt: alarm ?? null,
      }));
    }

    // WebSocket upgrade
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() === "websocket") {
      const origin = request.headers.get("Origin") ?? "";
      if (!this.isOriginAllowed(origin)) {
        return new Response("Forbidden", { status: 403 });
      }

      const role = url.searchParams.get("role");
      const key = url.searchParams.get("key");

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      if (role === "speaker") {
        if (!this.roomState.speakerKey) {
          return new Response("Room not found", { status: 404 });
        }
        if (key !== this.roomState.speakerKey) {
          return new Response("Forbidden", { status: 403 });
        }
        this.speakerSocket?.close(1000, "Replaced by new speaker connection");
        this.speakerSocket = server;
        server.accept();
        server.addEventListener("message", (event: MessageEvent) => this.handleSpeakerMessage(event));
        server.addEventListener("close", () => { this.speakerSocket = null; });
      } else {
        // Audience
        if (!this.roomState.speakerKey) {
          return new Response("Room not found", { status: 404 });
        }
        this.audienceSockets.add(server);
        server.accept();
        if (this.lastLangInfo) server.send(this.lastLangInfo);
        server.addEventListener("message", () => {
          try { server.close(1008, "Audience is read-only"); } catch { /* ignore */ }
        });
        server.addEventListener("close", () => { this.audienceSockets.delete(server); });
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Expected WebSocket", { status: 400 });
  }

  private isOriginAllowed(origin: string): boolean {
    if (this.allowedOrigins.includes("*")) return true;
    return this.allowedOrigins.includes(origin);
  }

  /** Self-destruct handler: closes all sockets and deletes storage */
  async alarm() {
    this.speakerSocket?.close(1000, "Room expired");
    for (const socket of this.audienceSockets) {
      try { socket.close(1000, "Room expired"); } catch { /* ignore */ }
    }
    await this.state.storage.deleteAll();
  }

  /** Broadcast message from speaker to all audience */
  private handleSpeakerMessage(event: MessageEvent) {
    const data = event.data;
    const size =
      typeof data === "string"
        ? new TextEncoder().encode(data).byteLength
        : data instanceof ArrayBuffer
          ? data.byteLength
          : 0;
    if (size > RoomDO.MAX_MESSAGE_BYTES) {
      try { this.speakerSocket?.close(1009, "Message too large"); } catch { /* ignore */ }
      return;
    }
    if (typeof data === "string") {
      try {
        const parsed = JSON.parse(data) as { t?: string };
        if (parsed.t === "lang_info") this.lastLangInfo = data;
      } catch {
        // ignore non-json payloads
      }
    }
    for (const socket of this.audienceSockets) {
      try { socket.send(data); } catch { /* socket closed */ }
    }
  }
}
