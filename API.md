# API

This document is the normative contract for the Research Interview
Trainer's backend. It is written for a developer reimplementing the
backend on a different stack. [`BACKEND-PLAN.md`](BACKEND-PLAN.md) section
9 names FastAPI on a university VM as the anticipated move.

The contract described here is the implementation in `worker/`, not the
original design in `BACKEND-PLAN.md` section 4. Section 7 of this
document lists every place the two differ, and section 5 records one
further deviation, from `BACKEND-PLAN.md` section 6.

## 1. Conventions

- All request and response bodies are JSON, except the CSV export in
  section 5 and the redirect in section 3.
- Every non-2xx JSON response has the shape `{"error": "<message>"}`.
  This shape is used everywhere in the app: student endpoints, admin
  endpoints, and the one general error wrapper around the whole Worker.
- All timestamps in request and response bodies are milliseconds since
  the Unix epoch, except where a field name says otherwise.
- All database and settings timestamps (`updated_at`, `started_at`,
  and similar) are seconds since the Unix epoch.
- Every response, success or error, carries `cache-control: no-store`.
  Most responses carry identity or student data.

## 2. Session cookie

The student session is a signed cookie, not a server-side session store.

| Property | Value |
|---|---|
| Cookie name | `riv_session` |
| Value format | `<base64url(payload JSON)>.<base64url(HMAC-SHA256 signature)>` |
| Payload fields | `sid` (student id, string), `exp` (Unix seconds), `v` (schema version, currently `1`) |
| Signing key | A Worker secret, `SESSION_SECRET`, HMAC-SHA256 |
| Verification | `crypto.subtle.verify`, not a string comparison of signatures |
| Flags | `HttpOnly; Secure; SameSite=Lax; Path=/` |
| Default lifetime | 8 hours |
| "Remember this device" lifetime | 90 days |

The cookie is stateless: reading it needs no database call. Because of
this, it does not reflect a student deactivation that happened after the
cookie was issued. Every handler that spends the OpenAI key re-checks
`roster.active = 1` from the database itself; it does not trust the
cookie alone for that check. A reimplementation must preserve this
re-check, not treat the signed cookie as sufficient proof of a still-active
student.

## 3. Student endpoints

Seven endpoints carry the student-facing product. An eighth route,
`GET /api/auth/redeem`, is documented here as the second half of the
break-glass flow described in [`OPERATIONS.md`](OPERATIONS.md) section 4,
not as an addition to the seven. It exists only to complete a link an
instructor hands a student directly; a student never reaches it any other
way.

### POST /api/auth/request

Requests a login code. No authentication.

**Request body**

```json
{ "email": "jane.doe@tilburguniversity.edu" }
```

**Response, success**

`200 {"ok": true}`. The code was generated, stored, and accepted by the
email provider.

**Response, failure**

| Status | Body | Cause |
|---|---|---|
| `400` | `{"error": "Enter your university email address."}` | The `email` field is missing, is not a string, or has no `@` |
| `429` | `{"error": "Too many attempts. Wait a minute and try again."}` | A rate limit in section 4 was exceeded |
| `404` | `{"error": "This email address is not on the course list. Check for typos or contact your instructor."}` | No roster row with that email and `active = 1` |
| `502` | `{"error": "The code email could not be sent. Try again in a minute."}` | The code was stored, but the email provider call failed |

The handler tests these in the order of the table. Nothing is generated
and nothing is stored on the `400`, `429`, or `404` branch. Section 5
records why this endpoint names an unknown address.

A request that fails to parse at all, wrong content type, an oversized
body, or malformed JSON, returns `415`, `413`, or `400` respectively,
each with `{"error": "<message>"}`. Those are transport-level failures
and carry no information about the address.

### POST /api/auth/verify

Exchanges an address and a code for a session.

**Request body**

```json
{ "email": "jane.doe@tilburguniversity.edu", "code": "482913", "remember": false }
```

**Response, success**

`200`, body is `MeResponse`:

```json
{ "studentId": "2026001", "fullName": "Jane Doe" }
```

Also sets the `riv_session` cookie described in section 2.

**Response, any failure**

`401 {"error": "Code incorrect or expired."}`

This single message covers every failure branch: wrong code, expired
code, more than 5 attempts on this code, unknown email, and a
deactivated student. Do not give these branches different messages in a
reimplementation. A distinguishable message here tells a caller how far a
guess got: whether an address has a live code, whether a code is merely
expired, or whether the attempts are already used. `POST
/api/auth/request` names an unknown address (section 5); this endpoint
does not follow it.

### POST /api/auth/logout

Clears the session cookie.

**Authentication.** None checked. The handler does not read or require a
valid session; it unconditionally sends a cookie-clearing header. This is
safe because the endpoint only ever destroys client-side state; it never
reads or writes a student record.

**Response**

`200 {"ok": true}`, with a `set-cookie` header that expires `riv_session`
immediately.

### GET /api/me

Returns the logged-in student's identity.

**Authentication.** Session cookie required. Additionally joins to the
roster with `active = 1`, so a deactivated student's still-valid cookie
is rejected here even though the cookie itself has not expired.

**Response, success**

`200`, body is `MeResponse`, same shape as `POST /api/auth/verify`.

**Response, not logged in or deactivated**

`401 {"error": "Not logged in."}`

### GET /api/personas

Lists the personas a student may choose for an interview.

**Authentication.** Session cookie required.

**Response, success**

`200`, body is an array of `PersonaSummary`, not wrapped in an object:

```json
[
  {
    "id": "elena",
    "name": "Elena van Dijk",
    "title": "Former hospital nurse",
    "researchTopic": "Why experienced nurses leave the profession",
    "shortBio": "..."
  }
]
```

Only these five fields are ever returned here. `systemInstruction` and
`hiddenCore` are excluded at the SQL level, not filtered afterward, so no
code path can accidentally widen this response. See section 6 for how
this differs from `BACKEND-PLAN.md`.

**Response, not logged in**

`401 {"error": "Not logged in."}`

### POST /api/session

Mints a short-lived OpenAI realtime token for one interview, and
consumes one unit of the student's total session quota.

**Authentication.** Session cookie required, with the same active-roster
re-check as `GET /api/me`.

**Request body**

```json
{ "personaId": "elena" }
```

**Response, success**

`200`, body is `SessionResponse`:

```json
{
  "token": "ek_...",
  "expiresAt": 1755180000,
  "limitMinutes": 12,
  "warnMinutes": 10
}
```

`expiresAt` is Unix seconds, matching what OpenAI returns. `token` is
valid to *start* a realtime session for `limitMinutes + 2` minutes from
mint time; it does not bound how long an already-started session may run.
There is no `instructions` field in the current build: the persona's
system instruction is set on OpenAI's side at mint time, so it never
reaches the response body or the browser.

**Response, failure**

| Status | Body | Cause |
|---|---|---|
| `401` | `{"error": "Not logged in."}` | No session, or deactivated student |
| `400` | `{"error": "A persona is required."}` | Missing or non-string `personaId` |
| `503` | `{"error": "The service is not configured yet. Tell your instructor."}` | No OpenAI key set in `settings` |
| `429` | `{"error": "You have used all your interview sessions. Ask your instructor if you need another one."}` | `sessions_total` used up for this student. An instructor can clear it with the reset-sessions endpoint below. |
| `404` | `{"error": "That persona is not available."}` | No active persona with that id |
| `502` | `{"error": "Could not start the interview. Try again in a moment."}` | The OpenAI mint call failed |

The 429 case still consumes a grant; a rejected mint attempt is not
refunded. This is deliberate, and simpler than a compensating write.

### POST /api/report

Scores a finished interview, stores it, and emails it.

**Authentication.** Session cookie required, same active-roster re-check.

**Request body**, `ReportRequest`:

```json
{
  "personaId": "elena",
  "transcript": [
    { "speaker": "student", "text": "...", "tStart": 0, "tEnd": 3200, "speechMs": 2800 }
  ],
  "startedAt": 1755179000000,
  "endedAt": 1755179720000,
  "metrics": { "...": "Metrics, see shared/types.ts" }
}
```

The transcript is capped at 500 entries and 200 KB serialized. Every
field on every entry is validated or defaulted; a missing or
non-finite timing value becomes `0` rather than rejecting the whole
report, since losing a real interview's report is worse than losing one
timestamp.

**Response, success**

`200`, body is `ReportResponse`:

```json
{
  "scores": [ { "id": "open_questions", "name": "Open vs. closed questions", "score": 4, "max": 5, "justification": "..." } ],
  "feedback": { "strengths": ["..."], "improvements": ["..."], "moments": [], "missedDepth": "...", "summary": "..." },
  "overall": 76.0,
  "emailed": true,
  "shared": true
}
```

`scores` is always in rubric order. Each row now carries `max`, the top
of that criterion's own scale (2 to 10, set per criterion from the
dashboard; 5 for every seeded criterion), because criteria no longer
share one fixed scale. A row stored before criteria carried their own
scale has no `max`; every renderer defaults a missing `max` to `5`.
`overall` is a percentage with one decimal, computed by the server,
never by a model: the sum of `score` over the sum of `max` across every
non-null row, times 100. It is `null` only when every criterion came
back not-assessable. Both report emails carry two plain-text attachments:
`interview-transcript-<date>.txt` and `interview-assessment-<date>.txt`. When
`share_report_with_student` is `0`, the student's mail carries only the
transcript file. `emailed` reflects whether both report emails were
sent successfully; a failed send does not fail the request; the
submission is already stored either way.

`shared` reports whether this copy carries the scores and the feedback.
It is `true` unless the instructor has set the `share_report_with_student`
setting to `"0"`. With the setting off, the interview is still scored and
still stored in full, and the instructor recipients still get the whole
report, but the student's copy is the transcript only. The response is
then:

```json
{
  "scores": [],
  "feedback": null,
  "overall": null,
  "emailed": true,
  "shared": false
}
```

The scores are held back from the response body, not only from the
screen, so no score the student is not meant to see reaches the browser.
The student's email in this mode is the transcript with a header block
and one sentence, and no metrics table, rubric or feedback.

**Response, failure**

| Status | Body | Cause |
|---|---|---|
| `401` | `{"error": "Not logged in."}` | No session, or deactivated student |
| `400` | `{"error": "Malformed report."}` or a more specific message | Body fails validation |
| `413` | `{"error": "The transcript is too large."}` | Over 200 KB serialized |
| `404` | `{"error": "That persona is not available."}` | No active persona with that id |
| `503` | `{"error": "The service is not configured yet. Tell your instructor."}` | No OpenAI key set, or the rubric has no active criteria |
| `502` | `{"error": "Scoring failed. Use Retry."}` | One or more evaluator calls (one per active criterion, plus the feedback call) failed after its retry |

Scoring is all-or-nothing. On the `502` case, nothing is stored and no
email is sent, so the client's retry is a clean re-`POST`, not a
reconciliation against a partial record.

### GET /api/auth/redeem (break-glass, not an 8th surface)

Exchanges a one-time break-glass token, minted by an instructor through
the admin surface (section 5), for a normal session.

**Authentication.** None. Security rests entirely on the token: 32 hex
characters from `crypto.getRandomValues`, single use, 15-minute expiry,
only its SHA-256 stored server-side.

**Request**

`GET /api/auth/redeem?token=<32 hex characters>`

**Response**

Always a `302` redirect, never JSON.

- Success: redirects to `/`, sets the `riv_session` cookie (not
  "remembered": always the 8-hour lifetime), and the token is
  consumed and cannot be used again.
- Any failure (malformed token, unknown token, expired token, or the
  underlying student since deactivated): redirects to
  `/?breakglass=expired`. No detail is given, since the link travels
  outside email and a failure here is an instructor problem, not a
  student one.

## 4. Rate limits

| Scope | Window | Max requests | Applies to |
|---|---|---|---|
| Per email address | 60 seconds | 1 | `POST /api/auth/request` |
| Per email address | 1 hour | 5 | `POST /api/auth/request` |
| Per source IP | 1 hour | 120 | `POST /api/auth/request` |
| Per login code | not time-boxed | 5 attempts | `POST /api/auth/verify` |
| Login code lifetime | - | 600 seconds (10 minutes) | issued by `POST /api/auth/request` |
| Break-glass token lifetime | - | 900 seconds (15 minutes) | issued by admin `POST /api/admin/breakglass` |

The per-IP limit is 120 per hour, not a tighter number, because a whole
computer lab or a campus WiFi network can sit behind one shared address.
It still stops bulk probing and email bombing; it just does not mistake a
classroom logging in together for an attack.

Counters are consumed even once a caller is already over a limit, so
repeated hammering stays locked out rather than recovering one attempt
per window. A caller over any of the three `POST /api/auth/request`
limits gets `429` with the message in section 3. `POST /api/auth/verify`
invalidates its code entirely once 5 attempts are used, rather than
merely refusing the 6th.

## 5. Address disclosure at login

`POST /api/auth/request` tells the caller when an address is not on the
roster. It answers `404` with the message in section 3, before a code is
generated.

This is a deliberate deviation from `BACKEND-PLAN.md` section 6, which
specifies `200 {"ok": true}` on every branch so that the endpoint cannot
be used to enumerate enrolment. The instructor decided on 2026-08-14 to
trade that resistance for clarity. The cohort is 400 students. A student
who mistypes an address, or who uses a personal address instead of the
university one, must learn it at once. The alternative is a student
waiting for a code that will never arrive, then writing to the
instructor. Clarity for every student was judged worth more than
concealment of a list that a university publishes in other forms.

A reimplementation must keep the rate limits in section 4, because they
are now the only bound on bulk probing of the roster. One request per
address per 60 seconds, five per address per hour, and 120 per source IP
per hour. Counters are consumed before the roster is read and are
consumed even when the caller is already over a limit, so a script cannot
recover one probe per window by hammering the endpoint.

`POST /api/auth/verify` keeps a single failure message for every branch.
That decision is unchanged; see section 3.

## 6. Admin surface

Every `/api/admin/*` request passes two checks in `worker/index.ts`:
the Cloudflare Access JWT (authentication), then the admin list
(authorization): a master admin from the `MASTER_ADMINS` var, or a row
in the `admins` table. A valid Access login that is not on the list gets
`403 {"error": "Your account is not on the admin list. ..."}`.

All of these live under `/api/admin/*`. Every request to this prefix
passes through one check, in `worker/index.ts`, before it reaches any
handler: a Cloudflare Access JWT, read from the `Cf-Access-Jwt-Assertion`
header, verified against the team's JWKS, checked for `iss`, `aud`,
`exp`, and `nbf`. A missing or invalid header returns
`403 {"error": "Access denied."}` before any handler runs. There is no
per-endpoint duplicate of this check; a reimplementation should keep the
check in one place for the same reason: a missing check on one endpoint
must be structurally impossible, not merely unlikely.

In local development only, setting `DEV_ALLOW_INSECURE_ADMIN=1` in
`.dev.vars` bypasses this check entirely and identifies the caller as
`dev@localhost`. This variable must never be set in `wrangler.jsonc` or
any deployed configuration; doing so would open the roster, the personas,
and the masked-but-rotatable OpenAI key to anyone who can reach the
Worker.

| Method | Path | Request body | Response |
|---|---|---|---|
| GET | `/api/admin/settings` | none | `{"settings": {key: {value, updatedAt, updatedBy}}}`. `openai_api_key` is masked, see key masking rule below. |
| PUT | `/api/admin/settings` | partial `{key: value}` map | `200` same shape as GET, or `400` on any validation failure. Whole batch is atomic. |
| GET | `/api/admin/roster` | query: `q`, `cohort` | `{"students": [RosterView], "limit": 500}` |
| POST | `/api/admin/roster` | `{studentId, fullName, email, cohort?}` | `201` RosterView, or `400`/`409` |
| POST | `/api/admin/roster/import` | `{csv, mode: "preview"|"apply"}` | `{"mode", "new", "changed", "unchanged", "invalid": [{line, reason}]}` |
| PATCH | `/api/admin/roster/:id` | partial `{email?, fullName?, cohort?, active?}` | `200` RosterView, or `400`/`404`/`409` |
| DELETE | `/api/admin/roster/:id` | none | `200 {studentId, active: false, message}`. Deactivates; never a SQL delete. |
| DELETE | `/api/admin/roster/:id?hard=1` | none | `200 {studentId, deleted: true}`. Permanently removes the student, only when they have no stored reports (`409` otherwise, naming the count). Also clears their login codes and session grants. |
| POST | `/api/admin/roster/:id/reset-sessions` | none | `200 {studentId, cleared}`. Deletes the student's session grants, so the `sessions_total` quota opens again. Reports are not touched. `404` for an unknown student. |
| POST | `/api/admin/roster/bulk-remove` | `{ids: [...]}` (max 500) | `200 {deleted, kept}`. Removes the listed students permanently, exactly like the single hard delete. Students with stored reports are skipped and listed in `kept` with their report count. |
| GET | `/api/admin/admins` | none | `{admins: [{email, note, master, createdAt, createdBy}]}`. Master admins first, marked `master: true`. |
| POST | `/api/admin/admins` | `{email, note?}` | `200 {email, added}`. Lowercases the email. `400` for a master admin's address, `409` for a duplicate. |
| DELETE | `/api/admin/admins/:email` | none | `200 {email, deleted}`. `400` for a master admin, `404` for an unknown address. |
| GET | `/api/admin/personas` | none | `{"personas": [{id, name, title, active, updatedAt, updatedBy}]}`. No spoiler fields, even here; the list view does not need them. |
| POST | `/api/admin/personas` | full persona fields, including `systemInstruction`, `hiddenCore` | `201` full persona, or `400`/`409` |
| GET | `/api/admin/personas/:id` | none | `200` full persona including `systemInstruction` and `hiddenCore`, or `404` |
| PUT | `/api/admin/personas/:id` | full persona fields | `200` full persona; writes one `persona_versions` snapshot in the same batch as the row update |
| DELETE | `/api/admin/personas/:id` | none | `200 {id, deleted: true}`. Permanently removes the persona, only when no reports reference it (`409` otherwise, naming the count). `persona_versions` is kept either way; there is no route that deletes a version. |
| GET | `/api/admin/personas/:id/versions` | none | `{"personaId", "versions": [{id, savedAt, savedBy, snapshot}]}` |
| GET | `/api/admin/criteria` | none | `{"criteria": [{id, name, scaleMax, needsGroundTruth, sortOrder, active, updatedAt, updatedBy}]}` |
| POST | `/api/admin/criteria` | full criterion fields, including `anchorLow`, `anchorMid`, `anchorHigh` | `201` full criterion, or `400`/`409` |
| GET | `/api/admin/criteria/:id` | none | `200` full criterion including `description` and the three anchors, or `404` |
| PUT | `/api/admin/criteria/:id` | full criterion fields | `200` full criterion; writes one `criteria_versions` snapshot in the same batch as the row update |
| DELETE | `/api/admin/criteria/:id` | none | `200 {id, deleted: true}`. Permanently removes the criterion, only when no stored report references it and it is not the last active criterion (`409`/`400` otherwise). `criteria_versions` is kept either way. |
| GET | `/api/admin/criteria/:id/versions` | none | `{"criterionId", "versions": [{id, savedAt, savedBy, snapshot}]}` |
| POST | `/api/admin/criteria/reorder` | `{ids: [...]}`, every criterion exactly once | `200 {reordered}`. Rewrites `sort_order` in the given order (drag-and-drop on the Rubric screen). Writes no version snapshots: order is layout, not content. |
| GET | `/api/admin/submissions` | query: `student` (substring match on student id), `cohort`, `from`, `to`, `sort=duration`, `limit` | `{"submissions": [...], "limit"}`. Excludes the four large JSON columns. |
| GET | `/api/admin/submissions/:id` | none | `200` full submission, including transcript, scores, feedback, metrics; or `404` |
| DELETE | `/api/admin/submissions/:id` | none | `200 {id, deleted: true}`. Permanently removes one submission. Nothing else references a submission, so there is no reference count and no deactivate-instead option; the dashboard offers this only from the submission's own detail view, not the list. |
| POST | `/api/admin/submissions/bulk-delete` | `{ids: [...]}` (max 500) | `200 {deleted}`. Deletes the listed submissions in one statement. Unknown ids are ignored; `deleted` counts the rows really removed. |
| GET | `/api/admin/submissions.csv` | same query params as list | `text/csv`, one row per submission plus one column per rubric criterion |
| POST | `/api/admin/breakglass` | `{studentId}` | `200 {url, expiresInMinutes, studentId, fullName}`, or `404`/`400` |

### Key masking rule

`GET /api/admin/settings` never returns the OpenAI key in full. If a key
is set, its value in the response is `sk-...` followed by its last four
characters. If no key is set, the `openai_api_key` entry is absent from
the response entirely, rather than present with an empty value; this is
what lets the dashboard distinguish "not set" from "set but masked."
There is no endpoint, and no query parameter, that returns the key in
full. `PUT /api/admin/settings` accepts a full key to store one, and that
is the only place a full key appears in a request or response body
anywhere in this API.

`PUT /api/admin/settings` also accepts `{"openai_api_key": null}` to
clear the stored key. Every subsequent `POST /api/session` and
`POST /api/report` answers `503` until a new key is saved. This is the
one setting that supports removal; every other setting key must always
carry a value.

### The student-copy switch

`share_report_with_student` is the one settings key that is a switch.
`PUT /api/admin/settings` accepts `true` or `false` for it, and also the
strings `"1"` and `"0"`; it stores `"1"` or `"0"`. Any other value answers
`400`, and nothing in the batch is written.

`"1"` is the default and is today's behaviour: the student receives the
scores and the feedback. `"0"` withholds both from the student copy only.
The interview is still scored, the submission is still stored in full,
and the instructor recipients still receive the whole report.
`POST /api/report` in section 3 gives the two response shapes. A missing
or unreadable value counts as `"1"`, so a cleared row shares rather than
withholds.

### Criteria validation rules

These apply to `POST /api/admin/criteria` and `PUT /api/admin/criteria/:id`.

| Field | Rule |
|---|---|
| `id` | `POST` only, immutable after creation. 1 to 40 characters, lowercase letters, digits, underscores and hyphens: `/^[a-z0-9_-]{1,40}$/`. The underscore is allowed here and not in a persona id, because every seeded criterion id already uses one (`open_questions`, `cue_pursuit`). |
| `name`, `description`, `anchorLow`, `anchorMid`, `anchorHigh` | All required, non-empty after trimming. |
| `scaleMax` | Whole number from 2 to 10. Defaults to 5 on create if omitted. Changing it on an existing criterion does not reword its anchors; that stays the instructor's job. |
| `needsGroundTruth` | Boolean. Defaults to `false` on create if omitted. |
| `sortOrder` | Whole number, zero or more. Defaults to the current highest `sortOrder` plus 10 on create, so a new item lands at the end without renumbering the rest. |
| `active` | Boolean. Defaults to `true` on create. |

Two rules bound the size and shape of the whole rubric, checked after every
field above is valid:

- **At most 20 active criteria.** A `POST` or `PUT` that would bring the
  count of active criteria to 21 answers `400`. Each active criterion costs
  one evaluator call per report, so the cap is a subrequest budget as well as
  a rubric-size limit.
- **At least 1 active criterion.** A `PUT` that would deactivate the last
  remaining active criterion answers `400`, naming the reason: no interview
  could be scored otherwise.

`DELETE /api/admin/criteria/:id` has its own two refusals, checked in this
order:

1. `400` if the criterion is active and is the only active criterion.
2. `409` if any stored submission's `scores_json` contains this criterion's
   `id` (checked with a `json_each` scan over every submission, since a
   criterion id is not a foreign key, it is a key inside stored JSON),
   naming the number of reports.

Both refusals suggest deactivating instead. `criteria_versions` rows are
never deleted by any route, including this one; a criterion re-created under
the same `id` finds its history waiting.

## 7. Deviations from BACKEND-PLAN.md section 4

The implementation differs from the original plan in these ways.

1. **`GET /api/personas` includes `researchTopic`.** The plan specifies
   `{id, name, title, shortBio}` only. The shipped `PersonaSummary` type
   adds `researchTopic`. This is deliberate, not an oversight: the
   research topic is the surface framing a student is told openly, for
   example "why experienced nurses leave the profession", and both the
   setup screen and the results screen display it. It carries no spoiler;
   withholding it would only move the identical string into `shortBio`.
2. **`POST /api/auth/logout` performs no session check.** The plan lists
   its auth as "session." The implementation clears the cookie
   unconditionally, without calling `identify()`. This is safe rather
   than a gap, since the endpoint only ever destroys state and never
   reads or writes anything tied to a student.
3. **`GET /api/auth/redeem` exists as an unauthenticated route.** It is
   not one of the plan's seven student endpoints, and section 3 of this
   document documents it as part of break-glass rather than an eighth
   surface, per the scope discipline `BACKEND-PLAN.md` section 9 asks
   for. It accepts only a single-use, server-issued opaque token and
   produces exactly what `POST /api/auth/verify` already produces: a
   session cookie.
4. **`DEV_ALLOW_INSECURE_ADMIN` is not in the plan.** It is a local-only
   addition for testing the admin surface without a real Access
   deployment, fails closed by default, and is documented in
   [`DEPLOYMENT.md`](DEPLOYMENT.md) with the warning never to set it in
   deployed configuration.
5. **The scoring rubric is editable from the dashboard, not fixed in
   code.** The plan (section 5) describes `CRITERIA` moving from
   `src/lib/scoring.ts` to the Worker unchanged, as a fixed list. The
   implementation goes further, as a 2026-08-21 addition: criteria live
   in a `criteria` D1 table plus a `criteria_versions` history,
   mirroring how personas already worked, with a per-criterion
   `scaleMax` (2 to 10) and a 20-active cap. `overall` changed from a
   plain mean to a percentage of points earned over points possible,
   because criteria no longer share one scale. See
   [`BACKEND-PLAN.md`](BACKEND-PLAN.md) sections 3 and 7 for the added
   schema, and section 6 above for the admin surface.

## 8. Invariants

These properties must hold in any reimplementation of this backend. They
are not incidental to the current code; each protects something the rest
of the app depends on.

- **The scoring calls stay independent.** One call per active criterion
  (8 in the seeded rubric, up to 20), plus one qualitative-feedback
  call, every one a separate call to the OpenAI Responses API with a
  fresh context. No evaluator call ever sees another criterion's
  definition, another criterion's score, or the persona's own system
  instruction. Collapsing this into one call reintroduces the anchoring
  bias the design exists to prevent; it is explicitly disallowed, not
  merely an optimization left undone.
- **`system_instruction` and `hidden_core` never reach a student-facing
  response.** `GET /api/personas` and `POST /api/session` both exclude
  them at the query level. Only the Access-gated admin surface exposes
  them, to an authenticated instructor.
- **`score: null` means not assessable, and is distinct from a score of
  `1`.** A `1` means the student did the thing being measured, and did it
  badly. `null` means the interview gave the evaluator nothing to judge.
  `null` scores are excluded from the points-based `overall` score, not
  counted as zero, and render as `n/a` in every surface: the dashboard,
  the emailed report, and the CSV export.
- **Money-spending calls re-check the roster, not just the cookie.**
  `POST /api/session` and `POST /api/report` both query
  `roster ... AND active = 1` themselves. The session cookie is stateless
  and cannot reflect a deactivation that happened after it was issued.
- **The OpenAI key never appears in a response body, a thrown error
  message, or a log line.** Every OpenAI-facing call maps its failure to
  one of four fixed strings before it leaves `worker/openai.ts`; no
  response body or header from OpenAI is ever read into a message that
  could reach a client or a log aggregator.
