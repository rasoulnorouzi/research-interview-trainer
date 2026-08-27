# Deployment

This document tells you how to deploy the Research Interview Trainer to
Cloudflare. It is for the instructor or an assistant who runs the deploy.

The app is one Cloudflare Worker. The Worker serves the built React app and
the `/api/*` backend from one origin. Read [`BACKEND-PLAN.md`](BACKEND-PLAN.md)
first if you have not, for the design this deployment implements.

## 1. What you need

Gather these before you start.

| Item | Value for this project |
|---|---|
| Cloudflare account ID | `d47f04214378f82cee8294125ebf2c0b` |
| D1 database | `riv-trainer`, id `33a29bc2-6efd-4d16-a214-467084202acc`, region WEUR (already created) |
| Node.js | version 22 |
| Resend account | owner `rasoulzaryab@gmail.com` |
| Instructor email for Access | `r.norouzinikjeh@tilburguniversity.edu` |

### Cloudflare API token

Create an account-scoped API token in the Cloudflare dashboard. Grant it
exactly these permissions.

| Resource | Permission |
|---|---|
| Workers Scripts | Edit |
| D1 | Edit |
| Access: Apps and Policies | Edit |
| User Details | Read |
| Memberships | Read |

Wrangler, the Cloudflare CLI, reads two environment variables. Set both
before you run any `wrangler` command.

```bash
export CLOUDFLARE_API_TOKEN="<your token>"
export CLOUDFLARE_ACCOUNT_ID="d47f04214378f82cee8294125ebf2c0b"
```

## 2. First deploy, step by step

Do these steps in order. Run every command from the repository root.

**1. Install dependencies.**

```bash
npm install
```

**2. Build the client.**

```bash
npm run build
```

This writes the static app to `dist/`. The Worker serves this folder.

**3. Create the database tables.**

```bash
npx wrangler d1 execute riv-trainer --remote --file=schema.sql
```

`schema.sql` uses `CREATE TABLE IF NOT EXISTS`, so this command is safe to
run again later.

**4. Load the default settings.**

```bash
npx wrangler d1 execute riv-trainer --remote --file=seed-settings.sql
```

This sets the interview time limit, the total session quota, and the default
models. It does not set the OpenAI key or the instructor email list. Step 6
sets the key. [OPERATIONS.md](OPERATIONS.md) covers the instructor email list.

**5. Generate and load the built-in personas and rubric.**

```bash
npm run seed:gen
npx wrangler d1 execute riv-trainer --remote --file=seed-personas.sql
npm run seed:gen:criteria
npx wrangler d1 execute riv-trainer --remote --file=seed-criteria.sql
```

`npm run seed:gen` reads `src/personas.ts` and writes `seed-personas.sql`.
`npm run seed:gen:criteria` reads `src/criteria.ts` and writes
`seed-criteria.sql`. Both generated files are gitignored. Delete them
after this step if you want a clean working tree; regenerate either one
any time from its source file. Skipping the second command leaves the
`criteria` table empty, and every `POST /api/report` then answers `503`
until it is seeded.

**6. Set the two Worker secrets.**

```bash
openssl rand -base64 32
```

Copy the output. Use it as the session secret in the next command.

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put RESEND_API_KEY
```

Wrangler prompts for each value on stdin. `SESSION_SECRET` signs the
student login cookie. `RESEND_API_KEY` is your Resend API key.

**Caution.** The OpenAI API key is not a Worker secret. It is not set with
`wrangler secret put`. Step 7 sets it a different way.

**7. Bootstrap the OpenAI key.**

The OpenAI key lives in the `settings` table, not in a Worker secret. This
lets the instructor rotate it later from the dashboard, without a new
deploy. The first time, you set it by hand.

1. Create a file named `set-key.sql` in the repository root. Do not commit
   it; `.gitignore` already excludes it.
2. Write one line into it, with your real key:

   ```sql
   INSERT INTO settings (key, value, updated_at, updated_by) VALUES
     ('openai_api_key', 'sk-REPLACE-WITH-REAL-KEY', strftime('%s','now'), 'bootstrap');
   ```

3. Run the file against the remote database:

   ```bash
   npx wrangler d1 execute riv-trainer --remote --file=set-key.sql
   ```

4. Delete `set-key.sql`.

```bash
rm set-key.sql
```

After this first bootstrap, rotate the key from the dashboard Settings
screen instead. [OPERATIONS.md](OPERATIONS.md) covers rotation. The
dashboard validates a new key against OpenAI before it saves it.

**8. Deploy the Worker.**

```bash
npx wrangler deploy
```

Wrangler prints the deployed URL. It has the form
`https://research-interview-trainer.<your-account-subdomain>.workers.dev`.
Write this URL down. You need it for Cloudflare Access setup in section 3.

**9. Smoke check.**

1. Open the deployed URL in a browser.
2. Confirm the login screen loads.
3. Enter your own email address and request a code.
4. Confirm you receive it (see section 4 on Resend if you do not).
5. Log in with the code and confirm the setup screen loads.

The admin dashboard at `/admin` still rejects every request at this point,
because Cloudflare Access is not configured yet. That is correct. Section
3 sets it up.

## 3. Cloudflare Access setup

Cloudflare Access protects `/admin` and `/api/admin/*`. It is free for a
teaching team of this size. Do these steps in the Cloudflare dashboard.

**1. Open Zero Trust.**

Go to the Cloudflare dashboard, then **Zero Trust > Access > Applications**.

**2. Add a self-hosted application.**

1. Click **Add an application**.
2. Choose **Self-hosted**.
3. Name it, for example "Research Interview Trainer Admin".

**3. Set the application domain.**

Enter the workers.dev hostname from step 2.8 above, for example
`research-interview-trainer.<your-account-subdomain>.workers.dev`.

**4. Restrict the application to the admin paths.**

Add both of these paths to the application, so Access covers the
dashboard and its API together:

- `/admin`
- `/api/admin/*`

**5. Configure the identity provider.**

Use an existing identity provider, or Cloudflare's own one-time-PIN email
login. Either works; the Worker only reads the verified email address from
the token Access produces.

**6. Add an Allow policy.**

1. Create a policy named "Instructor".
2. Set the action to **Allow**.
3. Add a rule: **Emails** includes `r.norouzinikjeh@tilburguniversity.edu`.
4. Add any other instructor or teaching-assistant addresses the same way.

**7. Save the application.**

**8. Copy the Application Audience (AUD) tag.**

Open the application you just created. Its **Overview** tab shows an
**Application Audience (AUD) Tag**. Copy it.

**9. Find the team domain.**

Your Zero Trust team domain has the form `<team-name>.cloudflareaccess.com`.
Find it in **Zero Trust > Settings > Custom Pages**, or in the URL of your
Zero Trust dashboard.

**10. Add both values to `wrangler.jsonc`.**

Edit the `vars` block:

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "<team-name>.cloudflareaccess.com",
  "ACCESS_AUD": "<the AUD tag you copied>",
  "EMAIL_FROM": "onboarding@resend.dev"
}
```

**11. Redeploy.**

```bash
npm run build && npx wrangler deploy
```

**12. Confirm the gate works.**

Open `/admin` in a private browser window, signed out of Cloudflare Access.
Confirm it redirects to an Access login page rather than showing the
dashboard.

**Note.** The Worker checks the Access JWT itself, on every `/api/admin/*`
request. It does this whether or not Access sits in front of the Worker.
Until `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are both set, the Worker fails
closed: it rejects every admin request with 403, rather than allowing them
through unchecked. Steps 1 through 11 remove that block; they do not create
protection that was previously absent.

## 4. Resend email setup

The Worker sends student login codes and interview reports through Resend.

### Current state: domain verified, mail live

The sending domain, `rslnorouzi.site`, is verified at
[resend.com/domains](https://resend.com/domains). Its DNS records (SPF,
DKIM, and MX) are set in Cloudflare DNS. `EMAIL_FROM` in `wrangler.jsonc`
is `Research Interview Trainer <trainer@rslnorouzi.site>`. Mail delivers
to every address, students included, not only to the Resend account
owner's own address. No further Resend setup is needed for this
deployment.

**Note.** A brand-new Resend account, before its domain is verified,
restricts outgoing mail two ways: mail can only be sent from
`onboarding@resend.dev`, and can only be delivered to the account owner's
own address. That restriction does not apply to this deployment. It
matters only if you set up Resend again from scratch, for example for a
separate deployment of this app.

### Changing the sending domain later

Follow these steps if this deployment ever needs to move to a different
sending domain.

**1. Choose a sending domain** you control, for example a different
subdomain of the university's mail domain.

**2. Verify the domain at [resend.com/domains](https://resend.com/domains).**

Resend gives you DNS records to add at your domain's DNS provider,
typically an SPF record (TXT), a DKIM record (TXT or CNAME), and an MX
record. Add every record it gives you.

**3. Wait for verification.** Resend checks the records automatically.
This can take up to 48 hours, though it is usually much faster.

**Caution.** A domain missing any required record gets mail rejected by
many university mail servers, not filed to spam. A student checking their
spam folder will not find a message that was never accepted. Verify every
record before trusting delivery.

**4. Update `EMAIL_FROM` in `wrangler.jsonc`.**

```jsonc
"vars": {
  "EMAIL_FROM": "Sender Name <noreply@your-new-domain.example>"
}
```

**5. Redeploy.**

```bash
npm run build && npx wrangler deploy
```

**6. Send one test code to a real student-side inbox**, not just to your
own address, before students start using the new domain. Confirm it
arrives in the inbox, not spam.

## 5. Update deploy

Once the first deploy and setup above are done, an ordinary update is one
command.

```bash
npm run build && npx wrangler deploy
```

Run this after any code change to `worker/`, `shared/`, or `src/`.

**A schema change is not covered by this command.** If a change adds or
alters a table, run the matching `wrangler d1 execute` command from section
2, step 3, against the remote database, before or after the deploy as the
change requires.

### Deploying the editable rubric to an existing database

The rubric feature (2026-08-21) adds two tables, `criteria` and
`criteria_versions`, and changes what `submissions.overall_score` means:
it used to store a 1-to-5 mean, and now stores a 0-to-100 percentage. Run
all three steps below against the remote database **before** running
`wrangler deploy` with the new Worker code. The currently running old
code does not read the new tables and does not know about the new score
scale, so applying all of this ahead of the deploy is always safe.

**1. Re-apply the schema.**

```bash
npx wrangler d1 execute riv-trainer --remote --file=schema.sql
```

`schema.sql` uses `CREATE TABLE IF NOT EXISTS`, so this adds `criteria`
and `criteria_versions` without touching any table that already exists.

**2. Load the built-in rubric.**

```bash
npm run seed:gen:criteria
npx wrangler d1 execute riv-trainer --remote --file=seed-criteria.sql
```

**3. Convert stored scores to the new percentage scale, once.**

```bash
npx wrangler d1 execute riv-trainer --remote --command="UPDATE submissions SET overall_score = ROUND(overall_score * 20.0, 1) WHERE overall_score IS NOT NULL AND overall_score <= 5;"
```

Every report scored before this change stored a mean out of 5. This
statement multiplies each of those old values by 20, converting them onto
the same 0-to-100 scale every new report stores. The `<= 5` guard means
running this command twice is harmless: a row already converted is
already above 5 and is left alone.

**4. Move the session quota setting to its new key, once.**

The same feature round (2026-08-26) replaced `sessions_per_day` with
`sessions_total`: the quota is now a per-student total for the course,
not a daily allowance. Remove the old row and seed the new one:

```bash
npx wrangler d1 execute riv-trainer --remote --command="DELETE FROM settings WHERE key='sessions_per_day';"
npx wrangler d1 execute riv-trainer --remote --file=seed-settings.sql
```

`seed-settings.sql` uses `INSERT OR IGNORE`, so it adds `sessions_total`
(default 10) and `share_report_with_student` (default 1) without touching
any value the dashboard has already set.

**5. Deploy the Worker.**

```bash
npm run build && npx wrangler deploy
```

### The admin list experiment (2026-08-26 to 2026-08-27, removed)

For two days the Worker had a second authorization layer: a
`MASTER_ADMINS` var plus an `admins` D1 table with a dashboard screen.
The instructor removed it the same week — too much machinery for one
course team. Since 2026-08-27 the rule is the original one again:
**whoever passes the Cloudflare Access login is the admin.** Manage
admins in one place only, the Access policy of the "Research Interview
Trainer Admin" application in the Zero Trust dashboard (section 3). The
`admins` table was dropped from the live database.

## 6. Rollback

The `main` branch runs the Worker. It no longer deploys to GitHub Pages.
The `legacy-client` branch is kept as a fallback: the client-side app that
holds its own OpenAI key and needs no backend at all.

### Creating the branch

Do this once, before or as part of the first Worker deploy. The last
commit of the pure client-side app, before any backend code, is
`3e07268` ("Remove em dashes from prompt text and user-visible errors").

```bash
git branch legacy-client 3e07268
git push origin legacy-client
```

Confirm `.github/workflows/deploy.yml` exists on `legacy-client`. That
workflow deploys to GitHub Pages on every push to its branch. Leave it
there; do not run it from `main`.

### Rolling back

Use this if the Worker deploy has a serious problem and you need students
working again immediately, before you can fix the Worker.

1. Check out `legacy-client`.
2. Confirm it still builds: `npm install && npm run build`.
3. Either point the GitHub Pages source at `legacy-client` in the repo
   settings, or push it to trigger the branch's own Pages workflow.
4. Confirm the Pages site loads at
   `https://rasoulnorouzi.github.io/research-interview-trainer/`.
5. Tell students to use that URL instead, and to paste their own OpenAI
   API key on the setup screen. This is the old flow: no login, no roster,
   no server-side scoring.
6. Fix the Worker on `main`, redeploy, and switch students back once you
   have re-run the smoke check in section 2, step 9.

**Note.** The rollback flow asks students to supply their own API key
again. It is a genuine fallback for an emergency, not a seamless switch.
Treat it as a short-term measure while you fix the Worker.
