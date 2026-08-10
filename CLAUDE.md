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

## Architecture

**Pure client-side React + Vite. There is no backend and no build step beyond
Vite.** The browser talks to the Gemini API directly with a user-supplied API
key. Three dependencies total: `react`, `react-dom`, `@google/genai`.

```
src/
  main.tsx                    React root — NO StrictMode (see gotchas)
  App.tsx                     Phase machine: "setup" | "interview" | "results"
  types.ts                    All shared types
  personas.ts                 3 layered personas + buildCustomPersona()
  index.css                   The entire stylesheet, plain CSS
  lib/
    audio.ts                  PCM encode/decode, PcmAudioPlayer, base64PcmDurationMs
    liveSession.ts            InterviewSession class — Gemini Live + mic + transcript/timing
    metrics.ts                computeMetrics() and formatters, pure functions
    scoring.ts                Rubric definitions + independent evaluator calls
  screens/
    SetupScreen.tsx           API key, persona choice, custom persona
    InterviewScreen.tsx       Live transcript, mute, end
    ResultsScreen.tsx         Metrics, rubric, feedback, transcript, export
```

No router (three screens, one state variable). No state library. No test suite.

Models: `gemini-3.1-flash-live-preview` for the voice session,
`gemini-3.6-flash` for scoring.

The report "export" is a client-side Markdown download: `buildMarkdownReport()`
in `ResultsScreen.tsx` renders metrics + rubric + feedback + full transcript
into a `Blob` saved as `interview-report-<date>.md`. No email, no server.

## Audio pipeline

Two sample rates, deliberately — they are what the Live API expects on each
side and must not be unified:

- **Uplink 16 kHz.** `AudioContext({sampleRate: 16000})` → `ScriptProcessorNode`
  (2048 frames) → `pcmFloat32ToBase64()` → `sendRealtimeInput` with
  `mimeType: "audio/pcm;rate=16000"`.
- **Downlink 24 kHz.** `PcmAudioPlayer` schedules each received chunk at
  `nextStartTime` (advanced by `buffer.duration`) so playback is gapless
  instead of one-`AudioBufferSourceNode`-per-chunk stutter.
- **Barge-in.** `serverContent.interrupted` calls `player.stop()`, which closes
  the playback `AudioContext` outright — that is how queued-but-unplayed chunks
  are discarded. The context is lazily recreated on the next `playChunk()`.
  Changing `stop()` to something gentler will make the interviewee keep talking
  over the student.

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
4. **If a backend ever becomes necessary, it must be FastAPI + Python** — not
   Node, not Express. Client-side React is preferred while it suffices.
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

When editing personas: keep the three-layer structure, keep unlock conditions
explicit and behavioural, keep answers capped at four spoken sentences, and
keep `shortBio` on the setup screen **spoiler-free** — students must not see
what they are supposed to discover.

## Scoring — independent evaluators, deliberately

The instructor specifically requires that rubric scoring be free of anchoring
bias. Therefore:

- **Eight criteria, eight separate `generateContent` calls.** Each evaluator is
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
- **Student speaking time is a proxy**: the span of input-transcription
  timestamps, which stream near-real-time.
- Turn clustering merges same-speaker transcription chunks less than
  `TURN_GAP_MS` (2000 ms) apart into one entry.
- Question counting is an acknowledged heuristic: `?` marks, falling back to an
  interrogative opening word.
- `avgQuestionWords` is student words ÷ student *turns*, not ÷ questions. The
  name is loose; the number is words per student turn.

## Gotchas

- **`main.tsx` must not use `StrictMode`.** Its dev-mode double-mount opens the
  Gemini Live session and the microphone twice.
- **Never set `httpOptions.headers["User-Agent"]`** on `GoogleGenAI` in the
  browser — browsers forbid setting that header. (The deleted server did this.)
- **`getUserMedia` requires a secure context.** `http://localhost:5173` works;
  the LAN address Vite also prints (`http://192.168.x.x:5173`) does **not** —
  the mic is silently blocked there.
- `ScriptProcessorNode` is deprecated but retained deliberately: it works
  everywhere and AudioWorklet would add a module file and message plumbing for
  no user-visible gain. Buffer is 2048 @ 16 kHz (~128 ms) for low latency.
- Mic permission is requested **before** connecting to Gemini, so a denial
  fails fast without burning an API call.
- `setMuted` goes through the session object, not React state, to avoid the
  stale-closure bug the original app had in its `onaudioprocess` handler.
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

The student pastes their own Gemini API key on the setup screen. "Remember this
key" stores it in `localStorage` (`riv.apiKey`, `riv.rememberKey`,
`riv.lastPersona`). The key never leaves the browser except to Google. There is
no `.env` file and no server-side key.

## Verified / not verified

Verified: TypeScript and production build clean; setup-screen validation and
localStorage round-trip across reload; mic-denial path; results screen renders
metrics, all rubric rows, per-criterion retry, and transcript when every AI call
fails.

**Not yet verified with a real API key**: the live voice conversation itself
(latency, transcription fidelity, interruption handling), whether the Layer 3
unlock conditions are reachable within a realistic 10-minute interview, and
whether the rubric scores are calibrated sensibly. If the gates prove too tight
in practice, loosen the unlock conditions in `personas.ts` rather than weakening
the rubric.
