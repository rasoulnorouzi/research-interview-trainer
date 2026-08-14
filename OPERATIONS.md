# Operations

This document is for the instructor running a cohort on the Research
Interview Trainer. It covers day-to-day running of the app: settings,
roster, personas, submissions, and cost control. It does not cover
deployment; see [`DEPLOYMENT.md`](DEPLOYMENT.md) for that.

Everything here is done from the instructor dashboard at `/admin`, behind
Cloudflare Access, unless a step says otherwise.

## 1. Settings and safe ranges

The Settings screen edits the `settings` table. A change here takes effect
on the very next request. No redeploy is needed.

| Key | Meaning | Default | Safe range |
|---|---|---|---|
| `openai_api_key` | The university's OpenAI key. Write-only; the dashboard never shows the full value. | none, must be set | Any key valid for your account. The dashboard tests it before saving and rejects a broken key. |
| `interview_limit_minutes` | Interview length before the app ends the session for the student. | 12 | 5 to 20. Shorter than 5 rarely reaches the deeper persona layer. Longer than 20 raises cost with little teaching benefit. |
| `interview_warn_minutes` | When the on-screen countdown becomes visible. | 10 | Must be less than `interview_limit_minutes`. The dashboard rejects a save that violates this. |
| `sessions_per_day` | How many interviews one student may start per day. | 5 | 1 to 10. This is the real backstop on cost: see section 8. |
| `interview_model` | The OpenAI realtime model used for the spoken interview. | `gpt-realtime-2.1-mini` | Any realtime model id your key can reach. |
| `scoring_model` | The OpenAI model used for all nine scoring calls. | `gpt-5.6-terra` | Any text model id your key can reach. |
| `instructor_recipients` | Comma-separated email addresses that get a copy of every report. | none, must be set | At least one address. The dashboard rejects an empty list. |

**Caution.** The dashboard validates `openai_api_key` live against OpenAI
before saving it. It does not validate `interview_model` or
`scoring_model` the same way. A typo in either model id is not caught at
save time. It surfaces later, as a failed interview or a failed report,
when a student hits it. Check a model id change with a real interview
before trusting it for a class.

## 2. Roster import

The roster is the list of students allowed to log in. Import it as a CSV
file, either through the dashboard or with `wrangler d1 execute` directly.

### CSV format

The first line is a header. Two forms are accepted.

```
student_id,email,full_name,cohort
2026001,jane.doe@tilburguniversity.edu,Jane Doe,2026-2027-S1
2026002,john.roe@tilburguniversity.edu,John Roe,2026-2027-S1
```

The `cohort` column is optional. Without it, use a three-column header:

```
student_id,email,full_name
2026001,jane.doe@tilburguniversity.edu,Jane Doe
```

**Rule: lowercase every email.** The importer lowercases each address
automatically. Login also looks up by lowercased address. A capital
letter left in by hand elsewhere is the single most common cause of "the
code never arrives."

### Preview, then apply

Do not upload a roster file directly into the live table. Always preview
first.

1. On the Roster screen, upload the CSV.
2. Choose **Preview**. The dashboard reports how many rows are new, how
   many change an existing student, and how many are unchanged, plus a
   list of any invalid lines and why.
3. Review the counts. A surprise here, such as far more "changed" rows
   than expected, usually means a stale export or a wrong file.
4. Choose **Apply** only once the preview looks right.

### Deactivate, never delete

The roster has no delete action, only deactivate. A student's submissions
reference their roster row, so deleting it would break or orphan their
reports.

To remove a student's access, deactivate them instead. Deactivation blocks
login immediately and keeps their history intact.

### Mid-semester re-import

Re-running an import is safe at any point in the semester. It **upserts**:
it adds new students and updates changed ones, by matching on
`student_id`. It never deactivates or removes a student who is simply
absent from the new file. If a student has left the course, deactivate
them by hand; do not rely on a re-import to do it.

## 3. Key rotation

Rotate the OpenAI key from the dashboard, not from the command line, after
the first bootstrap in [`DEPLOYMENT.md`](DEPLOYMENT.md) section 2.

1. Open **Settings**.
2. Enter the new key in the OpenAI key field.
3. Save.

The dashboard makes a live, cheap call to OpenAI to confirm the key
works, before it writes anything. If the key does not work, nothing is
saved and you see an error. The previous key stays in effect until a
working replacement is saved.

The dashboard never displays a full key, before or after rotation. It
shows only the last four characters, for example `sk-...a1b2`. There is no
"reveal" control. If you need the full key again, get it from wherever
you first obtained it.

## 4. When a student gets no code

Work through these in order.

1. **Ask them to check spam or junk.** This resolves most cases. The
   login screen already tells students to do this.
2. **Confirm the address is correct.** The code step shows the address
   back to the student. A typo there means they are asking a code to be
   sent to an address that is not theirs, and not on the roster either.
3. **Check the rate limits.** A student who has requested a code more
   than once in the last minute, or more than five times in the last
   hour, will not get a new one until the window passes. The app does not
   distinguish this case in its own message, since revealing it would
   also reveal whether an address is enrolled.
4. **Use break-glass** if none of the above explains it. Some students
   never receive the mail for reasons neither of you can see: a
   forwarding rule, a full mailbox, a filter set by their faculty.

### Break-glass procedure

1. In the dashboard, find the student by name, ID, or email.
2. Trigger break-glass for that student.
3. The dashboard returns a one-time link, valid for 15 minutes.
4. Send that link to the student through a channel other than email,
   since email is the channel that is failing. Use the LMS, chat, or hand
   it to them in person.
5. The student opens the link. It logs them in directly and sends them to
   the app.

**Caution.** The link works once. It expires after use or after 15
minutes, whichever comes first. If it expires unused, trigger break-glass
again for a fresh one.

## 5. Personas

Edit personas from the **Personas** screen. Full CRUD is available there,
including the fields that must stay hidden from students.

### Editing rules

- **Keep `shortBio` spoiler-free.** It is the only persona text a student
  sees before the interview starts. It must describe the persona and the
  research topic without hinting at the layer-two or layer-three material
  the student is supposed to discover. The dashboard does not check this
  for you; it is a judgment call every time you save.
- **`hiddenCore` improves scoring, and its absence is not an error.**
  Two of the eight rubric criteria, noticing cues and depth of discovery,
  need a ground-truth summary of what the persona was hiding, to judge
  how far the student actually got. Without `hiddenCore`, those two
  criteria are still scored, from the transcript alone, but less
  precisely. The editor notes this when the field is empty.
- **Mechanics are appended automatically.** Do not paste the shared
  disclosure rules, the ones covering hints, retreat, and pacing, into a
  persona's own text. The server appends them at the moment an interview
  starts. A persona row holds only its own material.

### Version history and restore

Every save, whether creating a persona or editing one, writes a full
snapshot before the change takes effect. Snapshots are never deleted.

To view history:

1. Open the persona.
2. Choose **View history**.
3. Each entry shows when it was saved and by whom.

To restore an old version:

1. Open the version you want from the history list.
2. Choose **Restore this version**.
3. This saves it as the new current version. It also creates one more
   snapshot, of the restore itself, so history stays complete.

**Note.** Elena van Dijk's first two layers are the instructor's original
material. Preserve them exactly if you ever restore or edit that persona.

## 6. Submissions

The Submissions screen lists every completed interview. The student
clicks "Submit interview for scoring" on the results screen. Only then
is the report scored, stored, and emailed. Every submission also arrives
by email, so this screen is a convenience, not the only record.

### Filters

Filter the list by cohort and by a date range on when the interview
started.

### Spotting overruns by duration

Sort by duration, descending, to see the longest interviews first. A
session that ran well past `interview_limit_minutes` usually means the
student's client-side countdown was bypassed, since the server has no way
to force-stop an interview already in progress. See section 8 for what
this does and does not mean for cost.

### CSV export

Export the current filtered list as a CSV file. Each row is one
submission. Each rubric criterion gets its own column. A criterion that
was not assessable exports as an empty cell, never as a zero: the two are
different things, and the export must not blur them.

## 7. Semester rollover

Do these steps at the start of a new cohort.

1. **Import the new cohort's roster**, following section 2. Use a new
   `cohort` value for the new group of students.
2. **Deactivate the previous cohort**, if those students should no longer
   log in. Import does not do this automatically; do it by hand, or with
   a bulk update if your dashboard build supports one.
3. **Leave the daily quota alone.** `sessions_per_day` counts against a
   calendar day, not a semester. It resets on its own every day and needs
   no action at rollover.
4. **Confirm `instructor_recipients` still points to the right people**,
   if the teaching team changed between semesters.

## 8. Cost controls

Three settings bound what one interview, and one cohort, can cost.

### Time limit

`interview_limit_minutes` and `interview_warn_minutes` drive the
on-screen countdown a student sees. When the limit is reached, the app
ends the session the same way the "End interview" button would, and the
student still gets a report from what was recorded.

This is a client-side control. Nothing on the server forces a running
realtime session to stop at the limit. A student who disables the
countdown, for instance through browser developer tools, is not stopped
by this setting alone.

### Daily quota

`sessions_per_day` is what makes the time limit meaningful even when a
student bypasses it. However long any one session runs, no student can
start more than this many per day. This is the real backstop: total daily
exposure per student is bounded by roughly `sessions_per_day` times
`interview_limit_minutes`, not by the time limit alone.

### What a `duration_ms` overrun means

Every submission records its actual duration. A duration well past
`interview_limit_minutes` is not a bug in the app. It means one specific
student ran a session past the intended limit, most likely by working
around the client-side countdown. It is not, by itself, evidence of
routine cost overrun across the cohort, since the daily quota still
bounds the worst case per student per day.

Check the Submissions screen sorted by duration, from time to time,
particularly early in a cohort, to see whether this is happening and how
often, and to which students.
