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
| `sessions_total` | How many interviews one student may start, in total, for the whole course. | 10 | 1 to 30. This is the real backstop on cost: see section 9. Use the Reset sessions button on the Students screen (the roster) to give one student more. |
| `interview_model` | The OpenAI realtime model used for the spoken interview. | `gpt-realtime-2.1-mini` | Any realtime model id your key can reach. |
| `scoring_model` | The OpenAI model used for every scoring call: one per active rubric item, plus feedback. | `gpt-5.6-terra` | Any text model id your key can reach. |
| `share_report_with_student` | Whether the student's copy of the report includes the scores and the feedback. | `1` (students receive them) | `1` or `0`. The dashboard shows this as a checkbox. Report mail always attaches the transcript as a text file; the assessment text file goes to the student only with `1`, and to the instructors always. |
| `instructor_recipients` | Email addresses that get a copy of every report. Stored as one comma-joined string. | none, must be set | At least one address. The dashboard rejects an empty list. |

The Settings screen presents `interview_model` and `scoring_model` as
dropdowns over a curated list of ids, and `instructor_recipients` as a
list with Add and Remove controls, not a text box. Picking a model this
way is the normal path. The API itself still accepts any non-empty model
id, so a value set straight in the database also works and shows in the
dropdown as the current choice.

**Sending scores to students.** The checkbox "Send scores and feedback to
students" controls the student copy of the report, and nothing else. With
it off, the student sees only the speaking metrics, the transcript and a
short notice on the results screen, and their email contains only the
transcript. The interview is still scored, the assessment recipients still
receive the full scored report, and the complete report is still stored
and readable under Submissions and in the CSV export. Switch it back on
and the next interview submitted shows the student everything again.
Reports already sent are not resent.

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

1. On the Students screen (the roster), upload the CSV.
2. Choose **Preview**. The dashboard reports how many rows are new, how
   many change an existing student, and how many are unchanged, plus a
   list of any invalid lines and why.
3. Review the counts. A surprise here, such as far more "changed" rows
   than expected, usually means a stale export or a wrong file.
4. Choose **Apply** only once the preview looks right.

### Deactivate, or remove permanently

Deactivating a student is the normal way to remove their access. It
blocks login immediately and keeps their history intact. Use the
**Deactivate** button on the Students screen (the roster).

A second control, **Remove**, deletes the student for good, together
with **all of their stored reports and transcripts**. The confirmation
dialog says so before anything is sent; read it. Emailed copies of the
reports are not affected. Use Remove when the record itself must go: a
typo in a student ID, a student added to the wrong cohort, or a student
whose data must be erased. Use Deactivate when the student must only
lose access and the reports must stay. A permanent removal also clears
the student's pending login code and their session quota count, so a
student re-added under the same ID later does not inherit the old
count. If a removal was a mistake, D1 Time Travel (section 11) can
restore the database to a point before it.

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

Once a key is set, the Settings screen shows a status line under the key
field: the masked value, who saved it, and when. A separate **Remove
key** control clears the stored key entirely, with a confirmation prompt.
Use it to shut off the service on purpose, for example between cohorts.
After removal, students see "not configured" and cannot start or submit
an interview until a working key is saved again.

## 4. When a student gets no code

The login screen now names the problem directly, on the failed request
itself, rather than leaving a student to guess. Start by asking what
message they saw.

1. **"This email address is not on the course list. Check for typos or
   contact your instructor."** The address is not on the roster, is
   misspelled, or is a personal address instead of the university one.
   Check it against the roster in section 2 and correct it if it is
   wrong, or add the student if they belong on the course but are
   missing.
2. **"Too many attempts. Wait a minute and try again."** The student, or
   someone sharing their network, has hit a rate limit: more than one
   request in the last minute, more than five in the last hour for that
   address, or more than 120 in the last hour from the same network
   (see `API.md` section 4). Ask them to wait a minute and try again.
3. **"The code email could not be sent. Try again in a minute."** The
   address was accepted but Resend failed to deliver the message. Ask
   the student to try again in a minute. If it keeps happening, check
   the Resend account status.
4. **No error, but still no email.** Ask them to check spam or junk.
   This resolves most of these cases. The login screen already tells
   students to do this.
5. **Use break-glass** if none of the above explains it. Some students
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
  Two of the built-in rubric criteria, noticing cues and depth of
  discovery, need a ground-truth summary of what the persona was hiding,
  to judge how far the student actually got; any criterion marked "uses
  hidden core" on the Rubric screen (section 6) does. Without
  `hiddenCore`, those criteria are still scored, from the transcript
  alone, but less precisely. The editor notes this when the field is
  empty.
- **Mechanics are appended automatically.** Do not paste the shared
  disclosure rules, the ones covering hints, retreat, and pacing, into a
  persona's own text. The server appends them at the moment an interview
  starts. A persona row holds only its own material.
- **Voice is a dropdown, checked on save.** The editor offers only the
  voices the realtime API knows. The server also checks this itself, so
  a name outside that list is rejected at save time, not discovered later
  when a student tries to start an interview.

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

### Deleting a persona

The persona editor has a **Delete persona** control, set apart from Save
so it is never the button a hurried hand reaches for. It removes the
persona for good, and only works while no stored report references it.
If any report does, the dashboard answers with the count and refuses;
clear the persona's Active checkbox and save instead, which keeps it out
of the student list without touching the reports.

Version history is never deleted, even when the persona itself is.

## 6. Edit the rubric

Drag a rubric row by its handle to change the order with the mouse.
The order sets how reports list the items. The numeric order field in
the editor does the same and accepts exact values.

Edit the scoring rubric from the **Rubric** screen. Each item is one
criterion, scored by its own independent evaluator that sees only the
transcript and that one item.

### Adding or editing an item

1. Choose **New criterion**, or click an existing row to open it.
2. Write **Name** and **Description**. The description is what the
   evaluator reads verbatim to decide what behaviour it is judging.
3. Write the three anchors and set the top score, covered below.
4. Leave **Uses hidden core** off, unless this item judges how deep the
   student got into the persona's layered backstory. Only turn it on for
   an item like that; it shows the evaluator the persona's hidden
   backstory, which most items have no business seeing.
5. Set **Order**. Lower numbers appear first, in the report and on this
   screen. Built-in items use 10, 20, 30, and so on, so you can insert a
   new item between two existing ones without renumbering the rest.
6. Save.

### Writing anchors

Each anchor describes what the transcript actually looks like at that
score, not an instruction to the student. Write all three as
observations, in the third person, never addressed to the student.

- **The lowest score (1).** What a poor showing on this item looks like
  in the transcript.
- **The midpoint.** What a middling showing looks like. This is shown to
  the evaluator only when the item's scale has a true middle; a 2-point
  item has no midpoint line.
- **The top score.** What an excellent showing looks like.

Keep the wording neutral and specific enough that two different readers
would apply it the same way.

### Top score

Every item has its own top score, called **scale**, from 2 to 10. The
default is 5, which is what every seeded item uses. An item is scored
from 1 up to its own top score.

**If you change an item's top score, reword its anchors.** The midpoint
anchor describes the middle of whatever scale you choose, so changing
the top score without touching the anchors leaves the midpoint anchor
describing the wrong number.

### Activating and deactivating

The **Active** checkbox controls whether an item is scored on the next
interview. Deactivating an item is the normal way to retire it: it
disappears from every future report while every past report that used
it stays exactly as it was scored.

Two limits apply to the active set:

- **At most 20 items can be active at once.** Each active item costs one
  evaluator call per report, so the cap also bounds what one report
  costs. Deactivate an item before activating a 21st.
- **At least 1 item must stay active.** Without this, no interview could
  be scored at all. The dashboard refuses a save that would empty the
  rubric, and names the reason.

### Version history and restore

Every save, whether creating an item or editing one, writes a full
snapshot before the change takes effect. Snapshots are never deleted.

To view history:

1. Open the criterion.
2. Choose **View history**.
3. Each entry shows when it was saved and by whom.

To restore an old version:

1. Open the version you want from the history list.
2. Choose **Restore this version**.
3. This saves it as the new current version. It also creates one more
   snapshot, of the restore itself, so history stays complete.

### Deleting an item

The criterion editor has a **Delete criterion** control, set apart from
Save so it is never the button a hurried hand reaches for. It removes
the item for good, and only works while both of these hold:

- No stored report references it. If any report does, the dashboard
  answers with the count and refuses; deactivate the item instead, which
  keeps it out of future interviews without touching past reports.
- It is not the only active item left. Deactivate a different item
  first, or activate a replacement, if this is the last one standing.

Version history is never deleted, even when the item itself is.

### Restoring the full built-in rubric

If the rubric needs to go back to the eight built-in items exactly as
shipped, for example after experimenting with custom items, regenerate
and reload the seed file from the repository:

```bash
npm run seed:gen:criteria
npx wrangler d1 execute riv-trainer --remote --file=seed-criteria.sql
```

This reads `src/criteria.ts` and re-inserts each built-in item under its
original id. It does not remove any custom item you added; deactivate or
delete those separately if you no longer want them.

### What changes when

A rubric change applies to the **next** interview scored, never to a
report already stored. A stored report keeps the exact wording, top
score, and active/inactive state its criteria had at the moment it was
scored, so past reports never shift under a student after the fact.

## 7. Submissions

### One row per student

The list shows one row per student: name, ID, cohort, how many
interviews they submitted, the date of the last one, and their average
score across the scored interviews. Click a student's row to open their
interviews underneath; click again to close them. Click an interview to
open its full report. The Student ID search box narrows the list; a
partial ID also matches, so "0001" finds u000001, and a search that
leaves one student opens their row by itself.

### Select, download, delete

The student row's check box selects all of that student's interviews at
once; each interview under it also has its own. Two buttons appear
under the table once anything is selected.

**Download selected** saves every selected report as its own Markdown
file, scores and feedback included. One selected report downloads
directly as a .md file; more than one arrives as a single ZIP archive
with one file per report, named by student, date and persona. It is
built in the browser from the same data the detail view shows. For a
file without scores, open a single report and use its own download with
the include switch off.

**Delete selected** removes the selected submissions permanently. A
warning names the number of rows and asks for confirmation first; the
emailed copies are not affected. The same warning-then-confirm pattern
protects the other destructive controls: Remove, bulk Remove selected
and Reset sessions on the Students screen (the roster), and the
single-submission delete in the detail view.

### Download one submission

Open a submission to see the full report. The detail view has a switch,
"Include scores and feedback". It controls the screen, the Markdown file
and the print output together. "Download Markdown" saves a .md file.
"Print / Save as PDF" opens the browser print dialog; choose "Save as
PDF" there for a PDF file. With the switch off, both files carry only
the identity block, the metrics and the transcript, so you can hand the
file to a student while scores stay withheld.

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
to force-stop an interview already in progress. See section 9 for what
this does and does not mean for cost.

### CSV export

Export the current filtered list as a CSV file. Each row is one
submission. Each rubric criterion gets its own column. A criterion that
was not assessable exports as an empty cell, never as a zero: the two are
different things, and the export must not blur them.

### Deleting a submission

Open a submission's detail view to find its **Delete submission**
control, below everything else on the page. It removes the report and
its transcript from the dashboard for good. It does not touch the copies
already emailed to the student and to `instructor_recipients`.

There is no delete action on the list itself. Opening the detail view
first means you see the report before you remove it.

## 8. Semester rollover

Do these steps at the start of a new cohort.

1. **Import the new cohort's roster**, following section 2. Use a new
   `cohort` value for the new group of students.
2. **Deactivate the previous cohort**, if those students should no longer
   log in. Import does not do this automatically; do it by hand, or with
   a bulk update if your dashboard build supports one.
3. **Reset the session quota for returning students.** `sessions_total`
   is a total, not a daily allowance, so it does not reset on its own. A
   new cohort starts at zero. For a student who continues into the new
   semester, use the Reset sessions button on their Roster row.
4. **Confirm `instructor_recipients` still points to the right people**,
   if the teaching team changed between semesters.

## 9. Cost controls

Four settings bound what one interview, and one cohort, can cost.

### Time limit

`interview_limit_minutes` and `interview_warn_minutes` drive the
on-screen countdown a student sees. When the limit is reached, the app
ends the session the same way the "End interview" button would, and the
student still gets a report from what was recorded.

This is a client-side control. Nothing on the server forces a running
realtime session to stop at the limit. A student who disables the
countdown, for instance through browser developer tools, is not stopped
by this setting alone.

### Session quota

`sessions_total` is what makes the time limit meaningful even when a
student bypasses it. However long any one session runs, no student can
start more than this many interviews in total. This is the real backstop:
total exposure per student is bounded by roughly `sessions_total` times
`interview_limit_minutes`, not by the time limit alone. The Reset sessions
button on the Students screen (the roster) re-opens the quota for one student without
raising it for everyone.

### Rubric size

The number of active rubric items also drives cost, separately from the
time limit and the quota. Each active item costs one evaluator call per
submitted report, so a rubric with 20 active items scores every report at
roughly 20 times the cost of a rubric with 1. See section 6 for the
20-item cap and how to manage it.

### What a `duration_ms` overrun means

Every submission records its actual duration. A duration well past
`interview_limit_minutes` is not a bug in the app. It means one specific
student ran a session past the intended limit, most likely by working
around the client-side countdown. It is not, by itself, evidence of
routine cost overrun across the cohort, since the session quota still
bounds the worst case per student.

Check the Submissions screen sorted by duration, from time to time,
particularly early in a cohort, to see whether this is happening and how
often, and to which students.

## 10. Manage admins

One rule: **whoever passes the Cloudflare Access login is the admin.**
There is no second list in the app. (A dashboard-managed admin list
existed for two days, 2026-08-26 to 2026-08-27, and was removed at the
instructor's request.)

To add or remove an admin, open the Cloudflare Zero Trust dashboard
(one.dash.cloudflare.com), go to Access → Applications, open
"Research Interview Trainer Admin", and edit the policy's email list.
Removal blocks dashboard access at once. To make every university
address an allowed admin in one step, add an "Emails ending in" rule
with the university domain — but then anyone at the university can open
the dashboard, so prefer listing individual addresses for a small team.

## 11. Backups and disaster recovery

Two mechanisms protect the data. Both are independent of this app's
code.

**Point-in-time recovery, built into D1 (the last 30 days).** Cloudflare
keeps a continuous history of the database. If someone deletes the
roster, the rubric, or every submission, the whole database can be
restored to any minute in the last 30 days:

```bash
npx wrangler d1 time-travel info riv-trainer     # shows the current restore point
npx wrangler d1 time-travel restore riv-trainer --timestamp=<unix-or-ISO>
```

Restore replaces the WHOLE database with its state at that moment.
Changes made after that moment are lost, so restore to the minute just
before the accident. No setup is needed; this always works.

**Exported snapshots (long-term).** For records older than 30 days,
export the database to a plain SQL file:

```bash
npm run backup        # writes backup-<date>.sql from the live database
```

Do this at the start and at the end of every semester, and store the
file somewhere safe outside this folder. The file restores with
`npx wrangler d1 execute riv-trainer --remote --file=<backup file>` into
an empty database. Backup files are gitignored; never commit one, they
contain student data.

## 12. Find a problem fast

The Worker keeps searchable logs (Cloudflare dashboard: Workers &
Pages, the Worker, Logs). Every error path writes one line there. Live
logs: `npx wrangler tail`. With that, the triage routine for "a student
has a problem":

1. **Students screen**: is the email on the list, spelled right, and
   active? Most cases end here.
2. **Resend dashboard** (resend.com, Emails): was the mail sent, and
   does it say delivered? "Delivered" but not in the inbox means the
   receiving side filtered it - for university addresses, the Microsoft
   quarantine (section 4).
3. **Worker logs**: search the time window or the student's email for
   error lines. Scoring failures name the reason category; the OpenAI
   key never appears in a log line.
4. **Submissions screen**: did the interview complete and store?
5. If only login is broken: **Break-glass** unblocks the student now;
   investigate afterwards.

Common log lines and their meaning: "login code send failed" = Resend
refused the send (check the Resend dashboard and the API key);
"scoring failed: OpenAI rate limit hit" = the OpenAI organization is
over its rate or spend limit (check platform.openai.com limits);
"scoring aborted: the rubric has no active criteria" = the rubric was
emptied (activate an item).
