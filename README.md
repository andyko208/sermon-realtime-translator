# Sermon Real-Time Translator

Real-time sermon translation utilizing Google's Gemini Live API, Cloudflare Workers, and Cloudflare Durable Objects.

This open-source project allows a speaker to stream their microphone audio and have it translated to text and synthetic speech in real time. Audience members can connect to the speaker's room via a web browser to view the live transcript and listen to the translated audio.

Live Demo: [https://main.sermon-translator-frontend.pages.dev/](https://main.sermon-translator-frontend.pages.dev/)

---

## Key Features

- **Live AI Translation:** Powered by the `gemini-2.5-flash-native-audio` model to deliver low-latency speech-to-speech and speech-to-text translation.
- **Durable Object Room Fan-out:** Efficient WebSocket broadcasting via Cloudflare Durable Objects to send live transcripts and audio to multiple audience members simultaneously.
- **Secure Ephemeral Auth:** Employs ephemeral tokens generated backend-side to access the Gemini API safely without exposing permanent API keys to the browser.
- **Robust Audio Pipeline:** Low-latency 16kHz microphone capture using a custom inline `AudioWorklet` and scheduled 24kHz PCM16 audio queue playback.
- **Polished UI & Accessibility:**
  - Real-time display of original and translated transcripts.
  - Interactive +/- font size controls for improved readability.
  - Independent audio toggle buttons for the speaker and audience.
  - Automatic display of source/target languages for audience members.
- **Automatic Self-Destruction:** Serverless rooms automatically expire and clean up state after 2 hours via Durable Object alarms.

---

## System Architecture

```mermaid
graph TD
    subgraph Speaker Interface
        Mic[Microphone Input] -->|PCM16 @ 16kHz| Recorder[AudioWorklet Recorder]
        Recorder -->|Audio Chunks| LiveSession[Gemini Live Session]
        LiveSession -->|Translated Audio| LocalPlayer[Audio Player]
    end

    subgraph Serverless Backend
        Worker[Cloudflare Worker] -->|Provision Ephemeral Token| TokenEndpoint[/api/token]
        RoomDO[Durable Object: RoomDO] -->|WebSocket Fan-out| AudienceSockets[Audience Clients]
    end

    subgraph Gemini AI
        LiveSession <-->|WebSocket: Ephemeral Auth| Gemini[Gemini Live API]
    end

    LiveSession -->|Original & Translated Text + Audio| RoomClient[WebSocket Room Client]
    RoomClient -->|Publish Events| RoomDO
    RoomDO -->|Broadcast Text & Audio| Audience[Audience Listeners]
```

### Protocol Events

All WebSocket communications carry a monotonic sequence number (`seq`) for proper message ordering:

| Event Type | Payload | Description |
|---|---|---|
| `lang_info` | `{ sourceLang, targetLang }` | Tells audience the source and target languages. |
| `in_text` | `{ text, final }` | Speaker's original transcription. |
| `out_text` | `{ text, final }` | Live translated transcription. |
| `out_audio` | `{ b64, sr }` | Base64-encoded PCM16 audio chunk. |
| `interrupt` | `null` | Instructs clients to immediately halt playback and clear queues. |
| `status` | `{ level, msg }` | System warning, error, or informational message. |

---

## Repository Directory Structure

```
sermon_realtime_translator/
├── src/                      # Frontend Application (Vite + TypeScript)
│   ├── main.ts              # URL router & entry point
│   ├── config.ts            # Configuration constants & languages
│   ├── audio/               # Mic recorder (16kHz) & audio player (24kHz)
│   ├── live/                # Gemini Live Session wrapper & prompt builders
│   ├── room/                # Room WebSocket client & message protocols
│   └── ui/                  # Speaker, Audience, & Font size UI controllers
├── worker/                   # Backend Application (Cloudflare Worker)
│   ├── index.ts             # API routing (rooms, tokens, health check)
│   └── roomDO.ts            # Durable Object managing WebSocket rooms & expiry
├── index.html               # Main single-page application template
├── wrangler.toml            # Cloudflare Worker configuration
└── package.json             # Build tools & dependencies
```

---

## Setup & Local Development

### Prerequisites

- **Node.js** (v18+) and **npm** installed.
- A **Gemini API Key** (obtainable from [Google AI Studio](https://aistudio.google.com/)).
- A **Cloudflare Account** (for Durable Objects and Pages deployment).

### 1. Installation

Install all project dependencies:
```bash
npm install
```

### 2. Configuration

Create a `.env` file in the root directory and add your Gemini API Key:
```env
GEMINI_API_KEY=your_gemini_api_key_here
```

Generate the `.dev.vars` file required by Wrangler using the setup script:
```bash
npm run setup
```

### 3. Running Locally

To run both the backend Cloudflare Worker and the frontend Vite application concurrently, execute:
```bash
npm run dev
```

Vite is configured to automatically proxy backend API requests to the local Wrangler development server. Once started, you can access the application in your browser at the address shown in your terminal.

---

## Usage Flow

1. Access the application in your web browser.
2. Click **Create Room** on the home screen to spin up a new session. This creates a room and redirects you to the Speaker Dashboard.
3. Select the **Source Language** and **Target Language** for the sermon.
4. Click **Start** to grant microphone permissions and begin streaming.
5. Share the generated **Audience Link** at the bottom of the card with your listeners.
6. Audience members opening the link will view live translations and can optionally toggle translated audio playback.

---

## Supported Languages

The application currently supports translation between any combination of the following languages:

- English (`en`)
- Korean (`ko`)
- Spanish (`es`)
- Chinese (`zh`)
- Japanese (`ja`)
- French (`fr`)
- German (`de`)
- Portuguese (`pt`)

---

## License

This project is licensed under the MIT License.


