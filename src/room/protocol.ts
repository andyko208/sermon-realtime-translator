/**
 * Room WebSocket protocol types
 */
export type RoomEvent =
  | { t: "in_text"; seq: number; text: string; finished?: boolean }
  | { t: "out_text"; seq: number; text: string; finished?: boolean }
  | { t: "out_audio"; seq: number; b64: string; sr: 24000 }
  | { t: "interrupt"; seq: number }
  | { t: "status"; seq: number; level: "info" | "warn" | "error"; msg: string };

/** Event without seq (used when sending, seq added by client) */
export type RoomEventPayload =
  | { t: "in_text"; text: string; finished?: boolean }
  | { t: "out_text"; text: string; finished?: boolean }
  | { t: "out_audio"; b64: string; sr: 24000 }
  | { t: "interrupt" }
  | { t: "status"; level: "info" | "warn" | "error"; msg: string };

export function encodeEvent(event: RoomEvent): string {
  return JSON.stringify(event);
}

export function decodeEvent(data: string): RoomEvent | null {
  try {
    return JSON.parse(data) as RoomEvent;
  } catch {
    return null;
  }
}

