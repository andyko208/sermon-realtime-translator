/**
 * PCM16@24kHz playback with queue management
 */
import { CONFIG } from "../config";

export class AudioPlayer {
  private context: AudioContext | null = null;
  private queue: AudioBuffer[] = [];
  private nextStartTime = 0;
  private playing = false;

  start(): void {
    this.context = new AudioContext({ sampleRate: CONFIG.OUTPUT_SAMPLE_RATE });
    this.nextStartTime = 0;
    this.playing = true;
  }

  /** Queue PCM16 base64 chunk for playback */
  enqueue(b64: string): void {
    if (!this.context || !this.playing) return;

    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;

    const buffer = this.context.createBuffer(1, float32.length, CONFIG.OUTPUT_SAMPLE_RATE);
    buffer.copyToChannel(float32, 0);
    this.queue.push(buffer);
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (!this.context || this.queue.length === 0) return;
    const buffer = this.queue.shift()!;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);

    const now = this.context.currentTime;
    const startTime = Math.max(now, this.nextStartTime);
    source.start(startTime);
    this.nextStartTime = startTime + buffer.duration;
  }

  /** Clear queue (on interrupt) */
  clear(): void {
    this.queue = [];
    this.nextStartTime = this.context?.currentTime ?? 0;
  }

  stop(): void {
    this.playing = false;
    this.queue = [];
    this.context?.close();
    this.context = null;
  }
}

