# Eleven Labs TTS Integration Plan

## Problem Summary

The current speech synthesis is broken:
- **AUTO mode**: No audio is synthesized - Gemini Live API returns text but not audio
- **MANUAL mode**: UI shows visual feedback but users cannot hear speech
- **Root cause**: `PIPELINE_CONFIG.TTS.ENABLED = false` in [src/config.ts](src/config.ts) and Gemini models not producing audio output

## Solution

Integrate Eleven Labs TTS API as the primary speech synthesis provider, with Gemini as fallback.

**Why Eleven Labs:**
- Supports `pcm_24000` output format (16-bit PCM @ 24kHz) - exact match for existing `AudioPlayer`
- Streaming API with low latency (~75ms with `eleven_turbo_v2_5` model)
- High-quality, natural-sounding voices
- API key already configured: `ELEVENLABS_API_KEY` in `.env`

---

## Implementation Steps

### Step 1: Add Eleven Labs TTS Endpoint to Worker

**File:** [worker/index.ts](worker/index.ts)

Add new endpoint `/api/tts/elevenlabs`:

```typescript
// Add to Env interface:
ELEVENLABS_API_KEY: string;

// Add endpoint after existing /api/tts:
// POST /api/tts/elevenlabs - synthesize using Eleven Labs
if (path === "/api/tts/elevenlabs" && request.method === "POST") {
  const body = await request.json() as { text: string; voiceId?: string };
  const { text, voiceId = "VR6AewLTigWG4xSOukaG" } = body; // Default: Arnold voice

  if (!text) {
    return json({ error: "Missing text" }, { status: 400, headers: corsHeaders });
  }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000&optimize_streaming_latency=3`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": env.ELEVENLABS_API_KEY,
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    return json({ error: "Eleven Labs TTS failed", details: err }, { status: response.status, headers: corsHeaders });
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const base64 = btoa(String.fromCharCode(...bytes));
  const durationMs = Math.round((arrayBuffer.byteLength / 2 / 24000) * 1000);

  return json({ audio: base64, durationMs }, { headers: corsHeaders });
}
```

### Step 2: Create Eleven Labs TTS Service

**New File:** `src/pipeline/tts/elevenlabs-tts.ts`

```typescript
/**
 * Eleven Labs TTS Service
 * Uses Eleven Labs API for high-quality speech synthesis.
 * Returns base64-encoded PCM16@24kHz audio compatible with AudioPlayer.
 */
import type { TTSService, TTSRequest, AudioSegment } from "../types";
import { API_BASE } from "../../config";

export class ElevenLabsTTSService implements TTSService {
  private voiceId: string;

  constructor(voiceId = "VR6AewLTigWG4xSOukaG") { // Arnold voice
    this.voiceId = voiceId;
  }

  async synthesize(request: TTSRequest): Promise<AudioSegment> {
    const response = await fetch(`${API_BASE}/api/tts/elevenlabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: request.text, voiceId: this.voiceId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Eleven Labs TTS error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as { audio: string; durationMs: number };
    return {
      sequenceId: request.sequenceId,
      audioData: data.audio,
      durationMs: data.durationMs,
    };
  }

  setVoiceId(voiceId: string): void {
    this.voiceId = voiceId;
  }
}
```

### Step 3: Update Configuration

**File:** [src/config.ts](src/config.ts)

```typescript
TTS: {
  /** Enable TTS synthesis */
  ENABLED: true,  // Change from false

  /** TTS Provider: "elevenlabs" | "gemini" */
  PROVIDER: "elevenlabs" as const,

  /** Eleven Labs Configuration */
  ELEVENLABS: {
    VOICE_ID: "VR6AewLTigWG4xSOukaG", // Arnold - male, authoritative
    MODEL_ID: "eleven_turbo_v2_5",     // Fastest model
    OPTIMIZE_LATENCY: 3,               // Max latency optimization
  },

  // Keep existing Gemini config as fallback
  USE_LIVE_API: true,
  LIVE_MODEL: "gemini-2.5-flash-native-audio-dialog",
  REST_MODEL: "gemini-2.5-flash-preview-tts",
  VOICE: "Kore",
  OUTPUT_SAMPLE_RATE: 24000,
},
```

### Step 4: Update Fallback TTS Service

**File:** [src/pipeline/tts/fallback-tts.ts](src/pipeline/tts/fallback-tts.ts)

Add Eleven Labs as primary provider:

```typescript
import { ElevenLabsTTSService } from "./elevenlabs-tts";

export class FallbackTTSService implements LiveTTSService {
  private elevenLabs: ElevenLabsTTSService;
  private liveTTS: GeminiLiveTTSService;
  private restTTS: GeminiTTSService;

  private provider = PIPELINE_CONFIG.TTS.PROVIDER;
  private elevenLabsFailed = false;

  constructor() {
    this.elevenLabs = new ElevenLabsTTSService(
      PIPELINE_CONFIG.TTS.ELEVENLABS?.VOICE_ID
    );
    this.liveTTS = new GeminiLiveTTSService();
    this.restTTS = new GeminiTTSService();
  }

  async synthesize(request: TTSRequest): Promise<AudioSegment> {
    // Try Eleven Labs first if configured
    if (this.provider === "elevenlabs" && !this.elevenLabsFailed) {
      try {
        return await this.elevenLabs.synthesize(request);
      } catch (err) {
        console.warn("[FallbackTTS] Eleven Labs failed, falling back to Gemini:", err);
        this.elevenLabsFailed = true;
      }
    }

    // Fall back to Gemini (existing logic)
    if (this.useLiveAPI && this.liveTTS.isConnected() && !this.liveAPIFailed) {
      // ... existing Gemini Live API logic
    }
    return this.restTTS.synthesize(request);
  }
}
```

### Step 5: Configure Worker Secrets

Run in terminal:
```bash
npx wrangler secret put ELEVENLABS_API_KEY
# Enter: sk_81f4889b7bd94399c56b18d928afd38fc8011ccdf362df34
```

Update `wrangler.toml` to document the new secret (optional):
```toml
# Environment variables set via `wrangler secret put`:
# - GEMINI_API_KEY
# - ELEVENLABS_API_KEY
```

---

## Files to Modify

| File | Change |
|------|--------|
| [worker/index.ts](worker/index.ts) | Add `/api/tts/elevenlabs` endpoint, update Env interface |
| `src/pipeline/tts/elevenlabs-tts.ts` | **NEW** - Eleven Labs TTS service |
| [src/config.ts](src/config.ts) | Enable TTS, add Eleven Labs config |
| [src/pipeline/tts/fallback-tts.ts](src/pipeline/tts/fallback-tts.ts) | Add Eleven Labs as primary provider |

---

## Eleven Labs Voice Options

| Voice ID | Name | Description |
|----------|------|-------------|
| `VR6AewLTigWG4xSOukaG` | **Arnold** | Male, authoritative **(selected)** |
| `21m00Tcm4TlvDq8ikWAM` | Rachel | Clear female, professional |
| `EXAVITQu4vr4xnSDxMaL` | Bella | Soft female, warm tone |
| `ErXwobaYiN019PkySvjV` | Antoni | Male, clear enunciation |

---

## Verification Plan

1. **Unit test the endpoint:**
   ```bash
   curl -X POST http://localhost:8787/api/tts/elevenlabs \
     -H "Content-Type: application/json" \
     -d '{"text": "Hello, this is a test."}'
   ```

2. **Test AUTO mode:**
   - Create a room as speaker
   - Select source/target languages
   - Click Start and speak
   - Verify audio plays automatically after translation

3. **Test MANUAL mode:**
   - Toggle to Manual mode
   - Speak and wait for buffer indicator
   - Click Play button (or press Space)
   - Verify buffered audio plays

4. **Test audience reception:**
   - Open room URL in another browser
   - Enable audio toggle
   - Verify translated audio is received and plays

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Eleven Labs rate limits | Fallback to Gemini TTS automatically |
| Network latency | Use `optimize_streaming_latency=3` and turbo model |
| API cost | Monitor usage; Gemini fallback reduces dependency |
| Audio format mismatch | Verified: `pcm_24000` = 16-bit PCM @ 24kHz (exact match) |
