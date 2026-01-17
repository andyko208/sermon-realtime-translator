/**
 * Speaker UI controller: mic + Gemini session + room broadcast
 */
import { AudioRecorder } from "../audio/recorder";
import { AudioPlayer } from "../audio/player";
import { LiveSession } from "../live/session";
import { RoomClient } from "../room/client";
import { LANGUAGES, API_BASE } from "../config";
import { bindTranscriptFontSizeControls } from "./fontSizeControls";
import { TranscriptAccumulator } from "./transcript";

interface SpeakerElements {
  sourceLang: HTMLSelectElement;
  targetLang: HTMLSelectElement;
  startBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  statusEl: HTMLElement;
  inputText: HTMLElement;
  outputText: HTMLElement;
  audienceLink: HTMLButtonElement;
  audioToggle: HTMLInputElement;
}

export class SpeakerUI {
  private recorder = new AudioRecorder();
  private player = new AudioPlayer();
  private liveSession: LiveSession | null = null;
  private roomClient: RoomClient | null = null;
  private roomId: string;
  private speakerKey: string;
  private inputTranscript: TranscriptAccumulator;
  private outputTranscript: TranscriptAccumulator;
  private idleAutoStopTimer: number | null = null;
  private lastSpeechAtMs = 0;
  private static readonly AUTO_STOP_AFTER_SILENCE_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private els: SpeakerElements, roomId: string, speakerKey: string) {
    this.roomId = roomId;
    this.speakerKey = speakerKey;
    this.inputTranscript = new TranscriptAccumulator(els.inputText);
    this.outputTranscript = new TranscriptAccumulator(els.outputText);
    bindTranscriptFontSizeControls(els.inputText.closest(".card") as HTMLElement | null);
    this.populateLanguages();
    this.bindEvents();
    this.showAudienceLink();
  }

  private populateLanguages(): void {
    for (const lang of LANGUAGES) {
      this.els.sourceLang.add(new Option(lang.name, lang.code));
      this.els.targetLang.add(new Option(lang.name, lang.code));
    }
    this.els.sourceLang.value = "ko";
    this.els.targetLang.value = "en";
  }

  private bindEvents(): void {
    this.els.startBtn.onclick = () => this.start();
    this.els.stopBtn.onclick = () => this.stop();
  }

  private showAudienceLink(): void {
    const url = `${location.origin}/room/${this.roomId}`;
    this.els.audienceLink.textContent = "Audience Join Here";
    this.els.audienceLink.onclick = () => {
      window.open(url, "_blank", "noopener,noreferrer");
    };
    this.els.audienceLink.style.display = "block";
  }

  private setStatus(msg: string, level: "info" | "warn" | "error" = "info"): void {
    this.els.statusEl.textContent = msg;
    this.els.statusEl.className = `status ${level}`;
  }

  private clearIdleAutoStopTimer(): void {
    if (this.idleAutoStopTimer == null) return;
    window.clearTimeout(this.idleAutoStopTimer);
    this.idleAutoStopTimer = null;
  }

  private markSpeechActivity(): void {
    this.lastSpeechAtMs = Date.now();
    this.armIdleAutoStopTimer();
  }

  private armIdleAutoStopTimer(): void {
    this.clearIdleAutoStopTimer();
    if (this.liveSession?.getState() !== "streaming") return;

    const elapsedMs = Date.now() - this.lastSpeechAtMs;
    const remainingMs = SpeakerUI.AUTO_STOP_AFTER_SILENCE_MS - elapsedMs;

    if (remainingMs <= 0) {
      this.handleIdleAutoStop();
      return;
    }

    this.idleAutoStopTimer = window.setTimeout(() => this.handleIdleAutoStop(), remainingMs);
  }

  private handleIdleAutoStop(): void {
    if (this.liveSession?.getState() !== "streaming") return;
    const msg = "Auto-stopped after 5 minutes of silence";
    this.stop({ statusMsg: msg, statusLevel: "warn", broadcastStatus: true });
  }

  private cleanupStreamingResources(): void {
    this.clearIdleAutoStopTimer();
    this.recorder.stop();
    this.player.stop();
    this.liveSession?.disconnect();
    this.roomClient?.disconnect();
    this.liveSession = null;
    this.roomClient = null;
  }

  private async start(): Promise<void> {
    this.els.startBtn.disabled = true;
    this.setStatus("Getting token...");

    try {
      // Get ephemeral token
      const tokenRes = await fetch(`${API_BASE}/api/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: this.roomId, speakerKey: this.speakerKey }),
      });
      if (!tokenRes.ok) throw new Error("Failed to get token");
      const { token } = await tokenRes.json();

      // Connect to room
      this.setStatus("Connecting to room...");
      this.roomClient = new RoomClient(this.roomId, "speaker", this.speakerKey);
      await this.roomClient.connect();

      // Setup live session
      this.setStatus("Connecting to Gemini...");
      this.liveSession = new LiveSession({
        onStateChange: (state) => {
          if (state === "streaming") {
            this.setStatus("Streaming");
            this.els.stopBtn.disabled = false;
            this.lastSpeechAtMs = Date.now();
            this.armIdleAutoStopTimer();
            // Broadcast language info to audience
            const sourceName = this.els.sourceLang.selectedOptions[0]?.text || this.els.sourceLang.value;
            const targetName = this.els.targetLang.selectedOptions[0]?.text || this.els.targetLang.value;
            this.roomClient?.send({ t: "lang_info", sourceLang: sourceName, targetLang: targetName });
          } else if (state === "error") {
            this.setStatus("Error occurred", "error");
          }
        },
        onInputTranscript: (text, finished) => {
          this.inputTranscript.update(text, finished);
          this.roomClient?.send({ t: "in_text", text, finished });
          if (text.trim()) this.markSpeechActivity();
        },
        onOutputTranscript: (text, finished) => {
          this.outputTranscript.update(text, finished);
          this.roomClient?.send({ t: "out_text", text, finished });
          if (text.trim()) this.markSpeechActivity();
        },
        onOutputAudio: (b64) => {
          if (this.els.audioToggle.checked) {
            this.player.enqueue(b64);
          }
          this.roomClient?.send({ t: "out_audio", b64, sr: 24000 });
        },
        onInterrupt: () => {
          this.player.clear();
          this.roomClient?.send({ t: "interrupt" });
        },
        onError: (err) => this.setStatus(err.message, "error"),
      });

      await this.liveSession.connect(
        token,
        this.els.sourceLang.value,
        this.els.targetLang.value
      );

      // Start audio
      this.player.start();
      this.recorder.onChunk = (pcm16) => this.liveSession?.sendAudio(pcm16);
      await this.recorder.start();
    } catch (err) {
      this.cleanupStreamingResources();
      this.setStatus((err as Error).message, "error");
      this.els.startBtn.disabled = false;
    }
  }

  private stop(opts?: {
    statusMsg?: string;
    statusLevel?: "info" | "warn" | "error";
    broadcastStatus?: boolean;
  }): void {
    this.els.stopBtn.disabled = true;
    if (opts?.broadcastStatus && opts.statusMsg) {
      this.roomClient?.send({ t: "status", level: opts.statusLevel ?? "info", msg: opts.statusMsg });
    }
    this.cleanupStreamingResources();
    this.setStatus(opts?.statusMsg ?? "Stopped", opts?.statusLevel ?? "info");
    this.els.startBtn.disabled = false;
  }
}
