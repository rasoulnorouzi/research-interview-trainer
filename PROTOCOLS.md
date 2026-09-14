# Change protocols

This file records each feature round as a protocol: what changed, which
decisions were made, how it was tested, and how it was deployed. Add new
rounds at the top. Write in ASD-STE100: short sentences, active voice,
one instruction per action.

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
