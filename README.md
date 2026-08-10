# Research Interview Trainer

**▶ Live: https://rasoulnorouzi.github.io/research-interview-trainer/**

Nothing to install — students open the link, paste their own Gemini API key,
and start. The site is served over HTTPS, which the browser requires before it
will grant microphone access.

A simple client-side React app for teaching students how to conduct
qualitative research interviews. The student speaks (voice only) with an
AI-simulated interviewee via the Gemini Live API. When the interview ends,
the app produces a detailed report:

- **Speaking metrics** (computed locally): duration, talk ratio, questions
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
left university), plus a free-text box to define a fully custom persona.

## Using the hosted version

1. Get a Gemini API key from https://aistudio.google.com
2. Open https://rasoulnorouzi.github.io/research-interview-trainer/
3. Paste the key, choose an interviewee, allow microphone access, and start.

The key is held in your browser and sent only to Google — this app has no
server to send it to. If you would rather it could not be used elsewhere at
all, you can restrict the key to this site's address under
*API key → Application restrictions → Websites* in Google Cloud Console.

## Running it locally

1. Get a Gemini API key from https://aistudio.google.com
2. Install and run:

   ```bash
   npm install
   npm run dev
   ```

3. Open **http://localhost:5173** — not the LAN address Vite also prints.
   Only `localhost` counts as a secure context, so the microphone is silently
   blocked on `http://192.168.x.x:5173`.
4. Paste your API key (optionally tick "Remember this key" — it is stored only
   in your browser's localStorage and sent only to Google), choose an
   interviewee, and start. The browser will ask for microphone access.

## Scripts

- `npm run dev` — development server
- `npm run build` — production build (static files in `dist/`)
- `npm run preview` — serve the production build
- `npm run lint` — TypeScript check

There is no backend: the browser talks to the Gemini API directly.

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and
publishes `dist/` to GitHub Pages. No manual step.
