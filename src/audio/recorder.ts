/**
 * Mic capture -> PCM16 chunks at 16kHz using AudioWorklet
 */
import { CONFIG } from "../config";

const WORKLET_CODE = `
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      this.buffer.push(sample);
    }
    // Send chunks of ~4096 samples
    while (this.buffer.length >= 4096) {
      const chunk = this.buffer.splice(0, 4096);
      const pcm16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(chunk[i] * 32767)));
      }
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }
    return true;
  }
}
registerProcessor("recorder-processor", RecorderProcessor);
`;

export class AudioRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  onChunk?: (pcm16: ArrayBuffer) => void;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: CONFIG.INPUT_SAMPLE_RATE, channelCount: 1, echoCancellation: true },
    });
    this.context = new AudioContext({ sampleRate: CONFIG.INPUT_SAMPLE_RATE });

    // Load worklet from blob
    const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    await this.context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const source = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.context, "recorder-processor");
    this.worklet.port.onmessage = (e) => this.onChunk?.(e.data);
    source.connect(this.worklet);
  }

  stop(): void {
    this.worklet?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.context?.close();
    this.worklet = null;
    this.stream = null;
    this.context = null;
  }
}

