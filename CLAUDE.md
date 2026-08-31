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

**The Worker is deployed and live (2026-08-14).** It runs at
https://research-interview-trainer.rasoulnorouzi.workers.dev, backed by the
`riv-trainer` D1 database (migrated and seeded) and a Cloudflare Access app,
"Interview Trainer Admin" (team `rasouldns.cloudflareaccess.com`), with
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` filled in `wrangler.jsonc`; admin
routes have been verified to reject missing or forged Access JWTs. The
Resend sending domain `rslnorouzi.site` is verified (SPF, DKIM, MX in
Cloudflare DNS), `EMAIL_FROM` is `Research Interview Trainer
<trainer@rslnorouzi.site>`, and mail delivers to every address, not only
the account owner's — see the Resend gotcha below, now historical for this
deployment. The roster currently holds three test entries. `legacy-client`
exists as a local git branch for rollback (`DEPLOYMENT.md` §6); pushing it
to GitHub is still pending.

The results screen no longer scores automatically: a student clicks
"Submit interview for scoring" on `ResultsScreen.tsx`, and only that click
triggers `POST /api/report`. Login failures are explicit rather than a
single generic message — `worker/auth.ts` answers `400`, `404`, `429`, or
`502` with a message naming the problem, a 2026-08-14 instructor decision
documented in `API.md` §5. The per-IP rate limit on `POST /api/auth/request`
is 120 per hour, not 10, raised because a shared classroom network is one
NAT address. The admin dashboard also gained hard-delete paths this same
day: `DELETE .../roster/:id?hard=1`, `DELETE .../personas/:id`, and
`DELETE .../submissions/:id`. The persona delete refuses (`409`) while any
stored report references the persona; the roster delete **cascaded** as of
2026-08-27, an instructor decision reversing the original never-orphan rule
— deleting a student now deletes their stored reports with them, single and
bulk alike, and the dashboard's confirm dialog carries the warning.
Deactivate remains the keep-history option. The Submissions screen shows
one row per student (click to open that student's interviews) and its
checkbox selection drives bulk delete and a bulk download, built
client-side from the existing per-submission GET: one selection saves a
plain .md, more than one saves a ZIP of Markdown files written by
`admin/zip.ts`, a small dependency-free store-only ZIP writer. See
`API.md` §6 for the full admin surface.

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
  scoring.ts                  One evaluator call per active D1 criterion (moved from src/lib)
  report.ts                   POST /api/session, POST /api/report handlers
  admin.ts                    The whole /api/admin/* surface
  genseed.ts                  Generates seed-personas.sql from src/personas.ts (Node, not Worker)
  genseed-criteria.ts         Generates seed-criteria.sql from src/criteria.ts (Node, not Worker)
shared/
  types.ts                    Types both src/ and worker/ import; src/types.ts re-exports them
  format.ts                   fmtMs(), shared by the client and the report emails
  models.ts                   The model ids the dashboard's Settings form offers
  voices.ts                   REALTIME_VOICES — the castable persona voices
src/
  main.tsx                    React root — NO StrictMode (see gotchas)
  App.tsx                     Phase machine: "login" | "setup" | "interview" | "results"
  api.ts                      Same-origin fetch wrapper, ApiError
  personas.ts                 3 layered personas + SHARED_DISCLOSURE_MECHANICS (seed origin, see below)
  criteria.ts                 8 seeded rubric criteria (seed origin, see below)
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
  AdminApp.tsx, api.ts, and one file per screen: Roster, Personas, Rubric,
  Settings, Submissions, Breakglass
```

**There are two HTML entry points, not one:** `index.html` (student app,
`src/`) and `admin.html` (dashboard, `admin/`), declared as separate Rollup
inputs in `vite.config.ts` and served by the same Worker. A change to the
build config has to keep both.

No router (four screens, one state variable). No state library. No test
suite for the client; the Worker has its own stricter tsconfig instead (see
gotchas).

Models are **instructor settings now, not student choices**: `interview_model`
and `scoring_model` live in the `settings` table, edited from the dashboard,
defaulting to `gpt-realtime-2.1-mini` and `gpt-5.6-terra`
(`seed-settings.sql`). `src/models.ts` is gone; the id lists the dashboard
offers moved to `shared/models.ts`. Note the asymmetry between the two
lists: **models are UI-only** — `worker/admin.ts` accepts any non-empty
string, so an id typed straight into the database keeps working and adding a
newly shipped model is a one-line edit — whereas **voices in
`shared/voices.ts` are enforced server-side**, deliberately, because an
unknown voice fails at session start in front of a student. Input
transcription joined the enforced side on 2026-08-31: `transcription_model`
is a settings row (default `gpt-live-transcribe`), validated against
`TRANSCRIPTION_MODEL_IDS` in `shared/models.ts` because a bad id fails the
mint in front of a student and because only streaming transcribers may ever
be offered — see the voice-only constraint for why that is not negotiable.

`src/personas.ts` stays in the repo as the origin point for the built-in
personas, even though the Worker serves them from D1: `npm run seed:gen`
regenerates `seed-personas.sql` from it, and it is git's history, diffs and
review for content the dashboard's `persona_versions` table cannot fully
replace on its own (`BACKEND-PLAN.md` §7).

The scoring rubric works the same way: `src/criteria.ts` is the origin
point for the 8 built-in criteria, even though the Worker reads the active
rubric from the `criteria` D1 table. `npm run seed:gen:criteria`
regenerates `seed-criteria.sql` from it, mirroring `seed:gen` for
personas, and it is the ultimate restore if the dashboard's
`criteria_versions` history is ever not enough (`BACKEND-PLAN.md` §7,
2026-08-21 addition).

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
   The student's words stream as they speak, via
   `conversation.item.input_audio_transcription.delta`. The transcription
   model became an instructor setting on 2026-08-31 (`transcription_model`,
   default `gpt-live-transcribe`), but the constraint is unchanged and now
   lives in the curated list: `shared/models.ts` offers only models verified
   to stream deltas during speech (`gpt-live-transcribe`,
   `gpt-realtime-whisper` — tested live by driving a realtime session with
   synthesized speech), and `worker/admin.ts` enforces that list on save.
   **Never add a committed-turn transcriber** (`gpt-transcribe`,
   `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1` — all tested,
   all transcribe only after the turn): that is the exact Gemini limitation
   this migration removed.
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
is *audible*. Rule 22 (2026-08-26) restricts the interviewee to English and
Dutch: it answers in the interviewer's language and declines, in English, any
other language. See [`PROMPTING.md`](PROMPTING.md).

When editing personas: keep the three-layer structure, keep unlock conditions
explicit and behavioural, keep answers capped at four spoken sentences, and
keep `shortBio` on the setup screen **spoiler-free** — students must not see
what they are supposed to discover.

## Scoring — independent evaluators, deliberately

The instructor specifically requires that rubric scoring be free of anchoring
bias. **Scoring now runs server-side, in `worker/scoring.ts`, not in the
browser.** Since 2026-08-21 the rubric itself is instructor-editable: criteria
live in the `criteria` D1 table (+ `criteria_versions` history), edited from
the dashboard's Rubric screen and seeded from `src/criteria.ts`, the same role
`src/personas.ts` plays for personas. Each criterion carries its own
`scale_max` (2 to 10, default 5) alongside its own anchors. What is fixed in
`worker/scoring.ts` is the **template** that criterion text is rendered into,
not the criteria themselves; that template is byte-identical, at `scale_max`
5, to the client version it replaced — `worker/scoring.ts`'s own header
comment says so and points back at [`PROMPTING.md`](PROMPTING.md). Treat a
change to the template, the guard, or any criterion's stored text as seriously
as before, and re-run the injection test in `PROMPTING.md` §B after any edit
that touches one. Therefore:

- **One call per active criterion (8 seeded, up to 20 active), each its own
  `/v1/responses` call.** Each evaluator is a fresh context that sees the
  transcript and *one* criterion definition rendered at that criterion's own
  `scale_max` — never the other criteria, never another score, never the
  persona's system instruction.
- A **separate, independent call** writes the qualitative feedback and never
  sees any numbers. The `generate_feedback` setting can switch this one call
  off entirely (see below); the criterion calls are never optional.
- All of those calls, one per active criterion plus feedback, launch together
  from `scoreAll()`; wall-clock ≈ one call. Each gets one sequential retry if
  it fails the first parallel round. `worker/admin.ts` caps the rubric at 20
  active criteria, so a report never fires more calls than that plus one.
- `overall` is computed in `worker/report.ts`, never by a model, and is now
  **points-based**: the sum of earned points over the sum of possible points
  across every assessable criterion, as a percentage with one decimal. A plain
  mean stopped being meaningful once criteria could carry different scales.
  Each `CriterionScore` carries `max`, the scale it was scored on, so a report
  stays readable after the instructor changes a criterion's scale later; rows
  stored before this change have no `max` and every renderer defaults it to
  `5`. An empty, all-inactive rubric makes `POST /api/report` answer `503`,
  the same response a missing OpenAI key produces.
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
criteria render as `n/a` and are excluded from the points-based `overall`
score rather than counted as zero. Keep this distinction — collapsing it back
into a low score silently punishes students for a short session.

Errors from OpenAI are deliberately **not** surfaced to students in detail
anymore. `describeScoringError()` and its `/v1/models` hint are gone: they
were client-only, and a student is no longer the one who can fix a bad key or
an unreachable model. `worker/openai.ts` maps every OpenAI failure to one of
four fixed strings before it can reach a response body or a log line — see
the key-hygiene note at the top of that file — and `worker/report.ts` turns
those into the generic `502` a student sees. An instructor diagnosing a
scoring outage reads the Worker logs, not the student-facing message.

Student-facing prose is governed by `PLAIN_WRITING_RULE`, appended to every
scoring call: no em dashes, no markdown, no filler vocabulary, no praise
without a specific. Feedback is the most-read text in the app and it should
not read like a chatbot.

**The transcript is untrusted input to every scoring call** — a student can
say an injection out loud and speech-to-text puts it in the prompt. It is
fenced in `<transcript>` tags with an explicit guard, the instructions come
after it, and `strict: true` bounds the output. See
[`PROMPTING.md`](PROMPTING.md) §B, which includes the tested result for all
three scoring models.

Criteria: `open_questions`, `probing`, `cue_pursuit`, `depth_reached`,
`leading`, `rapport`, `neutrality`, `structure`. These 8 are the seeded
defaults, not a fixed list — the instructor can rename, reword, add, remove,
or (de)activate criteria from the dashboard's Rubric screen, subject to the
20-active cap and the 1-active minimum (`worker/admin.ts`). The two discovery
criteria
(`cue_pursuit`, `depth_reached`) carry `needsGroundTruth: true` and receive the
persona's `hiddenCore` — you cannot judge whether a student reached the bottom
without knowing what the bottom was. This is scenario knowledge, not score
knowledge, so it does not reintroduce anchoring. `hiddenCore` now comes from
the `personas` D1 table (`worker/report.ts` reads it alongside `name`,
`title`, `researchTopic`), not from the bundled `src/personas.ts` object —
though `src/personas.ts` is still where the built-in personas' `hiddenCore`
is authored; see the persona-system section above.

**Whether the student sees the scores is an instructor setting.**
`share_report_with_student` (`"1"` by default) lives in the `settings` table
and changes only the student's copy: with it at `"0"` the results screen and
the student's email carry the transcript and a short notice instead of the
rubric and the feedback, and `POST /api/report` answers `shared: false` with
empty `scores` and a null `feedback` so no withheld number reaches the
browser. Scoring, the stored submission and the instructor email are
identical in both modes.

**Whether the feedback is written at all is a second instructor setting
(2026-08-31).** `generate_feedback` (`"1"` by default) switches the
qualitative-feedback call off entirely: `scoreAll` skips it, `feedback` is
null in the response, the stored `feedback_json` holds the JSON value
`null`, and every renderer (results screen, both emails, the assessment
attachment, the Submissions detail and its Markdown export) omits the
feedback section rather than showing an empty one. Criterion scoring is
untouched. This is orthogonal to `share_report_with_student`: that one
hides written feedback from the student; this one stops it being written.
Old submissions keep their stored feedback either way, so
`SubmissionDetail.feedback` and `ReportEmailData.feedback` are nullable
and every reader guards.

**Assessment recipients carry per-address switches (2026-08-31).**
`instructor_recipients` is still one comma-separated settings string, but
an address prefixed with `!` is switched off: kept on the list, excluded
from report emails. `shared/recipients.ts` is the one parse/serialize
definition, used by the dashboard form, the settings validation and
`worker/report.ts`; a pre-existing value without `!` parses as all-on. The
dashboard's Settings screen gives each address an on/off Toggle and a
Remove button behind a confirm dialog; an all-off list is legal (the
screen warns) and simply sends no instructor copies.

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
  so that path is gone and the energy gate replaced it. Two comments still
  describe the old chunk-counting method and are stale, not a second
  measurement path: `shared/types.ts:20` (on `intervieweeAudioMs`) and
  `src/lib/metrics.ts:32`. Worth correcting in the code and deleting these
  two sentences.
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
- **Admin authorization is Cloudflare Access alone.** Whoever passes the
  Access login is the admin; the Access policy in the Zero Trust
  dashboard is the one and only admin list (it currently allows
  `rasoulnorouzi@live.com` and `rslnorouzi@gmail.com` — the Tilburg
  address is NOT in it). A second, dashboard-managed admin list
  (`MASTER_ADMINS` var + `admins` table + Admins screen) existed
  2026-08-26 to 2026-08-27 and was **removed at the instructor's
  request** — do not rebuild it without being asked.
- **Backups**: D1 Time Travel restores the whole database to any minute in
  the last 30 days with zero setup (`wrangler d1 time-travel restore`);
  `npm run backup` exports a SQL snapshot for long-term keeping. Worker
  logs persist via `observability` in `wrangler.jsonc`; OPERATIONS.md §12
  has the triage routine.
- **`DEV_ALLOW_INSECURE_ADMIN` belongs only in `.dev.vars`, never in
  `wrangler.jsonc`.** It bypasses the Cloudflare Access check on
  `/api/admin/*` for local testing. A copy of it in `wrangler.jsonc` would
  deploy live and open the roster, the personas and the OpenAI key to
  anyone. `worker/access.ts` fails closed (rejects, does not wave through)
  whenever `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is unset, which is the
  correct state for this file to be absent in.
- **A brand-new Resend account is restricted until its sending domain is
  verified — historical for this deployment, still true for a fresh one.**
  Until verified, mail can only go out from `onboarding@resend.dev` and can
  only be delivered to the Resend account owner's own address. This
  project's domain, `rslnorouzi.site`, is verified (SPF, DKIM, MX in
  Cloudflare DNS) and mail reaches every address, students included. Keep
  this note in mind only if you ever set up Resend again for a different
  deployment. See `DEPLOYMENT.md` §4.
- **The OpenAI key is a `settings` row, not a Worker secret.** `wrangler
  secret put` is for `SESSION_SECRET` and `RESEND_API_KEY` only. The key is
  bootstrapped once by hand into D1 (`DEPLOYMENT.md` §2 step 7) and rotated
  afterward from the dashboard, which validates it live before saving and
  never displays it in full (`GET /api/admin/settings` masks it to
  `sk-...`+last four characters). A **Remove key** control on the Settings
  screen (`PUT {openai_api_key: null}`) clears it outright; every
  subsequent `POST /api/session` and `POST /api/report` then answers `503`
  until a working key is saved again.

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
into it before changing any `voiceName`; do not commit it. The dashboard's
persona editor now also has a "Preview voice" button (2026-08-31): `POST
/api/admin/voice-preview` speaks one fixed sample sentence through
`gpt-4o-mini-tts` on the university key — verified live to accept all ten
realtime voices, marin and cedar included — so the instructor can cast by
ear without this folder. The auditions stay the record of why the built-in
casting is what it is.

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

- **`base: './'` in `vite.config.ts` is load-bearing — and not only here.**
  Pages serves the app from a subpath (`/research-interview-trainer/`), and
  Vite's default absolute `/assets/…` URLs 404 there — a blank white page.
  Relative works because there is no router. It also keeps `admin.html`'s
  assets resolving on the Worker, so this line matters on `main` too, not
  just on the fallback branch. Do not "tidy" it back to the default.
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
  `session_grants` quota as the real backstop (a per-student total,
  `sessions_total`, since 2026-08-26; the dashboard Students screen (the roster) can reset
  one student's grants).

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
