# Change protocols

This file records each feature round as a protocol: what changed, which
decisions were made, how it was tested, and how it was deployed. Add new
rounds at the top. Write in ASD-STE100: short sentences, active voice,
one instruction per action.

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
