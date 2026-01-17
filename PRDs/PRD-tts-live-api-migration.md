# PRD: TTS Migration to Gemini Live API (Native Audio Dialog)

## Executive Summary

Migrate the Text-to-Speech (TTS) service from the REST-based `gemini-2.5-flash-preview-tts` model to the WebSocket-based `gemini-2.5-flash-native-audio-dialog` model to resolve rate limiting issues and improve real-time performance for sermon translation.

## Problem Statement

### Current State
The translation pipeline successfully:
1. Captures Korean speech via Gemini Live STT (WebSocket)
2. Detects sentence boundaries and segments text
3. Translates Korean → English via Gemini REST API
4. Synthesizes English audio via `gemini-2.5-flash-preview-tts` REST API

### The Problem
The TTS preview model (`gemini-2.5-flash-preview-tts`) has **restrictive rate limits** that are quickly exhausted during real-world sermon translation:
- Each sentence requires a separate REST API call
- Preview models have lower quotas than production/live models
- Sermons involve continuous speech, generating many TTS requests in quick succession
- Rate limit errors (429) disrupt the translation flow

### Impact
- Translation audio frequently fails mid-sermon
- User experience degradation
- Unreliable for production use cases

## Proposed Solution

Migrate TTS to use the **Gemini Live API** with the `gemini-2.5-flash-native-audio-dialog` model, which:
1. Uses WebSocket connections (like our existing STT)
2. Has more lenient rate limits designed for conversational use
3. Supports streaming audio output
4. Maintains a persistent connection, reducing connection overhead

## Technical Analysis

### Current TTS Architecture

```
┌─────────────────┐     REST POST      ┌──────────────────────────┐
│  GeminiTTSService │ ─────────────────► │  /api/tts (Worker)      │
│  (client-side)   │                    │                          │
│                  │ ◄───────────────── │  generateContent API     │
│  synthesize()    │     JSON + B64     │  gemini-2.5-flash-       │
└─────────────────┘                     │  preview-tts             │
                                        └──────────────────────────┘
```

**Current Flow:**
1. `GeminiTTSService.synthesize()` calls `/api/tts` endpoint
2. Worker backend calls Gemini `generateContent` REST API
3. Returns base64-encoded PCM16 audio
4. Each sentence = 1 REST call = rate limit consumption

**Files Involved:**
- `src/pipeline/tts/gemini-tts.ts` - Client-side TTS service
- `worker/index.ts` - Backend `/api/tts` endpoint
- `src/config.ts` - Model configuration

### Proposed TTS Architecture

```
┌─────────────────────┐     WebSocket      ┌──────────────────────────┐
│  GeminiLiveTTSService │ ◄───────────────► │  Gemini Live API         │
│  (client-side)       │    Bidirectional  │  gemini-2.5-flash-       │
│                      │                    │  native-audio-dialog     │
│  - connect()         │                    └──────────────────────────┘
│  - synthesize()      │
│  - disconnect()      │
└─────────────────────┘
```

**Proposed Flow:**
1. Establish WebSocket connection to Gemini Live API at session start
2. Send text messages for synthesis
3. Receive streaming audio responses
4. Maintain connection throughout session (no per-request overhead)

### Model Comparison

| Aspect | Current (Preview TTS) | Proposed (Native Audio Dialog) |
|--------|----------------------|-------------------------------|
| API Type | REST (generateContent) | WebSocket (Live API) |
| Connection | Per-request | Persistent session |
| Rate Limits | Restrictive (preview) | Lenient (conversational) |
| Latency | Higher (connection overhead) | Lower (persistent conn) |
| Audio Output | Complete response | Streaming chunks |
| Input | Text only | Text + optional audio |

### Reference Implementation

The existing STT service (`src/pipeline/stt/gemini-live-stt.ts`) demonstrates the Live API pattern:

```typescript
// STT uses Live API successfully - same pattern for TTS
export class GeminiLiveSTTService implements STTService {
  private ws: WebSocket | null = null;

  async start(token: string): Promise<void> {
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${token}`;
    this.ws = new WebSocket(url);
    // ... setup handlers
  }

  sendAudio(pcm16: ArrayBuffer): void {
    // Send via WebSocket
  }
}
```

## Implementation Plan

### Phase 1: Create GeminiLiveTTSService

**New File:** `src/pipeline/tts/gemini-live-tts.ts`

```typescript
/**
 * Gemini Live API TTS Service
 *
 * Uses WebSocket connection for text-to-speech synthesis
 * with the gemini-2.5-flash-native-audio-dialog model.
 */

import type { TTSService, TTSRequest, AudioSegment } from "../types";

interface LiveTTSConfig {
  voice: string;
  sampleRate: number;
}

export class GeminiLiveTTSService implements TTSService {
  private ws: WebSocket | null = null;
  private token: string = "";
  private config: LiveTTSConfig;
  private pendingRequests: Map<number, {
    resolve: (segment: AudioSegment) => void;
    reject: (error: Error) => void;
    audioChunks: string[];
    sequenceId: number;
  }> = new Map();
  private requestId = 0;

  constructor(config?: Partial<LiveTTSConfig>) {
    this.config = {
      voice: config?.voice || "Kore",
      sampleRate: config?.sampleRate || 24000,
    };
  }

  /**
   * Connect to Gemini Live API for TTS
   */
  async connect(token: string): Promise<void> {
    this.token = token;

    return new Promise((resolve, reject) => {
      const model = "gemini-2.5-flash-native-audio-dialog";
      const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${token}`;

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        // Send setup message
        this.sendSetup();
        resolve();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onerror = (event) => {
        reject(new Error("WebSocket connection failed"));
      };

      this.ws.onclose = () => {
        this.ws = null;
      };
    });
  }

  /**
   * Send initial setup message
   */
  private sendSetup(): void {
    const setup = {
      setup: {
        model: "models/gemini-2.5-flash-native-audio-dialog",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.config.voice,
              },
            },
          },
        },
        systemInstruction: {
          parts: [{
            text: "You are a text-to-speech service. Read the provided text naturally and clearly. Do not add any commentary or additional text."
          }],
        },
      },
    };

    this.ws?.send(JSON.stringify(setup));
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data);

      // Handle audio data
      if (msg.serverContent?.modelTurn?.parts) {
        for (const part of msg.serverContent.modelTurn.parts) {
          if (part.inlineData?.mimeType?.includes("audio")) {
            // Route to pending request
            this.handleAudioChunk(part.inlineData.data);
          }
        }
      }

      // Handle turn complete
      if (msg.serverContent?.turnComplete) {
        this.handleTurnComplete();
      }
    } catch (err) {
      console.error("[LiveTTS] Failed to parse message:", err);
    }
  }

  /**
   * Handle audio chunk from server
   */
  private handleAudioChunk(b64Audio: string): void {
    // Route to current pending request
    const current = this.pendingRequests.get(this.requestId);
    if (current) {
      current.audioChunks.push(b64Audio);
    }
  }

  /**
   * Handle turn complete signal
   */
  private handleTurnComplete(): void {
    const current = this.pendingRequests.get(this.requestId);
    if (current) {
      // Combine all audio chunks
      const combinedAudio = this.combineAudioChunks(current.audioChunks);

      current.resolve({
        sequenceId: current.sequenceId,
        audioData: combinedAudio,
        durationMs: this.estimateDuration(combinedAudio),
      });

      this.pendingRequests.delete(this.requestId);
    }
  }

  /**
   * Combine base64 audio chunks
   */
  private combineAudioChunks(chunks: string[]): string {
    if (chunks.length === 0) return "";
    if (chunks.length === 1) return chunks[0];

    // Decode, concatenate, re-encode
    const buffers = chunks.map(b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
    const combined = new Uint8Array(totalLength);

    let offset = 0;
    for (const buf of buffers) {
      combined.set(buf, offset);
      offset += buf.length;
    }

    return btoa(String.fromCharCode(...combined));
  }

  /**
   * Estimate audio duration from base64 PCM16 data
   */
  private estimateDuration(b64Audio: string): number {
    if (!b64Audio) return 0;
    const bytes = atob(b64Audio).length;
    const samples = bytes / 2; // PCM16 = 2 bytes per sample
    return (samples / this.config.sampleRate) * 1000;
  }

  /**
   * Synthesize text to audio
   */
  async synthesize(request: TTSRequest): Promise<AudioSegment> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("TTS WebSocket not connected");
    }

    return new Promise((resolve, reject) => {
      this.requestId++;

      this.pendingRequests.set(this.requestId, {
        resolve,
        reject,
        audioChunks: [],
        sequenceId: request.sequenceId,
      });

      // Send text for synthesis
      const message = {
        clientContent: {
          turns: [{
            role: "user",
            parts: [{ text: request.text }],
          }],
          turnComplete: true,
        },
      };

      this.ws!.send(JSON.stringify(message));

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(this.requestId)) {
          this.pendingRequests.delete(this.requestId);
          reject(new Error("TTS synthesis timeout"));
        }
      }, 30000);
    });
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Disconnect from Live API
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.pendingRequests.clear();
  }
}
```

### Phase 2: Update Pipeline Orchestrator

**File:** `src/pipeline/index.ts`

Changes required:
1. Replace `GeminiTTSService` with `GeminiLiveTTSService`
2. Initialize TTS WebSocket connection during `connect()`
3. Disconnect TTS during `disconnect()`

```typescript
// Import new service
import { GeminiLiveTTSService } from "./tts/gemini-live-tts";

export class TranslationPipeline {
  // Change type
  private tts: GeminiLiveTTSService;

  constructor(private callbacks: PipelineCallbacks) {
    // ...
    this.tts = new GeminiLiveTTSService();
    // ...
  }

  async connect(geminiToken: string): Promise<void> {
    // ... existing STT connection ...

    // Add TTS connection
    await this.tts.connect(geminiToken);

    // ...
  }

  disconnect(): void {
    // ... existing cleanup ...

    // Add TTS disconnect
    this.tts.disconnect();

    // ...
  }
}
```

### Phase 3: Update Configuration

**File:** `src/config.ts`

```typescript
export const PIPELINE_CONFIG = {
  ENABLED: true,
  STT: {
    MODEL: "gemini-2.5-flash-native-audio-preview-12-2025",
  },
  TRANSLATION: {
    MODEL: "gemini-2.5-flash",
  },
  TTS: {
    // Updated model
    MODEL: "gemini-2.5-flash-native-audio-dialog",
    VOICE: "Kore",
    USE_LIVE_API: true, // Feature flag for gradual rollout
  },
};
```

### Phase 4: Backend Cleanup (Optional)

The `/api/tts` endpoint in `worker/index.ts` can be:
1. Kept as fallback for non-Live API mode
2. Removed if fully migrating to Live API

Recommend keeping as fallback initially with feature flag.

## Migration Strategy

### Step 1: Feature Flag Implementation
```typescript
// In pipeline/index.ts
if (PIPELINE_CONFIG.TTS.USE_LIVE_API) {
  this.tts = new GeminiLiveTTSService();
} else {
  this.tts = new GeminiTTSService(); // Existing REST-based
}
```

### Step 2: Gradual Rollout
1. Implement `GeminiLiveTTSService` with comprehensive error handling
2. Test with feature flag disabled (existing behavior)
3. Enable for internal testing
4. Monitor rate limits and errors
5. Full rollout

### Step 3: Fallback Handling
```typescript
// If Live API fails, fall back to REST
async synthesize(request: TTSRequest): Promise<AudioSegment> {
  try {
    return await this.liveTTS.synthesize(request);
  } catch (err) {
    console.warn("[TTS] Live API failed, falling back to REST:", err);
    return await this.restTTS.synthesize(request);
  }
}
```

## API Reference

### Gemini Live API WebSocket Protocol

**Connection URL:**
```
wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={API_KEY}
```

**Setup Message:**
```json
{
  "setup": {
    "model": "models/gemini-2.5-flash-native-audio-dialog",
    "generationConfig": {
      "responseModalities": ["AUDIO"],
      "speechConfig": {
        "voiceConfig": {
          "prebuiltVoiceConfig": {
            "voiceName": "Kore"
          }
        }
      }
    }
  }
}
```

**Text Input Message:**
```json
{
  "clientContent": {
    "turns": [{
      "role": "user",
      "parts": [{ "text": "Hello, how are you?" }]
    }],
    "turnComplete": true
  }
}
```

**Audio Response:**
```json
{
  "serverContent": {
    "modelTurn": {
      "parts": [{
        "inlineData": {
          "mimeType": "audio/pcm;rate=24000",
          "data": "base64_encoded_audio..."
        }
      }]
    }
  }
}
```

**Turn Complete:**
```json
{
  "serverContent": {
    "turnComplete": true
  }
}
```

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Live API unavailable | Low | High | Keep REST fallback |
| Different audio format | Medium | Medium | Verify PCM16@24kHz compatibility |
| WebSocket connection drops | Medium | Medium | Implement reconnection logic |
| Higher latency for first request | Low | Low | Pre-warm connection at session start |
| Token expiration mid-session | Medium | Medium | Monitor and refresh token |

## Success Metrics

1. **Rate Limit Errors**: Reduce to <1% of TTS requests
2. **TTS Latency**: Maintain or improve average latency
3. **Session Completion Rate**: >99% of sessions complete without TTS failures
4. **Audio Quality**: No degradation in output quality

## Testing Plan

### Unit Tests
- WebSocket connection establishment
- Message serialization/deserialization
- Audio chunk combining
- Error handling

### Integration Tests
- Full pipeline: STT → Translation → TTS
- Concurrent TTS requests
- Connection recovery
- Mode switching (AUTO/MANUAL)

### Load Tests
- Sustained TTS requests over 30+ minutes
- Multiple concurrent sessions
- Rate limit verification

## Timeline

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| Phase 1: Implementation | 2-3 days | GeminiLiveTTSService |
| Phase 2: Integration | 1 day | Pipeline updates |
| Phase 3: Testing | 2 days | Test coverage |
| Phase 4: Rollout | 1-2 days | Production deployment |

## Appendix

### Existing Files Reference

- `src/pipeline/tts/gemini-tts.ts` - Current REST-based TTS
- `src/pipeline/stt/gemini-live-stt.ts` - Live API pattern reference
- `src/pipeline/index.ts` - Pipeline orchestrator
- `src/pipeline/tts/ordered-queue.ts` - Audio ordering (unchanged)
- `worker/index.ts` - Backend TTS endpoint (fallback)

### Voice Options

Available voices for `gemini-2.5-flash-native-audio-dialog`:
- `Puck` - Upbeat, lively
- `Charon` - Informative, conversational
- `Kore` - Firm, confident (recommended for sermons)
- `Fenrir` - Excitable, energetic
- `Aoede` - Bright, positive
- `Leda` - Youthful, engaging
- `Orus` - Firm, confident
- `Zephyr` - Gentle, soft

### Rate Limits Comparison

| Model | Type | RPM | TPM |
|-------|------|-----|-----|
| gemini-2.5-flash-preview-tts | REST | 10 | 40,000 |
| gemini-2.5-flash-native-audio-dialog | Live | 10 concurrent | 4M+ tokens/day |

Note: Live API limits are per-connection concurrent, not per-minute, making them more suitable for continuous use.
