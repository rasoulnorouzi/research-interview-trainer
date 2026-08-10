# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Research Interview Trainer

A teaching tool for a university instructor: students practise qualitative
research interviewing by holding a **spoken** interview with an AI-simulated
interviewee, then receive a scored report on their interviewing technique.

The folder name (`nurse-exit-research-interview`) is historical. The app is no
longer nurse-specific — it ships three personas and supports custom ones.

## Current state

Rewritten from scratch (2026-08-10) out of a Google AI Studio scaffold. The
original had an Express + WebSocket backend, Tailwind/motion/lucide, an email
exporter, a "fact injector", a text-question mode, and **no scoring at all**.
All of that is gone.

**Migrated from Gemini to OpenAI (2026-08-10).** Gemini is entirely gone. The
reasoning and the verified API findings are in
[`OPENAI-MIGRATION.md`](OPENAI-MIGRATION.md); the prompt-safety design is in
[`PROMPTING.md`](PROMPTING.md) — **read that before editing any persona or
evaluator prompt**, several lines that look like boilerplate are load-bearing.

## Architecture

**Pure client-side React + Vite. There is no backend and no build step beyond
Vite.** The browser talks to the OpenAI API directly with a user-supplied API
key. **Two dependencies total: `react`, `react-dom`** — there is no OpenAI SDK.
WebRTC is native to the browser and scoring is one `fetch`, so every network
call is plain visible HTTP.

```
src/
  main.tsx                    React root — NO StrictMode (see gotchas)
  App.tsx                     Phase machine: "setup" | "interview" | "results"
  types.ts                    All shared types
  personas.ts                 3 layered personas + buildCustomPersona()
  index.css                   The entire stylesheet, plain CSS
  models.ts                   The two user-selectable model lists
  lib/
    audio.ts                  createSpeechMeter() — voiced-time measurement only
    liveSession.ts            InterviewSession class — WebRTC + transcript/timing
    metrics.ts                computeMetrics() and formatters, pure functions
    scoring.ts                Rubric definitions + independent evaluator calls
  screens/
    SetupScreen.tsx           API key, persona choice, custom persona
    InterviewScreen.tsx       Live transcript, mute, end
    ResultsScreen.tsx         Metrics, rubric, feedback, transcript, export
```

No router (three screens, one state variable). No state library. No test suite.

Models are **chosen by the student on the setup screen** and listed in
`src/models.ts`: `gpt-realtime-2.1-mini` / `gpt-realtime-2.1` for the voice
session, and `gpt-5.6-terra` / `-sol` / `-luna` for scoring. Input transcription
is pinned to `gpt-live-transcribe` in `liveSession.ts` — see the voice-only
constraint for why that one is not negotiable.

The report "export" is a client-side Markdown download: `buildMarkdownReport()`
in `ResultsScreen.tsx` renders metrics + rubric + feedback + full transcript
into a `Blob` saved as `interview-report-<date>.md`. No email, no server.

## Audio

**WebRTC carries the audio; the app does not touch samples.** Capture,
encoding, jitter buffering, echo cancellation, playback and barge-in are all
handled by the browser. The hand-rolled PCM codec, the gapless player and the
deprecated `ScriptProcessorNode` chain the Gemini build needed are gone.

What remains in `audio.ts` is measurement: `createSpeechMeter(stream)` runs an
`AnalyserNode` energy gate and is applied to **both** the local mic and the
remote track, so the two speaking times are directly comparable.

One trap: the remote stream must also be attached to an `<audio>` element or
Chrome delivers no samples to the Web Audio graph and the meter silently reads
zero. `liveSession.ts` attaches it in `ontrack` for exactly this reason.

## Hard design constraints (from the instructor — do not drift)

1. **Genuinely simple.** Resist adding files, dependencies, abstraction layers,
   or features. If something can be deleted, delete it.
2. **Plain scientific/academic visual design. No "AI slop."** No gradients, no
   glassmorphism, no purple, no drop shadows, no animation, no icon libraries,
   no emoji decoration. White background, serif headings (Georgia), system sans
   body, one muted accent (`--accent: #1a4a8a`), 1px `#c8c8c8` borders, ≤3px
   radii. It should look like a research instrument, not a SaaS landing page.
3. **Voice only.** No text-question fallback. The student speaks; the
   interviewee speaks back.
   The student's words stream as they speak, via `gpt-live-transcribe` and
   `conversation.item.input_audio_transcription.delta`. **Do not swap that
   transcription model for `gpt-transcribe`**, which only transcribes after a
   committed turn — that is the exact Gemini limitation this migration removed.
4. **If a backend ever becomes necessary, it must be FastAPI + Python** — not
   Node, not Express. None is necessary today: the browser mints its own
   ephemeral token at `/v1/realtime/client_secrets` with the student's key, and
   that endpoint returns `access-control-allow-origin: *` (verified against the
   live API, 2026-08-10). If OpenAI ever closes that path, FastAPI's entire job
   is minting the token — it would never see the student's key. See
   [`OPENAI-MIGRATION.md`](OPENAI-MIGRATION.md) §2.
5. **Audio quality and latency matter.** Going through the browser directly
   (rather than relaying via a server) is deliberate.

## The persona system — the heart of the product

Personas are **layered with gated disclosure**. This is not decoration; it is
what makes the scoring meaningful. A flat pile of biographical facts would let
a lazy interviewer extract everything, leaving nothing to measure.

Each persona in `personas.ts` has:

- **Layer 1 — the rehearsed account.** Given freely to anyone. True but not the
  real reason. Explicitly marked as "safe ground" the persona will happily stay
  on forever if never pushed.
- **Layer 2 — the personal cost.** Unlocks when the student asks about *them*
  rather than about circumstances.
- **Layer 3 — the real reason.** Four unlock conditions that must **all** hold:
  reached Layer 2 and stayed with it; followed up on the interviewee's own
  words; no judging/advising/leading; asked something adjacent to the material.
- **Hints**: at most one per turn at the edge of an unopened layer. Followed up
  → the layer opens. Ignored → dropped permanently.
- **Retreat**: judgmental, rushed, or leading questioning closes a layer.
- **A thing they resist**: an interpretation that, offered too early, costs the
  interviewer ground (Elena refuses the systemic reading as an excuse; Tom
  refuses "you were burnt out, not your fault"; Jasmine refuses being framed as
  fragile).
- **`hiddenCore`**: a ~150-word ground-truth summary of the layers, used *only*
  by the scoring evaluators (see below). Custom personas have none, and scoring
  degrades gracefully.

The prompts explicitly instruct the model that ending an interview without
revealing Layer 3 is normal, and that a bad interviewer must not be rewarded
with the truth.

**Elena van Dijk's Layer 1 and 2 content is the instructor's original material
— preserve it.** Layer 3 (the concealed medication error) was added in the
rewrite.

Voices: Elena `marin`, Tom `cedar`, Jasmine `coral`, custom `alloy` — `marin`
and `cedar` are OpenAI's most natural realtime voices and go to the two
personas that must not sound performed. Delivery is directed per persona and
tied to the disclosure state (rules 16-18 of the shared mechanics), so retreat
is *audible*. See [`PROMPTING.md`](PROMPTING.md).

When editing personas: keep the three-layer structure, keep unlock conditions
explicit and behavioural, keep answers capped at four spoken sentences, and
keep `shortBio` on the setup screen **spoiler-free** — students must not see
what they are supposed to discover.

## Scoring — independent evaluators, deliberately

The instructor specifically requires that rubric scoring be free of anchoring
bias. Therefore:

- **Eight criteria, eight separate `/v1/responses` calls.** Each evaluator is
  a fresh context that sees the transcript and *one* criterion definition with
  its 1/3/5 anchors — never the other criteria, never another score, never the
  persona's system instruction.
- A **ninth independent call** writes the qualitative feedback and never sees
  any numbers.
- All nine run in parallel; wall-clock ≈ one call.
- `overallScore` is computed client-side as the mean. The model never produces
  an aggregate.
- Each call resolves independently; the UI renders whatever succeeded and
  offers per-criterion retry.

**Do not "optimise" this into a single call that scores everything at once.**
That would reintroduce exactly the bias the design exists to prevent.

**Score 0 means "not assessable", and is stored as `score: null`.** A short or
aborted interview gives some criteria nothing to judge; the evaluators are told
explicitly that absence of evidence is not poor performance and that a 1 is for
doing the thing badly, not for never having had the chance. Not-assessable
criteria render as `n/a` and are excluded from the overall mean rather than
counted as zero. Keep this distinction — collapsing it back into a low score
silently punishes students for a short session.

Errors are surfaced, not swallowed: `describeScoringError()` separates a
rejected key, an unreachable model, a rate limit, and bad JSON, and a
model-not-found additionally triggers a one-time `GET /v1/models` so the
message names the models the key can actually use.

**The transcript is untrusted input to all nine calls** — a student can say an
injection out loud and speech-to-text puts it in the prompt. It is fenced in
`<transcript>` tags with an explicit guard, the instructions come after it, and
`strict: true` bounds the output. See [`PROMPTING.md`](PROMPTING.md) §B, which
includes the tested result for all three scoring models.

Criteria: `open_questions`, `probing`, `cue_pursuit`, `depth_reached`,
`leading`, `rapport`, `neutrality`, `structure`. The two discovery criteria
(`cue_pursuit`, `depth_reached`) carry `needsGroundTruth: true` and receive the
persona's `hiddenCore` — you cannot judge whether a student reached the bottom
without knowing what the bottom was. This is scenario knowledge, not score
knowledge, so it does not reintroduce anchoring.

## Metrics

Computed locally in `metrics.ts`, always shown even if every AI call fails.

- **Interviewee speaking time is exact**: summed from the sample count of every
  received audio chunk (`base64PcmDurationMs`).
- **Both sides are measured from audio**, via `createSpeechMeter`. **Never go
  back to deriving speaking time from transcript timestamps** — that produced a
  permanent 0:00 for the student and a 0%/100% talk ratio.
- Per-turn `speechMs` is the meter's advance since that turn opened, so it
  survives text and audio arriving out of step.
- **Turns are keyed by the server's `item_id`**, so the old `TURN_GAP_MS`
  time-gap guessing is gone. A `.completed` / `.done` event replaces the
  accumulated deltas with the corrected final transcript.
- Question counting is an acknowledged heuristic: `?` marks, falling back to an
  interrogative opening word.
- `avgQuestionWords` is student words ÷ student *turns*, not ÷ questions. The
  name is loose; the number is words per student turn.

## Gotchas

- **`main.tsx` must not use `StrictMode`.** Its dev-mode double-mount opens the
  realtime session and the microphone twice.
- **The remote audio track must be attached to an `<audio>` element**, or the
  speech meter reads zero in Chrome even though you can hear the audio fine.
- **`getUserMedia` requires a secure context.** `http://localhost:5173` works;
  the LAN address Vite also prints (`http://192.168.x.x:5173`) does **not** —
  the mic is silently blocked there.
- Mic permission is requested **before** minting a token, so a denial fails
  fast without burning an API call.
- `setMuted` disables the outgoing track rather than gating a send loop, so
  there is no stale-closure hazard.
- A mid-interview disconnect preserves the transcript and offers "View
  results"; only a failure with an empty transcript sends the user back to
  setup.
- **`tsconfig.json` is not `strict`.** `npm run lint` catches shape errors but
  not nullability, so it is a weaker guarantee than it looks. There are no
  tests either: anything touching audio, the Live session, or scoring has to be
  checked by hand in the browser with a real API key.

## Running it

```bash
npm install
npm run dev      # then open http://localhost:5173 — not the LAN address
npm run lint     # tsc --noEmit
npm run build    # static output in dist/
npm run preview  # serve the production build
```

`.claude/launch.json` already declares the dev server (`npm run dev`, port
5173), so the `/run` skill can start the app without rediscovering it.

## Deployment

Live at **https://rasoulnorouzi.github.io/research-interview-trainer/**.
Pushing to `main` runs `.github/workflows/deploy.yml` (build → Pages); there is
no manual publish step and no `gh-pages` dependency — only first-party GitHub
actions, so the three-dependency constraint holds.

- **`base: './'` in `vite.config.ts` is load-bearing.** Pages serves the app
  from a subpath (`/research-interview-trainer/`), and Vite's default absolute
  `/assets/…` URLs 404 there — a blank white page. Relative works because there
  is one `index.html` and no router. Do not "tidy" it back to the default.
- **The hosted origin is the best way to run this**, not a fallback: Pages is
  HTTPS, hence a secure context, so `getUserMedia` works. It is the local LAN
  address that is broken, not the deployment.
- The API key stays a per-student runtime input. Publishing the site adds no
  secret to the repo, and there is deliberately nothing in CI that injects one.

The student pastes their own OpenAI API key (`sk-…`) on the setup screen.
"Remember this key" stores it in `localStorage` (`riv.apiKey`,
`riv.rememberKey`, `riv.lastPersona`, `riv.interviewModel`,
`riv.scoringModel`). The key never leaves the browser except to OpenAI, and is
used there only to mint a short-lived ephemeral token for the voice session.
There is no `.env` file and no server-side key.

## Verified / not verified

**Verified against the live OpenAI API with a real key (2026-08-10):**

- Browser-origin `POST /v1/realtime/client_secrets` → 200 with
  `access-control-allow-origin: *` and a usable `ek_…` token. This is what
  makes the backend-free design legitimate rather than hopeful.
- A full realtime session driven with synthesized speech: **14 streaming
  `conversation.item.input_audio_transcription.delta` events** during one
  utterance, then `.completed`. Interviewee text arrives as
  `response.output_audio_transcript.delta` / `.done`. Event names in
  `liveSession.ts` are transcribed from that run, not guessed.
- `/v1/responses` with `strict: true` returns clean scored JSON on all three
  scoring models.
- The prompt-injection guard holds on all three scoring models — see
  [`PROMPTING.md`](PROMPTING.md) §B for the transcript used and the results.
- TypeScript and production build clean.

Also verified earlier and still true: setup-screen validation and localStorage
round-trip, mic-denial path, and the results screen rendering metrics, all
rubric rows and the transcript when every AI call fails.

**Not yet verified — needs a human with a microphone:**

- The live conversation end to end: latency, transcription fidelity, and
  whether barge-in feels right through WebRTC.
- **Whether the layered personas still behave under the OpenAI realtime models.**
  The gating instructions were tuned against Gemini. This is the biggest open
  risk, because the personas *are* the product. Check `gpt-realtime-2.1-mini`
  especially — if it will not hold Layer 1, that is an argument for defaulting
  to the flagship, not for weakening the rubric.
- Whether Layer 3 is reachable in a realistic 10-minute interview. If the gates
  prove too tight, loosen the unlock conditions in `personas.ts` rather than
  weakening the rubric.
- Speaking-time plausibility: the energy gate uses a fixed threshold, so a
  noisy room may over-count.
