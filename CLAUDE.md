# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Research Interview Trainer

A teaching tool for a university instructor: students practise qualitative
research interviewing by holding a **spoken** interview with an AI-simulated
interviewee, then receive a scored report on their interviewing technique.

The project started nurse-specific but no longer is — it ships three personas
(a nurse, a teacher, a first-generation student), editable from the instructor
dashboard and extendable with more of the same shape. Free-text custom
personas, once student-facing, were dropped from that flow per
`BACKEND-PLAN.md` §4's open decision: at cohort scale the instructor assigning
personas fits better than a textarea, and the dashboard now covers "try a new
character" properly. `buildCustomPersona()` and its guardrails still exist in
`src/personas.ts` but are unused dead code — nothing calls them. The GitHub
repo is `research-interview-trainer`; the local folder name may differ.

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

**The hosted, roster-backed backend is built (2026-08-14).** The app moved
from a pure client-side build to a Cloudflare Worker: D1, email login against
a pre-loaded roster, the university's OpenAI key server-side instead of a
per-student one, time-limited interviews, server-side scoring, emailed
reports, and an instructor dashboard behind Cloudflare Access that owns the
roster, the personas, the key and the limits. For a cohort of 400.
[`BACKEND-PLAN.md`](BACKEND-PLAN.md) is the design that drove the build;
[`DEPLOYMENT.md`](DEPLOYMENT.md), [`OPERATIONS.md`](OPERATIONS.md) and
[`API.md`](API.md) document the result. Read the plan first if a change
touches keys, scoring or personas, since the implementation is authoritative
over the plan wherever the two differ, and `API.md` §7 lists the known
differences.

## Architecture

**One Cloudflare Worker serves both the static app and `/api/*`, from the
same origin.** There is no CORS anywhere in the system for that reason. The
browser still talks to OpenAI directly over WebRTC for audio — only token
minting and scoring moved server-side; see the audio section below and
constraint 5. **Two client dependencies total: `react`, `react-dom`** — there
is no OpenAI SDK, on either side. D1 (SQLite) is the only datastore: no KV,
no Durable Objects, so the schema lifts to plain SQLite or Postgres on a
university VM unchanged if that migration ever happens (`BACKEND-PLAN.md` §9).

```
worker/
  index.ts                    Route table, one Access guard, one error wrapper
  auth.ts                     Email+code login, session cookie, break-glass redeem
  access.ts                   Cloudflare Access JWT verification for /api/admin/*
  db.ts                       Env binding, settings read, json()/readJsonBody() helpers
  openai.ts                   Token minting + /v1/responses calls, zero Cloudflare imports
  email.ts                    Resend dispatch + report email rendering, zero Cloudflare imports
  scoring.ts                  Rubric + nine independent evaluator calls (moved from src/lib)
  report.ts                   POST /api/session, POST /api/report handlers
  admin.ts                    The whole /api/admin/* surface
  genseed.ts                  Generates seed-personas.sql from src/personas.ts (Node, not Worker)
shared/
  types.ts                    Types both src/ and worker/ import; src/types.ts re-exports them
  format.ts                   fmtMs(), shared by the client and the report emails
src/
  main.tsx                    React root — NO StrictMode (see gotchas)
  App.tsx                     Phase machine: "login" | "setup" | "interview" | "results"
  api.ts                      Same-origin fetch wrapper, ApiError
  personas.ts                 3 layered personas + SHARED_DISCLOSURE_MECHANICS (seed origin, see below)
  index.css                   The entire stylesheet, plain CSS
  lib/
    audio.ts                  createSpeechMeter() — voiced-time measurement only
    liveSession.ts            InterviewSession class — WebRTC + transcript/timing
    metrics.ts                computeMetrics() and formatters, pure functions
  screens/
    LoginScreen.tsx           Email + 6-digit code, remember-device
    SetupScreen.tsx           Persona choice (no API key field anymore)
    InterviewScreen.tsx       Live transcript, countdown, mute, end
    ResultsScreen.tsx         Metrics, rubric, feedback, transcript, export
admin/                        Instructor dashboard, behind Cloudflare Access
```

No router (four screens, one state variable). No state library. No test
suite for the client; the Worker has its own stricter tsconfig instead (see
gotchas).

Models are **instructor settings now, not student choices**: `interview_model`
and `scoring_model` live in the `settings` table, edited from the dashboard,
defaulting to `gpt-realtime-2.1-mini` and `gpt-5.6-terra`
(`seed-settings.sql`). `src/models.ts` is gone. Input transcription is still
pinned to `gpt-live-transcribe`, now in `worker/openai.ts` — see the
voice-only constraint for why that one is not negotiable.

`src/personas.ts` stays in the repo as the origin point for the built-in
personas, even though the Worker serves them from D1: `npm run seed:gen`
regenerates `seed-personas.sql` from it, and it is git's history, diffs and
review for content the dashboard's `persona_versions` table cannot fully
replace on its own (`BACKEND-PLAN.md` §7).

The report "export" is still a client-side Markdown download in
`ResultsScreen.tsx`, unchanged. What changed is where the scores it renders
come from: one `POST /api/report`, not nine client-side calls. The same
report is now also emailed to the student and to `instructor_recipients`,
server-side, from `worker/email.ts`.

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
2. **Calm modern dashboard design. No "AI slop."** (Revised by the instructor
   2026-08-14, replacing the earlier plain-academic serif rule; the reference
   is a student-dashboard mock the instructor supplied.) Cool neutral page
   background (`--bg: #f5f6f8` light), white cards with 12px radius and
   hairline borders, a dark navy app frame, one sans-serif stack for
   everything (weight makes headings, not typeface), pill chips and
   8px-radius buttons, one subtle card shadow. **The app is theme-aware:**
   every color is a token on `:root`, redefined under
   `@media (prefers-color-scheme: dark)`, with `color-scheme: light dark`
   so UA widgets follow; a deliberately warm or cream background was
   rejected by the instructor as the generic AI look. Student app accent is
   navy (`--accent`); the admin dashboard uses the same system with a
   distinct deep-green accent (`.admin-root` token overrides) so the two
   apps are never confusable in either theme. Still banned: gradients,
   glassmorphism, purple, animation beyond hover/focus color, icon
   libraries, emoji decoration, external fonts. Print output stays plain
   black-on-white in both themes.
3. **Voice only.** No text-question fallback. The student speaks; the
   interviewee speaks back.
   The student's words stream as they speak, via `gpt-live-transcribe` and
   `conversation.item.input_audio_transcription.delta`. **Do not swap that
   transcription model for `gpt-transcribe`**, which only transcribes after a
   committed turn — that is the exact Gemini limitation this migration removed.
4. **A narrow backend, built per `BACKEND-PLAN.md`, not a backend-free app
   anymore.** Cohort scale (400 students, most without their own OpenAI
   account or a card to pay for one) forced this, plus two things a browser
   genuinely cannot do: send email, and reliably say who did the interview.
   The constraint that still holds absolutely, unchanged from before, is
   **scope**: the Worker does a small, named list of narrow jobs — auth,
   token minting, scoring, email dispatch, the admin surface — and it stores
   transcripts and scores but never audio. If the API surface starts growing
   past `API.md`'s seven student endpoints plus the admin surface, that is
   the signal to stop and rethink, not to keep adding routes. TypeScript on
   Cloudflare Workers was the implementation choice over FastAPI + Python:
   Workers is where the client already had to be redeployed, D1 needed no
   separate hosting decision, and the OpenAI- and email-facing modules
   (`worker/openai.ts`, `worker/email.ts`) are kept free of Cloudflare
   imports specifically so they lift to Python almost mechanically if the
   project ever does move to the university's own infrastructure
   (`BACKEND-PLAN.md` §9). That move is still not built and still not
   scheduled; §9's abstractions exist to keep the door open, not because the
   move is imminent.
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

Playback speed stays at the API default. A 0.9 slowdown was tried and reverted
because it read as dragged rather than unhurried; pacing is handled by rules
19-21 instead, which tell the persona to take its tempo from the interviewer
and sit slightly under it. A rushed interviewee invites a rushed interviewer,
and rushing is what the rubric penalises.

**Turn taking is `semantic_vad` with `eagerness: "low"`, not the default
`server_vad`.** Do not revert it: the default ends the student's turn after
500 ms of silence, which cuts off anyone thinking mid-question and actively
punishes leaving space after a disclosure — behaviour the `rapport` criterion
rewards.

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
bias. **Scoring now runs server-side, in `worker/scoring.ts`, not in the
browser.** Every prompt string there is byte-identical to the client version
it replaced; `worker/scoring.ts`'s own header comment says so and points back
at [`PROMPTING.md`](PROMPTING.md) — treat a change to any of them as seriously
as before, and re-run the injection test in `PROMPTING.md` §B after any edit
that touches one. Therefore:

- **Eight criteria, eight separate `/v1/responses` calls.** Each evaluator is
  a fresh context that sees the transcript and *one* criterion definition with
  its 1/3/5 anchors — never the other criteria, never another score, never the
  persona's system instruction.
- A **ninth independent call** writes the qualitative feedback and never sees
  any numbers.
- All nine launch together from `scoreAll()`; wall-clock ≈ one call. Each gets
  one sequential retry if it fails the first parallel round.
- `overall` is computed in `worker/report.ts` as the mean. The model never
  produces an aggregate.
- **Failure is all-or-nothing now, which is the one real behaviour change
  from the client version.** The browser used to render eight rows and offer
  a retry on just the ninth; the server cannot do that without reconciling a
  retry against an already-stored, already-emailed row. If any call still
  fails after its retry, nothing is stored and nothing is emailed, and
  `ResultsScreen.tsx` retries the **whole report** with one more `POST
  /api/report` — see `API.md` §3.

**Do not "optimise" this into a single call that scores everything at once.**
That would reintroduce exactly the bias the design exists to prevent, and
running server-side is not a reason to revisit it — `worker/scoring.ts` says
this outright.

**Score 0 means "not assessable", and is stored as `score: null`.** A short or
aborted interview gives some criteria nothing to judge; the evaluators are told
explicitly that absence of evidence is not poor performance and that a 1 is for
doing the thing badly, not for never having had the chance. Not-assessable
criteria render as `n/a` and are excluded from the overall mean rather than
counted as zero. Keep this distinction — collapsing it back into a low score
silently punishes students for a short session.

Errors from OpenAI are deliberately **not** surfaced to students in detail
anymore. `describeScoringError()` and its `/v1/models` hint are gone: they
were client-only, and a student is no longer the one who can fix a bad key or
an unreachable model. `worker/openai.ts` maps every OpenAI failure to one of
four fixed strings before it can reach a response body or a log line — see
the key-hygiene note at the top of that file — and `worker/report.ts` turns
those into the generic `502` a student sees. An instructor diagnosing a
scoring outage reads the Worker logs, not the student-facing message.

Student-facing prose is governed by `PLAIN_WRITING_RULE`, appended to all nine
calls: no em dashes, no markdown, no filler vocabulary, no praise without a
specific. Feedback is the most-read text in the app and it should not read like
a chatbot.

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
knowledge, so it does not reintroduce anchoring. `hiddenCore` now comes from
the `personas` D1 table (`worker/report.ts` reads it alongside `name`,
`title`, `researchTopic`), not from the bundled `src/personas.ts` object —
though `src/personas.ts` is still where the built-in personas' `hiddenCore`
is authored; see the persona-system section above.

**Models are instructor settings now, not student choices.** `scoring_model`
lives in the `settings` table (`gpt-5.6-terra` by default) and is read fresh
on every `POST /api/report`, so a dashboard change takes effect on the next
request, not the next deploy. `src/models.ts`, which used to list the
student-facing choices, is deleted.

## Metrics

Computed locally in `metrics.ts`, always shown even if every AI call fails.

- **Both sides are measured from audio**, via `createSpeechMeter` — the mic
  stream for the student, the remote track for the interviewee (`stop()` in
  `liveSession.ts` reads both meters). **Never go back to deriving speaking
  time from transcript timestamps** — that produced a permanent 0:00 for the
  student and a 0%/100% talk ratio.
  Under Gemini the interviewee's time was instead summed exactly from the
  sample count of every received PCM chunk. WebRTC never hands the app samples,
  so that path is gone and the energy gate replaced it. Comments in `types.ts`
  and `metrics.ts` still describe the old chunk-counting method; they are
  stale, not a second measurement path.
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
- **`tsconfig.json` (the client) is not `strict`; `tsconfig.worker.json` (the
  Worker) is.** `npm run lint` now runs both: `tsc --noEmit` against the
  client, then again with `-p tsconfig.worker.json` against `worker/`,
  `shared/`, and the two `src/` files the Worker imports persona and
  shared-type data from. The client half still catches shape errors but not
  nullability; the Worker half is a real guarantee. There are no tests
  either: anything touching audio, the Live session, or scoring has to be
  checked by hand with a real interview. `.github/workflows/deploy.yml` on
  `legacy-client` still runs `npm run lint` before `npm run build`, so a type
  error blocks that path's deploy; `main` no longer auto-deploys on push (see
  Deployment below), so running `npm run lint` and `npm run build` by hand
  before `wrangler deploy` is on the person deploying.
- **`DEV_ALLOW_INSECURE_ADMIN` belongs only in `.dev.vars`, never in
  `wrangler.jsonc`.** It bypasses the Cloudflare Access check on
  `/api/admin/*` for local testing. A copy of it in `wrangler.jsonc` would
  deploy live and open the roster, the personas and the OpenAI key to
  anyone. `worker/access.ts` fails closed (rejects, does not wave through)
  whenever `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is unset, which is the
  correct state for this file to be absent in.
- **Student mail is Resend-restricted until a sending domain is verified.**
  Until then, mail can only go out from `onboarding@resend.dev` and can only
  be delivered to the Resend account owner's own address — no student
  actually receives a login code in that state. See `DEPLOYMENT.md` §4.
- **The OpenAI key is a `settings` row, not a Worker secret.** `wrangler
  secret put` is for `SESSION_SECRET` and `RESEND_API_KEY` only. The key is
  bootstrapped once by hand into D1 (`DEPLOYMENT.md` §2 step 7) and rotated
  afterward from the dashboard, which validates it live before saving and
  never displays it in full (`GET /api/admin/settings` masks it to
  `sk-...`+last four characters).

## Running it

```bash
npm install
npm run dev        # client only, http://localhost:5173 — no /api, for UI work
npm run dev:worker # wrangler dev: build output + /api together, --local D1 by default
npm run lint       # tsc --noEmit against the client, then again against the Worker
npm run build      # static output in dist/, which the Worker serves
npm run preview    # serve the production build (client only, still no /api)
npm run seed:gen   # regenerate seed-personas.sql from src/personas.ts
```

`npm run dev` alone has no backend behind it, so the login screen and
anything behind it will not work there — use it only for client-only UI
changes upstream of login. `npm run dev:worker` is the one that behaves like
the deployed app; see `DEPLOYMENT.md` for the D1 migration and secrets it
needs first.

`.claude/launch.json` already declares the dev server (`npm run dev`, port
5173), so the `/run` skill can start the app without rediscovering it.

`voice-auditions/` holds the `.wav` clips the voice casting was decided from
(each persona against its rejected alternatives, plus Elena before and after
the reverted 0.9 playback slowdown). It is gitignored and local-only. Re-record
into it before changing any `voiceName`; do not commit it.

## Deployment

The app now deploys as a Cloudflare Worker: `npm run build && npx wrangler
deploy`, serving from the account's `workers.dev` subdomain. Full first-deploy
and update procedures, the Cloudflare Access click-through, and the Resend
domain setup are in [`DEPLOYMENT.md`](DEPLOYMENT.md) — that document, not this
one, is the source of truth for running any deploy command.

`main` no longer deploys to GitHub Pages. **`legacy-client` is the fallback
branch**: the last pre-backend commit, still a pure client-side build with
its own `.github/workflows/deploy.yml` pointed at Pages, kept deployable in
case the Worker needs to be rolled back for a semester (`DEPLOYMENT.md` §6).
Two things from the old Pages-era notes still matter if anyone works on that
branch:

- **`base: './'` in `vite.config.ts` is load-bearing.** Pages serves the app
  from a subpath (`/research-interview-trainer/`), and Vite's default absolute
  `/assets/…` URLs 404 there — a blank white page. Relative works because there
  is one `index.html` and no router. Do not "tidy" it back to the default.
- Pages is HTTPS, hence a secure context, so `getUserMedia` works there the
  same way it does on the Worker's own origin.

The student no longer pastes an API key. They log in with a university email
and a mailed 6-digit code (`LoginScreen.tsx`, `worker/auth.ts`); the
university's OpenAI key lives server-side in the `settings` table, never in
the browser. `localStorage` now holds only `riv.lastPersona`. `riv.apiKey`,
`riv.rememberKey`, `riv.interviewModel` and `riv.scoringModel` are gone along
with the setup-screen fields that wrote them: the key is server-side and the
models are instructor settings, not student choices. There is still no
`.env` file; Worker configuration is `wrangler.jsonc` vars, `wrangler secret
put`, and the `settings` table, as `DEPLOYMENT.md` §2 walks through.

## Verified / not verified

**Verified for the Worker backend, against the live API with the university
key (2026-08-14).** These are the two checks `BACKEND-PLAN.md` §2 required
before building; full detail is in `OPENAI-MIGRATION.md` §7.

- **`instructions` accepted at mint time: yes.** The Worker sets the persona's
  system instruction in the `POST /v1/realtime/client_secrets` call itself
  (`worker/openai.ts`), so the persona text, and Layer 3 with it, never
  reaches the browser. The client's old `session.update` instructions payload
  is gone.
- **A server-side maximum session duration: no such field exists.**
  `expires_after` bounds only when a minted token may *start* a session, not
  how long a started one may run. The interview time limit is therefore
  enforced by the fallback stack `BACKEND-PLAN.md` §5 describes: token
  validity of `limitMinutes + 2` minutes, the client-side countdown, and the
  daily `session_grants` quota as the real backstop.

**Verified against the live OpenAI API with a real key, from the earlier
browser-direct design (2026-08-10).** The CORS finding below described why a
key-in-the-browser architecture was legitimate; it is superseded now that
minting moved server-side, but the realtime event names and behaviours it
recorded are unchanged and still what `liveSession.ts` and `worker/openai.ts`
rely on:

- Browser-origin `POST /v1/realtime/client_secrets` → 200 with
  `access-control-allow-origin: *` and a usable `ek_…` token.
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
