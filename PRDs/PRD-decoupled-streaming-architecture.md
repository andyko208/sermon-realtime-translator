# PRD: Decoupled Concurrent Streaming Architecture

## Executive Summary

This PRD proposes a fundamental architectural change from the current **coupled speech-to-speech** model (Gemini Live API) to a **decoupled pipeline** architecture that separates Speech-to-Text (STT), Translation, and Text-to-Speech (TTS) into independent concurrent streams. This addresses the critical issue of **lost speaker audio** during translation synthesis.

---

## Problem Statement

### Current Architecture Limitation

The existing implementation uses Google's Gemini Live API (`gemini-2.5-flash-native-audio`) which provides an all-in-one speech-to-speech translation solution. While the API documentation states that input "can be sent continuously without interruption to model generation," the fundamental issue is **turn-taking semantics**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    CURRENT ARCHITECTURE                          │
│                                                                  │
│  Speaker Audio ──► Gemini Live API ──► Translated Audio          │
│       │                  │                    │                  │
│       │           [Turn-based processing]     │                  │
│       │                  │                    │                  │
│       └──────── VAD detects pause ───────────┘                  │
│                          │                                       │
│                  Model generates response                        │
│                          │                                       │
│            ┌─────────────┴─────────────┐                        │
│            │  PROBLEM: New speech      │                        │
│            │  during this window is    │                        │
│            │  queued, not processed    │                        │
│            │  concurrently             │                        │
│            └───────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────┘
```

**Observed Behavior:**
1. VAD detects a pause in speaker's speech
2. Model begins generating translated speech + audio
3. Speaker continues talking during translation playback
4. New speech enters a queue but isn't processed until current turn completes
5. **Result**: Significant portions of continuous speech are delayed or contextually disconnected

**Impact on Use Case:**
- Sermons involve continuous speech with natural breathing pauses
- Brief pauses trigger translation, but speaker continues immediately
- Translation lags behind, creating a growing gap
- Audience receives fragmented, delayed translations

---

## Proposed Solution

### Decoupled Pipeline Architecture

Replace the monolithic Gemini Live API with three independent, concurrent processing streams:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     PROPOSED ARCHITECTURE                                │
│                                                                          │
│  ┌─────────────┐                                                        │
│  │   Speaker   │                                                        │
│  │ Microphone  │                                                        │
│  └──────┬──────┘                                                        │
│         │                                                                │
│         ▼                                                                │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │              STREAM 1: Continuous STT                            │   │
│  │  ┌─────────────────────────────────────────────────────────┐    │   │
│  │  │  Google Cloud Speech-to-Text (Streaming)                │    │   │
│  │  │  - Never stops listening                                 │    │   │
│  │  │  - Emits interim + final transcripts                    │    │   │
│  │  │  - ~200-500ms latency                                   │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  └──────────────────────────┬──────────────────────────────────────┘   │
│                             │                                           │
│                             │ Text chunks (sentences/phrases)           │
│                             ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │              STREAM 2: Async Translation                         │   │
│  │  ┌─────────────────────────────────────────────────────────┐    │   │
│  │  │  Gemini Flash API (Text-to-Text)                        │    │   │
│  │  │  - Parallel translation requests                         │    │   │
│  │  │  - ~300-800ms per sentence                              │    │   │
│  │  │  - Maintains sentence order via sequence IDs            │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  └──────────────────────────┬──────────────────────────────────────┘   │
│                             │                                           │
│                             │ Translated text (ordered)                 │
│                             ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │              STREAM 3: TTS Queue                                 │   │
│  │  ┌─────────────────────────────────────────────────────────┐    │   │
│  │  │  Gemini TTS API (gemini-2.5-flash-preview-tts)          │    │   │
│  │  │  - Synthesizes translated sentences                      │    │   │
│  │  │  - Queues audio for sequential playback                 │    │   │
│  │  │  - ~500-1000ms per sentence                             │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  └──────────────────────────┬──────────────────────────────────────┘   │
│                             │                                           │
│                             ▼                                           │
│                    ┌─────────────────┐                                  │
│                    │  Audio Playback │ ──► Audience                     │
│                    │     Queue       │                                  │
│                    └─────────────────┘                                  │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  KEY BENEFIT: All three streams operate CONCURRENTLY              │  │
│  │  - STT never stops, even during translation/TTS                   │  │
│  │  - Translation can process multiple sentences in parallel         │  │
│  │  - TTS queues ensure ordered playback                             │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Technical Feasibility Assessment

### API Availability

| Component | API Option | Status | Latency | Notes |
|-----------|-----------|--------|---------|-------|
| **STT** | Google Cloud Speech-to-Text v2 | ✅ GA | 200-500ms | Streaming, 120+ languages |
| **STT** | Deepgram | ✅ GA | 100-300ms | Lower latency alternative |
| **STT** | Gemini Audio Input | ✅ GA | 300-600ms | Can use Gemini for transcription |
| **Translation** | Gemini Flash (text) | ✅ GA | 300-800ms | Fast, high quality |
| **Translation** | Google Cloud Translation | ✅ GA | 100-300ms | Lower latency, less context |
| **TTS** | Gemini TTS (`gemini-2.5-flash-preview-tts`) | ✅ Preview | 500-1000ms | High quality, multiple voices |
| **TTS** | Google Cloud TTS | ✅ GA | 200-500ms | More voices, WaveNet quality |
| **TTS** | ElevenLabs | ✅ GA | 300-600ms | Premium voice quality |

### Recommended Stack

**Primary (All-Google):**
- STT: Google Cloud Speech-to-Text v2 (streaming)
- Translation: Gemini 2.5 Flash (text-to-text)
- TTS: Gemini TTS (`gemini-2.5-flash-preview-tts`)

**Alternative (Lower Latency):**
- STT: Deepgram
- Translation: Google Cloud Translation API
- TTS: Google Cloud TTS (Neural2 voices)

---

## Detailed Design

### Component 1: Continuous STT Stream

```typescript
interface STTConfig {
  sampleRate: 16000;
  encoding: 'LINEAR16';
  languageCode: string;
  enableAutomaticPunctuation: true;
  enableWordTimeOffsets: true;
  model: 'latest_long'; // Optimized for long-form speech
}

interface TranscriptSegment {
  sequenceId: number;
  text: string;
  isFinal: boolean;
  confidence: number;
  startTime: number;
  endTime: number;
}
```

**Key Features:**
- Bidirectional streaming connection that never closes during session
- Emits both interim (for display) and final (for translation) transcripts
- Sentence boundary detection for natural chunking
- Automatic reconnection on network issues

### Component 2: Translation Pipeline

```typescript
interface TranslationRequest {
  sequenceId: number;
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  context?: string[]; // Previous sentences for context
}

interface TranslationResponse {
  sequenceId: number;
  translatedText: string;
  processingTimeMs: number;
}
```

**Key Features:**
- Parallel processing with sequence ID ordering
- Context window (last 2-3 sentences) for coherent translation
- Retry logic with exponential backoff
- Rate limiting to prevent API quota exhaustion

### Component 3: TTS Queue System

```typescript
interface TTSRequest {
  sequenceId: number;
  text: string;
  voiceName: string;
  speakingRate?: number;
}

interface AudioSegment {
  sequenceId: number;
  audioData: ArrayBuffer; // PCM16 @ 24kHz
  durationMs: number;
}

class TTSQueue {
  private queue: Map<number, AudioSegment>;
  private nextPlaySequence: number;
  private isPlaying: boolean;

  enqueue(segment: AudioSegment): void;
  private playNext(): void;
  getBufferDepth(): number;
}
```

**Key Features:**
- Ordered playback despite out-of-order synthesis completion
- Buffer management to handle variable synthesis times
- Gapless audio playback with precise scheduling
- Support for playback speed adjustment

---

## Data Flow Sequence

```
Time →
─────────────────────────────────────────────────────────────────────────

Speaker:     "The Lord is my shepherd..."
                │
STT:          [streaming...] ──► "The Lord is my shepherd"
                                        │
Translation:                           [translating...] ──► "주님은 나의 목자시니"
                                                                  │
TTS:                                                           [synthesizing...]
                                                                      │
Playback:                                                          [queued...]

Speaker:     "...I shall not want."
                │
STT:          [streaming...] ──► "I shall not want"
                                        │
Translation:                           [translating...] ──► "내게 부족함이 없으리로다"
                                                                  │
TTS:                                                           [synthesizing...]
                                                                      │
Playback:  ◄─────── "주님은 나의 목자시니" ────────── [playing] ◄──── [queued...]

─────────────────────────────────────────────────────────────────────────
KEY: STT continues during ALL other operations - no audio is lost
```

---

## Latency Analysis

### Current Architecture (Gemini Live API)
| Stage | Latency |
|-------|---------|
| VAD Detection | ~1000ms (configured silence duration) |
| Processing + Synthesis | ~2000-4000ms |
| **Total** | **~3000-5000ms** |

### Proposed Architecture (Decoupled)
| Stage | Latency | Parallelization |
|-------|---------|-----------------|
| STT | ~300ms | Continuous |
| Translation | ~500ms | Parallel |
| TTS | ~700ms | Parallel |
| **Total (sequential)** | ~1500ms | - |
| **Total (pipelined)** | **~300ms per sentence*** | Highly parallel |

*After initial pipeline fill, each sentence appears ~300ms after the previous, regardless of individual processing times.

---

## Architecture Comparison

| Aspect | Current (Gemini Live) | Proposed (Decoupled) |
|--------|----------------------|---------------------|
| **Audio Loss** | Yes, during synthesis | No, STT always active |
| **Latency** | 3-5 seconds | 1-2 seconds (pipelined) |
| **Parallelism** | Single stream | Triple concurrent streams |
| **API Calls** | 1 WebSocket | 3 separate services |
| **Complexity** | Low | Medium-High |
| **Cost** | Single API | Multiple APIs |
| **Voice Quality** | Native Gemini | Configurable (Gemini TTS) |
| **Transcript Accuracy** | Good | Potentially better (dedicated STT) |
| **Failure Isolation** | All-or-nothing | Component-level fallback |

---

## Implementation Plan

### Phase 1: STT Integration (Week 1)
1. Integrate Google Cloud Speech-to-Text v2 streaming API
2. Implement sentence boundary detection
3. Create transcript event emitter
4. Parallel display: show interim transcripts in UI

### Phase 2: Translation Pipeline (Week 1-2)
1. Implement translation request queue with sequence IDs
2. Add Gemini Flash text translation
3. Implement context windowing for coherent translation
4. Add parallel processing with ordering guarantee

### Phase 3: TTS Queue System (Week 2)
1. Integrate Gemini TTS API
2. Implement ordered playback queue
3. Add buffer management and monitoring
4. Implement gapless audio scheduling

### Phase 4: Integration & Testing (Week 3)
1. Wire all components together
2. Implement graceful degradation (fallback to current system)
3. Performance testing with various speech patterns
4. Latency optimization

### Phase 5: Production Hardening (Week 3-4)
1. Error handling and retry logic
2. Monitoring and metrics
3. Cost optimization (batching, caching)
4. A/B testing framework

---

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Higher API costs | Medium | High | Implement caching, optimize chunk sizes |
| Increased complexity | Medium | High | Modular design, comprehensive testing |
| TTS voice quality variance | Low | Medium | Allow voice selection, fallback options |
| Ordering issues | High | Low | Robust sequence ID system, testing |
| Network latency spikes | Medium | Medium | Buffering, graceful degradation |
| API rate limits | High | Medium | Rate limiting, quota monitoring |

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Audio loss rate | ~15-25% | <2% |
| End-to-end latency | 3-5s | <2s |
| Transcript accuracy | ~85% | >90% |
| Translation quality | Good | Good or better |
| System uptime | N/A | >99.5% |

---

## Cost Estimation

### Per Hour of Sermon (approximate)

| Service | Usage | Cost |
|---------|-------|------|
| Google Cloud STT | ~60 min audio | ~$1.44 |
| Gemini Flash (translation) | ~10K tokens | ~$0.01 |
| Gemini TTS | ~10K characters | ~$0.15 |
| **Total per hour** | - | **~$1.60** |

*Compared to current Gemini Live API: ~$0.50-1.00/hour but with audio loss issues*

---

## Alternative Approaches Considered

### Option A: Tune Gemini Live API VAD Settings
- **Pros**: No architecture change
- **Cons**: Fundamental turn-taking limitation remains; cannot eliminate audio loss entirely
- **Verdict**: Rejected - doesn't solve root cause

### Option B: Dual Gemini Live Sessions
- **Pros**: Redundancy, potentially capture missed audio
- **Cons**: Complex synchronization, double cost, still turn-based
- **Verdict**: Rejected - over-engineered without solving core issue

### Option C: Decoupled Architecture (This Proposal)
- **Pros**: Solves root cause, better latency, component flexibility
- **Cons**: Higher complexity, more API integrations
- **Verdict**: Recommended - addresses fundamental limitation

---

## Conclusion

The decoupled architecture is **technically feasible** and **recommended** for solving the audio loss problem. The key insight is that the current Gemini Live API's turn-taking semantics are fundamentally incompatible with continuous speech translation where the speaker never truly "stops."

By separating STT, Translation, and TTS into independent streams:
1. **STT runs continuously** - no audio is ever lost
2. **Translation processes in parallel** - multiple sentences can be translated simultaneously
3. **TTS queues ensure order** - playback remains coherent despite async processing

The trade-offs (increased complexity, multiple API integrations, slightly higher cost) are justified by the significant improvement in translation completeness and reduced latency.

---

## Appendix: API References

- [Google Cloud Speech-to-Text v2](https://cloud.google.com/speech-to-text/v2/docs)
- [Gemini API - Text Generation](https://ai.google.dev/gemini-api/docs)
- [Gemini TTS API](https://ai.google.dev/gemini-api/docs/speech-generation)
- [Google Cloud Text-to-Speech](https://cloud.google.com/text-to-speech/docs)
