-- D1 schema for the hosted trainer. Copied verbatim from BACKEND-PLAN.md §3,
-- the authoritative source, with IF NOT EXISTS added so re-running this file
-- (e.g. against a fresh `wrangler d1 execute`) is always safe. Do not let this
-- drift from the plan; if the plan changes, change both.

-- Who is allowed to use the app. Imported per semester from the registry.
CREATE TABLE IF NOT EXISTS roster (
  student_id   TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,        -- lowercased at import time
  full_name    TEXT NOT NULL,
  cohort       TEXT,                        -- e.g. '2026-2027-S1'
  lms_user_id  TEXT,                        -- null until Canvas; see §9
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

-- One live login code per address. Rows are short-lived.
CREATE TABLE IF NOT EXISTS login_codes (
  email        TEXT PRIMARY KEY,
  code_hash    TEXT NOT NULL,               -- SHA-256 of the 6 digits
  expires_at   INTEGER NOT NULL,            -- unix seconds
  attempts     INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER NOT NULL
);

-- Rate limiting for /api/auth/request, keyed by email and by IP.
CREATE TABLE IF NOT EXISTS request_log (
  key          TEXT NOT NULL,               -- 'email:…' or 'ip:…'
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

-- One row per completed interview.
CREATE TABLE IF NOT EXISTS submissions (
  id              TEXT PRIMARY KEY,         -- uuid
  student_id      TEXT NOT NULL REFERENCES roster(student_id),
  persona_id      TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL,
  overall_score   REAL,                     -- null when nothing was assessable
  scores_json     TEXT NOT NULL,
  feedback_json   TEXT NOT NULL,
  metrics_json    TEXT NOT NULL,
  transcript_json TEXT NOT NULL,
  emailed_at      INTEGER,
  -- Transcript-consent answer (instructor request, 2026-09-18): 1 = the
  -- student agreed that their transcript may be used to improve the chatbot,
  -- 0 = they refused, NULL = stored before the question existed. An existing
  -- database needs one ALTER TABLE; see DEPLOYMENT.md.
  transcript_consent INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id, created_at);

-- A stored interview scored again later from its transcript (instructor
-- request, 2026-09-21), to test a changed rubric or changed prompts. One row
-- per submission at most: scoring again replaces it (no history, instructor
-- decision), and the dashboard shows this row instead of the submission's
-- own scores. The submission row is never touched: what the student and the
-- assessors got stays as it was, and the student's history keeps reading it. Each row keeps a copy of what produced it (the rubric,
-- both prompt templates, the model, which persona text), so a score can
-- always be traced to the rubric version that gave it. No email is sent.
CREATE TABLE IF NOT EXISTS rescores (
  id                 TEXT PRIMARY KEY,         -- uuid
  submission_id      TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  overall_score      REAL,                     -- null when nothing was assessable
  scores_json        TEXT NOT NULL,
  feedback_json      TEXT NOT NULL,            -- JSON null when feedback was off
  model              TEXT NOT NULL,
  rubric_json        TEXT NOT NULL,            -- the active criteria, in full, as used
  prompts_json       TEXT NOT NULL,            -- {criterion, feedback} templates as used
  -- Which persona text the evaluators saw: the persona_versions row saved
  -- last before the interview, or the current row when there is none.
  persona_version_id INTEGER,                  -- null = the current persona row
  created_at         INTEGER NOT NULL,
  created_by         TEXT
);
-- One row per submission, enforced: the dashboard joins on it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rescores_one ON rescores(submission_id);

-- Per-student daily cap on realtime sessions. Protects the university key.
CREATE TABLE IF NOT EXISTS session_grants (
  student_id TEXT NOT NULL,
  day        TEXT NOT NULL,                 -- 'YYYY-MM-DD'
  count      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (student_id, day)
);

-- Everything the instructor can change without a deploy. See §7.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT                           -- instructor email from Access
);

-- Personas, editable from the dashboard. Seeded from src/personas.ts.
CREATE TABLE IF NOT EXISTS personas (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  title              TEXT NOT NULL,
  research_topic     TEXT NOT NULL,
  short_bio          TEXT NOT NULL,         -- must stay spoiler-free
  voice_name         TEXT NOT NULL,
  system_instruction TEXT NOT NULL,
  hidden_core        TEXT,
  active             INTEGER NOT NULL DEFAULT 1,
  updated_at         INTEGER NOT NULL,
  updated_by         TEXT
);

-- Every save of a persona, never deleted. See §7 on why this is not optional.
CREATE TABLE IF NOT EXISTS persona_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id  TEXT NOT NULL,
  snapshot    TEXT NOT NULL,                -- full JSON of the row as saved
  saved_at    INTEGER NOT NULL,
  saved_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_persona_versions ON persona_versions(persona_id, saved_at);

-- The scoring rubric, editable from the dashboard. Seeded from src/criteria.ts.
CREATE TABLE IF NOT EXISTS criteria (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL,
  anchor_low         TEXT NOT NULL,   -- what a score of 1 looks like
  anchor_mid         TEXT NOT NULL,   -- what the midpoint score looks like
  anchor_high        TEXT NOT NULL,   -- what the top score looks like
  scale_max          INTEGER NOT NULL DEFAULT 5,  -- top of this item's scale, 2..10
  needs_ground_truth INTEGER NOT NULL DEFAULT 0,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  active             INTEGER NOT NULL DEFAULT 1,
  updated_at         INTEGER NOT NULL,
  updated_by         TEXT
);

-- Every save of a criterion, never deleted. Mirrors persona_versions.
CREATE TABLE IF NOT EXISTS criteria_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  criterion_id TEXT NOT NULL,
  snapshot     TEXT NOT NULL,          -- full JSON of the row as saved
  saved_at     INTEGER NOT NULL,
  saved_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_criteria_versions ON criteria_versions(criterion_id, saved_at);

-- Which roster cohorts see a persona (2026-09-11). A persona with no rows here
-- is open to every student. A persona with rows is shown only to students
-- whose roster.cohort is one of them. Re-applying this file adds the table and
-- touches nothing else.
CREATE TABLE IF NOT EXISTS persona_cohorts (
  persona_id TEXT NOT NULL,
  cohort     TEXT NOT NULL,                 -- matches roster.cohort exactly
  PRIMARY KEY (persona_id, cohort)
);
