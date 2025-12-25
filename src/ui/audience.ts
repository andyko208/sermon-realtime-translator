/**
 * Audience UI controller: receives translated text + audio
 */
import { AudioPlayer } from "../audio/player";
import { RoomClient } from "../room/client";
import { RoomEvent } from "../room/protocol";
import { TranscriptAccumulator } from "./transcript";

interface AudienceElements {
  statusEl: HTMLElement;
  inputText: HTMLElement;
  outputText: HTMLElement;
  audioToggle: HTMLInputElement;
}

export class AudienceUI {
  private roomClient: RoomClient;
  private player = new AudioPlayer();
  private audioEnabled = false;
  private inputTranscript: TranscriptAccumulator;
  private outputTranscript: TranscriptAccumulator;

  constructor(private els: AudienceElements, roomId: string) {
    this.roomClient = new RoomClient(roomId, "audience");
    this.inputTranscript = new TranscriptAccumulator(els.inputText);
    this.outputTranscript = new TranscriptAccumulator(els.outputText);
    this.bindEvents();
    this.connect();
  }

  private bindEvents(): void {
    this.els.audioToggle.onchange = () => {
      this.audioEnabled = this.els.audioToggle.checked;
      if (this.audioEnabled) this.player.start();
      else this.player.stop();
    };
  }

  private async connect(): Promise<void> {
    this.setStatus("Connecting...");
    this.roomClient.onOpen = () => this.setStatus("Connected");
    this.roomClient.onClose = () => this.setStatus("Disconnected", "warn");
    this.roomClient.onEvent = (event) => this.handleEvent(event);

    try {
      await this.roomClient.connect();
    } catch {
      this.setStatus("Connection failed", "error");
    }
  }

  private handleEvent(event: RoomEvent): void {
    switch (event.t) {
      case "in_text":
        this.inputTranscript.update(event.text, event.finished);
        break;
      case "out_text":
        this.outputTranscript.update(event.text, event.finished);
        break;
      case "out_audio":
        if (this.audioEnabled) this.player.enqueue(event.b64);
        break;
      case "interrupt":
        this.player.clear();
        break;
      case "status":
        this.setStatus(event.msg, event.level);
        break;
    }
  }

  private setStatus(msg: string, level: "info" | "warn" | "error" = "info"): void {
    this.els.statusEl.textContent = msg;
    this.els.statusEl.className = `status ${level}`;
  }
}

