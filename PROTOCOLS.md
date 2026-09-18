# Change protocols

This file records each feature round as a protocol: what changed, which
decisions were made, how it was tested, and how it was deployed. Add new
rounds at the top. Write in ASD-STE100: short sentences, active voice,
one instruction per action.

---

## 2026-09-18 (evening) — Production moves to its own account and domain

Two branches merged into `main`: `cf-email-service` (the move) and
`editable-prompts` (the dashboard prompts and the help notes). Tagged
`release-2026-09-18-migration`. No schema change. The previous state of
the NEW deployment (Worker `c852b069`) is the rollback target; the older
account still runs the pre-move app untouched.

### What changed

1. **A new home.** The app runs at https://qualitativeinterviewskills.com
   in account `ef71fbe7795df43f5adddf5abdd8f4a7`, owned by a colleague and
   administered by the instructor. The workers.dev address and preview
   URLs are off. `www` redirects to the apex, 301, path preserved.
2. **The data moved.** The whole database was exported from the old
   account and imported into `riv-trainer`
   (`81264e33-443c-45ec-8593-3db6c01acd16`, WEUR), then compared table by
   table against the export: 5 roster, 8 personas, 13 criteria, 4
   submissions, 11 settings, 64 persona versions, 29 criteria versions.
3. **Mail left Resend for Cloudflare Email Service.** No mail API key
   exists any more; `SESSION_SECRET` is the only secret. `worker/email.ts`
   keeps zero Cloudflare imports and takes a `MailSender`; `mailer()` in
   `worker/db.ts` is the one place that knows the transport. Attachments
   became raw text with a media type, where Resend wanted base64.
4. **The dashboard login** is an Access app covering `/admin` and
   `/api/admin/*`, 24 hour session, two allowed addresses, with both
   "Login with Cloudflare" and one-time PIN enabled so a colleague without
   a Cloudflare account can sign in.
5. **The AI assessor's instructions are editable** from a new Prompts
   screen, backed by `shared/prompts.ts` and the settings rows
   `scoring_criterion_prompt` and `scoring_feedback_prompt`.
6. **Twenty "?" notes** across Settings, Prompts, Rubric, Personas and
   Break-glass.

### Decisions

- **The injection guard stays in code.** A template places it with
  `{{TRANSCRIPT_BLOCK}}` and is refused without it. Editing everything
  else is allowed; removing the guard is not.
- **An empty prompt row means the shipped default**, so the feature is
  inert until someone uses it, and "Restore default" clears rather than
  pastes.
- **A user API token, not an account-owned one**, because the instructor
  administers that account rather than owning it.
- **Zero Trust had never been enabled** on the new account. That, not a
  missing role, was behind "your current role does not allow this"; the
  owner enabled it.
- **The old deployment stays up** as the fallback. Anything written there
  from now on does not reach the new one.

### Tests done

- `npm run lint` and `npm run build` clean.
- Data compared against the export, row counts per table.
- Mail: test sends delivered to Gmail and to Microsoft 365 at
  `tilburguniversity.edu`; the instructor confirmed a real login code
  arrived at the university address from the new domain.
- Scoring through the live gateway against the real 13-criterion rubric:
  14 calls in 8.7 s, scores tracking planted flaws, one criterion
  correctly returned as not assessable.
- A prompt containing "begin every justification with MARKER" produced
  justifications beginning with MARKER, which proves the dashboard's text
  reaches the evaluator. An invalid template was refused with its reason.
- Help notes: all panels open and close, a "?" on a switch leaves the
  switch untouched, Escape closes, nothing overflows at 390px.
- After the deploy: `/` 200, `/api/me` 401, `/api/personas` 401, `/admin`
  and `/api/admin/*` 302 to Access, `www` 301 to the apex, and the live
  admin bundle contains the Prompts screen and the help notes.
- **Not done: a live voice interview on the new domain.** The instructor
  runs that with a microphone.

### Deploy

- Backup first: `backup-new-2026-09-18.sql` (1.16 MB, holds the key,
  gitignored).
- `npm run build && npx wrangler deploy` with the new account's token.
  Worker version `aee893e7-55d5-44d5-b028-e4e72567d749`.

### Rollback

- Code: `npx wrangler rollback c852b069-f1a1-424a-9828-4a76bea9ffb5` in
  the new account.
- Whole service: the old deployment at
  https://research-interview-trainer.rasoulnorouzi.workers.dev is still
  live with its own database and its own Resend mail. Point students back
  at it. Data created on the new deployment would have to be exported and
  imported to follow them.

---

## 2026-09-18 — Transcript consent before a student may submit

Branch `consent-gate`, three commits, merged into `main` with a merge
commit. One schema change: a new column on `submissions`. No settings
change, no key change, no new dependency. The release is tagged
`release-2026-09-18`. The state before it (Worker version `35820845`) is
tagged `release-2026-09-15`.

### What changed

1. **The question.** The results screen asks for consent before the
   student may submit. One box carries the instructor's wording in
   English and Dutch, answered with "Yes / Ja" or "No / Nee". The submit
   button stays disabled, with a bilingual hint under it, until one is
   chosen.
2. **"No" still submits.** The refusal is recorded. The interview is
   scored, stored and emailed exactly as with "Yes".
3. **The answer is stored.** `POST /api/report` carries `consent`, a
   required boolean, into `submissions.transcript_consent` (1, 0, or
   NULL for interviews from before the question existed).
4. **Every report names it**, as a block that quotes the English
   question: both emails in text and HTML, the two .txt attachments, the
   student's Markdown download, and the dashboard's submission detail
   and its Markdown export.
5. **One definition of the wording**, `shared/consent.ts`, used by the
   client, the Worker and the dashboard.

### Decisions

- **"No" does not block the submission** (instructor, 2026-09-18, after
  being asked directly). Consent that costs a student their coursework
  is not freely given, which is the standard an ethics committee
  applies. The instructor can reverse this in one line if they choose.
- **The answer is stored, not only shown.** A consent question nobody
  records is worthless for research.
- **A missing `consent` field is refused with `400`**, not stored as a
  refusal, so a stale client cannot be mistaken for a student who said
  no.
- **The report quotes the question**, because "Transcript consent: Yes"
  alone cannot be read in context later, and because the wording may
  change.
- **No `<fieldset>`/`<legend>`**: a legend sits on the border and reads
  as overlapping text. The answers are pills in the app's own style.

### Tests done

- `npm run lint` and `npm run build` clean.
- The results screen rendered with fake data in headless Chrome at
  1000px and at 360px, in light and dark: no overlap, no sideways
  scroll, no clipped text, measured in the page.
- The button disabled before answering, enabled after; the POST body
  carried `consent:false` after "No / Nee".
- All four email builders rendered for "Yes", "No" and "Not asked". Each
  copy carried the block exactly once; the assessor copy did not repeat
  it.
- Production after the deploy: `/` answers 200, `/api/me` 401,
  `/api/report` 401 without a cookie, `/admin` redirects to Access. The
  served bundle carries both language versions of the question.
- **Not done: a live interview on production.** The instructor tests
  that with a microphone.

### Deploy

- Backup first: `backup-2026-09-18.sql` (1.1 MB, holds the key,
  gitignored). D1 Time Travel bookmark
  `0000011e-00000000-000050ea-ce0ca2edbcb350a47af1149b2f0e9ff9`.
- Schema before code, as the old code never writes the column:
  `npx wrangler d1 execute riv-trainer --remote --command "ALTER TABLE
  submissions ADD COLUMN transcript_consent INTEGER"`.
- `npm run build && npx wrangler deploy` at 13:45 UTC. Worker version
  `ad77c84c-4204-4cc1-9846-31a7577bfc24`.

### Rollback

- `npx wrangler rollback 35820845-ed1b-4c3b-b8e5-41dc6e54b7a0`. The old
  code ignores the new column, so the column can stay. Nothing else has
  to be undone.
- For the data: `npx wrangler d1 time-travel restore riv-trainer
  --bookmark=0000011e-00000000-000050ea-ce0ca2edbcb350a47af1149b2f0e9ff9`.

---

## 2026-09-15 — The orb design (student app and dashboard)

Branch `ui-orb`, three commits (student design, dashboard design, orb
palette) plus a docs commit, merged into `main` with a merge commit. No
schema change, no settings change, no key change. One new client
dependency: `ogl`. The release is tagged `release-2026-09-15`. The state
before it (Worker version `596c8979`) is tagged `release-2026-09-13`.

### What changed

1. **A new look for both apps.** A white page with a faint violet and cyan
   glow, a floating translucent header, pill buttons, larger type, and
   soft motion: screens and cards rise in, buttons give under a press.
2. **The orb.** A WebGL orb (`src/components/ui/voice-powered-orb.tsx`,
   adapted from 21st.dev) sits on a dark stage. On the interview screen it
   swells and glows with the interviewee's voice, and more softly with the
   student's. It also greets the student on the login screen and heads the
   dashboard.
3. **Student screens.** Login: the orb stage with the form as a sheet
   below it. Setup: interviewees as rows with initials avatars and a check
   that springs in. Report: the overall score counts up above a bar that
   fills, and a thin bar runs while scoring.
4. **Dashboard.** A hero with the orb, a segmented tab bar whose highlight
   slides to the active tab, iOS-style switches, compact row buttons, and
   cards and table rows that rise in on each tab change.
5. **One palette from the orb:** an indigo accent, a violet-to-indigo blend
   on primary buttons, and the orb gradient on highlights only. The
   dashboard's green is gone.
6. **A bug fix:** on a phone, the dashboard's stacked search and add forms
   had large gaps between fields (a 10rem flex basis became a height).

### Decisions

- The instructor tried the design on a local test branch first, then
  asked for it to ship. It replaces the design rule of 2026-08-14
  (CLAUDE.md, constraint 2 is rewritten).
- The orb never opens the microphone. It reads the interview's own speech
  meters (`SpeechMeter.level`, `InterviewSession.levels()`). The original
  opened a second microphone stream with echo cancellation off, which can
  change how Chrome processes the call's audio.
- No Tailwind or shadcn: the app is plain CSS, and adding them would
  restyle every screen. The component sits in `src/components/ui/`, the
  shadcn-style folder, with a small `cn()` helper in `src/lib/utils.ts`.
- Everything is scoped with `:root:has(.student-app)` and
  `:root:has(.admin-root)`. Print output stays black on white. Motion
  stops under `prefers-reduced-motion`.

### Tests done

- `npm run lint` and `npm run build` clean.
- Headless Chrome with WebGL (SwiftShader), screenshots checked by eye:
  login (both steps), setup, interview, scoring, report; every dashboard
  tab; light and dark; desktop and phone width.
- A full interview through the production gateway: the orb level rose to
  about 0.2 to 0.5 while the student spoke and up to 0.98 while the
  interviewee spoke; the report was scored and shown.
- The instructor tried both apps locally and approved them.

### Deploy procedure

1. `npm run backup` (kept locally, never committed).
2. `npm run lint && npm run build && npx wrangler deploy`.
3. Smoke tests: `/` `200`; `/admin` and `/api/admin/settings` `302` to
   Access; `/api/personas` `401`; the live bundle carries the orb.

### Rollback

- **Worker, immediately:**
  `npx wrangler rollback 596c8979-1e1f-4a10-ac53-4b2c9188ca36` returns the
  gateway release with the old design. No key or setting changes with it.
- **Code, in git:** `git revert -m 1 <merge commit>` on `main`. The tag
  `release-2026-09-13` marks the old state.

### Deploy record, 2026-09-15

1. `npm run backup` wrote `backup-2026-09-15.sql`. D1 Time Travel
   bookmark before the deploy:
   `000000c3-00000000-000050e6-ac13121ce0fe5f25134063578af3d328`.
2. `main` merged `ui-orb` as `881afb3`, tagged `release-2026-09-15`. Lint
   and build clean. A last full interview on the final build passed.
3. `npx wrangler deploy` at 22:06 UTC on 2026-09-14: Worker version
   `35820845-ed1b-4c3b-b8e5-41dc6e54b7a0`. The previous version is
   `596c8979`. No downtime: no key, schema or settings change.
4. Smoke tests: `/` `200`; `/admin` and `/api/admin/settings` `302` to
   Access; `/api/personas` and `/api/me` `401`. The live bundles carry the
   orb styles, the palette and the gateway code.
5. GitHub: the instructor pushes `main` and the tag (no credentials on the
   machine that deployed).

---

## 2026-09-13 — AI calls through the university gateway (Tilburg.AI)

Branch `azure-migration`, one commit (`5614894`), merged onto the
2026-09-11 release on branch `azure-release` (merge `4f7fa9e`), then into
`main`. No schema change. One new Worker var: `AI_BASE_URL`. The release
is tagged `release-2026-09-13`. The state before it (Worker version
`79a99a60`) is tagged `release-2026-09-11`.

### What changed

1. **Every AI call goes to the gateway.** The university asked the project
   to stop calling OpenAI with its own key. The Worker reads the gateway
   address from `AI_BASE_URL` (`https://api.tilburg.ai/v1`). The voice
   token mint, every scoring call and the key check on the Settings screen
   go there. The gateway is LiteLLM in front of Azure OpenAI in Sweden
   Central, and it speaks the OpenAI API. The settings row
   `openai_api_key` kept its name and now holds the gateway key.
2. **The mint body has the gateway's shape:** a top-level `"model"` and an
   empty `session.model`. The OpenAI shape fails at Azure, and LiteLLM
   hides that error behind `429 "No deployments available"`.
3. **The browser sends its SDP offer to `callsUrl`,** a new field of the
   `POST /api/session` response. The browser retries once on a `404` or a
   network error. The Worker retries its own gateway calls once on a
   `404`. One gateway upstream answers a bare nginx `404` now and then.
4. **Only the university's models can be selected.** The model dropdowns
   offer `gpt-realtime-2.1-mini`, `gpt-5.6-terra` and
   `gpt-live-transcribe`. Other models show greyed out, and a saved model
   outside the list gets a red warning.
5. **Neutral texts.** Student and dashboard texts no longer name OpenAI.
6. **Voice preview** answers `502` with a message, because the gateway has
   no text-to-speech model yet.

### Decisions

- The audio stays browser-direct over WebRTC (constraint 5). A WebSocket
  relay through the Worker worked in tests and stays the fallback.
- The instructor chose that only university models can be selected
  (2026-09-11).
- The gateway key uses the existing settings row, so masking, rotation and
  removal work unchanged.
- Open: EU data residency. The instructor chose strict EU, but
  `gpt-realtime-2.1-mini` and `gpt-live-transcribe` are global
  deployments. The EU voice model `gpt-realtime-2.1` answers `403` for our
  key. Tilburg.AI must grant it.

### Blockers cleared before the release

- **LiteLLM bug #24659.** The gateway built the Azure mint address in the
  old preview shape, so every mint failed. Robert Smolders (Tilburg.AI)
  applied our patch, `litellm-azure-webrtc-fix.patch`, to the testing
  gateway on 2026-09-11.
- **DNSSEC.** On 2026-09-11 `tilburg.ai` failed DNSSEC validation: the
  `.ai` registry held a DS record for key 107, and the zone was signed
  with key 54271. Every validating resolver, Cloudflare's included,
  answered `SERVFAIL`. UvT IT corrected the DS record by 2026-09-13.

### Tests done

- 2026-09-11, testing gateway (IP pinned during the DNS fault): an A/B
  test of the mint body; a full browser WebRTC call; a full interview in
  the app with scoring and the report email.
- 2026-09-13, testing gateway, normal DNS, merged code:
  - `npm run lint` and `npm run build` clean.
  - Mint `200` for the three personas and for all ten voices. An unknown
    persona gives `404`. A fake key is refused (`400`), and the stored key
    stays.
  - A full interview in headless Chrome with a recorded voice as the
    microphone: SDP answer `201`, three interruptions, the heard-text note
    sent each time, no restart of the answer, no transcript on screen
    during the interview, the report scored in 14.6 s with the
    "(interrupted)" labels. Raw log:
    `~/Desktop/tilburg-app-e2e-raw-20260913T153701Z.log`.
- Production gateway, 2026-09-13 16:07 to 16:08 UTC, local Worker with the
  production key: the key check passes (`GET /v1/models` `200`, three
  models), but every mint fails with `429` from the gateway (app `502`),
  with a 25-minute and with a 12-minute limit. The same code and body
  give `200` on testing. This is the failure the testing gateway had
  before the patch, so the patch is most likely not on production yet.
  **Not deployed.** Robert Smolders was asked to patch production. Raw
  log: `~/Desktop/tilburg-prod-mint-raw-*.log`.
- Production gateway, 2026-09-14 19:19 to 19:22 UTC, after Robert patched
  production:
  - Two direct mints to `api.tilburg.ai` with the production key: `200`.
  - Local Worker with the production key and production's 25-minute
    limit: mint `200` for the three personas; a fake key refused (`400`).
  - A full interview in headless Chrome: SDP answer `201` from
    `api.tilburg.ai/v1/realtime/calls`, WebRTC connected, five
    interruptions with the heard-text note each time, no error events,
    no transcript on screen, the report scored in 14.5 s.
  - Raw logs: `~/Desktop/tilburg-prod-api-raw-20260914T192043Z.log` and
    `~/Desktop/tilburg-prod-e2e-raw-20260914T192043Z.log`.
- Production settings to change at the deploy: `interview_model` is
  `gpt-realtime-2.1` (the gateway answers `403` for our key) and
  `transcription_model` is `gpt-realtime-whisper` (not on the gateway).
  Set them to `gpt-realtime-2.1-mini` and `gpt-live-transcribe`. Both
  values also work on OpenAI, so they can change before the deploy.

### Deploy procedure

`DEPLOYMENT.md` §5, "Switching an existing deployment to the gateway", has
the steps: backup, check the model rows, deploy, then save the production
gateway key on the Settings screen at once. Interviews fail between the
deploy and the save.

**Deploy record, 2026-09-14.**

1. `npm run backup` wrote `backup-2026-09-14.sql` (kept locally, never
   committed; it holds the OpenAI key, the way back). D1 Time Travel
   bookmark before the changes:
   `000000be-00000000-000050e6-77530a885238d251ba45b0858f41273c`.
2. Production model rows changed: `interview_model` from
   `gpt-realtime-2.1` to `gpt-realtime-2.1-mini`, `transcription_model`
   from `gpt-realtime-whisper` to `gpt-live-transcribe`. `scoring_model`
   stayed `gpt-5.6-terra`.
3. `main` fast-forwarded to `azure-release` (`5a12f4a`), tagged
   `release-2026-09-13`. Lint and build clean.
4. `npx wrangler deploy` at 19:27 UTC: Worker version
   `596c8979-1e1f-4a10-ac53-4b2c9188ca36`, `AI_BASE_URL`
   `https://api.tilburg.ai/v1`. The previous version is `79a99a60`.
5. The instructor saved the production gateway key on the Settings
   screen at 19:35:35 UTC. Interviews failed for about 8.5 minutes.
6. Smoke tests: `/` `200`; `/admin` and `/api/admin/settings` `302` to
   Access; `/api/personas` and `/api/me` `401`. The live bundle carries
   `callsUrl` and the heard-text note, and no `api.openai.com`.

Open, 2026-09-14: the instructor asked for a longer admin login, like the
students' "Remember this device". The login page belongs to Cloudflare
Access, so the app cannot add a checkbox to it. The Access app "Research
Interview Trainer Admin" keeps a login for 24 hours. The instructor sets
its **Session Duration** (maximum one month) in the Zero Trust dashboard;
Claude Code's permission check blocked the API change.

### Rollback

- **Worker, immediately:**
  `npx wrangler rollback 79a99a60-61f3-4db0-87ce-abc2cbfe0457`. Then paste
  the OpenAI key on the Settings screen again: the old Worker checks keys
  against OpenAI and cannot use the gateway key. The `openai_api_key` row
  of the pre-deploy backup file holds the OpenAI key.
- **Code, in git:** `git revert -m 1 <merge commit>` on `main`. The tag
  `release-2026-09-11` marks the old state.
- **Forward again:** check out the tag `release-2026-09-13`, build, deploy,
  and paste the gateway key.

---

## 2026-09-11 — Welcome panel, persona cohorts, transcript after the interview

Branch `next-release`, three commits (one per feature), merged into
`main` with a merge commit. One additive schema change: the table
`persona_cohorts`. The release is tagged `release-2026-09-11`. The state
before it (Worker version `99cc3856`) is tagged `release-2026-08-31`.

### What changed

1. **Student welcome panel.** The card at the top of the student setup
   screen is no longer fixed text. Instructors write it on the Settings
   screen, with a live preview. It is the settings row `student_panel`
   (at most 4000 characters) and reaches the student on
   `MeResponse.panel`. No row means the old text; an empty text means no
   panel. `src/panel.tsx` renders headings, paragraphs, bullets and bold
   as text, never as HTML.
2. **Persona cohorts.** Each persona is shown to all students, or only
   to the roster cohorts the instructor ticks. The table
   `persona_cohorts` holds the links; no rows means all students. One
   SQL condition (`PERSONA_OPEN_TO_COHORT`) filters `GET /api/personas`
   and guards `POST /api/session`, which answers `404` for a persona of
   another cohort.
3. **Transcript after the interview.** The interview screen shows no
   transcript. The student reads it on the results screen and in the
   report. An interviewee turn that the student cuts off keeps only the
   words the student heard, ends in "…", and carries the label
   "(interrupted)" in the results, the emails, the dashboard and the
   scoring transcript (`TranscriptEntry.interrupted`). After a cut, the
   app also tells the model in a `system` note what the student heard.
   Per-turn speaking time of the interviewee now follows the audio.

### Decisions

- The panel travels on `/api/me` and `/api/auth/verify`, so the student
  API gets no new route.
- A persona with no cohorts stays open to all students. The existing
  personas, five of them made by teachers, need no change.
  `POST /api/report` does not check the cohort, so a cohort change
  during an interview does not lose the report.
- The instructor chose to hide the transcript during the interview.
- The realtime model writes its text seconds before it speaks it. For an
  interrupted turn, the instructor chose to cut the text by timing (the
  server's `audio_end_ms` times the voice's pace) over a second
  speech-to-text of the interviewee audio, and chose "…" plus the label.
- The server cuts the model's memory itself, but it also deletes the
  text of the cut answer, and the model then started its answer again.
  The heard-text note stopped that (3 of 4 runs without it, 0 of 8
  with it). A persona rule was tried instead and failed in 2 of 6 runs,
  so the persona prompt did not change. See PROMPTING.md.
- Open: a student who keeps saying "just a test" pulls the interviewee
  into helper talk. No tested rule fixed it.

### Tests done

- Panel: API round trips; 4001 characters and a non-text value give
  `400`; typed `<script>` shows as text; the dashboard preview matches
  the student page.
- Cohorts: raw API log. Students of two cohorts and one without a
  cohort each saw exactly their personas. Four cross-cohort session
  starts gave `404`. Validation gave `400`. Deleting a persona removed
  its links. Browser check of the editor and the student list.
- Transcript: live interruptions through the university testing gateway,
  driven in a headless browser with recorded speech. The received audio
  was transcribed as ground truth: the cut text was exact in one run and
  two words short in the other. Scoring accepted the label, and two
  evaluators named the interruption. The stored submission and the email
  carried the label. The instructor tested the interview screen.
- `npm run lint` and `npm run build` clean.

### Deploy procedure

1. `npm run backup` (writes `backup-2026-09-11.sql`, kept locally, never
   committed).
2. Note the D1 Time Travel bookmark before the change:
   `000000b3-00000000-000050e3-a823bceeae2595b3f828943440bc3876`.
3. `npx wrangler d1 execute riv-trainer --remote --file=schema.sql`. This
   adds `persona_cohorts` and changes nothing else. Do it before step 4,
   because the new Worker reads the table.
4. `npm run lint && npm run build && npx wrangler deploy`.
5. Smoke tests: `/` gives `200`; `/admin` and `/api/admin/settings` give
   a `302` to Access; `/api/personas` gives `401` without a session.

Do not run `seed-personas.sql` or `seed-criteria.sql`: they replace
rows, and production has personas that teachers made.

### Rollback

- **Worker, immediately:**
  `npx wrangler rollback 99cc3856-3c6e-474c-b2e0-8dc4fe5fe34c` returns
  the Worker that ran before this release. The `persona_cohorts` table
  and a saved `student_panel` row stay in the database; the old Worker
  ignores both.
- **Code, in git:** `git revert -m 1 <merge commit>` on `main` undoes the
  whole release. To undo one feature only, revert its own commit. The
  tag `release-2026-08-31` marks the old state.
- **Forward again:** check out the tag `release-2026-09-11`, then build
  and deploy.
- **Data:** D1 Time Travel restores the whole database to any minute in
  the last 30 days, for example to the bookmark in step 2
  (OPERATIONS.md §11). The backup file restores into an empty database.

---

## 2026-08-31 — Remember-device on by default

Branch `remember-default`, one commit. One line plus a comment in
`src/screens/LoginScreen.tsx`: the "Remember this device" box on the
login code step starts checked, so the default session lasts 90 days
instead of 8 hours. Students on a shared computer untick it. No server
change: the checkbox already carried the choice to `/api/auth/verify`.
Verified in a browser against wrangler dev.

---

## 2026-08-31 — Distinct report emails

Branch `email-distinct`, one commit, merged fast-forward into `main`.
No database change. Instructor request, after the student copy of a
report was mistaken for an assessor copy in an inbox that serves both
roles.

### What changed

The student's copy and the assessor's copy of a report email are now
marked apart in four ways:

1. **Subject.** Student: "Your interview report: <persona>, <date>"
   (or "Your interview transcript: ..." when scores are withheld).
   Assessor: "Assessor copy: <student name> (<id>), <persona>".
2. **Label band.** Each body opens with one line that names the copy:
   "Student copy. Sent to the student who did the interview." or
   "Assessor copy. Sent only to the assessment recipients, not to the
   student."
3. **Accent color.** Student mail keeps the app's navy. Assessor mail
   uses the dashboard's deep green. This is the same pairing that keeps
   the student app and the dashboard unconfusable.
4. **Structure and filenames.** The assessor body leads with the
   student identity block and no longer repeats the persona header.
   The assessor's two `.txt` attachments carry the student id in their
   filenames; the student's keep the short names.

### Tests done

- `npm run lint` clean. All three variants rendered from the real
  module (esbuild bundle, no re-implementation) and inspected in a
  browser: labels, colors, subjects, and the de-duplicated assessor
  header verified.
- One real report sent through wrangler dev; the assessor copy
  delivered in the new format.

### Deploy

Steps 1, 2, 4, 5 of the 2026-08-31 assessor-controls protocol below
(no seed step: no settings change).

Branch `assessor-controls`, four commits, merged fast-forward into
`main`. No database schema change.

### What changed

1. **Per-recipient switches** (`13984e1`). Each assessment recipient has
   an On/Off switch and a Remove button. Remove asks for confirmation
   first. A switched-off address stays on the list and gets no report
   emails. The stored format is unchanged in shape: one comma-separated
   string, with `!` before a switched-off address.
   `shared/recipients.ts` is the one definition of that format.
2. **AI feedback switch** (`13984e1`). The setting `generate_feedback`
   (default `1`) controls whether the feedback evaluator call runs at
   all. With `0`, no copy of a report has a feedback section, and the
   stored `feedback_json` holds the JSON value `null`. Rubric scoring
   does not change.
3. **Voice preview** (`13984e1`). The persona editor has a "Preview
   voice" button. It calls `POST /api/admin/voice-preview`, which speaks
   one fixed sentence through `gpt-4o-mini-tts` and returns MP3 bytes.
   The voice must be on the enforced voice list. The sample text is
   fixed server-side.
4. **Transcription model setting** (`d75f72e`). The setting
   `transcription_model` (default `gpt-live-transcribe`) selects the
   model that writes the student's live transcript. The server accepts
   only the ids in `shared/models.ts` `TRANSCRIPTION_MODEL_OPTIONS`.
5. **Share switch is subordinate to the feedback switch** (`4d028ee`).
   With "Generate AI feedback" off, students receive only their
   transcript. The dashboard disables the share switch and shows it as
   Off. The Worker applies the same rule itself. The stored share value
   is not rewritten, so sharing comes back when feedback comes back.

### Decisions

- The instructor first asked whether the two switches should be
  coupled. The first answer was a contextual note only, because the
  share switch also covers scores. The instructor then decided on the
  coupling. The coupling keeps the stored share value untouched.
- The transcription list is enforced server-side, unlike the interview
  and scoring model settings. Two reasons: the mint call answers `400`
  for an unknown transcription id, which stops interviews in front of
  students; and only models that stream words during speech may ever be
  offered (hard design constraint 3).
- The transcription options were chosen by a live test, not from
  documentation. A realtime session was driven with synthesized speech
  for each candidate model, and the transcription delta events that
  arrived before the turn commit were counted. `gpt-live-transcribe`
  (31) and `gpt-realtime-whisper` (32) stream during speech.
  `gpt-transcribe`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and
  `whisper-1` sent deltas only after the commit. Do not add them.

### Tests done (2026-08-31, against wrangler dev with local D1)

- Settings API: round-trips for both switches and the model; `400` for
  a bad switch value, an empty recipient list, a bad address (also a
  switched-off one), and an off-list transcription id.
- Voice preview: `200` `audio/mpeg` for a valid voice; `400` for a bad
  voice or body; `405` for GET. All ten voices answered `200` on the
  TTS model in a direct probe.
- Reports, scored live with the real key: feedback off gave
  `feedback: null` and stored `'null'`; feedback on gave full feedback;
  feedback off with share stored on gave the student the
  transcript-only `shared: false` shape while the stored row kept its
  scores; the instructor email went only to the switched-on address.
- Session mint: `POST /api/session` succeeded under both transcription
  models.
- Browser: confirm-dialog text, toggle save round-trips, the all-off
  warning, the disabled share switch and its recovery, voice clips
  played to the end with a cache hit on replay, Submissions detail with
  and without feedback, no console errors.

### Deploy procedure

1. `npm run lint`
2. `npm run build`
3. `npx wrangler d1 execute riv-trainer --remote --file seed-settings.sql`
   (INSERT OR IGNORE; adds the `generate_feedback` and
   `transcription_model` rows. A missing row also works: the Worker
   defaults both.)
4. `npx wrangler deploy`
5. Smoke tests: `/` gives `200`; `/admin` and `/api/admin/settings`
   give a `302` to Access; `/api/personas` gives `401` without a
   session.

### Rollback

`npx wrangler rollback` returns to the previous Worker version. The
seeded settings rows are harmless to an older Worker, which ignores
them. D1 Time Travel restores data if needed (OPERATIONS.md §11).
