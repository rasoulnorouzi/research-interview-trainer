# Backend plan: hosting the trainer for a full cohort

Written 2026-08-14. This plan takes the trainer from a pure client-side app
with a student-supplied API key to a hosted service with a roster, login,
server-side scoring and emailed reports, for **400 students over one academic
year**.

It deliberately stops short of Canvas/LTI integration and university-hosted
infrastructure. Those are not in scope, but every design decision here is
checked against them, and §9 lists the specific choices that keep those doors
open. Nothing in this plan needs a conversation with the IT department.

Read [`CLAUDE.md`](CLAUDE.md) first for the existing architecture and the
instructor's design constraints, and [`PROMPTING.md`](PROMPTING.md) before
touching anything that builds a prompt.

---

## 0. What changes, and the constraint being traded

Today: the browser holds a student's own OpenAI key, mints its own realtime
token, runs nine scoring calls, and stores nothing. Personas are compiled into
the bundle.

Target: a Cloudflare Worker serves the app and a small API. The university's
OpenAI key lives server-side. Students log in against a pre-loaded roster.
Interviews are time-limited. Scoring runs on the server. Reports are emailed to
the student and the instructors, and stored. An instructor dashboard behind
Cloudflare Access manages the roster, the personas, the key and the limits
without a deploy.

Three things force this, in order of how much they force it:

1. **Per-student API keys do not scale to 400 people.** Most students do not
   have an OpenAI account, and getting one needs a payment card. This alone
   makes the current design unworkable at cohort scale, and the university's
   OpenAI collaboration removes the reason it existed.
2. **The reports have to reach the instructors.** A browser cannot send email.
3. **Identity has to be real.** A report that does not reliably say who did the
   interview is not much use for a course of 400.

**This trades design constraint #1 ("genuinely simple, resist adding files,
dependencies, abstraction layers, or features").** That is a deliberate
decision, not an accident. The counterweight is the revised constraint #4:
whatever the backend becomes, it does a small number of narrow jobs, and if it
starts growing it is time to stop and rethink.

Two properties from the original design are preserved and should stay
preserved:

- **The browser still talks to OpenAI directly over WebRTC.** Only token
  minting moves to the server. Audio never relays through us. (Constraint #5.)
- **We store no audio, ever.** Transcripts and scores, nothing else.

---

## 1. Target architecture

```
Browser (React SPA, unchanged rendering)
   |
   |  same-origin  /api/*
   v
Cloudflare Worker  ──────────────  D1 (SQLite)
   |   static assets                roster
   |   auth, session minting        login_codes
   |   OpenAI token minting         submissions
   |   scoring (9 calls)            session_grants
   |   email dispatch               settings
   |   /admin behind Access         personas + persona_versions
   |
   +──> OpenAI  /v1/realtime/client_secrets   (mint, university key)
   +──> OpenAI  /v1/responses                 (scoring, university key)
   +──> Resend                                (email)

Browser ════ WebRTC audio, direct ════> OpenAI realtime
        (using the short-lived ek_… token the Worker returned)
```

**One Worker, serving both the static app and `/api/*` from the same origin.**
This is Cloudflare's current recommendation for new projects over Pages, and it
means there is no CORS configuration anywhere in this system.

**D1 for everything durable. No KV, no Durable Objects.** D1 is SQLite, so the
schema below lifts to SQLite or Postgres on a university VM unchanged. KV and
Durable Objects have no off-platform equivalent and would be the pieces that
strand us later. Login codes go in D1 too; the write volume is nowhere near any
limit.

Free-tier headroom at 400 students/year is between two and three orders of
magnitude on every axis. Capacity is not a design consideration here and should
not be treated as one.

---

## 2. Verify these two things before building anything

Both are curl checks against `POST /v1/realtime/client_secrets` with the
university key, and together they take under an hour. **Do them first.** Each
determines whether a protection in this plan is real enforcement or only a
convention.

**(a) Does the session object accept `instructions` at mint time?**

Today the app mints a token without instructions and then sends them over the
data channel in `configureSession()`. If instructions can be set at mint time,
the persona text never reaches the browser. If they cannot, the browser must
keep sending them and the Layer 3 material stays client-visible.

**(b) Does the session object accept a maximum session duration?**

This decides whether the interview time limit (§5) is enforced by OpenAI or
only by our own client-side timer. Look for a `max_session_duration` or
similarly named field, and check what the API's own default session ceiling is.
If a server-side cap exists, use it: it is the only mechanism in this plan that
a student cannot switch off.

Everything else in the plan holds either way, but the answers change how much
of §5 is enforcement and how much is good manners. Record both in
[`OPENAI-MIGRATION.md`](OPENAI-MIGRATION.md) alongside the other verified API
findings.

---

## 3. Data model

```sql
-- Who is allowed to use the app. Imported per semester from the registry.
CREATE TABLE roster (
  student_id   TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,        -- lowercased at import time
  full_name    TEXT NOT NULL,
  cohort       TEXT,                        -- e.g. '2026-2027-S1'
  lms_user_id  TEXT,                        -- null until Canvas; see §9
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

-- One live login code per address. Rows are short-lived.
CREATE TABLE login_codes (
  email        TEXT PRIMARY KEY,
  code_hash    TEXT NOT NULL,               -- SHA-256 of the 6 digits
  expires_at   INTEGER NOT NULL,            -- unix seconds
  attempts     INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER NOT NULL
);

-- Rate limiting for /api/auth/request, keyed by email and by IP.
CREATE TABLE request_log (
  key          TEXT NOT NULL,               -- 'email:…' or 'ip:…'
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

-- One row per completed interview.
CREATE TABLE submissions (
  id              TEXT PRIMARY KEY,         -- uuid
  student_id      TEXT NOT NULL REFERENCES roster(student_id),
  persona_id      TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL,
  overall_score   REAL,                     -- null when nothing was assessable
  scores_json     TEXT NOT NULL,
  feedback_json   TEXT NOT NULL,
  metrics_json    TEXT NOT NULL,
  transcript_json TEXT NOT NULL,
  emailed_at      INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_submissions_student ON submissions(student_id, created_at);

-- Per-student daily cap on realtime sessions. Protects the university key.
CREATE TABLE session_grants (
  student_id TEXT NOT NULL,
  day        TEXT NOT NULL,                 -- 'YYYY-MM-DD'
  count      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (student_id, day)
);

-- Everything the instructor can change without a deploy. See §7.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT                           -- instructor email from Access
);

-- Personas, editable from the dashboard. Seeded from src/personas.ts.
CREATE TABLE personas (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  title              TEXT NOT NULL,
  research_topic     TEXT NOT NULL,
  short_bio          TEXT NOT NULL,         -- must stay spoiler-free
  voice_name         TEXT NOT NULL,
  system_instruction TEXT NOT NULL,
  hidden_core        TEXT,
  active             INTEGER NOT NULL DEFAULT 1,
  updated_at         INTEGER NOT NULL,
  updated_by         TEXT
);

-- Every save of a persona, never deleted. See §7 on why this is not optional.
CREATE TABLE persona_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id  TEXT NOT NULL,
  snapshot    TEXT NOT NULL,                -- full JSON of the row as saved
  saved_at    INTEGER NOT NULL,
  saved_by    TEXT
);
CREATE INDEX idx_persona_versions ON persona_versions(persona_id, saved_at);
```

Three columns exist only to keep later options open and are unused for now:
`roster.lms_user_id`, `roster.cohort`, and `submissions.overall_score`. They
cost nothing today. See §9.

**Settings keys** used by this plan, all editable from the dashboard:

| Key | Meaning | Suggested default |
|---|---|---|
| `openai_api_key` | University key, write-only (§7) | none, must be set |
| `interview_limit_minutes` | Hard stop for an interview | 12 |
| `interview_warn_minutes` | When the countdown turns visible | 10 |
| `sessions_per_day` | Per-student realtime session cap | 5 |
| `interview_model` | Realtime model id | `gpt-realtime-2.1-mini` |
| `scoring_model` | Evaluator model id | `gpt-5.6-terra` |
| `instructor_recipients` | Who receives every report | none, must be set |

Read these on each request rather than caching them in module scope, so a
change from the dashboard takes effect immediately rather than at the next
cold start.

**Roster import** is a CSV (`student_id,email,full_name,cohort`), either
applied with `wrangler d1 execute` or uploaded through the dashboard (§7).
Lowercase every email on the way in. Import must **upsert**, so that a
mid-semester enrolment change is a re-run rather than a manual reconciliation.

**Never hard-delete a student.** `submissions.student_id` references the roster,
so deletion either fails or orphans a report. Deactivate with `active = 0`,
which blocks login and leaves the history intact.

---

## 4. API contract

Keep this small. It is the thing that has to be reimplementable in FastAPI if
the app ever moves to a university VM, and it stays cheap to move only while it
stays small.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/request` | none | `{email}` → always `200 {ok:true}` |
| POST | `/api/auth/verify` | none | `{email, code, remember}` → sets session cookie |
| POST | `/api/auth/logout` | session | clears the cookie |
| GET | `/api/me` | session | `{student_id, full_name}` or `401` |
| GET | `/api/personas` | session | picker fields only, no spoilers |
| POST | `/api/session` | session | `{personaId}` → `{token, expiresAt}` |
| POST | `/api/report` | session | transcript + metrics → scores, feedback, emails sent |

`GET /api/personas` returns **only** `{id, name, title, shortBio}` for active
personas. `system_instruction` and `hidden_core` are never serialised to a
student-facing response. This is the point of moving personas server-side; do
not "helpfully" widen this payload later.

`POST /api/session` also returns `{limitMinutes, warnMinutes}` from settings, so
the client knows what countdown to render (§5).

**Open decision:** the current setup screen lets a student paste a custom
persona. For a 400-student cohort the instructor probably wants everyone on the
assigned persona, and the dashboard now covers the "try a new character" case
better than a student-facing textarea did. Recommendation: drop custom personas
from the student flow. If kept, the `CUSTOM_RULES` guardrails from
`personas.ts` must be applied **server-side** at mint time and never trusted
from the client.

### Admin API

Separate surface, all behind Cloudflare Access (§7). `identify` here resolves an
*instructor* from the `Cf-Access-Jwt-Assertion` header, not a student session.

| Method | Path | Purpose |
|---|---|---|
| GET/PUT | `/api/admin/settings` | read and write the settings table; the key is masked on read |
| GET/POST | `/api/admin/roster` | list, search, add a student |
| PATCH/DELETE | `/api/admin/roster/:id` | edit; DELETE deactivates, never removes |
| POST | `/api/admin/roster/import` | CSV upsert |
| GET/POST | `/api/admin/personas` | list, create |
| GET/PUT | `/api/admin/personas/:id` | read full persona including spoilers, save new version |
| GET | `/api/admin/personas/:id/versions` | history, with restore |
| GET | `/api/admin/submissions` | list, filter by cohort and date |
| GET | `/api/admin/submissions/:id` | full report |
| GET | `/api/admin/submissions.csv` | export |
| POST | `/api/admin/breakglass` | mint a student session by student_id (§6) |

The seven student endpoints above are the ones that must stay small and
portable, for the reasons in §9. The admin surface can grow more freely: it is
the least coupled to OpenAI, the least load-bearing, and the last thing that
would need reimplementing if the app ever moved to a university VM.

---

## 5. The OpenAI integration

### Token minting

```
POST /api/session  { personaId }
  → identify(request) → student
  → check and increment session_grants for today; reject over quota
  → load persona from server-side personas module
  → POST https://api.openai.com/v1/realtime/client_secrets
       Authorization: Bearer <UNIVERSITY_KEY>
       session: { type, model, instructions: persona.systemInstruction,
                  audio: { input:  { transcription: {model:'gpt-live-transcribe'},
                                     turn_detection: {type:'semantic_vad',
                                                      eagerness:'low'} },
                           output: { voice: persona.voiceName } } }
  → return { token: ek_…, expiresAt }
```

The transcription model and turn detection settings are load-bearing and
documented in `CLAUDE.md`; carry them across verbatim.

If §2 comes back negative and `instructions` cannot be set at mint time, keep
`configureSession()` on the client as it is today and accept that persona text
remains client-visible.

### Scoring

The nine evaluator calls move from `src/lib/scoring.ts` to the Worker
essentially unchanged. `CRITERIA`, the injection guard, the ground-truth block,
the not-assessable rule and `PLAIN_WRITING_RULE` all move as-is.

**The per-criterion independence is not negotiable.** Nine separate calls, each
seeing one criterion. Running on a server is not a reason to batch them, and
batching would reintroduce exactly the anchoring bias the design exists to
prevent. Nine subrequests is well inside the free tier's limit of fifty.

Two things improve by moving:

- `hiddenCore` never reaches the browser.
- The student no longer runs their own evaluators, so the scores in the emailed
  report are trustworthy rather than merely plausible.

A student can still POST a fabricated transcript. Fabricating a convincing
ten-minute qualitative interview is real work, and the audio-derived metrics
would not corroborate it. That is a proportionate deterrent for practice work;
if this ever becomes summative, revisit it.

### Cost control: the interview time limit

Realtime audio is the dominant cost of a session, and it is charged by the
minute of conversation. With 400 students on one university account, an
unbounded interview length is the largest single financial risk in this design.
A student who opens a session and wanders off is worse than one who abuses it
deliberately, because nothing about it looks wrong.

**Defend in three layers, because only the outer two are enforcement.**

1. **Server-side maximum session duration at mint time**, if §2(b) confirms the
   API supports it. This is the only mechanism a student cannot switch off, so
   if it exists, it is the real limit and everything below is UX. Set it a
   minute or two above `interview_limit_minutes` so the client's own graceful
   ending normally happens first.
2. **A client-side countdown**, which is the mechanism students actually
   experience. Silent until `interview_warn_minutes`, then a visible countdown,
   then at `interview_limit_minutes` the app calls the same `stop()` path the
   "End interview" button uses. The transcript is preserved and the student
   goes to their report exactly as if they had finished deliberately.
3. **The daily session quota** in `session_grants`. Even if a student disables
   the countdown in devtools, `sessions_per_day` bounds the total exposure to
   `sessions_per_day × limit` per student per day. This is what makes the soft
   client limit acceptable rather than decorative.

Record `duration_ms` on every submission. A session materially over the limit
means someone bypassed the countdown, and it is worth knowing which student and
how often before it becomes a bill.

**The limit is pedagogically defensible, not just financial**, and it should be
presented to students that way. Real research interviews are time-boxed, the
`structure` criterion already rewards a proper closing, and a visible countdown
teaches interview time management rather than merely rationing tokens. Twelve
minutes is a reasonable starting value: long enough that Layer 3 is reachable
by a good interviewer, short enough to bound cost.

Both values live in `settings` so the instructor can tune them per cohort from
the dashboard without a deploy.

### Two more operational risks the key change introduces

**Concurrency.** Every student used to bring their own rate limit. Now 400
share one organisation. A lab session with 30 students starting together is 30
concurrent realtime connections on one account. **Find out what concurrent
realtime session limit the university's arrangement carries** before the first
class. This is a question for whoever administers the OpenAI collaboration, not
for IT, and it is the single number most likely to ruin a first session.

**Quota.** Free-to-you is not free-to-the-university. The `session_grants`
check belongs in the first build, not a later one, and it is the backstop the
time limit depends on.

---

## 6. Authentication

Email plus a mailed six-digit code, against the pre-loaded roster.

### Flow

```
1. Student enters university email
2. SELECT student_id, full_name FROM roster
     WHERE email = lower(?) AND active = 1
3. Found     → generate code, store hash, send it
   Not found → do nothing, but still return 200
4. Student enters the code
5. Verify → signed session cookie carrying student_id
6. Every submission is stamped with the roster's student_id
```

**The student never types their student ID.** It is already in the roster, and
asking for it again only creates a way for a real submission to carry a typo'd
identifier. The roster row is authoritative.

The security rests on one property: **the code goes to an address already on
file, never to one the student supplies.** Student numbers are semi-public;
inboxes are not. If you change nothing else from this section, keep that.

### Session

An HMAC-SHA256 signed cookie carrying `student_id | expiry | version`, signed
with a Worker secret. Stateless, so no storage read per request and nothing to
clean up. If early revocation is ever needed, add a `token_version` integer to
the roster row and include it in the signed payload.

Flags: `HttpOnly; Secure; SameSite=Lax; Path=/`.

**"Remember this device"** sets a 90-day cookie instead of the 8-hour default.
At 400 students this materially cuts both email volume and the support queue,
and it is a checkbox plus a longer `Max-Age`. Include it in the first build.

### Security checklist

Each of these is load-bearing. Together they are the difference between working
authentication and the appearance of it.

- [ ] `/api/auth/request` returns 200 whether or not the email is in the
      roster, so the endpoint cannot be used to enumerate enrolment.
- [ ] Codes generated with `crypto.getRandomValues`, never `Math.random`.
- [ ] Store SHA-256 of the code, never the code.
- [ ] Constant-time comparison on verify.
- [ ] Maximum 5 attempts per code, then invalidate. Six digits is a million
      combinations, which a script clears in seconds.
- [ ] Ten-minute TTL. One live code per address; a new request overwrites.
- [ ] Rate limit `/api/auth/request`: 1 per 60s and 5 per hour per email, plus
      an IP limit. Without this it is an email-bombing tool aimed at any
      student whose address someone knows, and it drains the send quota.
- [ ] Session cookie flags exactly as above.
- [ ] The university OpenAI key is a Worker secret, never in source, never in
      a response body, never logged.

### Delivery: tell the student, configure the sender

**The code screen says to check spam.** Finding it there is the student's job,
and saying so in the interface removes most of the support traffic before it
starts. Suggested copy, following the no-em-dash rule that governs all
user-facing text in this app:

> We sent a 6-digit code to name@university.example. It can take a minute to
> arrive. If it is not in your inbox, check your spam or junk folder.

Show the address back to them, since a typo is the other common cause, and put
a "send it again" control on the same screen with the 60-second rate limit
applied.

**Sender configuration is a separate problem and still has to be done.**
Telling students to check spam solves spam-foldering. It does not solve
rejection: a domain without SPF, DKIM and DMARC gets mail *refused* by many
university mail servers rather than filed in junk, and no amount of looking in
the spam folder recovers a message that was never accepted. Configure all three
on the sending domain, and send one test code into a real inbox on your
students' actual mail system before the cohort arrives. That is a one-time
setup, not an ongoing burden.

**Build the break-glass path in the first build.** A few students will not
receive the mail for reasons neither you nor they can see: a forwarding rule, a
full mailbox, a filter policy set by their faculty. `POST /api/admin/breakglass`
(§4) mints a session for a given student ID so you can hand someone a working
link without debugging their mail system. Twenty lines, and it will be used.

---

## 7. The instructor dashboard

Served at `/admin`, **behind Cloudflare Access**, which is free up to 50 users
and therefore free for a teaching team of 8. Access handles the login itself
(Google or Microsoft SSO, or its own email OTP), so there is no second
authentication system to write, and no instructor password anywhere in this
app. The Worker reads `Cf-Access-Jwt-Assertion` to learn which instructor is
acting, and writes that into `updated_by` / `saved_by` so every change is
attributable.

Four areas, in the order they earn their place.

### Settings

A form over the `settings` table (§3). The instructor can change the interview
time limit, the warning threshold, the daily session quota, both model ids, the
instructor recipient list, and the OpenAI key, without a deploy and without
`wrangler`.

**The API key needs specific handling.** Putting it in the database rather than
in a Worker secret is a real trade: it buys rotation without a deploy, and it
costs the extra protection a secrets store gives. That is an acceptable trade
here, but only with these rules:

- **Write-only.** `GET /api/admin/settings` returns a masked value
  (`sk-…last4`) and never the key itself. There is no "reveal" button. An
  instructor who needs the key has it from wherever they got it originally.
- **Never in a response body, never in a log line, never in an error message.**
  The 401 path from OpenAI is the one that most often leaks a key into a log;
  check it specifically.
- **Record `updated_at` and `updated_by` on every change**, so a key rotation
  is traceable to a person.
- Validate on save with a cheap authenticated call (`GET /v1/models`) and
  refuse to store a key that does not work. Saving a broken key silently is how
  you discover the problem during a class.

### Roster management

List, search, add, edit, deactivate, and bulk CSV import with upsert.

Two rules the UI has to enforce rather than merely encourage:

- **Deactivate, never delete.** `submissions.student_id` references the roster,
  so a delete either fails or orphans reports. The button says "Deactivate",
  sets `active = 0`, blocks login, and leaves the history readable.
- **Lowercase every email on write**, whether it arrives through the form or a
  CSV. Login looks up by lowercased email, and a single capital letter in an
  import is otherwise an unfindable "the code never arrives" report.

The CSV import should show a diff before applying: how many rows are new, how
many change an existing student, how many are unchanged. A silent 400-row
upsert is unreviewable, and enrolment files usually arrive with at least one
surprise.

### Persona management

Full CRUD over the `personas` table, including `system_instruction` and
`hidden_core`. This is the one dashboard area where the spoilers are legitimately
visible, and it is behind Access, so that is fine.

**`persona_versions` is not optional.** Moving personas out of `personas.ts`
means giving up git's history, diffs, review and rollback, and these are not
ordinary content: `CLAUDE.md` records that Elena's Layer 1 and 2 material is the
instructor's original writing and must be preserved. A web form with no history
is one distracted afternoon away from losing it. So every save writes a full
snapshot, snapshots are never deleted, and the persona editor offers "view
history" and "restore this version".

Keep the three built-in personas seeded from `src/personas.ts` as the initial
rows, and keep that file in the repo as the origin point. It costs nothing and
it is the ultimate restore.

Two things the editor should check on save, because they are the failure modes
that would quietly break the exercise:

- **`short_bio` must stay spoiler-free.** It is the only persona text students
  see before the interview. A warning next to the field is enough; this is a
  judgement a human makes, not something to validate mechanically.
- **A persona with no `hidden_core` degrades scoring gracefully but silently.**
  The `cue_pursuit` and `depth_reached` evaluators fall back to judging depth
  from the transcript alone. Say so in the editor rather than letting an
  instructor discover it from oddly generous scores.

New personas also need the shared disclosure mechanics appended, exactly as
`buildCustomPersona()` does today. Do that **server-side at mint time**, not by
pasting the rules into the editor, so no persona can be saved without them.

### Submissions

List with filters on cohort and date range, open a full report, export CSV.

This is what replaces reading 400 emails, and it is the area that can wait
longest: the emails still arrive whether or not this screen exists. Sort by
`duration_ms` descending occasionally to see who is running past the interview
limit (§5).

---

## 8. Client changes

Most of the app is untouched. The interview screen, the speech meters, the
metrics, the transcript rendering and the report layout all stay.

**Removed**

- The API key field, its validation, and the `riv.apiKey` / `riv.rememberKey`
  localStorage handling.
- `src/lib/scoring.ts` execution on the client. The rubric definitions move to
  the Worker.
- `src/personas.ts` from the bundle. The client gets picker fields from
  `/api/personas`.
- If §2 is positive: the `instructions` payload in `configureSession()`, and
  possibly that whole `session.update` message.

**Added**

- A login screen. `App.tsx`'s phase machine gains `"login"` before `"setup"`.
  Two steps: enter email, then enter code. The code step shows the address back
  to the student, tells them to check spam (§6), and offers "send it again"
  under the same 60-second rate limit the server enforces.
- An `identify`-backed `/api/me` check on load, so a remembered device skips
  straight to setup.
- **A countdown in `InterviewScreen`.** Silent until `warnMinutes`, then
  visible, then at `limitMinutes` it calls the same handler the "End interview"
  button uses. Both values come from `POST /api/session`, never hardcoded.
  Present it to students as part of the exercise rather than as a restriction:
  a real research interview is time-boxed, and closing well inside the time is
  something the `structure` criterion already rewards.
- A separate `/admin` entry point (§7). It shares the design language and
  nothing else. Do not let admin views and student views share routing or
  state; the student app has no router today and does not need one.

**Changed**

- `createEphemeralToken()` in `liveSession.ts` calls `POST /api/session`
  instead of OpenAI. It no longer holds a key. This is a smaller change than it
  sounds: same shape, different URL, no `Authorization` header.
- `ResultsScreen` receives scores from one `POST /api/report` rather than nine
  promises. **Expect a UX regression:** criteria no longer fill in one by one,
  and per-criterion retry becomes whole-report retry. A 10 to 20 second spinner
  replaces progressive rendering. Acceptable, but do not let it surprise you.
- The Markdown export can stay entirely client-side, unchanged.

`main.tsx` still must not use `StrictMode`, for the same reason as before.

---

## 9. Keeping the Canvas and university-VM doors open

None of this is built now. All of it is free if decided now and expensive if
retrofitted.

**One `identify(request) → Student` function, called by every handler.** In
this build it verifies the session cookie. Under Canvas it reads an LTI JWT
claim. Under university SSO it reads an OIDC claim. Nothing downstream changes.
This single abstraction is most of what makes a later Canvas integration a
two-day job rather than a rewrite. Do not let handlers reach for the cookie
directly.

**`roster.lms_user_id`**, nullable and unused, so that when Canvas arrives you
backfill it and the join already exists.

**`submissions.overall_score`** as a real column from day one, even though the
report is emailed rather than posted. Canvas grade passback (LTI Assignment and
Grade Services) is then a read from that column rather than a migration plus a
backfill.

**D1 only, no KV, no Durable Objects.** Plain SQL and a plain schema port to
SQLite or Postgres on a university VM without translation.

**Keep the OpenAI and email calls in thin modules with no Cloudflare imports.**
They are `fetch` calls; keeping them free of platform types means they lift to
Python almost mechanically.

**Keep the frontend's API base URL configurable** rather than assuming same
origin, so pointing the client at a university-hosted backend later is a config
change and not a code change.

**Keep the API surface to the seven endpoints in §4.** The realistic migration
path is reimplementing that contract in FastAPI, which is a few days of
mechanical work at this size and stops being a few days the moment the surface
sprawls. Treat additions to §4 as a decision, not a detail.

---

## 10. Build order

The stages exist to bound risk, not to bound typing. With AI-assisted
implementation the whole thing is perhaps a thousand lines of Worker code, a
schema, and a moderate client refactor, so the honest answer to "can this be
done in one pass" is yes.

**Recommended: build 1 and 2 together, ship gated on 1.** They share the schema,
the identity abstraction and the settings table, so splitting them means editing
the same files twice for no benefit. Build 3 depends on nothing in the student
flow and can land at any point after.

| | Contents | Ship gate |
|---|---|---|
| **Build 1** | Worker + static assets. `roster`, `login_codes`, `request_log`, `session_grants`, `settings`. Auth with remember-device and break-glass. Token minting with quota and time limit. Server-side scoring. Email dispatch. Client refactor per §8. | Must work before the cohort starts |
| **Build 2** | The dashboard behind Access (§7): settings, roster management, CSV import. `submissions` persistence and the submissions views. | Settings and roster before the cohort; submissions views can follow |
| **Build 3** | `personas` and `persona_versions`, seeded from `src/personas.ts`. Persona editor with history and restore. | Any time after Build 1 |

Build 2 splits along a natural line if the deadline gets tight: **settings and
roster management are needed from day one** (you cannot run a cohort without a
roster, and you want the time limit tunable during the first week), while the
submissions browser is a convenience that email already covers. Build the first
half, defer the second.

Build 3 replaces git as the persona store, which is a real loss of version
history, diffs and review. `persona_versions` (§7) is what buys that back, and
it is the reason that table is in the schema rather than being an optimisation
to add later.

### What one-pass implementation does and does not change

It removes the typing constraint. It does not remove the review constraint, and
review is what actually protects you here: this build handles student identity,
a university API key, and a cost lever with 400 students behind it. All three
are expensive to get wrong in ways that are invisible until they are not.

**Read these by hand, whoever or whatever wrote them.** Roughly 200 lines in
total:

- the `/api/auth/verify` path, in full;
- rate limiting on `/api/auth/request`;
- session cookie signing and verification;
- every line that touches the OpenAI key, including the masking on
  `GET /api/admin/settings` and the 401 error path that most often leaks it;
- the `session_grants` quota check and the time limit passed at mint;
- the roster import path;
- the Access JWT check that guards every `/api/admin/*` route. A missing check
  on one admin endpoint exposes the roster, the personas, or the key.

Everything else in this plan (student UI, email templates, report formatting,
the dashboard's presentation layer) is low-consequence and fine to accept after
a skim. The distinction is not who wrote the code, it is what the code can cost
you.

### Pre-flight checklist for the first cohort

- [ ] §2(a) and §2(b) verified and both answers recorded.
- [ ] Concurrent realtime session limit for the university account known.
- [ ] SPF, DKIM, DMARC configured; a test code delivered to a real student-side
      inbox, not just to your own.
- [ ] Roster imported and spot-checked against the registry.
- [ ] Rate limits and the daily quota exercised against a real deploy.
- [ ] Time limit exercised end to end: countdown appears, hard stop fires, the
      report still generates from the truncated interview.
- [ ] Every `/api/admin/*` route confirmed to reject a request without an
      Access JWT. Test this by hitting them directly, not through the UI.
- [ ] Break-glass path used at least once, by someone who is not you.
- [ ] One full interview run end to end on the deployed Worker, with a real
      microphone, on the hosted origin.
- [ ] A rollback plan: the current client-side build still works with a
      personal API key, so keep it deployable as a fallback for one semester.

---

## 11. Deliberately not built

- **Canvas/LTI and university SSO.** Doors held open per §9, no work done.
- **University-hosted infrastructure.** Same.
- **Audio storage.** Never. Transcripts and scores only.
- **A second authentication system for instructors.** Cloudflare Access is the
  instructor login. Do not write one.
- **A "reveal key" control in the dashboard.** See §7.
- **A single batched scoring call.** See §5.
- **Anything that makes the Worker a general-purpose application server.** If
  the API surface in §4 starts growing, that is the signal from revised
  constraint #4 to stop and rethink, not to keep adding endpoints.
