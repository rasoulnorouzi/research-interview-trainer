# Research Interview Trainer

Nothing to install — students open the link, log in with their university
email address and a mailed code, and start. No API key, no account of their
own to set up. The site is served over HTTPS, which the browser requires
before it will grant microphone access.

A React app, served by a Cloudflare Worker, for teaching students how to
conduct qualitative research interviews. The student speaks (voice only) with
an AI-simulated interviewee via the OpenAI Realtime API. Their own words
appear as they say them. When the interview ends, the app produces a detailed
report, which is also emailed to the student and the instructor:

- **Speaking metrics** (computed locally from the audio itself): duration,
  per-side speaking time and turn averages, silence, talk ratio, questions
  asked, words spoken, turn counts, longest turn.
- **Rubric assessment** (AI-scored): eight interviewing-skills criteria —
  open vs. closed questions, follow-up probing, noticing and pursuing cues,
  depth of discovery, avoiding leading questions, rapport, neutrality, and
  structure. Each is scored 1–5 by an **independent** evaluator call that sees
  only that one criterion — avoiding anchoring bias between scores — plus a
  ninth call for qualitative strengths, improvements, notable quoted moments,
  and a summary.

## Interviewees

Three built-in personas with detailed backstories (a nurse who left
healthcare, a teacher who left education, a first-generation student who
left university), managed from the instructor dashboard. There is no
student-facing option to define a custom persona; picking a persona for a
cohort is now an instructor task.

## Using it as a student

1. Open the link your instructor gave you.
2. Log in with your university email address. You'll get a 6-digit code by
   email; enter it to continue. Tick "Remember this device" to skip this next
   time.
3. Choose an interviewee, allow microphone access, and start.

No API key and no OpenAI account of your own is needed. The university's key
is used server-side. When the interview ends, your report is shown on screen
and emailed to you and your instructor.

## Running it locally

This is a two-part app now: a static client and a Cloudflare Worker that
serves the API. For most UI work, the client alone is enough.

**Client only** (no login, no API, for UI changes upstream of the login
screen):

```bash
npm install
npm run dev
```

Open **http://localhost:5173** — not the LAN address Vite also prints. Only
`localhost` counts as a secure context, so the microphone is silently blocked
on `http://192.168.x.x:5173`.

**Client and Worker together**, which behaves like the deployed app,
including login, persona data, and scoring:

```bash
npm run build
npm run dev:worker
```

This needs a local D1 database, migrated the same way as production; see
[DEPLOYMENT.md](DEPLOYMENT.md) for the full setup, including secrets and the
one-time key bootstrap.

## Scripts

- `npm run dev` — client-only development server
- `npm run dev:worker` — client and API together, via `wrangler dev`
- `npm run build` — production build (static files in `dist/`, served by the Worker)
- `npm run preview` — serve the production build (client only)
- `npm run lint` — TypeScript check, client and Worker
- `npm run seed:gen` — regenerate `seed-personas.sql` from `src/personas.ts`

The client still has only two dependencies, `react` and `react-dom`, and no
OpenAI SDK anywhere. The Worker talks to OpenAI over plain `fetch`; the
browser still talks to OpenAI directly over WebRTC for the interview audio
itself, only the token that authorizes it is minted server-side now.

Prompt design and the anti-injection rules are documented in
[PROMPTING.md](PROMPTING.md); the migration from Gemini in
[OPENAI-MIGRATION.md](OPENAI-MIGRATION.md); the backend design in
[BACKEND-PLAN.md](BACKEND-PLAN.md).

## Deployment

The app deploys as a Cloudflare Worker. See [DEPLOYMENT.md](DEPLOYMENT.md)
for the full first-deploy and update procedure, and
[OPERATIONS.md](OPERATIONS.md) for running a cohort day to day. `API.md`
documents the backend contract for anyone reimplementing it elsewhere.

The `legacy-client` branch keeps the earlier pure client-side build, the one
where a student pasted their own OpenAI API key and the app deployed to
GitHub Pages on every push to `main`. `main` no longer deploys there;
`legacy-client` is kept only as a fallback if the Worker ever needs to be
rolled back for a semester.
