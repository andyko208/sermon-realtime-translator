/**
 * Gemini Live session wrapper with state machine
 */
import { GoogleGenAI, Modality, LiveServerMessage, Session, Blob as GenAIBlob, StartSensitivity, EndSensitivity } from "@google/genai";
import { CONFIG } from "../config";
import { buildSystemInstruction } from "./prompt";

export type SessionState = "idle" | "connecting" | "streaming" | "stopping" | "error";

export interface SessionCallbacks {
  onStateChange?: (state: SessionState) => void;
  onInputTranscript?: (text: string, finished?: boolean) => void; // added finished flag
  onOutputTranscript?: (text: string, finished?: boolean) => void;
  onOutputAudio?: (b64: string) => void;
  onInterrupt?: () => void;
  onError?: (err: Error) => void;
}

export class LiveSession {
  private session: Session | null = null;
  private state: SessionState = "idle";
  private ai: GoogleGenAI | null = null;

  constructor(private callbacks: SessionCallbacks) {}

  getState(): SessionState {
    return this.state;
  }

  private setState(state: SessionState): void {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  async connect(token: string, sourceLang: string, targetLang: string): Promise<void> {
    if (this.state !== "idle") return;
    this.setState("connecting");

    try {
      this.ai = new GoogleGenAI({
        apiKey: token,
        httpOptions: { apiVersion: "v1alpha" },
      });

      this.session = await this.ai.live.connect({
        model: CONFIG.MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: buildSystemInstruction(sourceLang, targetLang),
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          // Improved VAD config for better transcription accuracy
          realtimeInputConfig: {
            automaticActivityDetection: {
              startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH, // Catch speech earlier
              endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,         // Wait longer before cutoff
              silenceDurationMs: 1000,  // 1s silence before end-of-speech
              prefixPaddingMs: 300,     // Capture 300ms before detected speech
            },
          },
        },
        callbacks: {
          onopen: () => this.setState("streaming"),
          onmessage: (msg: LiveServerMessage) => this.handleMessage(msg),
          onerror: (e) => {
            this.callbacks.onError?.(new Error(e.message));
            this.setState("error");
          },
          onclose: () => {
            if (this.state === "streaming") this.setState("idle");
          },
        },
      });
    } catch (err) {
      this.callbacks.onError?.(err as Error);
      this.setState("error");
    }
  }

  private handleMessage(msg: LiveServerMessage): void {
    const content = msg.serverContent;
    if (!content) return;

    // Input transcription with finished flag for proper sentence boundary detection
    if (content.inputTranscription?.text) {
      this.callbacks.onInputTranscript?.(
        content.inputTranscription.text,
        content.inputTranscription.finished
      );
    }

    // Output transcription with finished flag
    if (content.outputTranscription?.text) {
      this.callbacks.onOutputTranscript?.(
        content.outputTranscription.text,
        content.outputTranscription.finished
      );
    }

    // Audio output
    const parts = content.modelTurn?.parts;
    if (parts) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          this.callbacks.onOutputAudio?.(part.inlineData.data);
        }
      }
    }

    if (content.interrupted) {
      this.callbacks.onInterrupt?.();
    }
  }

  /** Send PCM16 audio chunk (ArrayBuffer) */
  sendAudio(pcm16: ArrayBuffer): void {
    if (this.state !== "streaming" || !this.session) return;
    const b64 = arrayBufferToBase64(pcm16);
    // Send as base64-encoded audio blob
    const audioBlob: GenAIBlob = { data: b64, mimeType: "audio/pcm;rate=16000" };
    this.session.sendRealtimeInput({ audio: audioBlob });
  }

  disconnect(): void {
    if (this.state === "idle") return;
    this.setState("stopping");
    this.session?.close();
    this.session = null;
    this.ai = null;
    this.setState("idle");
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}


