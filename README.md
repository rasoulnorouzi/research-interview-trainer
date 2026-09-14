# Research Interview Trainer

Students practise qualitative research interviewing. They hold a spoken
interview with an AI interviewee, then get a scored report on their
interviewing technique.

Nothing to install. Students open the link, log in with their university
email address and a mailed code, and start. They need no API key and no AI
account of their own. The site is served over HTTPS, which the browser
requires before it grants microphone access.

## How it works

A React app, served by a Cloudflare Worker with a D1 database. The student
and the interviewee speak; there is no typing. The voice runs over WebRTC,
straight from the browser to the university's AI gateway, Tilburg.AI
(LiteLLM in front of Azure OpenAI, Sweden Central). The Worker never
carries audio. It logs students in, mints a short-lived voice token, scores
the interview and emails the report.

The design is modern and quiet: a white page, colours taken from the
interview orb (violet, indigo, cyan), soft motion. During the interview a
glowing orb on a dark stage follows the voices: it swells with the
interviewee's voice and, more softly, with the student's. The orb only
reads the call's own audio levels; it never opens the microphone itself.

The transcript is not shown during the interview. The student reads it in
the report. An interviewee answer that the student cut off keeps only the
words the student heard, ends in "…", and carries the label
"(interrupted)".

The student clicks "Submit interview for scoring" at the end. The report is
shown on screen and emailed to the student and the instructor:

- **Speaking metrics**, measured from the audio: duration, speaking time
  per side, turn averages, silence, talk ratio, questions asked, words
  spoken, turn counts, longest turn.
- **Rubric assessment**, scored by AI: by default eight interviewing
  criteria (open vs. closed questions, follow-up probing, noticing and
  pursuing cues, depth of discovery, avoiding leading questions, rapport,
  neutrality, structure). The instructor edits the rubric, and each
  criterion has its own scale. Each criterion is scored by an
  **independent** evaluator call that sees only that one criterion, to
  avoid anchoring bias between scores.
- **Feedback**: a separate call writes strengths, improvements, quoted
  moments and a summary. The instructor can switch it off, and can keep
  the scores from the students.

## Interviewees

Three built-in personas (a nurse who left healthcare, a teacher who left
education, a first-generation student who left university), plus any the
instructor makes on the dashboard. Each persona tells its story in layers:
a careful interviewer reaches the real reason, a careless one does not.
The instructor shows a persona to all students or only to chosen roster
cohorts.

## Using it as a student

1. Open the link your instructor gave you.
2. Log in with your university email address. You get a 6-digit code by
   email. Enter it to continue. "Remember this device" is ticked by
   default; untick it on a shared computer.
3. Choose an interviewee, allow microphone access, and start.
4. When you finish, click "Submit interview for scoring".

## For the instructor

The dashboard is at `/admin`, behind Cloudflare Access. It manages the
roster and its cohorts, the personas, the rubric, the settings (the
gateway key, the models, the time limit, the session quota, report
sharing, the welcome panel) and the submissions.
[OPERATIONS.md](OPERATIONS.md) explains each screen and the safe values.

## Running it locally

**Client only** (no login, no API; for UI changes before the login
screen):

```bash
npm install
npm run dev
```

Open **http://localhost:5173**, not the LAN address Vite also prints. Only
`localhost` counts as a secure context, so the microphone is silently
blocked on `http://192.168.x.x:5173`.

**Client and Worker together**, which behaves like the deployed app:

```bash
npm run build
npm run dev:worker
```

This needs a local D1 database and a `.dev.vars` file; see
[DEPLOYMENT.md](DEPLOYMENT.md). Set `AI_BASE_URL` in `.dev.vars` to the
testing gateway (`https://api.testing.tilburg.ai/v1`), open
`http://localhost:8787/admin`, and paste the testing key on the Settings
screen.

## Scripts

- `npm run dev`: client-only development server
- `npm run dev:worker`: client and API together, through `wrangler dev`
- `npm run build`: production build (static files in `dist/`, served by
  the Worker)
- `npm run preview`: serve the production build (client only)
- `npm run lint`: TypeScript check, client and Worker
- `npm run seed:gen`: regenerate `seed-personas.sql` from
  `src/personas.ts`
- `npm run seed:gen:criteria`: regenerate `seed-criteria.sql` from
  `src/criteria.ts`
- `npm run backup`: export the production database to
  `backup-<date>.sql` (gitignored; it holds the API key)
- `npm run backup:local`: the same for the local database

The client has three dependencies: `react`, `react-dom`, and `ogl`, the
small WebGL library that draws the orb. There is no AI SDK anywhere: the
Worker and the browser use plain `fetch` and WebRTC.

## Documentation

| File | What it covers |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Architecture, design constraints, the gateway, gotchas. Read it before you change code. |
| [API.md](API.md) | The HTTP contract of the Worker, student and admin routes |
| [DEPLOYMENT.md](DEPLOYMENT.md) | First deploy, update deploys, rollback |
| [OPERATIONS.md](OPERATIONS.md) | Running a cohort day to day |
| [PROTOCOLS.md](PROTOCOLS.md) | Each release: what changed, decisions, tests, deploy, rollback |
| [PROMPTING.md](PROMPTING.md) | Persona and evaluator prompts, the prompt-injection guard |
| [BACKEND-PLAN.md](BACKEND-PLAN.md) | The original backend design (history) |
| [OPENAI-MIGRATION.md](OPENAI-MIGRATION.md) | The move from Gemini to OpenAI (history) |

## Deployment

The app deploys as a Cloudflare Worker: `npm run build && npx wrangler
deploy`. See [DEPLOYMENT.md](DEPLOYMENT.md) first, and the newest section
of [PROTOCOLS.md](PROTOCOLS.md) for the last release.

The `legacy-client` branch keeps the earlier pure client-side build, where
a student pasted their own OpenAI API key and the app deployed to GitHub
Pages. It is kept only as a fallback.
