# PRD: Concurrent Audio Capture & Playback for Real-Time Translation

## Executive Summary

The Sermon Real-Time Translator application experiences a critical bottleneck where **continuous listening capability is lost during speech synthesis**. This PRD outlines the root causes, architectural changes required, and implementation steps to enable true concurrent microphone capture and audio playback.

---

## Problem Statement

### Current Behavior
When the speaker is talking continuously with minimal pauses, the application:
1. Captures audio and sends to Gemini Live API
2. Detects sentence-ending punctuation (`. ! ? 。 ！ ？`) and forces a "turn" via `audioStreamEnd: true`
3. **During translation synthesis, microphone input is effectively paused or lost**
4. The speaker must wait for playback to complete before new speech is captured

### Impact
- **50-70% of speaker's continuous speech may be missed** during translation playback
- Sermon/lecture translation becomes fragmented and loses context
- User experience is severely degraded for the primary use case (single speaker with continuous speech)

---

## Root Cause Analysis

### 1. Architectural Bottleneck: `audioStreamEnd: true` Breaks Continuity

**File**: [session.ts:131-135](src/live/session.ts#L131-L135)

```typescript
private forceTurn(): void {
  if (this.state === "streaming" && this.session) {
    this.session.sendRealtimeInput({ audioStreamEnd: true });
  }
}
```

**Problem**: The `audioStreamEnd: true` signal tells Gemini that the audio stream has ended. According to Gemini documentation:

> "This should only be sent when automatic activity detection is enabled. The client can **reopen the stream** by sending an audio message."

This means:
- After `audioStreamEnd`, no audio is processed until a new audio message reopens the stream
- Any audio captured during this "closed" period is either lost or causes race conditions
- The stream must be explicitly reopened, creating a gap in continuous listening

### 2. Single-Threaded Event Loop Contention

**Current Flow (Synchronous on Main Thread)**:
```
Main Thread:
  ├─ AudioWorklet.onmessage (receive mic chunks)
  ├─ session.sendAudio() (encode + send to Gemini)
  ├─ session.handleMessage() (process Gemini responses)
  ├─ player.enqueue() (decode + schedule playback)
  └─ roomClient.send() (broadcast to audience)
```

While AudioWorklet runs on a dedicated audio thread, all message handling occurs on the main JavaScript thread. During heavy operations (e.g., base64 encoding large audio chunks, WebSocket operations), the event loop can become congested.

### 3. Turn-Based Architecture vs. Continuous Streaming

The current implementation treats the session as **turn-based**:
1. User speaks → end turn → wait for response → repeat

The Gemini Live API supports **continuous bidirectional streaming**:
1. User speaks continuously
2. Model can respond at any time (based on VAD or explicit signals)
3. If user speaks during model output, `interrupted` flag is sent
4. Both streams run independently

### 4. Sentence Detection Triggers Premature Stream Closure

**File**: [session.ts:96-100](src/live/session.ts#L96-L100)

```typescript
const sentenceCount = (text.match(/[.!?。！？]/g) || []).length;
if (sentenceCount > this.lastSentenceCount) {
  this.lastSentenceCount = sentenceCount;
  this.forceTurn();  // <-- Closes the stream!
}
```

Every detected sentence triggers `audioStreamEnd`, creating multiple stream closures per minute during continuous speech.

---

## Gemini Live API Capabilities (From Documentation)

### Bidirectional Streaming Architecture

The official examples demonstrate **4 concurrent async tasks**:

```python
async with client.aio.live.connect(model=MODEL, config=CONFIG) as session:
    async with asyncio.TaskGroup() as tg:
        tg.create_task(listen_audio())      # Capture mic continuously
        tg.create_task(send_realtime())     # Send to Gemini continuously
        tg.create_task(receive_audio())     # Receive responses
        tg.create_task(play_audio())        # Play responses
```

**Key Insight**: All four tasks run **concurrently** - audio capture NEVER stops.

### Voice Activity Detection (VAD) Handles Turn Management

The Gemini API has built-in VAD that handles turn-taking automatically:

```typescript
realtimeInputConfig: {
  automaticActivityDetection: {
    startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
    endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
    silenceDurationMs: 500,    // Wait 500ms of silence before responding
    prefixPaddingMs: 200,      // Include 200ms before speech detection
  },
},
```

**The API will automatically detect speech boundaries** - manual `audioStreamEnd` is unnecessary for most cases.

### Interruption Handling

When the user speaks during model output:
1. Gemini sends `{ serverContent: { interrupted: true } }`
2. Client should clear the playback queue
3. **Audio input stream remains open and active**

---

## Proposed Solution

### Architecture: True Concurrent Streaming

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        PROPOSED ARCHITECTURE                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐    │
│  │  AudioWorklet │────▶│  Audio Send Queue │────▶│  Gemini Live API │    │
│  │  (Mic Capture)│     │  (Never blocks)   │     │  (Bidirectional) │    │
│  └──────────────┘     └──────────────────┘     └────────┬─────────┘    │
│         ▲                                                │               │
│         │                                                ▼               │
│         │ ALWAYS ACTIVE                    ┌──────────────────┐         │
│         │                                  │  Response Handler │         │
│         │                                  │  (Async)          │         │
│         │                                  └────────┬─────────┘         │
│         │                                           │                    │
│         │              ┌──────────────────┐         │                    │
│         │              │  Interrupt        │◀────────┤                    │
│         │              │  Detection        │         │                    │
│         │              └────────┬─────────┘         │                    │
│         │                       │                    ▼                    │
│         │                       │         ┌──────────────────┐          │
│         │                       └────────▶│  Audio Playback  │          │
│         │                     (clear)     │  Queue           │          │
│         │                                 └──────────────────┘          │
│         │                                          │                     │
│         │                                          ▼                     │
│         │                                 ┌──────────────────┐          │
│         │                                 │  AudioContext    │          │
│         │                                 │  (Speaker)       │          │
│  ┌──────┴──────┐                          └──────────────────┘          │
│  │ MediaStream │                                                         │
│  │ (Microphone)│  ◀──── CONTINUOUS, NEVER STOPS ────────────────────────│
│  └─────────────┘                                                         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Remove Stream-Breaking Behavior

#### Task 1.1: Remove `audioStreamEnd` from Sentence Detection

**File**: [session.ts](src/live/session.ts)

**Current Code (REMOVE)**:
```typescript
private forceTurn(): void {
  if (this.state === "streaming" && this.session) {
    this.session.sendRealtimeInput({ audioStreamEnd: true });
  }
}
```

**Replacement Strategy**:
- Let VAD handle turn detection automatically
- Remove `forceTurn()` method entirely
- Remove `startTurnTimer()` and `stopTurnTimer()`
- Remove sentence counting logic

**Why This Works**: The Gemini Live API's VAD is designed for continuous speech. With `silenceDurationMs: 500`, it will detect natural pauses and generate translations without breaking the stream.

#### Task 1.2: Adjust VAD Configuration for Continuous Speech

**File**: [session.ts](src/live/session.ts)

**Updated Configuration**:
```typescript
realtimeInputConfig: {
  automaticActivityDetection: {
    startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
    endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,  // CHANGED: More patient
    silenceDurationMs: 1000,   // CHANGED: Wait 1 second for natural pauses
    prefixPaddingMs: 300,      // CHANGED: Capture more lead-in
  },
},
```

**Rationale**:
- `END_SENSITIVITY_LOW`: Waits longer for speech to truly end, better for continuous speakers
- `silenceDurationMs: 1000`: Sermons often have 1-second pauses that aren't turn endings
- `prefixPaddingMs: 300`: Captures more context before speech onset

---

### Phase 2: Ensure Continuous Audio Capture

#### Task 2.1: Verify AudioRecorder Never Stops During Playback

**File**: [recorder.ts](src/audio/recorder.ts)

The current implementation is correct - AudioWorklet runs on a dedicated thread. However, verify:

1. The `onChunk` callback is always connected
2. No code path sets `onChunk = undefined` during playback
3. The worklet continues processing even when main thread is busy

**Verification Test**:
```typescript
// Add temporary logging to verify continuous capture
this.worklet.port.onmessage = (e) => {
  console.log(`[RECORDER] Chunk received: ${e.data.byteLength} bytes at ${Date.now()}`);
  this.onChunk?.(e.data);
};
```

#### Task 2.2: Decouple Audio Send from Response Processing

**File**: [session.ts](src/live/session.ts)

**Add Buffering to Prevent Send Blocking**:
```typescript
private audioSendQueue: ArrayBuffer[] = [];
private isSending = false;

sendAudio(pcm16: ArrayBuffer): void {
  if (this.state !== "streaming" || !this.session) return;

  // Queue the audio
  this.audioSendQueue.push(pcm16);

  // Process queue if not already processing
  if (!this.isSending) {
    this.processAudioQueue();
  }
}

private async processAudioQueue(): Promise<void> {
  this.isSending = true;
  while (this.audioSendQueue.length > 0) {
    const pcm16 = this.audioSendQueue.shift()!;
    const b64 = arrayBufferToBase64(pcm16);
    const audioBlob: GenAIBlob = { data: b64, mimeType: "audio/pcm;rate=16000" };
    this.session!.sendRealtimeInput({ audio: audioBlob });
    // Yield to event loop to prevent blocking
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  this.isSending = false;
}
```

---

### Phase 3: Optimize Audio Playback

#### Task 3.1: Non-Blocking Audio Playback Queue

**File**: [player.ts](src/audio/player.ts)

The current implementation is already non-blocking (uses `AudioContext.currentTime` scheduling). Verify:

1. Playback scheduling doesn't block the main thread
2. Queue operations are O(1)
3. No synchronous waits during enqueue

#### Task 3.2: Add Playback State Monitoring

**File**: [player.ts](src/audio/player.ts)

```typescript
export class AudioPlayer {
  // ... existing code ...

  /** Check if audio is currently playing */
  isPlaying(): boolean {
    if (!this.context) return false;
    return this.context.currentTime < this.nextStartTime;
  }

  /** Get queue depth for monitoring */
  getQueueDepth(): number {
    return this.queue.length;
  }
}
```

---

### Phase 4: Implement Proper Interruption Handling

#### Task 4.1: Handle Interruptions Without Stopping Input

**File**: [session.ts](src/live/session.ts)

**Current Code**:
```typescript
if (content.interrupted) {
  this.callbacks.onInterrupt?.();
}
```

**Enhanced Handling**:
```typescript
if (content.interrupted) {
  // Clear playback queue (stop current output)
  this.callbacks.onInterrupt?.();

  // CRITICAL: Do NOT stop or pause the audio input stream
  // The microphone should continue capturing

  // Log for debugging
  console.log('[SESSION] Interrupted by user speech - playback cleared, input continues');
}
```

#### Task 4.2: Update Speaker UI Interrupt Handler

**File**: [speaker.ts](src/ui/speaker.ts)

```typescript
onInterrupt: () => {
  this.player.clear();
  this.roomClient?.send({ t: "interrupt" });
  // NOTE: recorder.onChunk remains connected - no action needed
},
```

---

### Phase 5: WebSocket Broadcast Optimization

#### Task 5.1: Async Fan-Out in RoomDO

**File**: [worker/roomDO.ts](worker/roomDO.ts)

**Current Issue**: Synchronous loop can block on slow clients

**Solution**: Use non-blocking send with error handling
```typescript
private handleSpeakerMessage(event: MessageEvent) {
  const data = event.data;

  // Non-blocking broadcast - don't wait for any socket
  for (const socket of this.audienceSockets) {
    try {
      // Check socket state before sending
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data);
      }
    } catch {
      // Remove dead socket
      this.audienceSockets.delete(socket);
    }
  }
}
```

---

## Testing Plan

### Test 1: Continuous Speech Capture
1. Start translation session
2. Speak continuously for 60 seconds without pauses
3. **Expected**: All speech is captured and translated, no gaps
4. **Verify**: Console logs show continuous chunk timestamps

### Test 2: Concurrent Capture During Playback
1. Start translation session
2. Speak sentence 1 → wait for translation playback
3. While playback is occurring, speak sentence 2
4. **Expected**: Sentence 2 is captured and queued for translation
5. **Verify**: Both sentences appear in transcript

### Test 3: Interruption Behavior
1. Start translation session
2. Speak a long sentence → translation starts playing
3. Interrupt by speaking during playback
4. **Expected**: Playback stops, new speech is captured
5. **Verify**: No audio gaps, smooth transition

### Test 4: High-Volume Continuous Speech
1. Start translation session
2. Read a prepared 5-minute sermon text continuously
3. **Expected**: Full text captured with minimal latency
4. **Measure**: End-to-end latency should be < 3 seconds

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Speech capture rate during playback | ~30% | 100% |
| End-to-end latency (speech → translation) | 2-5 sec | < 2 sec |
| Gaps in continuous speech capture | Frequent | Zero |
| Missed sentences during playback | Common | Zero |

---

## File Change Summary

| File | Changes |
|------|---------|
| [src/live/session.ts](src/live/session.ts) | Remove `forceTurn()`, `startTurnTimer()`, `stopTurnTimer()`, sentence counting; Update VAD config; Add audio queue |
| [src/audio/recorder.ts](src/audio/recorder.ts) | Add verification logging (optional) |
| [src/audio/player.ts](src/audio/player.ts) | Add `isPlaying()` and `getQueueDepth()` methods |
| [src/ui/speaker.ts](src/ui/speaker.ts) | No changes required (already correct) |
| [src/config.ts](src/config.ts) | Remove `TURN_INTERVAL_MS` |
| [worker/roomDO.ts](worker/roomDO.ts) | Optimize broadcast loop |

---

## Risks and Mitigations

### Risk 1: VAD Generates Too Many Short Translations
**Mitigation**: Adjust `silenceDurationMs` higher (1000-2000ms) for sermon context

### Risk 2: High Latency Without Sentence Forcing
**Mitigation**: Monitor latency; if needed, implement "soft hints" instead of stream closure

### Risk 3: Gemini API Rate Limits
**Mitigation**: Audio chunking already batches 4096 samples (~256ms); no additional changes needed

---

## Implementation Order

1. **Phase 1.1**: Remove `audioStreamEnd` usage (immediate impact)
2. **Phase 1.2**: Adjust VAD configuration
3. **Phase 2.2**: Add audio send queue buffering
4. **Phase 4**: Verify interruption handling
5. **Phase 3**: Add playback monitoring (optional, for debugging)
6. **Phase 5**: Optimize WebSocket broadcast (optional, for scale)

---

## References

- [Gemini Live API Documentation](https://ai.google.dev/gemini-api/docs/live)
- [BidiGenerateContentRealtimeInput API Reference](https://ai.google.dev/api/live)
- [Gemini Cookbook - Live Audio Examples](https://github.com/google-gemini/cookbook)
- [Live API Web Console Reference](https://github.com/google-gemini/live-api-web-console)
