/**
 * WebSocket client for Room connection (speaker/audience)
 */
import { RoomEvent, RoomEventPayload, encodeEvent, decodeEvent } from "./protocol";
import { API_BASE } from "../config";

type Role = "speaker" | "audience";

export class RoomClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  onEvent?: (event: RoomEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;

  constructor(
    private roomId: string,
    private role: Role,
    private speakerKey?: string
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({ role: this.role });
      if (this.speakerKey) params.set("key", this.speakerKey);
      const wsBase = API_BASE.replace(/^http/, "ws") || `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
      const url = `${wsBase}/api/rooms/${this.roomId}/ws?${params}`;

      this.ws = new WebSocket(url);
      this.ws.onopen = () => { this.onOpen?.(); resolve(); };
      this.ws.onclose = () => this.onClose?.();
      this.ws.onerror = () => reject(new Error("WebSocket connection failed"));
      this.ws.onmessage = (e) => {
        const event = decodeEvent(e.data);
        if (event) this.onEvent?.(event);
      };
    });
  }

  /** Speaker: send event to room for broadcast */
  send(event: RoomEventPayload): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const fullEvent = { ...event, seq: ++this.seq } as RoomEvent;
    this.ws.send(encodeEvent(fullEvent));
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}

