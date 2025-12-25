/**
 * Room Durable Object: manages WebSocket fan-out for speaker -> audience
 */
interface RoomState {
  speakerKey: string | null;
  seq: number;
}

export class RoomDO {
  private state: DurableObjectState;
  private roomState: RoomState = { speakerKey: null, seq: 0 };
  private speakerSocket: WebSocket | null = null;
  private audienceSockets: Set<WebSocket> = new Set();

  constructor(state: DurableObjectState) {
    this.state = state;
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
      return new Response("ok");
    }

    // Internal validate
    if (url.pathname === "/validate" && request.method === "POST") {
      const { speakerKey } = await request.json() as { speakerKey: string };
      const valid = this.roomState.speakerKey === speakerKey;
      return new Response(JSON.stringify({ valid }));
    }

    // WebSocket upgrade
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() === "websocket") {
      const role = url.searchParams.get("role");
      const key = url.searchParams.get("key");

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      if (role === "speaker") {
        if (key !== this.roomState.speakerKey) {
          return new Response("Forbidden", { status: 403 });
        }
        this.speakerSocket = server;
        server.accept();
        server.addEventListener("message", (event: MessageEvent) => this.handleSpeakerMessage(event));
        server.addEventListener("close", () => { this.speakerSocket = null; });
      } else {
        // Audience
        this.audienceSockets.add(server);
        server.accept();
        server.addEventListener("close", () => { this.audienceSockets.delete(server); });
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Expected WebSocket", { status: 400 });
  }

  /** Broadcast message from speaker to all audience */
  private handleSpeakerMessage(event: MessageEvent) {
    const data = event.data;
    for (const socket of this.audienceSockets) {
      try { socket.send(data); } catch { /* socket closed */ }
    }
  }
}

