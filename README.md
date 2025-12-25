# Sermon Real-Time Translator

Real-time sermon translation using Gemini Live API.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy your Gemini API key from `.env` to `.dev.vars`:
```bash
npm run setup
```

Or manually create `.dev.vars`:
```
GEMINI_API_KEY=your-api-key-here
```

## Development

Run both frontend and worker locally:
```bash
npm run dev
```

- Frontend: http://localhost:5173
- Worker API: http://localhost:8787

## Usage

1. Open http://localhost:5173
2. Click "Create Room" to start a speaker session
3. Select source and target languages, then click "Start"
4. Share the audience link with viewers

## Build

```bash
npm run build
```

## Deploy

```bash
npm run deploy
```

