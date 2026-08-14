# Moving the trainer from Gemini to the OpenAI API

**Status: done.** Gemini was removed entirely and the app now runs on OpenAI.
This file is the record of *why*, and of what was measured rather than assumed.
Prompt-safety design lives in [`PROMPTING.md`](PROMPTING.md).

Researched and implemented 2026-08-10.

### What changed against the plan, once tested with a real key

- **Backend-free is confirmed, not merely permitted.** The *actual* POST to
  `/v1/realtime/client_secrets` from a browser Origin returns
  `access-control-allow-origin: *` and a usable token — the caveat in §2 about
  only having tested the preflight is resolved.
- **Event names were transcribed from a live session**, not taken from docs:
  `conversation.item.input_audio_transcription.delta` / `.completed` for the
  student, `response.output_audio_transcript.delta` / `.done` for the
  interviewee. 14 streaming input deltas arrived during a single utterance.
- **Model ids are now fact, not [indicative]:** `gpt-realtime-2.1`,
  `gpt-realtime-2.1-mini`, `gpt-live-transcribe`, and `gpt-5.6-sol` /
  `-terra` / `-luna`, all confirmed present via `GET /v1/models`. Both choices
  are exposed to the student on the setup screen rather than hardcoded.
- **The bundle shrank from 644 KB to 262 KB** (gzip 151 → 85 KB) because the
  Gemini SDK is gone and nothing replaced it.

## Evidence grading

Not everything here is equally solid. Three tiers, used throughout:

- **[verified]** — I tested it against the live API from this machine on
  2026-08-10 and am reporting the actual response.
- **[docs]** — stated by OpenAI's own documentation.
- **[indicative]** — third-party aggregators and blogs. Directionally useful,
  **must be re-checked against the real API before anyone relies on it.**
  Model IDs and prices especially: pricing sites are frequently stale or wrong.

## 1. Why move at all

Two concrete defects in the current Gemini build drove this.

**The student cannot see their own words as they speak.** Gemini streams
`outputTranscription` while generating the interviewee's audio, but only emits
`inputTranscription` once the student's utterance has ended. It is server-gated;
no client setting changes it. The current app papers over the gap with a
mic-driven "speaking… / transcribing…" placeholder. For a tool whose whole
purpose is teaching people to *notice how they ask things*, not seeing your own
question form is a genuine pedagogical loss, not a cosmetic one.

**Scoring was broken for the instructor's real API key.** Every one of the nine
evaluator calls failed while the voice session worked, pointing at the
`gemini-3.6-flash` scoring model being unreachable for that key. It was never
diagnosed further, because the migration removed it — but it is a fair warning
about depending on a single vendor's model naming.

Neither is fatal on its own. Together they made it worth checking whether the
other vendor does this better. It does.

## 2. The blocking question: can this stay backend-free?

**Yes.** [verified]

This was the thing that could have killed the idea outright. OpenAI's WebRTC
guide says plainly: *"ensure that you only use standard OpenAI API keys on the
server, not in the browser"* [docs], and documents two paths, both with a server
in them — a server that forwards the SDP offer, or a server that mints an
ephemeral token.

That guidance exists to stop a developer leaking **their own** key to **their
users**. This app inverts that relationship: the key belongs to the student, is
typed in by the student, lives in the student's `localStorage`, and is already
in the browser by design. There is no secret to protect from anybody.

So the real constraint is not policy but CORS — will a browser be *allowed* to
make the call. Measured directly, preflighting each endpoint from the deployed
Pages origin:

| Endpoint | Purpose | `Access-Control-Allow-Origin` | `authorization` allowed |
| --- | --- | --- | --- |
| `/v1/realtime/client_secrets` | mint ephemeral token | `*` | yes |
| `/v1/realtime/calls` | WebRTC SDP exchange | `*` | yes |
| `/v1/responses` | scoring calls | `*` | yes |
| `/v1/chat/completions` | scoring calls (alt) | echoes the caller's origin | yes |
| `/v1/models` | model discovery | `*` | yes |

All five permit a cross-origin browser call carrying an `Authorization` header.
The browser can therefore mint its own ephemeral token with the student's key
and complete the handshake itself. **No backend.** [verified]

The table above was measured with `OPTIONS` preflights before a key was
available. It has since been **confirmed with a real POST**: minting an
ephemeral token from a browser Origin returns 200, `access-control-allow-origin: *`
and a working `ek_…` value.

### The remaining caveat

1. **This path is permitted, not blessed.** OpenAI documents the
   server-mediated flow and does not advertise browser-direct use. The CORS
   headers are real and deliberate, but they could be tightened. Constraint 4 in
   `CLAUDE.md` already names the fallback: a **FastAPI** service whose entire job
   is to POST `/v1/realtime/client_secrets` and return the ephemeral token. It
   would never see the student's key and would be roughly twenty lines. Design
   the client so that swapping the token source is a one-function change.

## 3. What the architecture becomes

### Deleted

WebRTC carries the microphone and the speaker natively. The browser handles
capture, encoding, jitter buffering, packet loss, echo cancellation and playback
scheduling — all the work `src/lib/audio.ts` currently does by hand.

- `pcmFloat32ToBase64`, `base64ToFloat32Pcm`, `base64PcmDurationMs` — gone.
- `PcmAudioPlayer`, including the `nextStartTime` gapless scheduling and the
  close-the-AudioContext trick for barge-in — gone; WebRTC handles interruption.
- The `ScriptProcessorNode` capture chain — gone, and with it the deprecated-API
  problem noted in `CLAUDE.md`.

This is a real simplification, in the direction hard constraint 1 asks for.

### Kept — and now used for both sides

`rms()` and the voice-activity gate were kept and generalised into
`createSpeechMeter(stream)`, applied to the microphone *and* the remote track.
Transcript deltas could have supplied rough student timing, but measuring both
sides the same way makes the two numbers directly comparable, and it keeps
`metrics.ts` untouched. Do not go back to `tEnd - tStart` on transcript
entries; that is what produced the 0:00 speaking time and the 0%/100% talk ratio.

### Unchanged

- **The persona system.** Layered disclosure, gated unlocks, hints, retreat,
  `hiddenCore` — all of it is prompt text and is provider-agnostic. This is the
  actual product and it ports untouched.
- **The nine-independent-calls scoring design.** Eight criteria plus one
  qualitative pass, no evaluator seeing another's output. Provider-agnostic.
  Do not collapse it into one call during the migration.
- **Metrics.** Computed locally, as now.

## 4. Component mapping

| Today (Gemini) | Replacement (OpenAI) | Grade |
| --- | --- | --- |
| `ai.live.connect()` WebSocket | WebRTC peer connection, SDP POSTed to `/v1/realtime/calls`; events over the `oai-events` data channel | [docs] |
| API key used directly in browser | ephemeral token from `/v1/realtime/client_secrets`, minted browser-side with the student's key | [verified] CORS; [docs] flow |
| `systemInstruction` | session instructions | [docs] |
| `inputAudioTranscription: {}` | `gpt-live-transcribe`, which *"returns transcript deltas as speech arrives"* | [docs] |
| `outputAudioTranscription: {}` | output transcription on the session | [docs] |
| `prebuiltVoiceConfig.voiceName` (Kore/Puck/Aoede) | OpenAI voice names — **different set, must be re-chosen per persona** | [docs] |
| `generateContent` + `responseSchema` | `/v1/responses` with `text.format` `json_schema`, `strict: true` | [docs] |
| manual `JSON.parse` of the reply | constrained decoding; the model cannot emit schema-violating tokens | [docs] |

### The transcription model is the whole point

`gpt-live-transcribe` streams `conversation.item.input_audio_transcription.delta`
events *during* speech, with a `.completed` event at the end of the turn [docs].
That is exactly the capability Gemini lacks, and the reason this migration is
worth doing at all.

There is also `gpt-transcribe`, which begins only after a committed audio turn
but returns detected-language output [docs]. **Prefer `gpt-live-transcribe`** —
choosing the other one silently reintroduces the defect being fixed.

### Structured outputs are stricter than what we have

`strict: true` uses constrained decoding, so schema-invalid tokens cannot be
produced [docs]. The `JSON.parse` failure branch in `describeScoringError()`
should become unreachable. Keep the branch anyway; unreachable error handling
costs nothing and this claim is the vendor's, not ours.

Note the API shape differs between endpoints: Responses puts the schema under
`text.format`, Chat Completions under `response_format` [docs].

## 5. Models and cost

**Treat every identifier and number in this section as [indicative].** They come
from pricing aggregators, not from OpenAI's own pricing page, and the app should
in any case discover what a given key can reach via `/v1/models` — the same
technique `availableModelHint()` already uses for Gemini.

Realtime (voice):

| Model | Audio in / out per 1M tokens | Effective |
| --- | --- | --- |
| `gpt-realtime-2.1` | $32 / $64 | ~$0.06–0.11 per minute |
| `gpt-realtime-2.1-mini` | $10 / $20 | ~$0.02–0.05 per minute |

A 10-minute interview therefore lands around **$0.60–1.10** flagship or
**$0.20–0.50** mini, before the nine scoring calls. Across a cohort doing
repeat attempts this is the dominant cost, and it falls on whoever's key is
pasted in — currently the student.

Text (scoring): the lineup reportedly moved to a GPT-5.4/5.5/5.6 family, with a
cheap tier around $0.20/$1.20 per 1M tokens. Scoring sends a short transcript
nine times and gets a few sentences back, so this is small next to the audio.
**Do not hardcode a model ID from this document.** Confirm against `/v1/models`.

**Not researched: Gemini's current pricing.** No cost comparison between the two
providers was made, so nothing here says OpenAI is cheaper. If cost per student
matters, price both before committing.

## 6. Open questions before implementation

1. Does a real (non-preflight) browser POST to `/v1/realtime/client_secrets`
   succeed with a student key, and is that use rate-limited or policy-restricted?
2. Exact current model IDs for realtime, transcription and scoring, from
   `/v1/models` with a real key.
3. Which OpenAI voices suit Elena, Tom and Jasmine. Voice materially affects
   whether a persona reads as guarded and weary; this is a casting decision, not
   a config default.
4. Do streaming transcript deltas give timing good enough to retire the RMS
   voice gate, or does the mic measurement stay?
5. Does the layered-disclosure prompting hold up as well under the OpenAI
   realtime model? The gating instructions are tuned against Gemini's behaviour.
   **This is the biggest product risk in the migration** — the personas are the
   product, and a model that leaks Layer 3 too readily, or refuses to leave
   Layer 1, breaks the teaching value even if every technical piece works.
6. Whether to keep a Gemini path as fallback. The decision is **no** — full
   replacement — but note that single-vendor is what produced the current
   scoring outage.

## Sources

- [Realtime with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
- [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [Realtime conversations](https://platform.openai.com/docs/guides/realtime-conversations)
- [Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Introducing Structured Outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/)
- [Realtime API pricing](https://www.layer3labs.io/guides/openai-realtime-api-pricing) [indicative]
- [OpenAI API pricing, Aug 2026](https://www.aipricing.guru/openai-pricing/) [indicative]
- [OpenAI API pricing tables](https://www.morphllm.com/openai-api-pricing) [indicative]

## 7. Backend-plan section 2 checks (verified 2026-08-14, university key)

These are the two mint-time checks that BACKEND-PLAN.md section 2 requires
before the Worker build.

**(a) `instructions` at mint time: YES.**
`POST /v1/realtime/client_secrets` with `session.instructions` set returned
HTTP 200. The response echoed the instructions in the session object, together
with the transcription model (`gpt-live-transcribe`), the turn detection
(`semantic_vad`, `eagerness: "low"`), and the voice. Consequence: the Worker
sets the persona instructions at mint time. The persona text never reaches the
browser, and the client `session.update` instructions payload can be removed.

**(b) A maximum session duration at mint time: NO.**
`session.max_session_duration` returns `unknown_parameter`. The session object
in the mint response contains no duration field. Two partial controls exist:

- `expires_after: {anchor: "created_at", seconds: N}` on the client secret is
  accepted (tested with 840 seconds; the token `expires_at` moved to match).
  This bounds when a token can start a session. It does not stop a session
  that already runs.
- The Realtime API has its own default session ceiling (OpenAI documents about
  60 minutes). We did not hold a session open to measure it.

Consequence: the interview time limit is enforced by the plan's fallback
stack: short token validity at mint (limit plus 2 minutes), the client-side
countdown with a hard stop, and the per-student daily session quota
(`session_grants`). Record from BACKEND-PLAN.md section 5 stands: the quota is
the real backstop.
