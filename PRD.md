# Product Requirements Document (PRD)
## Real‑Time Sermon Translation (Web, Cloudflare, Gemini Live)

**Version:** 1.1  
**Date:** 2025-12-25  
**Status:** Implementation-ready (lean spec)

---

## 1) What we’re building (scope)

A Cloudflare-hosted web app where a **Speaker** streams microphone audio and the system produces:

- **Original transcription** (speaker language → text)
- **Translated output** (target language → text)
- **Optional translated audio** (target language → live audio stream)

Audience members join a shareable link and receive the **same** translated text/audio in real time.

The app uses **Gemini Live API** over WebSockets (client-to-server) and must **not** expose a long-lived Gemini API key in the browser.

Primary docs: [Live API get started (mic stream)](https://ai.google.dev/gemini-api/docs/live?example=mic-stream#javascript_1), [Ephemeral tokens](https://ai.google.dev/gemini-api/docs/ephemeral-tokens), [Live API guide](https://ai.google.dev/gemini-api/docs/live-guide).

---

## 2) Goals / Non-goals

### Goals
- **Low latency**: target “speak → translation visible” ≤ 2s median.
- **Serverless operations**: Cloudflare Pages for hosting + serverless APIs (Worker/Pages Functions) only.
- **Single speaker → many listeners**: one Live API session (speaker side) feeds all audience clients.
- **Maintainable + modular codebase**: clear boundaries (audio, live session, room broadcast, UI).

### Non-goals (for MVP)
- User accounts, payments, analytics dashboards.
- Storing audio recordings long-term.
- Perfect punctuation/diarization; we accept incremental transcripts.
- Multi-speaker identification (one microphone stream).

---

## 3) Recommended tech stack (optimized for maintainability + low context tokens)

### Frontend (static, modular)
- **Vite + TypeScript** (no heavy UI framework required for MVP)
- **Web Audio API + AudioWorklet** for 16kHz capture and 24kHz playback
- **`@google/genai`** for Live API WebSocket sessions (browser)

Why: minimal moving parts, easy refactors, small surface area for a coding agent, and clean module boundaries.

### Cloudflare (serverless only)
- **Cloudflare Pages**: static hosting
- **Cloudflare Worker (or Pages Functions)**: ephemeral token issuance + room management API
- **Cloudflare Durable Object**: “Room” for fan-out/broadcast to many audience clients via WebSocket

Why: avoids a traditional backend server while still providing real-time broadcast and secret storage.

---

## 4) System architecture (the missing piece in the old PRD)

Without a broadcast layer, an “audience” can’t receive the speaker’s translation. We solve this with a **Room Durable Object**.

### High-level flow

```
Speaker Browser
  - mic (16k PCM) -> Gemini Live API (WebSocket)
  - receives: input transcript, output transcript, output audio
  - publishes: translation events -> Room DO (WebSocket)

Audience Browsers
  - connect to Room DO (WebSocket)
  - receive: translated text + optional audio chunks
```

### Component graph (backend logic)

```
           (secret) GEMINI_API_KEY
                   │
                   ▼
          Token API (Worker/Pages Function)
                   │ ephemeral token
                   ▼
Speaker ── Live API session ──► Speaker publishes events ──► Room DO ──► Audience
```

---

## 5) Core user flows

### Speaker flow (MVP)
- Create a room (returns `roomId` + `speakerKey`)
- Choose target language (and optionally source language for prompt clarity)
- Click **Start** (must be a user gesture for mic + audio context)
- Speak; see original transcript + translated text; optionally monitor translated audio
- Click **Stop** (ends mic + session)
- Share audience link: `/room/{roomId}`

### Audience flow (MVP)
- Open `/room/{roomId}`
- Toggle **Text** and/or **Audio**
- Receive live translated text; audio plays if enabled

---

## 6) Live API integration requirements (Gemini)

### Model + config
- Model: `gemini-2.5-flash-native-audio-preview-12-2025`
- Session config:
  - `responseModalities`: `AUDIO` (we get translated audio)
  - `inputAudioTranscription`: enabled (original speech text)
  - `outputAudioTranscription`: enabled (translated text derived from audio output)
  - `systemInstruction`: “translate from source to target, no commentary”

References: [Live API get started](https://ai.google.dev/gemini-api/docs/live?example=mic-stream#javascript_1), [Live API guide: audio + transcriptions](https://ai.google.dev/gemini-api/docs/live-guide).

### Audio formats (must match)
- **Input**: raw little-endian **16-bit PCM**, **16kHz**, mono  
  - send with `mimeType: "audio/pcm;rate=16000"`
- **Output**: raw little-endian **16-bit PCM**, **24kHz**, mono

### Payload encoding (practical)
- Client sends **base64-encoded PCM16** chunks over the Live session (per the official mic-stream example).
- Live responses deliver audio chunks as base64 too (`inlineData.data`), which we decode for playback.

### Interruptions (VAD)
- If the server signals interruption, **clear any queued playback** and do not keep playing stale audio.

### Session lifetime / reconnect strategy
- Use **ephemeral tokens** for browser access and plan for reconnects.
- Keep session logic as a small state machine (see §9 project structure).

---

## 7) Authentication: ephemeral tokens (required)

Browser code must **not** ship a long-lived Gemini API key. Use ephemeral tokens:

### Token issuance flow (serverless)
1) Speaker browser authenticates to our API (MVP: `speakerKey` per room).
2) Worker/Function requests ephemeral token from Gemini provisioning service.
3) API returns `token.name` to browser.
4) Browser uses `token.name` **as the API key** when calling Live API.

**Important:** Ephemeral tokens are only compatible with Live API and require **API version `v1alpha`**. (Set `httpOptions.apiVersion = "v1alpha"` in the JS client when needed.)

Reference: [Ephemeral tokens](https://ai.google.dev/gemini-api/docs/ephemeral-tokens).

### Minimum constraints (recommended)
When requesting ephemeral tokens, lock them to:
- specific model (`gemini-2.5-flash-native-audio-preview-12-2025`)
- allowed modalities (`AUDIO`)
- transcription flags
- short expiration (≤ 30 minutes)

---

## 8) Room broadcast API + protocol (Cloudflare Durable Object)

### Endpoints (MVP)
- `POST /api/rooms` → `{ roomId, speakerKey }`
- `POST /api/token` (requires `speakerKey`) → `{ token }`
- `GET /room/:roomId` → audience page (static)
- `GET /speaker/:roomId?speakerKey=...` → speaker page (static)
- `WS /api/rooms/:roomId/ws?role={speaker|audience}&key=...`

### Room message protocol (JSON, minimal)

All events carry `seq` (monotonic int) for ordering.

- `in_text`: original transcription update
  - `{ t:"in_text", seq, text, final?: boolean }`
- `out_text`: translated text update
  - `{ t:"out_text", seq, text, final?: boolean }`
- `out_audio`: translated audio chunk (base64 PCM16 @ 24kHz)
  - `{ t:"out_audio", seq, b64, sr:24000 }`
- `interrupt`: stop playback + reset buffers
  - `{ t:"interrupt", seq }`
- `status`: optional UX state (connected, reconnecting, ended)
  - `{ t:"status", seq, level:"info"|"warn"|"error", msg }`

### Broadcast rules
- Speaker publishes `out_*` events to the Room DO.
- Room DO fan-outs to all audience sockets.
- Audience never talks to Gemini (keeps cost and complexity down).

---

## 9) Project architecture (agent-friendly)

Single responsibility modules; avoid cross-import tangles.

```
sermon_realtime_translator/
├── worker/                         # Cloudflare Worker (API + Durable Object)
│   ├── index.ts                    # routes: /api/* and /api/rooms/:id/ws
│   └── roomDO.ts                   # Durable Object: ws fan-out + in-memory room state
└── src/                            # Frontend
    ├── main.ts                     # route -> speaker or audience bootstrap
    ├── config.ts                   # model name, defaults, constants
    ├── room/
    │   ├── protocol.ts             # event types + encode/decode
    │   └── client.ts               # ws client (speaker/audience)
    ├── live/
    │   ├── session.ts              # Gemini Live session wrapper + state machine
    │   └── prompt.ts               # builds systemInstruction from lang choices
    ├── audio/
    │   ├── recorder.ts             # mic -> PCM16 chunks (AudioWorklet)
    │   └── player.ts               # PCM16@24k -> scheduled playback
    └── ui/
        ├── speaker.ts              # binds speaker controls + panels
        └── audience.ts             # binds audience controls + panels
```

Notes:
- If you prefer **Cloudflare Pages Functions**, you can adapt the Worker routing, but keep the DO + WebSocket fan-out logic in one place.
- Keep the backend surface area tiny: room creation + token issuance + ws fan-out.

### State machine (speaker session)
- `idle` → `creating_room` → `getting_token` → `connecting_live` → `streaming` → `stopping` → `idle`
- Any state → `error` (recoverable with “Retry”)

Keep this explicit to avoid “if soup”.

---

## 10) Implementation plan (phased, with validation gates)

### Phase 0 — Scaffold + deploy pipeline
- Create Vite+TS frontend; Cloudflare Worker/Pages Functions skeleton.
- Validate: Cloudflare Pages deploy succeeds; `/api/health` (optional) works.

### Phase 1 — Speaker-only Live API spike (no audience yet)
- Mic capture → Live API → render `inputAudioTranscription` + `outputAudioTranscription`.
- Optionally play translated audio locally.
- Validate:
  - Chrome + Safari (desktop) can start mic + audio after click
  - Translation appears within latency target

### Phase 2 — Add Room DO (text broadcast MVP)
- `POST /api/rooms` creates room; speaker connects to Room WS and publishes `out_text`.
- Audience page connects and renders `out_text`.
- Validate:
  - multiple audience clients stay in sync
  - reconnection restores stream continuity (best-effort)

### Phase 3 — Add translated audio broadcast
- Speaker publishes `out_audio` chunks; audience plays via `audio/player.ts`.
- Validate:
  - no “speaker feedback loop” when speaker uses headphones
  - interruption clears queue correctly

### Phase 4 — Hardening + guardrails
- Rate limiting on token endpoint; speakerKey validation; basic abuse controls.
- Live session reconnect strategy; token refresh; UI status.
- Validate:
  - token endpoint cannot be used without `speakerKey`
  - reconnection after network loss resumes within 5–10s

---

## 11) Acceptance criteria (MVP)

- Speaker can start/stop mic and see both transcripts.
- Audience can join by link and see translated text live.
- If audio enabled: audience hears translated audio with tolerable jitter.
- No long-lived Gemini API key is shipped to browsers (ephemeral tokens only).

---

## 12) Cloudflare deployment checklist (minimal)

### Cloudflare Pages
- Build: `npm run build`
- Output dir: `dist`
- Add secrets:
  - `GEMINI_API_KEY` (server-side only)

### Durable Objects
- Bind DO in Cloudflare config (Pages Functions or Worker) and ensure WebSocket routes resolve to DO.

If deploying the backend as a Worker, the minimal `wrangler.toml` pieces look like:

```toml
durable_objects.bindings = [{ name = "ROOM", class_name = "RoomDO" }]
migrations = [{ tag = "v1", new_classes = ["RoomDO"] }]
```

Reference: [Cloudflare Pages](https://developers.cloudflare.com/pages/), [Pages Functions](https://developers.cloudflare.com/pages/functions/).

---

## 13) References

- Google Gemini Live API: [Get started (mic stream)](https://ai.google.dev/gemini-api/docs/live?example=mic-stream#javascript_1)
- Live API guide (audio, VAD, transcriptions): [Live API guide](https://ai.google.dev/gemini-api/docs/live-guide)
- Secure browser auth: [Ephemeral tokens](https://ai.google.dev/gemini-api/docs/ephemeral-tokens)
- Cloudflare hosting: [Cloudflare Pages](https://developers.cloudflare.com/pages/)
- Cloudflare serverless: [Pages Functions](https://developers.cloudflare.com/pages/functions/)
- JS SDK: [`@google/genai`](https://github.com/googleapis/js-genai)


